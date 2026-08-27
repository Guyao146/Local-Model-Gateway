const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  loadConfig,
  saveConfig,
  publicConfig,
  makeId,
  makeSecret,
  maskSecret,
  normalizeSettings
} = require('./config');
const {
  resolveEndpoint,
  openAIToAnthropic,
  anthropicToOpenAI,
  openAIResponseToAnthropic,
  anthropicResponseToOpenAI,
  responseInputToOpenAI,
  responsesResponseFromOpenAI,
  responsesResponseSkeleton,
  textFromContent
} = require('./protocol');
const { recordRequest, getMetrics, clearMetrics } = require('./metrics');
const { STRATEGIES, strategyFor, orderCandidates, resetRoutingState } = require('./routing');
const { createAdminAuth } = require('./admin-auth');
const { normalizeBalanceEndpoint, parseUpstreamBalance } = require('./balance');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const MAX_BODY_SIZE = 25 * 1024 * 1024;
const config = loadConfig();
const upstreamHealth = new Map();
const upstreamBalances = new Map();
const requestRateWindows = new Map();
let activeModelRequests = 0;

const ROUTE_STRATEGIES = STRATEGIES;
const THINKING_LEVELS = new Set(['auto', 'off', 'low', 'medium', 'high']);
const THINKING_BUDGETS = { low: 2048, medium: 4096, high: 8192 };

function nowIso() {
  return new Date().toISOString();
}

function log(message, details) {
  const suffix = details === undefined ? '' : ` ${JSON.stringify(details)}`;
  console.log(`[${nowIso()}] ${message}${suffix}`);
}

const adminAuth = createAdminAuth({ log });

function safeRecordRequest(entry) {
  try {
    recordRequest(entry);
  } catch (error) {
    log('metrics write failed', { message: error.message });
  }
}

function errorMessage(body, fallback = '上游请求失败') {
  return body?.error?.message || body?.message || fallback;
}

function isEqualSecret(left, right) {
  if (!left || !right || typeof left !== 'string' || typeof right !== 'string') return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...corsHeaders(),
    ...extraHeaders
  });
  res.end(body);
}

function sendJsonWithRequestId(res, statusCode, payload, requestId, extraHeaders = {}) {
  sendJson(res, statusCode, payload, { 'x-request-id': requestId, ...extraHeaders });
}

function sendText(res, statusCode, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    ...corsHeaders()
  });
  res.end(body);
}

function sendRedirect(res, location, extraHeaders = {}) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store', ...extraHeaders });
  res.end();
}

function validateLocalReturnTo(value) {
  const path = String(value || '/').trim();
  return path.startsWith('/') && !path.startsWith('//') && path.length <= 1000 ? path : '/';
}

function parsedHostname(host) {
  try { return new URL(`http://${String(host || '')}`).hostname.toLowerCase(); } catch { return ''; }
}

function isLoopbackHostname(hostname) {
  const normalized = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return true;
  if (normalized === '::1') return true;
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(normalized)) return false;
  return Number(normalized.split('.')[0]) === 127;
}

function configuredAdminOrigin() {
  try { return new URL(adminAuth.redirectUri).origin; } catch { return ''; }
}

function adminRequestIsSameOrigin(req, access) {
  const host = String(req.headers.host || '').toLowerCase();
  const hostname = parsedHostname(host);
  if (access.mode === 'local') {
    if (!isLoopbackHostname(hostname)) return false;
  } else {
    const publicOrigin = configuredAdminOrigin();
    if (!publicOrigin || host !== new URL(publicOrigin).host.toLowerCase()) return false;
  }
  if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return false;
  const origin = String(req.headers.origin || '').trim();
  if (origin) {
    try {
      if (access.mode === 'local') {
        const originUrl = new URL(origin);
        if (!isLoopbackHostname(originUrl.hostname) || originUrl.host.toLowerCase() !== host) return false;
      } else if (new URL(origin).origin !== configuredAdminOrigin()) return false;
    } catch {
      return false;
    }
  } else if (access.mode === 'oidc' && !['GET', 'HEAD'].includes(req.method)) {
    return false;
  }
  return true;
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-API-Key',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
  };
}

function getBearerToken(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

function getApiToken(req) {
  return req.headers['x-api-key'] || getBearerToken(req);
}

function sleep(milliseconds) {
  return milliseconds > 0 ? new Promise((resolve) => setTimeout(resolve, milliseconds)) : Promise.resolve();
}

function settingsFromBody(body, existing = config.settings) {
  const next = { ...existing, ...(body || {}) };
  if (next.host !== undefined && (typeof next.host !== 'string' || !next.host.trim())) {
    throw new Error('监听地址不能为空');
  }
  const ranges = [
    ['port', 1, 65535, '端口'],
    ['upstreamTimeoutMs', 1000, 3600000, '上游超时'],
    ['maxFallbackAttempts', 0, 12, '最大备用尝试次数'],
    ['retryDelayMs', 0, 30000, '重试等待时间'],
    ['circuitBreakerFailureThreshold', 1, 20, '熔断失败阈值'],
    ['circuitBreakerCooldownMs', 1000, 3600000, '熔断冷却时间'],
    ['maxConcurrentRequests', 0, 1000, '最大并发请求数'],
    ['requestsPerMinute', 0, 10000, '每 Key 每分钟请求数']
  ];
  for (const [key, min, max, label] of ranges) {
    if (next[key] === undefined) continue;
    const value = Number(next[key]);
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new Error(`${label}必须是 ${min} 到 ${max} 之间的整数`);
    }
    next[key] = value;
  }
  return normalizeSettings(next);
}

function findLocalKey(token) {
  if (!token) return null;
  return config.localApiKeys.find((item) => item.enabled !== false && isEqualSecret(item.key, token)) || null;
}

function healthFor(upstreamId) {
  if (!upstreamHealth.has(upstreamId)) {
    upstreamHealth.set(upstreamId, {
      consecutiveFailures: 0,
      state: 'closed',
      lastFailureAt: null,
      lastSuccessAt: null,
      openedAt: null,
      lastStatus: null,
      lastError: null
    });
  }
  return upstreamHealth.get(upstreamId);
}

function isCircuitOpen(upstream) {
  const health = healthFor(upstream.id);
  if (health.state !== 'open') return false;
  const cooldown = normalizeSettings(config.settings).circuitBreakerCooldownMs;
  if (!health.openedAt || Date.now() - health.openedAt >= cooldown) {
    health.state = 'half-open';
    return false;
  }
  return true;
}

function markUpstreamFailure(upstream, status, error) {
  const health = healthFor(upstream.id);
  health.consecutiveFailures += 1;
  health.lastFailureAt = nowIso();
  health.lastStatus = Number.isInteger(status) ? status : null;
  health.lastError = error ? String(error).slice(0, 300) : null;
  const settings = normalizeSettings(config.settings);
  if (health.consecutiveFailures >= settings.circuitBreakerFailureThreshold) {
    health.state = 'open';
    health.openedAt = Date.now();
  }
}

function markUpstreamSuccess(upstream) {
  const health = healthFor(upstream.id);
  health.consecutiveFailures = 0;
  health.state = 'closed';
  health.lastSuccessAt = nowIso();
  health.lastStatus = 200;
  health.lastError = null;
  health.openedAt = null;
}

function resetUpstreamHealth(upstreamId) {
  upstreamHealth.set(upstreamId, {
    consecutiveFailures: 0,
    state: 'closed',
    lastFailureAt: null,
    lastSuccessAt: null,
    openedAt: null,
    lastStatus: null,
    lastError: null
  });
  return upstreamHealth.get(upstreamId);
}

function publicUpstreamHealth() {
  return config.upstreams.map((upstream) => {
    const health = healthFor(upstream.id);
    const openUntil = health.state === 'open' && health.openedAt
      ? new Date(health.openedAt + normalizeSettings(config.settings).circuitBreakerCooldownMs).toISOString()
      : null;
    return {
      upstreamId: upstream.id,
      name: upstream.name,
      enabled: upstream.enabled !== false,
      state: health.state,
      consecutiveFailures: health.consecutiveFailures,
      lastFailureAt: health.lastFailureAt,
      lastSuccessAt: health.lastSuccessAt,
      openUntil,
      lastStatus: health.lastStatus,
      lastError: health.lastError
    };
  });
}

function publicUpstreamBalances() {
  return {
    items: config.upstreams.map((upstream) => upstreamBalances.get(upstream.id) || {
      upstreamId: upstream.id,
      name: upstream.name,
      state: 'idle',
      checkedAt: null,
      endpoint: null,
      httpStatus: null,
      balance: null,
      message: null
    })
  };
}

function requireAdmin(req, res) {
  const access = adminAuth.authenticate(req);
  if (access.ok) {
    if (!adminRequestIsSameOrigin(req, access)) {
      sendJson(res, 403, { error: { message: '管理请求来源不受信任', type: 'forbidden' } });
      return false;
    }
    req.adminAccess = access;
    return true;
  }
  const message = access.configured ? '远程管理访问需要通过 Authentik 登录' : adminAuth.configurationError();
  sendJson(res, access.configured ? 401 : 503, {
    error: {
      message,
      type: 'authentication_error',
      loginUrl: access.configured ? '/auth/oidc/login?returnTo=/' : null
    }
  });
  return false;
}

function requireApiKey(req, res) {
  const key = findLocalKey(getApiToken(req));
  if (key) return key;
  sendJson(res, 401, { error: { message: '需要有效的本地 API Key', type: 'authentication_error' } });
  return null;
}

function admitModelRequest(localKey) {
  const settings = normalizeSettings(config.settings);
  if (settings.maxConcurrentRequests > 0 && activeModelRequests >= settings.maxConcurrentRequests) {
    return { ok: false, message: '当前模型请求并发数已达到上限', retryAfter: 1 };
  }
  const now = Date.now();
  const windowMs = 60 * 1000;
  if (settings.requestsPerMinute > 0) {
    const previous = requestRateWindows.get(localKey.id) || [];
    const timestamps = previous.filter((timestamp) => timestamp > now - windowMs);
    if (timestamps.length >= settings.requestsPerMinute) {
      const retryAfter = Math.max(1, Math.ceil((timestamps[0] + windowMs - now) / 1000));
      requestRateWindows.set(localKey.id, timestamps);
      return { ok: false, message: '该本地 API Key 已达到每分钟请求上限', retryAfter };
    }
    timestamps.push(now);
    requestRateWindows.set(localKey.id, timestamps);
  }
  activeModelRequests += 1;
  let released = false;
  return {
    ok: true,
    release() {
      if (released) return;
      released = true;
      activeModelRequests = Math.max(0, activeModelRequests - 1);
    }
  };
}

