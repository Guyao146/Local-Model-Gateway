const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DATA_DIR = process.env.LOCAL_MODEL_GATEWAY_DATA_DIR || path.join(__dirname, '..', 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

function makeId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

function makeSecret(prefix) {
  return `${prefix}_${crypto.randomBytes(24).toString('base64url')}`;
}

function defaultConfig() {
  return {
    version: 1,
    adminToken: makeSecret('admin'),
    localApiKeys: [
      {
        id: makeId('key'),
        name: '默认本地 Key',
        key: makeSecret('sk-local'),
        enabled: true,
        createdAt: new Date().toISOString()
      }
    ],
    upstreams: [],
    routes: [],
    modelSelections: [],
    modelSelectionMode: false,
    settings: {
      host: process.env.HOST || '127.0.0.1',
      port: Number(process.env.PORT || 8787),
      upstreamTimeoutMs: 600000,
      maxFallbackAttempts: 0,
      retryDelayMs: 0,
      circuitBreakerFailureThreshold: 3,
      circuitBreakerCooldownMs: 60000,
      maxConcurrentRequests: 0,
      requestsPerMinute: 0
    }
  };
}

function normalizeSettings(settings = {}) {
  const integer = (value, fallback, min, max) => {
    const number = Number(value);
    return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
  };
  const defaults = defaultConfig().settings;
  return {
    host: typeof settings.host === 'string' && settings.host.trim() ? settings.host.trim() : defaults.host,
    port: integer(settings.port, defaults.port, 1, 65535),
    upstreamTimeoutMs: integer(settings.upstreamTimeoutMs, defaults.upstreamTimeoutMs, 1000, 3600000),
    maxFallbackAttempts: integer(settings.maxFallbackAttempts, defaults.maxFallbackAttempts, 0, 12),
    retryDelayMs: integer(settings.retryDelayMs, defaults.retryDelayMs, 0, 30000),
    circuitBreakerFailureThreshold: integer(settings.circuitBreakerFailureThreshold, defaults.circuitBreakerFailureThreshold, 1, 20),
    circuitBreakerCooldownMs: integer(settings.circuitBreakerCooldownMs, defaults.circuitBreakerCooldownMs, 1000, 3600000),
    maxConcurrentRequests: integer(settings.maxConcurrentRequests, defaults.maxConcurrentRequests, 0, 1000),
    requestsPerMinute: integer(settings.requestsPerMinute, defaults.requestsPerMinute, 0, 10000)
  };
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadConfig() {
  ensureDataDir();
  if (!fs.existsSync(CONFIG_PATH)) {
    const config = defaultConfig();
    saveConfig(config);
    return config;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const merged = {
      ...defaultConfig(),
      ...parsed,
      localApiKeys: Array.isArray(parsed.localApiKeys) ? parsed.localApiKeys : [],
      upstreams: Array.isArray(parsed.upstreams) ? parsed.upstreams : [],
      routes: Array.isArray(parsed.routes) ? parsed.routes : [],
      modelSelections: Array.isArray(parsed.modelSelections) ? parsed.modelSelections : [],
      modelSelectionMode: parsed.modelSelectionMode === true
    };
    merged.settings = normalizeSettings(parsed.settings || merged.settings);
    return merged;
  } catch (error) {
    throw new Error(`配置文件损坏，无法读取 ${CONFIG_PATH}: ${error.message}`);
  }
}

function saveConfig(config) {
  ensureDataDir();
  const tempPath = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempPath, CONFIG_PATH);
  try {
    fs.chmodSync(CONFIG_PATH, 0o600);
  } catch {
    // Windows does not expose Unix file modes consistently.
  }
}

function maskSecret(value) {
  if (!value) return '';
  if (value.length <= 8) return '••••••••';
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}

function publicConfig(config) {
  return {
    version: config.version,
    localApiKeys: config.localApiKeys.map((item) => ({
      ...item,
      key: maskSecret(item.key)
    })),
    upstreams: config.upstreams.map((item) => ({
      ...item,
      apiKey: maskSecret(item.apiKey)
    })),
    routes: config.routes,
    modelSelections: config.modelSelections || [],
    modelSelectionMode: config.modelSelectionMode === true,
    settings: config.settings
  };
}

module.exports = {
  CONFIG_PATH,
  loadConfig,
  saveConfig,
  publicConfig,
  makeId,
  makeSecret,
  maskSecret,
  normalizeSettings
};