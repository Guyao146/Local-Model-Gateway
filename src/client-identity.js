const CLIENT_IDENTITY_PRESETS = Object.freeze({
  default: Object.freeze({ userAgent: '', headers: Object.freeze({}) }),
  claude_code: Object.freeze({ userAgent: 'claude-code', headers: Object.freeze({}) }),
  codex_cli: Object.freeze({ userAgent: 'codex_cli_rs', headers: Object.freeze({ originator: 'codex_cli_rs' }) }),
  cherry_studio: Object.freeze({ userAgent: 'CherryStudio', headers: Object.freeze({}) }),
  custom: Object.freeze({ userAgent: '', headers: Object.freeze({}) })
});

function normalizeHeaderValue(value, label = '请求头值') {
  const normalized = String(value || '').trim();
  if (normalized.length > 300) throw new Error(`${label}不能超过 300 个字符`);
  if (/[^\x20-\x7e\x80-\xff]/.test(normalized) || normalized.includes('\r') || normalized.includes('\n')) {
    throw new Error(`${label}包含不允许的控制字符`);
  }
  return normalized;
}

function normalizeClientIdentity(presetValue, userAgentValue) {
  const preset = String(presetValue || 'default');
  if (!Object.prototype.hasOwnProperty.call(CLIENT_IDENTITY_PRESETS, preset)) throw new Error(`不支持的客户端兼容标识：${preset}`);
  const customUserAgent = normalizeHeaderValue(userAgentValue, '自定义 User-Agent');
  if (preset === 'custom' && !customUserAgent) throw new Error('选择自定义客户端标识时必须填写 User-Agent');
  return {
    preset,
    userAgent: preset === 'custom' ? customUserAgent : CLIENT_IDENTITY_PRESETS[preset].userAgent
  };
}

function clientIdentityHeaders(upstream) {
  const identity = normalizeClientIdentity(upstream?.clientIdentityPreset, upstream?.customUserAgent);
  const preset = CLIENT_IDENTITY_PRESETS[identity.preset];
  return {
    ...(identity.userAgent ? { 'User-Agent': identity.userAgent } : {}),
    ...preset.headers
  };
}

module.exports = {
  CLIENT_IDENTITY_PRESETS,
  clientIdentityHeaders,
  normalizeClientIdentity
};