function localKeyFromBody(body, existing = {}) {
  const name = String(body.name ?? existing.name ?? '本地 API Key').trim();
  if (!name) throw new Error('本地 API Key 名称不能为空');
  const key = existing.key || String(body.key || makeSecret('sk-local'));
  if (!key.trim()) throw new Error('本地 API Key 不能为空');
  return {
    id: existing.id || body.id || makeId('key'),
    name,
    key,
    enabled: body.enabled !== false,
    createdAt: existing.createdAt || nowIso(),
    updatedAt: nowIso()
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        reject(Object.assign(new Error('请求体过大'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('请求体必须是有效 JSON'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function normalizeModels(value) {
  if (Array.isArray(value)) return value.map((item) => typeof item === 'string' ? item : item?.id).map((item) => String(item || '').trim()).filter(Boolean);
  return String(value || '').split(/[,\n]/).map((item) => item.trim()).filter(Boolean);
}

function normalizeThinkingLevels(value) {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,\s]+/) : [];
  return [...new Set(values.map((item) => String(item).toLowerCase().trim()).filter((item) => ['low', 'medium', 'high'].includes(item)))];
}

function modelCapabilityMetadata(rawModel, existing = {}) {
  const raw = rawModel && typeof rawModel === 'object' ? rawModel : {};
  const capabilities = raw.capabilities && typeof raw.capabilities === 'object' ? raw.capabilities : {};
  const capabilityValues = [
    raw.reasoning_effort,
    raw.reasoningEffort,
    capabilities.reasoning_effort,
    capabilities.reasoningEffort
  ];
  const supportedParameters = [
    raw.supported_parameters,
    raw.supportedParameters,
    capabilities.supported_parameters,
    capabilities.supportedParameters
  ].flatMap((value) => Array.isArray(value) ? value : [])
    .concat(capabilityValues.flatMap((value) => Array.isArray(value) ? value : []))
    .map((value) => String(value).toLowerCase());
  const explicitThinking = raw.supports_thinking
    ?? raw.supportsThinking
    ?? raw.supports_reasoning
    ?? raw.supportsReasoning
    ?? raw.reasoning
    ?? raw.thinking
    ?? capabilities.thinking
    ?? capabilities.reasoning
    ?? capabilities.supports_thinking
    ?? capabilities.supportsThinking
    ?? capabilities.supports_reasoning
    ?? capabilities.supportsReasoning;
  const thinkingLevels = normalizeThinkingLevels(
    raw.thinking_levels
      ?? raw.thinkingLevels
      ?? raw.reasoning_effort
      ?? raw.reasoningEffort
      ?? raw.thinking?.levels
      ?? raw.thinking?.thinking_levels
      ?? raw.reasoning?.levels
      ?? raw.reasoning?.reasoning_effort
      ?? capabilities.thinking_levels
      ?? capabilities.thinkingLevels
      ?? capabilities.reasoning_effort
      ?? capabilities.reasoningEffort
      ?? capabilities.thinking?.levels
      ?? capabilities.thinking?.thinking_levels
      ?? capabilities.reasoning?.levels
      ?? capabilities.reasoning?.reasoning_effort
  );
  const hasThinkingParameter = supportedParameters.some((value) => value.includes('reasoning') || value.includes('thinking'));
  const thinkingObject = raw.thinking || capabilities.thinking;
  const reasoningObject = raw.reasoning || capabilities.reasoning;
  const objectDeclaresThinking = (thinkingObject && typeof thinkingObject === 'object') || (reasoningObject && typeof reasoningObject === 'object');
  const explicitBoolean = typeof explicitThinking === 'boolean' ? explicitThinking : null;
  const supportsThinking = explicitBoolean !== null
    ? explicitBoolean
    : (thinkingLevels.length || hasThinkingParameter || objectDeclaresThinking ? true : (existing.supportsThinking ?? null));
  return {
    supportsThinking: supportsThinking === true ? true : supportsThinking === false ? false : null,
    thinkingLevels: thinkingLevels.length ? thinkingLevels : (supportsThinking === true ? ['low', 'medium', 'high'] : (existing.thinkingLevels || [])),
    supportedParameters: [...new Set(supportedParameters)].slice(0, 30)
  };
}

function inferredThinkingCapability(id, protocol) {
  const normalized = String(id || '').toLowerCase().replace(/[^a-z0-9.-]/g, '');
  if (protocol === 'anthropic' && /claude[-.]?(3[-.]?7|4)([-.]|$)|claude[-.]?(sonnet|opus|haiku)[-.]?4/.test(normalized)) {
    return { supportsThinking: true, thinkingLevels: ['low', 'medium', 'high'] };
  }
  if (protocol === 'openai' && /(^|[-/.])(o1|o3|o4)([-/.]|$)|gpt[-.]?5/.test(normalized)) {
    return { supportsThinking: true, thinkingLevels: ['low', 'medium', 'high'] };
  }
  return { supportsThinking: null, thinkingLevels: [] };
}

function normalizeModelCatalog(value, existingCatalog = [], protocol) {
  const existingById = new Map((Array.isArray(existingCatalog) ? existingCatalog : []).map((item) => [item.id, item]));
  const rawItems = Array.isArray(value) ? value : normalizeModels(value).map((id) => ({ id }));
  const result = [];
  const seen = new Set();
  for (const rawItem of rawItems) {
    const raw = typeof rawItem === 'string' ? { id: rawItem } : rawItem;
    const id = String(raw?.id || raw?.name || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const existing = existingById.get(id) || {};
    const capability = modelCapabilityMetadata(raw, existing);
    const inferred = inferredThinkingCapability(id, protocol);
    const supportsThinking = capability.supportsThinking === null ? inferred.supportsThinking : capability.supportsThinking;
    result.push({
      id,
      name: String(raw.name || existing.name || id),
      ownedBy: String(raw.owned_by || raw.ownedBy || existing.ownedBy || ''),
      supportsThinking,
      thinkingLevels: capability.thinkingLevels.length ? capability.thinkingLevels : (supportsThinking === true ? inferred.thinkingLevels : []),
      supportedParameters: capability.supportedParameters,
      source: raw.source || existing.source || 'manual',
      syncedAt: raw.syncedAt || existing.syncedAt || null
    });
  }
  return result;
}

function catalogForUpstream(upstream) {
  const catalog = normalizeModelCatalog(upstream.modelCatalog || upstream.models || [], upstream.modelCatalog || [], upstream.protocol);
  const catalogIds = new Set(catalog.map((item) => item.id));
  for (const id of normalizeModels(upstream.models || [])) {
    if (!catalogIds.has(id)) {
      const inferred = inferredThinkingCapability(id, upstream.protocol);
      catalog.push({ id, name: id, ownedBy: '', supportsThinking: inferred.supportsThinking, thinkingLevels: inferred.thinkingLevels, supportedParameters: [], source: 'manual', syncedAt: null });
    }
  }
  return catalog;
}

function mergeModelCatalog(upstream, models) {
  const current = catalogForUpstream(upstream);
  const incoming = normalizeModelCatalog(models, current, upstream.protocol);
  const byId = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) byId.set(item.id, item);
  const merged = [...byId.values()];
  upstream.modelCatalog = merged;
  upstream.models = merged.map((item) => item.id);
  return merged;
}

function normalizeThinkingLevel(value, fallback = 'auto') {
  const level = String(value || '').toLowerCase().trim();
  return THINKING_LEVELS.has(level) ? level : fallback;
}

function modelSelectionKey(upstreamId, upstreamModel) {
  return `${upstreamId}:${upstreamModel}`;
}

function normalizeModelSelection(item, existing = {}) {
  const requestedMode = item?.upstreamMode ?? existing.upstreamMode;
  const upstreamMode = requestedMode === 'auto' ? 'auto' : 'fixed';
  const requestedIds = item?.upstreamIds !== undefined ? item.upstreamIds : existing.upstreamIds;
  const normalizedIds = (Array.isArray(requestedIds) ? requestedIds : [])
    .map((id) => String(id || '').trim())
    .filter((id, index, list) => id && list.indexOf(id) === index);
  const upstreamId = String(item?.upstreamId || normalizedIds[0] || existing.upstreamId || '').trim();
  const upstreamModel = String(item?.upstreamModel || existing.upstreamModel || '').trim();
  const localModel = String(item?.localModel || existing.localModel || upstreamModel).trim();
  if (!upstreamId || !upstreamModel || !localModel) throw new Error('模型选择必须包含上游、上游模型和本地模型名');
  const upstreamIds = upstreamMode === 'auto'
    ? [upstreamId, ...normalizedIds.filter((id) => id !== upstreamId)]
    : [upstreamId];
  return {
    id: existing.id || item.id || makeId('selection'),
    upstreamId,
    upstreamIds,
    upstreamMode,
    upstreamModel,
    localModel,
    thinkingLevel: normalizeThinkingLevel(item?.thinkingLevel ?? existing.thinkingLevel ?? 'auto'),
    enabled: item?.enabled !== false,
    managedRouteId: existing.managedRouteId || item.managedRouteId || null,
    createdAt: existing.createdAt || item.createdAt || nowIso(),
    updatedAt: nowIso()
  };
}

function modelEntryFor(upstream, modelId) {
  return catalogForUpstream(upstream).find((item) => item.id === modelId) || null;
}

function applyThinkingLevel(input, thinkingLevel, upstream, modelEntry) {
  const result = { ...(input || {}) };
  delete result.thinkingLevel;
  const level = normalizeThinkingLevel(thinkingLevel, 'auto');
  const hasExplicitThinking = result.reasoning_effort !== undefined || result.thinking !== undefined;
  if (hasExplicitThinking || level === 'auto' || level === 'off' || modelEntry?.supportsThinking === false) return result;
  if (upstream.protocol === 'anthropic') {
    result.thinking = { type: 'enabled', budget_tokens: THINKING_BUDGETS[level] || THINKING_BUDGETS.medium };
    const minimumMaxTokens = result.thinking.budget_tokens + 1024;
    if (Number(result.max_tokens || 0) < minimumMaxTokens) result.max_tokens = minimumMaxTokens;
  } else {
    result.reasoning_effort = level;
  }
  return result;
}

function publicModelCatalog() {
  const selections = config.modelSelections || [];
  return {
    upstreams: config.upstreams.map((upstream) => ({
      id: upstream.id,
      name: upstream.name,
      protocol: upstream.protocol,
      enabled: upstream.enabled !== false,
      modelsSyncedAt: upstream.modelsSyncedAt || null,
      models: catalogForUpstream(upstream).map((model) => ({
        ...model,
        selection: selections.find((item) => item.enabled !== false && (item.upstreamIds || [item.upstreamId]).includes(upstream.id) && item.upstreamModel === model.id) || null
      }))
    })),
    selections,
    selectionMode: config.modelSelectionMode === true
  };
}

function saveModelSelections(rawSelections) {
  if (!Array.isArray(rawSelections)) throw new Error('模型选择必须是数组');
  const previousByModel = new Map();
  for (const item of config.modelSelections || []) {
    if (!previousByModel.has(item.upstreamModel)) previousByModel.set(item.upstreamModel, item);
  }
  const selections = [];
  const usedLocalModels = new Set();
  const usedUpstreamModels = new Set();
  const managedRoutesBySelection = new Map(
    config.routes.filter((item) => item.managedBy === 'model-selector').map((item) => [item.selectionId || modelSelectionKey(item.upstreamId, item.upstreamModel), item])
  );

  for (const raw of rawSelections) {
    if (raw?.enabled === false) continue;
    const upstreamModel = String(raw?.upstreamModel || '').trim();
    if (!upstreamModel) throw new Error('模型选择缺少模型 ID');
    if (usedUpstreamModels.has(upstreamModel)) throw new Error(`模型重复选择：${upstreamModel}`);
    const previous = previousByModel.get(upstreamModel) || {};
    const selection = normalizeModelSelection({ ...raw, upstreamModel, enabled: true }, previous);
    const selectedUpstreams = selection.upstreamIds.map((upstreamId) => {
      const upstream = config.upstreams.find((item) => item.id === upstreamId);
      if (!upstream) throw new Error(`模型选择引用了不存在的上游：${upstreamId}`);
      if (!modelEntryFor(upstream, upstreamModel)) throw new Error(`上游 ${upstream.name} 中不存在模型：${upstreamModel}`);
      return upstream;
    });
    if (selection.upstreamMode === 'auto' && selectedUpstreams.length < 2) selection.upstreamMode = 'fixed';
    if (usedLocalModels.has(selection.localModel)) throw new Error(`本地模型名重复：${selection.localModel}`);
    const conflictingManualRoute = config.routes.find((item) => item.managedBy !== 'model-selector' && item.localModel === selection.localModel);
    if (conflictingManualRoute) throw new Error(`本地模型名与手工路由冲突：${selection.localModel}`);
    const oldRoute = selection.managedRouteId ? config.routes.find((item) => item.id === selection.managedRouteId) : managedRoutesBySelection.get(selection.id) || managedRoutesBySelection.get(modelSelectionKey(selection.upstreamId, upstreamModel));
    const fallbackUpstreamIds = selection.upstreamMode === 'auto' ? selection.upstreamIds.slice(1) : [];
    const upstreamWeights = Object.fromEntries(selection.upstreamIds.map((id) => [id, 1]));
    const route = buildRoute({
      id: oldRoute?.id,
      localModel: selection.localModel,
      upstreamId: selection.upstreamId,
      upstreamModel,
      thinkingLevel: selection.thinkingLevel,
      strategy: selection.upstreamMode === 'auto' ? 'round_robin' : 'failover',
      fallbackUpstreamIds,
      upstreamWeights,
      enabled: true,
      managedBy: 'model-selector',
      selectionId: selection.id
    }, oldRoute || {}, config.upstreams, config.routes);
    selection.managedRouteId = route.id;
    selection.updatedAt = nowIso();
    selections.push(selection);
    usedLocalModels.add(selection.localModel);
    usedUpstreamModels.add(selection.upstreamModel);
    managedRoutesBySelection.delete(selection.id);
    managedRoutesBySelection.delete(modelSelectionKey(selection.upstreamId, upstreamModel));
    const routeIndex = config.routes.findIndex((item) => item.id === route.id);
    if (routeIndex >= 0) config.routes[routeIndex] = route;
    else config.routes.push(route);
  }

  const selectedRouteIds = new Set(selections.map((item) => item.managedRouteId));
  config.routes = config.routes.filter((item) => item.managedBy !== 'model-selector' || selectedRouteIds.has(item.id));
  config.modelSelections = selections;
  config.modelSelectionMode = true;
  resetRoutingState();
  saveConfig(config);
  return publicModelCatalog();
}

function validateBaseUrl(value) {
  const url = new URL(String(value || ''));
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('上游地址必须使用 http 或 https');
  return url.toString().replace(/\/$/, '');
}

function upstreamFromBody(body, existing = {}) {
  if (!body.name || !body.baseUrl) throw new Error('上游名称和地址不能为空');
  const protocol = body.protocol === 'anthropic' ? 'anthropic' : 'openai';
  const authType = body.authType === 'x-api-key' || body.authType === 'none'
    ? body.authType
    : (protocol === 'anthropic' ? 'x-api-key' : 'bearer');
  const apiKey = body.apiKey && !body.apiKey.includes('••••') ? String(body.apiKey) : existing.apiKey;
  if (!apiKey && authType !== 'none') throw new Error('上游 API Key 不能为空');
  const balanceEndpoint = normalizeBalanceEndpoint(
    body.balanceEndpoint !== undefined ? body.balanceEndpoint : existing.balanceEndpoint
  );
  const catalogInput = body.modelCatalog !== undefined
    ? body.modelCatalog
    : existing.modelCatalog !== undefined
      ? existing.modelCatalog
      : body.models;
  return {
    id: existing.id || body.id || makeId('up'),
    name: String(body.name).trim(),
    baseUrl: validateBaseUrl(body.baseUrl),
    apiKey,
    protocol,
    authType,
    models: normalizeModels(body.models),
    modelCatalog: normalizeModelCatalog(catalogInput, existing.modelCatalog, protocol),
    ...(balanceEndpoint ? { balanceEndpoint } : {}),
    enabled: body.enabled !== false,
    createdAt: existing.createdAt || nowIso(),
    updatedAt: nowIso(),
    ...(body.modelsSyncedAt || existing.modelsSyncedAt ? { modelsSyncedAt: body.modelsSyncedAt || existing.modelsSyncedAt } : {})
  };
}

function routeFromBody(body, existing = {}) {
  return buildRoute(body, existing, config.upstreams, config.routes);
}

function buildRoute(body, existing = {}, availableUpstreams, existingRoutes) {
  if (!body.localModel || !body.upstreamId) throw new Error('本地模型名和上游不能为空');
  const localModel = String(body.localModel).trim();
  const upstreamId = String(body.upstreamId).trim();
  if (!localModel || !upstreamId) throw new Error('本地模型名和上游不能为空');
  if (!availableUpstreams.some((item) => item.id === upstreamId)) throw new Error('指定的上游不存在');
  const routeId = existing.id || body.id;
  if (routeId && existingRoutes.some((item) => item.id === routeId && item.id !== existing.id)) {
    throw new Error(`路由 ID 已存在：${routeId}`);
  }
  if (existingRoutes.some((item) => item.id !== existing.id && item.localModel === localModel)) {
    throw new Error(`本地模型路由已存在：${localModel}`);
  }
  const strategy = body.strategy ?? existing.strategy ?? 'failover';
  if (!ROUTE_STRATEGIES.has(strategy)) throw new Error(`不支持的路由策略：${strategy}`);
  const thinkingLevel = normalizeThinkingLevel(body.thinkingLevel ?? existing.thinkingLevel ?? 'auto');
  const fallbackValue = body.fallbackUpstreamIds !== undefined
    ? body.fallbackUpstreamIds
    : (existing.fallbackUpstreamIds || []);
  const fallbackUpstreamIds = (Array.isArray(fallbackValue) ? fallbackValue : normalizeModels(fallbackValue))
    .map((id) => String(id).trim())
    .filter((id, index, list) => id && id !== upstreamId && list.indexOf(id) === index);
  for (const id of fallbackUpstreamIds) {
    if (!availableUpstreams.some((item) => item.id === id)) throw new Error(`备用上游不存在：${id}`);
  }
  let weightSource = body.upstreamWeights ?? existing.upstreamWeights ?? {};
  if (typeof weightSource === 'string') {
    try { weightSource = JSON.parse(weightSource); } catch { throw new Error('上游权重必须是有效 JSON'); }
  }
  if (!weightSource || typeof weightSource !== 'object' || Array.isArray(weightSource)) {
    throw new Error('上游权重必须是对象');
  }
  const upstreamWeights = {};
  for (const id of [upstreamId, ...fallbackUpstreamIds]) {
    const value = weightSource[id] === undefined ? 1 : Number(weightSource[id]);
    if (!Number.isInteger(value) || value < 1 || value > 1000) {
      throw new Error(`上游 ${id} 的权重必须是 1 到 1000 之间的整数`);
    }
    upstreamWeights[id] = value;
  }
  return {
    id: routeId || makeId('route'),
    localModel,
    upstreamId,
    upstreamModel: String(body.upstreamModel || existing.upstreamModel || body.localModel).trim(),
    fallbackUpstreamIds,
    strategy,
    upstreamWeights,
    thinkingLevel,
    ...(body.managedBy ? { managedBy: String(body.managedBy) } : {}),
    ...(body.selectionId ? { selectionId: String(body.selectionId) } : {}),
    enabled: body.enabled !== false,
    createdAt: existing.createdAt || nowIso(),
    updatedAt: nowIso()
  };
}

function exposeNewKey(item) {
  return { ...item };
}

function listModels() {
  const models = new Map();
  for (const route of config.routes.filter((item) => item.enabled !== false)) {
    if (route.localModel !== '*') models.set(route.localModel, route.localModel);
  }
  if (config.modelSelectionMode !== true) {
    for (const upstream of config.upstreams.filter((item) => item.enabled !== false)) {
    }
  }
  for (const selection of config.modelSelections || []) {
    if (selection.enabled !== false && selection.localModel) models.set(selection.localModel, selection.localModel);
  }
  return [...models.keys()].map((id) => ({ id, object: 'model', created: 0, owned_by: 'local-model-gateway' }));
}

function chooseRoute(model) {
  const exact = config.routes.find((item) => item.enabled !== false && item.localModel === model);
  const wildcard = config.routes.find((item) => item.enabled !== false && item.localModel === '*');
  const route = exact || wildcard;
  if (route) {
    const ids = [route.upstreamId, ...(route.fallbackUpstreamIds || [])];
    const candidates = ids
      .map((id) => config.upstreams.find((item) => item.id === id && item.enabled !== false))
      .filter((item) => item && !isCircuitOpen(item))
      .filter(Boolean);
    return { route, upstreams: orderCandidates(route, candidates), upstreamModel: route.upstreamModel, strategy: strategyFor(route) };
  }
  const matching = config.upstreams.filter((item) => item.enabled !== false && (item.models || []).includes(model) && !isCircuitOpen(item));
  if (matching.length) return { route: null, upstreams: matching, upstreamModel: model, strategy: 'failover' };
  const enabled = config.upstreams.filter((item) => item.enabled !== false && !isCircuitOpen(item));
  if (enabled.length === 1) return { route: null, upstreams: enabled, upstreamModel: model, strategy: 'failover' };
  return { route: null, upstreams: [], strategy: 'failover' };
}

function upstreamHeaders(upstream, requestId) {
  const headers = {
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json'
  };
  if (upstream.authType === 'x-api-key') headers['x-api-key'] = upstream.apiKey;
  if (upstream.authType === 'bearer') headers.Authorization = `Bearer ${upstream.apiKey}`;
  if (upstream.protocol === 'anthropic') headers['anthropic-version'] = '2023-06-01';
  if (requestId) headers['x-request-id'] = requestId;
  return headers;
}

function safeModel(input, fallback) {
  return String(input?.model || fallback || '').trim();
}

function requestIdFromRequest(req) {
  const supplied = String(req.headers['x-request-id'] || '').trim();
  return /^[A-Za-z0-9._:-]{1,120}$/.test(supplied) ? supplied : `req_${crypto.randomBytes(8).toString('hex')}`;
}

function makeUpstreamRequest(localInput, localProtocol, upstream, upstreamModel, requestId) {
  const model = upstreamModel || safeModel(localInput);
  const modelEntry = modelEntryFor(upstream, model);
  const thinkingLevel = localInput.thinkingLevel || 'auto';
  const inputWithThinking = applyThinkingLevel(localInput, thinkingLevel, upstream, modelEntry);
  const openAIInput = localProtocol === 'responses' ? responseInputToOpenAI(inputWithThinking, model) : inputWithThinking;
  let body;
  if (localProtocol === upstream.protocol) {
    body = { ...inputWithThinking, model };
  } else if (upstream.protocol === 'anthropic') {
    body = openAIToAnthropic(openAIInput, model);
  } else {
    body = localProtocol === 'anthropic' ? anthropicToOpenAI(inputWithThinking, model) : { ...openAIInput, model };
  }
  return {
    endpoint: resolveEndpoint(upstream.baseUrl, upstream.protocol === 'anthropic' ? '/v1/messages' : '/v1/chat/completions'),
    body,
    headers: upstreamHeaders(upstream, requestId)
  };
}

async function fetchUpstream(requestInfo) {
  const controller = new AbortController();
  const timeoutMs = normalizeSettings(config.settings).upstreamTimeoutMs;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(requestInfo.endpoint, {
      method: 'POST',
      headers: requestInfo.headers,
      body: JSON.stringify(requestInfo.body),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithTimeout(url, options, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readResponseJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { error: { message: text || `上游返回 HTTP ${response.status}`, type: 'upstream_error' } };
  }
}

function errorForProtocol(localProtocol, body, status) {
  if (localProtocol === 'anthropic') {
    const message = body?.error?.message || body?.message || `上游返回 HTTP ${status}`;
    return { type: 'error', error: { type: 'api_error', message } };
  }
  return body?.error ? body : { error: { message: body?.message || `上游返回 HTTP ${status}`, type: 'upstream_error' } };
}

function shouldRetryUpstream(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function writeSse(res, data, eventName) {
  if (eventName) res.write(`event: ${eventName}\n`);
  res.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
}

async function consumeSse(response, onEvent) {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const flush = async (frame) => {
    const event = { name: '', data: '' };
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith('event:')) event.name = line.slice(6).trim();
      if (line.startsWith('data:')) event.data += (event.data ? '\n' : '') + line.slice(5).trimStart();
    }
    if (event.data) await onEvent(event);
  };
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() || '';
    for (const frame of frames) await flush(frame);
    if (done) break;
  }
  if (buffer.trim()) await flush(buffer);
}

async function pipeRawStream(response, res) {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const usage = {};
  const inspectFrame = (frame) => {
    let data = '';
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith('data:')) data += (data ? '\n' : '') + line.slice(5).trimStart();
    }
    if (!data || data === '[DONE]') return;
    try {
      const parsed = JSON.parse(data);
      const eventUsage = parsed.usage || parsed.message?.usage;
      if (eventUsage) Object.assign(usage, eventUsage);
    } catch {
      // A non-JSON SSE comment or provider-specific event does not affect forwarding.
    }
  };
  const inspectText = (text) => {
    buffer += text;
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() || '';
    for (const frame of frames) inspectFrame(frame);
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));
    inspectText(decoder.decode(value, { stream: true }));
  }
  inspectText(decoder.decode());
  if (buffer.trim()) inspectFrame(buffer);
  res.end();
  return Object.keys(usage).length ? usage : undefined;
}

