const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = process.env.LOCAL_MODEL_GATEWAY_DATA_DIR || path.join(__dirname, '..', 'data');
const METRICS_PATH = path.join(DATA_DIR, 'metrics.json');
const LOG_PATH = path.join(DATA_DIR, 'metrics-log.jsonl');
const parsedMaxLogs = Number(process.env.LOCAL_MODEL_GATEWAY_MAX_LOGS);
const MAX_LOGS = Number.isFinite(parsedMaxLogs) && parsedMaxLogs >= 100 ? Math.floor(parsedMaxLogs) : 5000;
const DEFAULT_LOG_LIMIT = 100;
const MAX_LOG_LIMIT = 500;
const MAX_ATTEMPTS_PER_LOG = 12;

function emptyMetrics() {
  return {
    version: 1,
    totals: {
      requests: 0,
      successful: 0,
      failed: 0,
      failovers: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0
    },
    byUpstream: {}
  };
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function numberOrZero(value) {
  return Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0;
}

// Aggregated counters live in metrics.json; individual request logs live in an
// append-only JSONL file so we can keep thousands of entries without rewriting a
// large JSON document on every request.
function loadMetrics() {
  ensureDataDir();
  const defaults = emptyMetrics();
  if (!fs.existsSync(METRICS_PATH)) return { aggregates: defaults, legacyLogs: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(METRICS_PATH, 'utf8'));
    return {
      aggregates: {
        version: 1,
        totals: { ...defaults.totals, ...(parsed.totals || {}) },
        byUpstream: parsed.byUpstream && typeof parsed.byUpstream === 'object' ? parsed.byUpstream : {}
      },
      // Older builds stored logs inline; migrate them into the JSONL file.
      legacyLogs: Array.isArray(parsed.logs) ? parsed.logs : []
    };
  } catch {
    // A corrupted metrics file should not prevent the gateway from starting.
    return { aggregates: defaults, legacyLogs: [] };
  }
}

function parseLogLines(raw) {
  const parsed = [];
  for (const line of String(raw || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      parsed.push(JSON.parse(trimmed));
    } catch {
      // Skip a single corrupted line instead of dropping the whole history.
    }
  }
  return parsed;
}

function writeLogFile(chronologicalEntries) {
  ensureDataDir();
  const tempPath = `${LOG_PATH}.tmp`;
  const body = chronologicalEntries.map((entry) => JSON.stringify(entry)).join('\n');
  fs.writeFileSync(tempPath, body ? `${body}\n` : '', { mode: 0o600 });
  fs.renameSync(tempPath, LOG_PATH);
  try {
    fs.chmodSync(LOG_PATH, 0o600);
  } catch {
    // Windows does not expose Unix file modes consistently.
  }
}

function loadLogs(legacyLogs) {
  ensureDataDir();
  if (!fs.existsSync(LOG_PATH)) {
    // Migrate inline logs (stored newest-first) into a chronological JSONL file.
    const chronological = Array.isArray(legacyLogs) ? [...legacyLogs].reverse() : [];
    if (chronological.length) writeLogFile(chronological.slice(-MAX_LOGS));
    const migrated = chronological.slice(-MAX_LOGS).reverse();
    return { logs: migrated, fileLines: Math.min(chronological.length, MAX_LOGS) };
  }
  try {
    const parsed = parseLogLines(fs.readFileSync(LOG_PATH, 'utf8'));
    const recent = parsed.slice(-MAX_LOGS);
    return { logs: recent.slice().reverse(), fileLines: parsed.length };
  } catch {
    return { logs: [], fileLines: 0 };
  }
}

const loaded = loadMetrics();
let metrics = loaded.aggregates;
// In-memory cache of the most recent entries, newest first.
let logs = [];
let logFileLines = 0;

(function initLogs() {
  const state = loadLogs(loaded.legacyLogs);
  logs = state.logs;
  logFileLines = state.fileLines;
  if (Array.isArray(loaded.legacyLogs) && loaded.legacyLogs.length) saveMetrics();
}());

