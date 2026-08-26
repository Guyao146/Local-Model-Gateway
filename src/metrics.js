const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = process.env.LOCAL_MODEL_GATEWAY_DATA_DIR || path.join(__dirname, '..', 'data');
const METRICS_PATH = path.join(DATA_DIR, 'metrics.json');
const MAX_LOGS = 200;
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
    byUpstream: {},
    logs: []
  };
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function numberOrZero(value) {
  return Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0;
}

function loadMetrics() {
  ensureDataDir();
  if (!fs.existsSync(METRICS_PATH)) return emptyMetrics();
  try {
    const parsed = JSON.parse(fs.readFileSync(METRICS_PATH, 'utf8'));
    const defaults = emptyMetrics();
    return {
      version: 1,
      totals: { ...defaults.totals, ...(parsed.totals || {}) },
      byUpstream: parsed.byUpstream && typeof parsed.byUpstream === 'object' ? parsed.byUpstream : {},
      logs: Array.isArray(parsed.logs) ? parsed.logs.slice(0, MAX_LOGS) : []
    };
  } catch {
    // A corrupted metrics file should not prevent the gateway from starting.
    return emptyMetrics();
  }
}

let metrics = loadMetrics();

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

  metrics.logs.unshift(logEntry);
  metrics.logs = metrics.logs.slice(0, MAX_LOGS);
  saveMetrics();
  return logEntry;
}

function getMetrics() {
  return {
    version: metrics.version,
    totals: { ...metrics.totals },
    byUpstream: Object.fromEntries(Object.entries(metrics.byUpstream).map(([name, value]) => [name, { ...value }])),
    logs: metrics.logs.map((entry) => ({ ...entry, attempts: entry.attempts.map((attempt) => ({ ...attempt })), usage: { ...entry.usage } }))
  };
}

function clearMetrics() {
  metrics = emptyMetrics();
  saveMetrics();
  return getMetrics();
}

module.exports = {
  METRICS_PATH,
  recordRequest,
  getMetrics,
  clearMetrics
};