function openAIChunk(model, id, delta, finishReason = null, usage) {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage ? { usage } : {})
  };
}

async function anthropicStreamAsOpenAI(response, res, model) {
  const id = `chatcmpl_${crypto.randomBytes(8).toString('hex')}`;
  let started = false;
  let stopped = false;
  const usage = { input_tokens: 0, output_tokens: 0 };
  let toolIndex = 0;
  const toolIndexes = new Map();
  const ensureStarted = () => {
    if (!started) {
      writeSse(res, openAIChunk(model, id, { role: 'assistant' }));
      started = true;
    }
  };
  await consumeSse(response, async ({ name, data }) => {
    if (data === '[DONE]') return;
    let parsed;
    try { parsed = JSON.parse(data); } catch { return; }
    const eventName = name || parsed.type;
    if (eventName === 'message_start') {
      usage.input_tokens = parsed.message?.usage?.input_tokens || 0;
      ensureStarted();
    } else if (eventName === 'content_block_start') {
      ensureStarted();
      const block = parsed.content_block || {};
      if (block.type === 'tool_use') {
        const index = toolIndex++;
        toolIndexes.set(parsed.index ?? index, index);
        writeSse(res, openAIChunk(model, id, {
          tool_calls: [{ index, id: block.id, type: 'function', function: { name: block.name, arguments: '' } }]
        }));
      }
    } else if (eventName === 'content_block_delta') {
      ensureStarted();
      const delta = parsed.delta || {};
      if (delta.type === 'text_delta') {
        writeSse(res, openAIChunk(model, id, { content: delta.text || '' }));
      } else if (delta.type === 'input_json_delta') {
        const index = toolIndexes.get(parsed.index) ?? 0;
        writeSse(res, openAIChunk(model, id, {
          tool_calls: [{ index, function: { arguments: delta.partial_json || '' } }]
        }));
      }
    } else if (eventName === 'message_delta') {
      ensureStarted();
      const stop = parsed.delta?.stop_reason;
      usage.output_tokens = parsed.usage?.output_tokens || usage.output_tokens;
      const finish = stop === 'tool_use' ? 'tool_calls' : (stop === 'max_tokens' ? 'length' : (stop ? 'stop' : null));
      if (finish || parsed.usage) {
        writeSse(res, openAIChunk(model, id, {}, finish, parsed.usage ? {
          prompt_tokens: 0,
          completion_tokens: parsed.usage.output_tokens || 0,
          total_tokens: parsed.usage.output_tokens || 0
        } : undefined));
      }
    } else if (eventName === 'message_stop') {
      ensureStarted();
      writeSse(res, '[DONE]');
      stopped = true;
    }
  });
  if (!stopped && !res.writableEnded) {
    ensureStarted();
    writeSse(res, '[DONE]');
    res.end();
  } else if (!res.writableEnded) {
    res.end();
  }
  return usage;
}