function saveMetrics() {
  ensureDataDir();
  const tempPath = `${METRICS_PATH}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(metrics, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempPath, METRICS_PATH);
  try {
    fs.chmodSync(METRICS_PATH, 0o600);
  } catch {
    // Windows does not expose Unix file modes consistently.
  }
}

function appendLog(entry) {
  ensureDataDir();
  fs.appendFileSync(LOG_PATH, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  logFileLines += 1;
  // Compact the file occasionally so it never grows without bound.
  if (logFileLines > MAX_LOGS * 2) {
    writeLogFile(logs.slice(0, MAX_LOGS).slice().reverse());
    logFileLines = Math.min(logs.length, MAX_LOGS);
  }
}

function normalizeUsage(usage = {}) {
  const promptTokens = numberOrZero(usage.prompt_tokens ?? usage.input_tokens);
  const completionTokens = numberOrZero(usage.completion_tokens ?? usage.output_tokens);
  const totalTokens = numberOrZero(usage.total_tokens) || promptTokens + completionTokens;
  return { promptTokens, completionTokens, totalTokens };
}

function normalizeAttempts(attempts) {
  if (!Array.isArray(attempts)) return [];
  return attempts.slice(0, MAX_ATTEMPTS_PER_LOG).map((attempt) => ({
    upstream: String(attempt.upstream || '未知上游').slice(0, 120),
    status: Number.isInteger(attempt.status) ? attempt.status : null
  }));
}

function recordRequest(entry) {
  const usage = normalizeUsage(entry.usage);
  const attempts = normalizeAttempts(entry.attempts);
  const success = entry.success === true;
  const logEntry = {
    id: String(entry.id || `req_${Date.now()}`),
    startedAt: entry.startedAt || new Date().toISOString(),
    finishedAt: entry.finishedAt || new Date().toISOString(),
    protocol: ['anthropic', 'responses'].includes(entry.protocol) ? entry.protocol : 'openai',
    strategy: ['failover', 'round_robin', 'random', 'weighted'].includes(entry.strategy) ? entry.strategy : 'failover',
    model: String(entry.model || '').slice(0, 200),
    upstream: entry.upstream ? String(entry.upstream).slice(0, 120) : null,
    upstreamModel: entry.upstreamModel ? String(entry.upstreamModel).slice(0, 200) : null,
    status: Number.isInteger(entry.status) ? entry.status : 500,
    durationMs: Math.max(0, Math.round(numberOrZero(entry.durationMs))),
    stream: entry.stream === true,
    success,
    failover: attempts.length > 1,
    attempts,
    usage,
    ...(entry.error ? { error: String(entry.error).slice(0, 500) } : {})
  };

  const totals = metrics.totals;
  totals.requests += 1;
  if (success) totals.successful += 1;
  else totals.failed += 1;
  if (logEntry.failover) totals.failovers += 1;
  totals.promptTokens += usage.promptTokens;
  totals.completionTokens += usage.completionTokens;
  totals.totalTokens += usage.totalTokens;

  for (const attempt of attempts) {
    const name = attempt.upstream;
    const item = metrics.byUpstream[name] || {
      requests: 0,
      successful: 0,
      failed: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0
    };
    item.requests += 1;
    if (attempt.status !== null && attempt.status >= 200 && attempt.status < 400) item.successful += 1;
    else item.failed += 1;
    if (attempt.upstream === logEntry.upstream) {
      item.promptTokens += usage.promptTokens;
      item.completionTokens += usage.completionTokens;
      item.totalTokens += usage.totalTokens;
    }
    metrics.byUpstream[name] = item;
  }

  logs.unshift(logEntry);
  if (logs.length > MAX_LOGS) logs.length = MAX_LOGS;
  appendLog(logEntry);
  saveMetrics();
  return logEntry;
}

function cloneLog(entry) {
  return {
    ...entry,
    attempts: Array.isArray(entry.attempts) ? entry.attempts.map((attempt) => ({ ...attempt })) : [],
    usage: { ...(entry.usage || {}) }
  };
}

function normalizeLimit(value) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LOG_LIMIT;
  return Math.min(parsed, MAX_LOG_LIMIT);
}

function normalizeOffset(value) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function getLogs({ limit, offset } = {}) {
  const normalizedLimit = normalizeLimit(limit);
  const normalizedOffset = normalizeOffset(offset);
  const slice = logs.slice(normalizedOffset, normalizedOffset + normalizedLimit);
  return {
    items: slice.map(cloneLog),
    limit: normalizedLimit,
    offset: normalizedOffset,
    total: logs.length,
    hasMore: normalizedOffset + slice.length < logs.length,
    maxLogs: MAX_LOGS
  };
}

function getMetrics(options = {}) {
  const logPage = getLogs(options);
  return {
    version: metrics.version,
    totals: { ...metrics.totals },
    byUpstream: Object.fromEntries(Object.entries(metrics.byUpstream).map(([name, value]) => [name, { ...value }])),
    logs: logPage.items,
    logPage: {
      limit: logPage.limit,
      offset: logPage.offset,
      total: logPage.total,
      hasMore: logPage.hasMore,
      maxLogs: logPage.maxLogs
    }
  };
}

function clearMetrics() {
  metrics = emptyMetrics();
  logs = [];
  logFileLines = 0;
  writeLogFile([]);
  saveMetrics();
  return getMetrics();
}

module.exports = {
  METRICS_PATH,
  LOG_PATH,
  recordRequest,
  getMetrics,
  getLogs,
  clearMetrics
};