async function openAIStreamAsAnthropic(response, res, model) {
  const id = `msg_${crypto.randomBytes(8).toString('hex')}`;
  let started = false;
  let blockOpen = false;
  let toolBlockIndex = 0;
  let stopped = false;
  const usage = { prompt_tokens: 0, completion_tokens: 0 };
  const sendStart = () => {
    if (started) return;
    started = true;
    writeSse(res, {
      type: 'message_start',
      message: {
        id,
        type: 'message',
        role: 'assistant',
        content: [],
        model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    }, 'message_start');
  };
  await consumeSse(response, async ({ data }) => {
    if (data === '[DONE]') {
      sendStart();
      if (blockOpen) writeSse(res, { type: 'content_block_stop', index: toolBlockIndex }, 'content_block_stop');
      writeSse(res, { type: 'message_stop' }, 'message_stop');
      stopped = true;
      return;
    }
    let parsed;
    try { parsed = JSON.parse(data); } catch { return; }
    sendStart();
    if (parsed.usage) {
      usage.prompt_tokens = parsed.usage.prompt_tokens || usage.prompt_tokens;
      usage.completion_tokens = parsed.usage.completion_tokens || usage.completion_tokens;
    }
    const chunk = parsed.choices?.[0] || {};
    const delta = chunk.delta || {};
    if (delta.content) {
      if (!blockOpen) {
        writeSse(res, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, 'content_block_start');
        blockOpen = true;
        toolBlockIndex = 0;
      }
      writeSse(res, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: delta.content } }, 'content_block_delta');
    }
    for (const tool of delta.tool_calls || []) {
      const index = tool.index || 0;
      if (tool.id || tool.function?.name) {
        if (blockOpen) writeSse(res, { type: 'content_block_stop', index: toolBlockIndex }, 'content_block_stop');
        toolBlockIndex = index;
        blockOpen = true;
        writeSse(res, {
          type: 'content_block_start',
          index,
          content_block: { type: 'tool_use', id: tool.id || `tool_${index}`, name: tool.function?.name || '' }
        }, 'content_block_start');
      }
      if (tool.function?.arguments) {
        writeSse(res, {
          type: 'content_block_delta',
          index,
          delta: { type: 'input_json_delta', partial_json: tool.function.arguments }
        }, 'content_block_delta');
      }
    }
    if (chunk.finish_reason) {
      if (blockOpen) {
        writeSse(res, { type: 'content_block_stop', index: toolBlockIndex }, 'content_block_stop');
        blockOpen = false;
      }
      const stopReason = chunk.finish_reason === 'tool_calls' ? 'tool_use' : (chunk.finish_reason === 'length' ? 'max_tokens' : 'end_turn');
      writeSse(res, { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: parsed.usage?.completion_tokens || 0 } }, 'message_delta');
    }
  });
  if (!stopped && !res.writableEnded) {
    sendStart();
    if (blockOpen) writeSse(res, { type: 'content_block_stop', index: toolBlockIndex }, 'content_block_stop');
    writeSse(res, { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } }, 'message_delta');
    writeSse(res, { type: 'message_stop' }, 'message_stop');
    res.end();
  } else if (!res.writableEnded) {
    res.end();
  }
  return usage;
}

function makeResponsesMessage(id, model, text, status = 'in_progress') {
  return {
    id,
    type: 'message',
    status,
    role: 'assistant',
    content: text ? [{ type: 'output_text', text, annotations: [] }] : []
  };
}

async function openAIStreamAsResponses(response, res, model) {
  const responseId = `resp_${crypto.randomBytes(8).toString('hex')}`;
  const messageId = `msg_${crypto.randomBytes(8).toString('hex')}`;
  let started = false;
  let text = '';
  let finishReason = 'stop';
  let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const start = () => {
    if (started) return;
    started = true;
    writeSse(res, { type: 'response.created', response: responsesResponseSkeleton(responseId, model) }, 'response.created');
    writeSse(res, { type: 'response.output_item.added', response_id: responseId, output_index: 0, item: makeResponsesMessage(messageId, model, '') }, 'response.output_item.added');
    writeSse(res, { type: 'response.content_part.added', response_id: responseId, item_id: messageId, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }, 'response.content_part.added');
  };
  await consumeSse(response, async ({ data }) => {
    if (data === '[DONE]') {
      start();
      return;
    }
    let parsed;
    try { parsed = JSON.parse(data); } catch { return; }
    start();
    const choice = parsed.choices?.[0] || {};
    const delta = choice.delta || {};
    if (delta.content) {
      text += delta.content;
      writeSse(res, { type: 'response.output_text.delta', response_id: responseId, item_id: messageId, output_index: 0, content_index: 0, delta: delta.content }, 'response.output_text.delta');
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
    if (parsed.usage) {
      usage = {
        prompt_tokens: parsed.usage.prompt_tokens || 0,
        completion_tokens: parsed.usage.completion_tokens || 0,
        total_tokens: parsed.usage.total_tokens || (parsed.usage.prompt_tokens || 0) + (parsed.usage.completion_tokens || 0)
      };
    }
  });
  start();
  const completedResponse = {
    ...responsesResponseSkeleton(responseId, model),
    status: 'completed',
    output: [makeResponsesMessage(messageId, model, text, 'completed')],
    output_text: text,
    usage: { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens, total_tokens: usage.total_tokens }
  };
  writeSse(res, { type: 'response.output_text.done', response_id: responseId, item_id: messageId, output_index: 0, content_index: 0, text }, 'response.output_text.done');
  writeSse(res, { type: 'response.content_part.done', response_id: responseId, item_id: messageId, output_index: 0, content_index: 0, part: { type: 'output_text', text, annotations: [] } }, 'response.content_part.done');
  writeSse(res, { type: 'response.output_item.done', response_id: responseId, output_index: 0, item: makeResponsesMessage(messageId, model, text, 'completed') }, 'response.output_item.done');
  writeSse(res, { type: 'response.completed', response: completedResponse }, 'response.completed');
  if (!res.writableEnded) res.end();
  return usage;
}

async function anthropicStreamAsResponses(response, res, model) {
  const responseId = `resp_${crypto.randomBytes(8).toString('hex')}`;
  const messageId = `msg_${crypto.randomBytes(8).toString('hex')}`;
  let started = false;
  let text = '';
  let usage = { input_tokens: 0, output_tokens: 0 };
  const start = () => {
    if (started) return;
    started = true;
    writeSse(res, { type: 'response.created', response: responsesResponseSkeleton(responseId, model) }, 'response.created');
    writeSse(res, { type: 'response.output_item.added', response_id: responseId, output_index: 0, item: makeResponsesMessage(messageId, model, '') }, 'response.output_item.added');
    writeSse(res, { type: 'response.content_part.added', response_id: responseId, item_id: messageId, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }, 'response.content_part.added');
  };
  await consumeSse(response, async ({ name, data }) => {
    if (data === '[DONE]') return;
    let parsed;
    try { parsed = JSON.parse(data); } catch { return; }
    const eventName = name || parsed.type;
    if (eventName === 'message_start') {
      start();
      usage.input_tokens = parsed.message?.usage?.input_tokens || 0;
    } else if (eventName === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
      start();
      text += parsed.delta.text || '';
      writeSse(res, { type: 'response.output_text.delta', response_id: responseId, item_id: messageId, output_index: 0, content_index: 0, delta: parsed.delta.text || '' }, 'response.output_text.delta');
    } else if (eventName === 'message_delta') {
      usage.output_tokens = parsed.usage?.output_tokens || usage.output_tokens;
    }
  });
  start();
  const completedResponse = {
    ...responsesResponseSkeleton(responseId, model),
    status: 'completed',
    output: [makeResponsesMessage(messageId, model, text, 'completed')],
    output_text: text,
    usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, total_tokens: usage.input_tokens + usage.output_tokens }
  };
  writeSse(res, { type: 'response.output_text.done', response_id: responseId, item_id: messageId, output_index: 0, content_index: 0, text }, 'response.output_text.done');
  writeSse(res, { type: 'response.content_part.done', response_id: responseId, item_id: messageId, output_index: 0, content_index: 0, part: { type: 'output_text', text, annotations: [] } }, 'response.content_part.done');
  writeSse(res, { type: 'response.output_item.done', response_id: responseId, output_index: 0, item: makeResponsesMessage(messageId, model, text, 'completed') }, 'response.output_item.done');
  writeSse(res, { type: 'response.completed', response: completedResponse }, 'response.completed');
  if (!res.writableEnded) res.end();
  return { prompt_tokens: usage.input_tokens, completion_tokens: usage.output_tokens, total_tokens: usage.input_tokens + usage.output_tokens };
}

async function forwardModelRequest(req, res, localProtocol, input, suppliedRequestId) {
  const requestId = suppliedRequestId || requestIdFromRequest(req);
  const startedAt = nowIso();
  const startedTime = Date.now();
  const localModel = safeModel(input);
  const wantsStream = Boolean(input.stream);
  const attempts = [];
  let selectedStrategy = 'failover';
  const finishMetrics = (details) => safeRecordRequest({
    id: requestId,
    startedAt,
    finishedAt: nowIso(),
    durationMs: Date.now() - startedTime,
    protocol: localProtocol,
    model: localModel,
    strategy: selectedStrategy,
    stream: wantsStream,
    attempts,
    ...details
  });
  if (!localModel) {
    finishMetrics({ success: false, status: 400, error: 'model 不能为空' });
    sendJsonWithRequestId(res, 400, errorForProtocol(localProtocol, { message: 'model 不能为空' }, 400), requestId);
    return;
  }
  const selected = chooseRoute(localModel);
  selectedStrategy = selected.strategy || 'failover';
  const upstreams = selected.upstreams || [];
  if (!upstreams.length) {
    finishMetrics({ success: false, status: 404, error: `没有找到模型 ${localModel} 的可用上游` });
    sendJsonWithRequestId(res, 404, errorForProtocol(localProtocol, { message: `没有找到模型 ${localModel} 的可用上游，请先在后台配置路由` }, 404), requestId);
    return;
  }
  const upstreamModel = selected.route?.upstreamModel || selected.upstreamModel || localModel;
  const routeThinkingLevel = selected.route?.thinkingLevel || 'auto';
  const settings = normalizeSettings(config.settings);
  const maxAttempts = settings.maxFallbackAttempts > 0
    ? Math.min(upstreams.length, 1 + settings.maxFallbackAttempts)
    : upstreams.length;
  let upstreamResponse = null;
  let upstream = null;
  let lastError = null;

  for (let index = 0; index < maxAttempts; index += 1) {
    upstream = upstreams[index];
    const requestInput = routeThinkingLevel === 'auto' && input.thinkingLevel === undefined
      ? input
      : { ...input, thinkingLevel: input.thinkingLevel ?? routeThinkingLevel };
    const requestInfo = makeUpstreamRequest(requestInput, localProtocol, upstream, upstreamModel, requestId);
    log('route request', {
      localProtocol,
      model: localModel,
      upstream: upstream.name,
      upstreamModel,
      stream: wantsStream,
      attempt: index + 1,
      totalCandidates: upstreams.length
    });
    try {
      upstreamResponse = await fetchUpstream(requestInfo);
    } catch (error) {
      const message = error.name === 'AbortError' ? '上游请求超时' : `无法连接上游：${error.message}`;
      attempts.push({ upstream: upstream.name, status: 502 });
      markUpstreamFailure(upstream, 502, message);
      lastError = { status: 502, body: { message } };
      if (index < maxAttempts - 1) {
        log('upstream unavailable, trying fallback', { upstream: upstream.name, message });
        await sleep(settings.retryDelayMs);
        continue;
      }
      break;
    }

    attempts.push({ upstream: upstream.name, status: upstreamResponse.status });
    if (upstreamResponse.ok) {
      markUpstreamSuccess(upstream);
      break;
    }

    const body = await readResponseJson(upstreamResponse);
    lastError = { status: upstreamResponse.status, body };
    if (shouldRetryUpstream(upstreamResponse.status)) markUpstreamFailure(upstream, upstreamResponse.status, errorMessage(body));
    if (shouldRetryUpstream(upstreamResponse.status) && index < maxAttempts - 1) {
      log('upstream returned retryable status, trying fallback', { upstream: upstream.name, status: upstreamResponse.status });
      await sleep(settings.retryDelayMs);
      continue;
    }
    break;
  }

  if (!upstreamResponse || !upstreamResponse.ok) {
    const failure = lastError || { status: 502, body: { message: '所有上游都不可用' } };
    finishMetrics({
      success: false,
      status: failure.status,
      upstream: upstream?.name,
      upstreamModel,
      error: errorMessage(failure.body, '所有上游都不可用')
    });
    sendJsonWithRequestId(res, failure.status, errorForProtocol(localProtocol, failure.body, failure.status), requestId);
    return;
  }

  if (!wantsStream) {
    const body = await readResponseJson(upstreamResponse);
    let result;
    if (localProtocol === upstream.protocol) {
      result = { ...body, model: localModel };
    } else if (localProtocol === 'responses') {
      const openAIResult = upstream.protocol === 'anthropic'
        ? anthropicResponseToOpenAI(body, localModel)
        : { ...body, model: localModel };
      result = responsesResponseFromOpenAI(openAIResult, localModel);
    } else if (localProtocol === 'openai') {
      result = anthropicResponseToOpenAI(body, localModel);
    } else {
      result = openAIResponseToAnthropic(body, localModel);
    }
    finishMetrics({ success: true, status: 200, upstream: upstream.name, upstreamModel, usage: result.usage || body.usage });
    sendJsonWithRequestId(res, 200, result, requestId);
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'x-request-id': requestId,
    ...corsHeaders()
  });
  try {
    let streamUsage;
    if (localProtocol === upstream.protocol) streamUsage = await pipeRawStream(upstreamResponse, res);
    else if (localProtocol === 'openai') streamUsage = await anthropicStreamAsOpenAI(upstreamResponse, res, localModel);
    else if (localProtocol === 'responses') {
      streamUsage = upstream.protocol === 'anthropic'
        ? await anthropicStreamAsResponses(upstreamResponse, res, localModel)
        : await openAIStreamAsResponses(upstreamResponse, res, localModel);
    }
    else streamUsage = await openAIStreamAsAnthropic(upstreamResponse, res, localModel);
    finishMetrics({ success: true, status: 200, upstream: upstream.name, upstreamModel, usage: streamUsage });
  } catch (error) {
    log('stream error', { message: error.message });
    finishMetrics({ success: false, status: 502, upstream: upstream.name, upstreamModel, error: error.message });
    if (!res.writableEnded) {
      writeSse(res, { error: { message: error.message, type: 'upstream_error' } });
      res.end();
    }
  }
}

async function testUpstream(upstream) {
  const isAnthropic = upstream.protocol === 'anthropic';
  const endpoint = resolveEndpoint(upstream.baseUrl, isAnthropic ? '/v1/messages' : '/v1/models');
  const options = { method: isAnthropic ? 'POST' : 'GET', headers: upstreamHeaders(upstream) };
  if (isAnthropic) {
    options.body = JSON.stringify({
      model: (upstream.models || [])[0] || 'claude-test',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
      stream: false
    });
  }
  const response = await fetchWithTimeout(endpoint, options);
  const body = await readResponseJson(response);
  return { ok: response.ok, status: response.status, protocol: upstream.protocol, endpoint, body };
}

function upstreamOriginEndpoint(upstream, endpointPath) {
  const origin = new URL(upstream.baseUrl).origin;
  return new URL(endpointPath, `${origin}/`).toString();
}

function safeUpstreamBalanceMessage(upstream, value) {
  let message = String(value || '余额查询失败');
  if (upstream.apiKey) {
    message = message.split(upstream.apiKey).join('[已隐藏]');
    try {
      message = message.split(encodeURIComponent(upstream.apiKey)).join('[已隐藏]');
    } catch {
      // The original secret replacement above is still sufficient for normal keys.
    }
  }
  return message.slice(0, 300);
}

function setUpstreamBalance(upstream, values) {
  const result = {
    upstreamId: upstream.id,
    name: upstream.name,
    state: values.state,
    checkedAt: nowIso(),
    endpoint: values.endpoint || null,
    httpStatus: Number.isInteger(values.httpStatus) ? values.httpStatus : null,
    balance: values.balance || null,
    message: values.message ? safeUpstreamBalanceMessage(upstream, values.message) : null
  };
  upstreamBalances.set(upstream.id, result);
  return result;
}

async function queryUpstreamBalance(upstream) {
  const candidates = upstream.balanceEndpoint
    ? [upstream.balanceEndpoint]
    : ['/api/usage/token', '/api/v1/user/platform-quotas'];
  const failures = [];

  for (const endpointPath of candidates) {
    const endpoint = upstreamOriginEndpoint(upstream, endpointPath);
    try {
      const response = await fetchWithTimeout(endpoint, { method: 'GET', headers: upstreamHeaders(upstream) }, 15000);
      const body = await readResponseJson(response);
      if (response.ok) {
        const balance = parseUpstreamBalance(body);
        if (balance) {
          return setUpstreamBalance(upstream, {
            state: 'ok',
            endpoint: endpointPath,
            httpStatus: response.status,
            balance
          });
        }
        failures.push({ endpoint: endpointPath, status: response.status, message: '响应中没有可识别的余额或额度字段' });
      } else {
        failures.push({
          endpoint: endpointPath,
          status: response.status,
          message: errorMessage(body, `上游返回 HTTP ${response.status}`)
        });
      }
    } catch (error) {
      failures.push({ endpoint: endpointPath, status: null, message: error.name === 'AbortError' ? '余额查询超时' : error.message });
    }
  }

  const last = failures[failures.length - 1] || { endpoint: candidates[0], status: null, message: '没有可用的余额接口' };
  const unsupported = failures.length > 0 && failures.every((item) => [404, 405].includes(item.status) || item.status === 200);
  const automaticHint = !upstream.balanceEndpoint && !unsupported
    ? '；模型 API Key 可能无权访问账户额度，可在上游设置中填写站点提供的余额接口路径'
    : '';
  return setUpstreamBalance(upstream, {
    state: unsupported ? 'unsupported' : 'error',
    endpoint: last.endpoint,
    httpStatus: last.status,
    message: `${last.message}${automaticHint}`
  });
}

async function queryAllUpstreamBalances() {
  const upstreams = [...config.upstreams];
  const results = new Array(upstreams.length);
  let nextIndex = 0;
  const workerCount = Math.min(4, upstreams.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < upstreams.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await queryUpstreamBalance(upstreams[index]);
    }
  });
  await Promise.all(workers);
  return { items: results };
}

async function fetchUpstreamModelCatalog(upstream) {
  const endpoint = resolveEndpoint(upstream.baseUrl, '/v1/models');
  const response = await fetchWithTimeout(endpoint, { method: 'GET', headers: upstreamHeaders(upstream) });
  const body = await readResponseJson(response);
  if (!response.ok) {
    throw Object.assign(new Error(errorMessage(body, `上游返回 HTTP ${response.status}`)), { statusCode: 502 });
  }
  const syncedAt = nowIso();
  const rawModels = Array.isArray(body)
    ? body
    : Array.isArray(body.data)
      ? body.data
      : Array.isArray(body.models)
        ? body.models
        : [];
  const modelCatalog = normalizeModelCatalog(
    rawModels,
    upstream.modelCatalog || [],
    upstream.protocol
  ).map((item) => ({ ...item, source: 'sync', syncedAt }));
  const models = modelCatalog.map((item) => item.id).sort((left, right) => left.localeCompare(right));
  return { count: models.length, models, modelCatalog, syncedAt, endpoint };
}

async function syncUpstreamModels(upstream) {
  const fetched = await fetchUpstreamModelCatalog(upstream);
  const manualCatalog = catalogForUpstream(upstream).filter((item) => item.source !== 'sync');
  const catalogById = new Map(manualCatalog.map((item) => [item.id, item]));
  for (const item of fetched.modelCatalog) catalogById.set(item.id, item);
  const modelCatalog = [...catalogById.values()];
  const models = modelCatalog.map((item) => item.id).sort((left, right) => left.localeCompare(right));
  if (!models.length) {
    throw Object.assign(new Error('上游没有返回可识别的模型列表'), { statusCode: 502 });
  }
  upstream.models = models;
  upstream.modelCatalog = modelCatalog;
  upstream.modelsSyncedAt = fetched.syncedAt;
  upstream.updatedAt = nowIso();
  saveConfig(config);
  return { count: models.length, models, modelCatalog, syncedAt: upstream.modelsSyncedAt };
}

async function syncAllUpstreamModels() {
  const results = [];
  for (const upstream of config.upstreams.filter((item) => item.enabled !== false)) {
    try {
      const result = await syncUpstreamModels(upstream);
      results.push({ upstreamId: upstream.id, name: upstream.name, ok: true, count: result.count });
    } catch (error) {
      results.push({ upstreamId: upstream.id, name: upstream.name, ok: false, message: error.message });
    }
  }
  return { results, catalog: publicModelCatalog() };
}

function cloneConfig() {
  return JSON.parse(JSON.stringify(config));
}

function isMaskedSecret(value) {
  return typeof value === 'string' && value.includes('••••');
}

function validateImportedSettings(settings) {
  return settingsFromBody(settings || {}, config.settings);
}

function importConfig(rawConfig, preserveCredentials = true) {
  const source = rawConfig?.config && typeof rawConfig.config === 'object' ? rawConfig.config : rawConfig;
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('配置备份必须是 JSON 对象');
  if (!Array.isArray(source.upstreams) || !Array.isArray(source.routes)) throw new Error('配置备份缺少 upstreams 或 routes 数组');

  const currentUpstreams = new Map(config.upstreams.map((item) => [item.id, item]));
  const importedUpstreams = [];
  const upstreamIds = new Set();
  for (const item of source.upstreams) {
    if (!item || typeof item !== 'object') throw new Error('配置备份包含无效上游');
    const id = String(item.id || '').trim();
    if (!id || upstreamIds.has(id)) throw new Error(`上游 ID 重复或为空：${id || '(空)'}`);
    const current = currentUpstreams.get(id) || {};
    const apiKey = isMaskedSecret(item.apiKey) ? (current.apiKey || '') : (item.apiKey || current.apiKey || '');
    const normalized = upstreamFromBody({ ...item, id, apiKey }, current);
    normalized.modelsSyncedAt = item.modelsSyncedAt;
    importedUpstreams.push(normalized);
    upstreamIds.add(id);
  }

  const importedRoutes = [];
  const routeIds = new Set();
  for (const item of source.routes) {
    if (!item || typeof item !== 'object') throw new Error('配置备份包含无效路由');
    const id = String(item.id || '').trim();
    if (!id || routeIds.has(id)) throw new Error(`路由 ID 重复或为空：${id || '(空)'}`);
    const route = buildRoute({ ...item, id }, {}, importedUpstreams, importedRoutes);
    importedRoutes.push(route);
    routeIds.add(id);
  }

  const importedSelections = [];
  const selectionsByModel = new Map();
  const redundantManagedRouteIds = new Set();
  for (const item of Array.isArray(source.modelSelections) ? source.modelSelections : []) {
    if (!item || typeof item !== 'object' || item.enabled === false) continue;
    const selection = normalizeModelSelection(item);
    const key = selection.upstreamModel;
    for (const upstreamId of selection.upstreamIds) {
      const upstream = importedUpstreams.find((candidate) => candidate.id === upstreamId);
      if (!upstream || !modelEntryFor(upstream, selection.upstreamModel)) throw new Error(`备份中的模型选择无效：${key} / ${upstreamId}`);
    }
    if (selection.managedRouteId && !importedRoutes.some((route) => route.id === selection.managedRouteId && route.managedBy === 'model-selector')) {
      throw new Error(`备份中的模型选择缺少管理路由：${key}`);
    }
    const existing = selectionsByModel.get(key);
    if (!existing) {
      importedSelections.push(selection);
      selectionsByModel.set(key, selection);
      continue;
    }
    const upstreamIds = [...new Set([...existing.upstreamIds, ...selection.upstreamIds])];
    existing.upstreamId = upstreamIds[0];
    existing.upstreamIds = upstreamIds;
    existing.upstreamMode = upstreamIds.length > 1 ? 'auto' : existing.upstreamMode;
    existing.updatedAt = nowIso();
    if (selection.managedRouteId && selection.managedRouteId !== existing.managedRouteId) redundantManagedRouteIds.add(selection.managedRouteId);
  }

  for (let index = importedRoutes.length - 1; index >= 0; index -= 1) {
    if (redundantManagedRouteIds.has(importedRoutes[index].id)) importedRoutes.splice(index, 1);
  }
  for (const selection of importedSelections) {
    const route = importedRoutes.find((item) => item.id === selection.managedRouteId && item.managedBy === 'model-selector');
    if (!route) continue;
    route.localModel = selection.localModel;
    route.upstreamId = selection.upstreamId;
    route.upstreamModel = selection.upstreamModel;
    route.fallbackUpstreamIds = selection.upstreamMode === 'auto' ? selection.upstreamIds.slice(1) : [];
    route.strategy = selection.upstreamMode === 'auto' ? 'round_robin' : 'failover';
    route.upstreamWeights = Object.fromEntries(selection.upstreamIds.map((id) => [id, 1]));
    route.thinkingLevel = selection.thinkingLevel;
    route.selectionId = selection.id;
    route.updatedAt = nowIso();
  }

  let importedKeys;
  if (preserveCredentials) {
    importedKeys = config.localApiKeys;
  } else {
    if (!Array.isArray(source.localApiKeys)) throw new Error('不保留凭据时，备份必须包含 localApiKeys 数组');
    importedKeys = source.localApiKeys.map((item) => {
      if (!item || typeof item !== 'object' || !item.key || isMaskedSecret(item.key)) throw new Error('备份中的本地 API Key 不完整或已被掩码');
      return {
        id: String(item.id || makeId('key')),
        name: String(item.name || '本地 API Key').trim(),
        key: String(item.key),
        enabled: item.enabled !== false,
        createdAt: item.createdAt || nowIso()
      };
    });
  }
  if (!importedKeys.length) throw new Error('至少需要一个本地 API Key');

  const adminToken = preserveCredentials ? config.adminToken : String(source.adminToken || '').trim();
  if (!adminToken || isMaskedSecret(adminToken)) throw new Error('备份中的管理员 Token 不完整');
  const importedSettings = validateImportedSettings(source.settings);
  config.version = Number(source.version) || 1;
  config.adminToken = adminToken;
  config.localApiKeys = importedKeys;
  config.upstreams = importedUpstreams;
  config.routes = importedRoutes;
  config.modelSelections = importedSelections;
  config.modelSelectionMode = source.modelSelectionMode === true || importedSelections.length > 0;
  config.settings = importedSettings;
  upstreamBalances.clear();
  saveConfig(config);
  return publicConfig(config);
}

function serveStatic(res, pathname) {
  const fileName = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!['index.html', 'app.js', 'model-groups.js', 'styles.css'].includes(fileName)) {
    sendText(res, 404, 'Not found');
    return;
  }
  const filePath = path.join(PUBLIC_DIR, fileName);
  if (!fs.existsSync(filePath)) {
    sendText(res, 404, 'Not found');
    return;
  }
  const types = { 'index.html': 'text/html; charset=utf-8', 'app.js': 'text/javascript; charset=utf-8', 'model-groups.js': 'text/javascript; charset=utf-8', 'styles.css': 'text/css; charset=utf-8' };
  sendText(res, 200, fs.readFileSync(filePath, 'utf8'), types[fileName]);
}

async function handleAdmin(req, res, pathname) {
  if (!requireAdmin(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET' && pathname === '/api/admin/config') {
    sendJson(res, 200, publicConfig(config));
    return;
  }
  if (req.method === 'GET' && pathname === '/api/admin/model-catalog') {
    sendJson(res, 200, publicModelCatalog());
    return;
  }
  if (req.method === 'POST' && pathname === '/api/admin/model-catalog/sync') {
    const result = await syncAllUpstreamModels();
    sendJson(res, 200, result);
    return;
  }
  if (req.method === 'POST' && pathname === '/api/admin/model-catalog/preview') {
    const body = await readBody(req);
    const upstreamId = String(body.upstreamId || '').trim();
    const existing = upstreamId ? config.upstreams.find((item) => item.id === upstreamId) : null;
    if (upstreamId && !existing) {
      sendJson(res, 404, { ok: false, error: { message: '上游不存在' } });
      return;
    }
    if (!body.baseUrl) {
      sendJson(res, 400, { ok: false, error: { message: '请先填写上游地址' } });
      return;
    }
    let upstream;
    try {
      upstream = upstreamFromBody({ ...body, name: body.name || existing?.name || '待添加上游' }, existing || {});
    } catch (error) {
      sendJson(res, 400, { ok: false, error: { message: error.message } });
      return;
    }
    try {
      const result = await fetchUpstreamModelCatalog(upstream);
      if (!result.count) throw Object.assign(new Error('上游没有返回可识别的模型列表'), { statusCode: 502 });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, error.statusCode || 502, { ok: false, error: { message: error.message } });
    }
    return;
  }
  if (req.method === 'PUT' && pathname === '/api/admin/model-selections') {
    const body = await readBody(req);
    const result = saveModelSelections(body.selections);
    sendJson(res, 200, result);
    return;
  }
  if (req.method === 'GET' && pathname === '/api/admin/config/export') {
    const exported = {
      exportVersion: 1,
      exportedAt: nowIso(),
      config: cloneConfig()
    };
    sendJson(res, 200, exported);
    return;
  }
  if (req.method === 'POST' && pathname === '/api/admin/config/import') {
    const body = await readBody(req);
    const imported = importConfig(body, body.preserveCredentials !== false);
    resetRoutingState();
    sendJson(res, 200, imported);
    return;
  }
  if (req.method === 'POST' && pathname === '/api/admin/upstreams') {
    const body = await readBody(req);
    let upstream;
    try {
      upstream = upstreamFromBody(body);
    } catch (error) {
      sendJson(res, 400, { error: { message: error.message } });
      return;
    }
    config.upstreams.push(upstream);
    saveConfig(config);
    sendJson(res, 201, { ...upstream, apiKey: maskSecret(upstream.apiKey) });
    return;
  }
  const upstreamMatch = pathname.match(/^\/api\/admin\/upstreams\/([^/]+)$/);
  if (upstreamMatch && req.method === 'PUT') {
    const id = decodeURIComponent(upstreamMatch[1]);
    const index = config.upstreams.findIndex((item) => item.id === id);
    if (index < 0) return sendJson(res, 404, { error: { message: '上游不存在' } });
    const body = await readBody(req);
    let upstream;
    try {
      upstream = upstreamFromBody(body, config.upstreams[index]);
    } catch (error) {
      sendJson(res, 400, { error: { message: error.message } });
      return;
    }
    config.upstreams[index] = upstream;
    upstreamBalances.delete(id);
    resetRoutingState();
    saveConfig(config);
    sendJson(res, 200, { ...upstream, apiKey: maskSecret(upstream.apiKey) });
    return;
  }
  if (upstreamMatch && req.method === 'DELETE') {
    const id = decodeURIComponent(upstreamMatch[1]);
    config.upstreams = config.upstreams.filter((item) => item.id !== id);
    upstreamHealth.delete(id);
    upstreamBalances.delete(id);
    config.routes = config.routes
      .filter((item) => item.upstreamId !== id)
      .map((item) => ({
        ...item,
        fallbackUpstreamIds: (item.fallbackUpstreamIds || []).filter((fallbackId) => fallbackId !== id)
      }));
    resetRoutingState();
    saveConfig(config);
    sendJson(res, 200, publicConfig(config));
    return;
  }
  const testMatch = pathname.match(/^\/api\/admin\/upstreams\/([^/]+)\/test$/);
  if (testMatch && req.method === 'POST') {
    const upstream = config.upstreams.find((item) => item.id === decodeURIComponent(testMatch[1]));
    if (!upstream) return sendJson(res, 404, { error: { message: '上游不存在' } });
    try {
      const result = await testUpstream(upstream);
      sendJson(res, result.ok ? 200 : 502, result);
    } catch (error) {
      sendJson(res, 502, { ok: false, error: { message: error.message } });
    }
    return;
  }
  const syncMatch = pathname.match(/^\/api\/admin\/upstreams\/([^/]+)\/sync-models$/);
  if (syncMatch && req.method === 'POST') {
    const upstream = config.upstreams.find((item) => item.id === decodeURIComponent(syncMatch[1]));
    if (!upstream) return sendJson(res, 404, { error: { message: '上游不存在' } });
    try {
      const result = await syncUpstreamModels(upstream);
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, error.statusCode || 502, { ok: false, error: { message: error.message } });
    }
    return;
  }
  const balanceMatch = pathname.match(/^\/api\/admin\/upstreams\/([^/]+)\/balance$/);
  if (balanceMatch && req.method === 'POST') {
    const upstream = config.upstreams.find((item) => item.id === decodeURIComponent(balanceMatch[1]));
    if (!upstream) return sendJson(res, 404, { error: { message: '上游不存在' } });
    sendJson(res, 200, await queryUpstreamBalance(upstream));
    return;
  }
  if (req.method === 'POST' && pathname === '/api/admin/routes') {
    const body = await readBody(req);
    const route = routeFromBody(body);
    config.routes.push(route);
    resetRoutingState(route.id);
    saveConfig(config);
    sendJson(res, 201, route);
    return;
  }
  const routeMatch = pathname.match(/^\/api\/admin\/routes\/([^/]+)$/);
  if (routeMatch && req.method === 'PUT') {
    const id = decodeURIComponent(routeMatch[1]);
    const index = config.routes.findIndex((item) => item.id === id);
    if (index < 0) return sendJson(res, 404, { error: { message: '路由不存在' } });
    const body = await readBody(req);
    const route = routeFromBody(body, config.routes[index]);
    config.routes[index] = route;
    resetRoutingState(route.id);
    saveConfig(config);
    sendJson(res, 200, route);
    return;
  }
  if (routeMatch && req.method === 'DELETE') {
    const routeId = decodeURIComponent(routeMatch[1]);
    config.routes = config.routes.filter((item) => item.id !== routeId);
    resetRoutingState(routeId);
    saveConfig(config);
    sendJson(res, 200, publicConfig(config));
    return;
  }
  if (req.method === 'POST' && pathname === '/api/admin/local-keys') {
    const body = await readBody(req);
    const item = localKeyFromBody(body);
    config.localApiKeys.push(item);
    saveConfig(config);
    sendJson(res, 201, { item: exposeNewKey(item), config: publicConfig(config) });
    return;
  }
  const keyMatch = pathname.match(/^\/api\/admin\/local-keys\/([^/]+)$/);
  if (keyMatch && req.method === 'PUT') {
    const id = decodeURIComponent(keyMatch[1]);
    const index = config.localApiKeys.findIndex((item) => item.id === id);
    if (index < 0) return sendJson(res, 404, { error: { message: '本地 API Key 不存在' } });
    const body = await readBody(req);
    const item = localKeyFromBody(body, config.localApiKeys[index]);
    config.localApiKeys[index] = item;
    saveConfig(config);
    sendJson(res, 200, { ...item });
    return;
  }
  if (keyMatch && req.method === 'DELETE') {
    if (config.localApiKeys.length <= 1) return sendJson(res, 400, { error: { message: '至少保留一个本地 API Key' } });
    config.localApiKeys = config.localApiKeys.filter((item) => item.id !== decodeURIComponent(keyMatch[1]));
    saveConfig(config);
    sendJson(res, 200, publicConfig(config));
    return;
  }
  if (req.method === 'GET' && pathname === '/api/admin/settings') {
    sendJson(res, 200, normalizeSettings(config.settings));
    return;
  }
  if (req.method === 'PUT' && pathname === '/api/admin/settings') {
    const body = await readBody(req);
    config.settings = settingsFromBody(body, config.settings);
    saveConfig(config);
    sendJson(res, 200, config.settings);
    return;
  }
  if (req.method === 'GET' && pathname === '/api/admin/upstream-status') {
    sendJson(res, 200, { settings: normalizeSettings(config.settings), items: publicUpstreamHealth() });
    return;
  }
  if (req.method === 'GET' && pathname === '/api/admin/upstream-balances') {
    sendJson(res, 200, publicUpstreamBalances());
    return;
  }
  if (req.method === 'POST' && pathname === '/api/admin/upstream-balances/query') {
    sendJson(res, 200, await queryAllUpstreamBalances());
    return;
  }
  const resetHealthMatch = pathname.match(/^\/api\/admin\/upstreams\/([^/]+)\/reset-health$/);
  if (resetHealthMatch && req.method === 'POST') {
    const id = decodeURIComponent(resetHealthMatch[1]);
    if (!config.upstreams.some((item) => item.id === id)) return sendJson(res, 404, { error: { message: '上游不存在' } });
    sendJson(res, 200, resetUpstreamHealth(id));
    return;
  }
  if (req.method === 'GET' && pathname === '/api/admin/metrics') {
    sendJson(res, 200, getMetrics());
    return;
  }
  if (req.method === 'DELETE' && pathname === '/api/admin/metrics') {
    sendJson(res, 200, clearMetrics());
    return;
  }
  sendJson(res, 404, { error: { message: '管理接口不存在' } });
}

async function requestHandler(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }
  const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = requestUrl.pathname;
  if (pathname === '/health') {
    sendJson(res, 200, { status: 'ok', service: 'local-model-gateway', time: nowIso() });
    return;
  }
  if (pathname === '/auth/status' && req.method === 'GET') {
    const access = adminAuth.authenticate(req);
    sendJson(res, access.ok ? 200 : (access.configured ? 401 : 503), {
      authenticated: access.ok,
      mode: access.ok ? access.mode : 'oidc',
      configured: access.configured !== false,
      user: access.user || null,
      error: access.ok ? null : { message: access.configured ? '需要通过 Authentik 登录' : adminAuth.configurationError() }
    }, { 'Cache-Control': 'no-store' });
    return;
  }
  if (pathname === '/auth/oidc/login' && req.method === 'GET') {
    const access = adminAuth.authenticate(req);
    if (access.ok) {
      sendRedirect(res, validateLocalReturnTo(requestUrl.searchParams.get('returnTo')));
      return;
    }
    try {
      const login = await adminAuth.beginLogin(requestUrl.searchParams.get('returnTo'));
      sendRedirect(res, login.location, { 'Set-Cookie': login.cookie });
    } catch (error) {
      sendText(res, error.statusCode || 503, error.message);
    }
    return;
  }
  if (pathname === '/auth/oidc/callback' && req.method === 'GET') {
    try {
      const result = await adminAuth.finishLogin(Object.fromEntries(requestUrl.searchParams), req.headers.cookie);
      sendRedirect(res, result.returnTo, { 'Set-Cookie': result.cookies });
    } catch (error) {
      sendText(res, error.statusCode || 502, error.message);
    }
    return;
  }
  if (pathname === '/auth/logout' && (req.method === 'GET' || req.method === 'POST')) {
    const result = await adminAuth.logout(req);
    sendRedirect(res, result.location, { 'Set-Cookie': result.cookie });
    return;
  }
  if (pathname.startsWith('/api/admin/')) {
    await handleAdmin(req, res, pathname);
    return;
  }
  if (pathname === '/v1/models' && req.method === 'GET') {
    if (!requireApiKey(req, res)) return;
    sendJson(res, 200, { object: 'list', data: listModels() });
    return;
  }
  if ((pathname === '/v1/chat/completions' || pathname === '/v1/messages' || pathname === '/v1/responses') && req.method === 'POST') {
    const localProtocol = pathname === '/v1/messages' ? 'anthropic' : pathname === '/v1/responses' ? 'responses' : 'openai';
    const requestId = requestIdFromRequest(req);
    const localKey = requireApiKey(req, res);
    if (!localKey) return;
    const admission = admitModelRequest(localKey);
    if (!admission.ok) {
      sendJsonWithRequestId(
        res,
        429,
        errorForProtocol(localProtocol, { message: admission.message }, 429),
        requestId,
        { 'Retry-After': String(admission.retryAfter) }
      );
      return;
    }
    try {
      const input = await readBody(req);
      await forwardModelRequest(req, res, localProtocol, input, requestId);
    } catch (error) {
      if (!res.headersSent) {
        sendJsonWithRequestId(
          res,
          error.statusCode || 400,
          errorForProtocol(localProtocol, { message: error.message }, error.statusCode || 400),
          requestId
        );
      }
    } finally {
      admission.release();
    }
    return;
  }
  if (pathname.startsWith('/v1/')) {
    sendJson(res, 404, { error: { message: '接口不存在' } });
    return;
  }
  if (req.method === 'GET') {
    if (pathname === '/' || pathname === '/index.html') {
      const access = adminAuth.authenticate(req);
      if (!access.ok) {
        if (!access.configured) {
          sendText(res, 503, adminAuth.configurationError());
          return;
        }
        sendRedirect(res, `/auth/oidc/login?returnTo=${encodeURIComponent(`${pathname}${requestUrl.search}`)}`);
        return;
      }
      if (!adminRequestIsSameOrigin(req, access)) {
        sendText(res, 403, '管理页面请求来源不受信任');
        return;
      }
    }
    serveStatic(res, pathname);
    return;
  }
  sendJson(res, 404, { error: { message: '接口不存在' } });
}

const server = http.createServer((req, res) => {
  requestHandler(req, res).catch((error) => {
    log('request error', { message: error.message, stack: error.stack });
    if (!res.headersSent) sendJson(res, error.statusCode || 500, { error: { message: error.message || '服务器内部错误' } });
    else res.end();
  });
});

server.listen(config.settings.port, config.settings.host, () => {
  log(`Local Model Gateway 已启动：http://${config.settings.host}:${config.settings.port}`);
  log('本地管理访问：无需认证');
  log(adminAuth.isConfigured() ? '远程管理访问：Authentik OIDC 已启用' : adminAuth.configurationError());
  for (const item of config.localApiKeys) log(`本地 API Key（${item.name}）：${item.key}`);
  if (config.upstreams.length === 0) log('当前还没有配置上游，请打开首页配置。');
});

process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));