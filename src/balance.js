function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function numberValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const number = Number(value.trim());
  return Number.isFinite(number) ? number : null;
}

function firstNumber(sources, keys) {
  for (const source of sources) {
    if (!isRecord(source)) continue;
    for (const key of keys) {
      const value = numberValue(source[key]);
      if (value !== null) return value;
    }
  }
  return null;
}

function firstValue(sources, keys) {
  for (const source of sources) {
    if (!isRecord(source)) continue;
    for (const key of keys) {
      if (source[key] !== undefined && source[key] !== null && source[key] !== '') return source[key];
    }
  }
  return null;
}

function normalizedTime(value) {
  if (value === undefined || value === null || value === '' || value === 0 || value === '0') return null;
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value.trim()))) {
    const number = Number(value);
    const date = new Date(number < 1e12 ? number * 1000 : number);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function quotaSources(body) {
  const sources = [];
  for (const candidate of [body?.data, body?.result, body]) {
    if (isRecord(candidate) && !sources.includes(candidate)) sources.push(candidate);
  }
  return sources;
}

function parseQuotaBalance(body) {
  const sources = quotaSources(body);
  let remaining = firstNumber(sources, [
    'total_available', 'remaining', 'remaining_balance', 'remain', 'remain_quota', 'available', 'balance', 'credit', 'credits'
  ]);
  let granted = firstNumber(sources, [
    'total_granted', 'granted', 'limit', 'total', 'credit_grants'
  ]);
  const used = firstNumber(sources, [
    'total_used', 'used', 'used_quota', 'usage', 'spent', 'consumed'
  ]);
  const quota = firstNumber(sources, ['quota']);
  if (remaining === null && granted === null && used === null && quota === null) return null;

  // NewAPI's user quota is the currently available quota, while token_usage
  // returns explicit total_available / total_granted fields.
  if (remaining === null && quota !== null) remaining = quota;
  if (remaining === null && granted !== null && used !== null) remaining = granted - used;
  if (granted === null && remaining !== null && used !== null) granted = remaining + used;
  const unlimited = firstValue(sources, ['unlimited_quota', 'unlimited']) === true;
  const unit = firstValue(sources, ['unit', 'currency']) || '额度';
  return {
    type: 'quota',
    unit: String(unit),
    remaining,
    granted,
    used,
    unlimited,
    expiresAt: normalizedTime(firstValue(sources, ['expires_at', 'expired_at', 'expiresAt']))
  };
}

function platformQuotaRecords(body) {
  const candidates = [body, body?.data, body?.result, body?.data?.data];
  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    if (Array.isArray(candidate.platform_quotas)) return candidate.platform_quotas;
    if (Array.isArray(candidate.platformQuotas)) return candidate.platformQuotas;
  }
  return null;
}

function parsePlatformQuotas(body) {
  const records = platformQuotaRecords(body);
  if (!records) return null;
  const platforms = records.filter(isRecord).map((record) => {
    const windows = [
      ['日', 'daily_usage_usd', 'daily_limit_usd', 'daily_window_resets_at'],
      ['周', 'weekly_usage_usd', 'weekly_limit_usd', 'weekly_window_resets_at'],
      ['月', 'monthly_usage_usd', 'monthly_limit_usd', 'monthly_window_resets_at']
    ].flatMap(([period, usageKey, limitKey, resetKey]) => {
      const used = numberValue(record[usageKey]);
      const limit = numberValue(record[limitKey]);
      if (used === null && limit === null) return [];
      return [{
        period,
        used: used ?? 0,
        limit,
        remaining: limit === null ? null : limit - (used ?? 0),
        resetAt: normalizedTime(record[resetKey])
      }];
    });
    return {
      platform: String(record.platform || record.name || '平台'),
      windows
    };
  });
  return { type: 'platform-quotas', unit: 'USD', platforms };
}

function parseUpstreamBalance(body) {
  if (!isRecord(body)) return null;
  return parsePlatformQuotas(body) || parseQuotaBalance(body);
}

function normalizeBalanceEndpoint(value) {
  if (value === undefined || value === null || String(value).trim() === '') return '';
  const endpoint = String(value).trim();
  if (endpoint.length > 300 || !endpoint.startsWith('/') || endpoint.startsWith('//') || endpoint.includes('\\') || /[\u0000-\u001f\u007f]/.test(endpoint)) {
    throw new Error('余额接口路径必须是 300 个字符以内的相对路径');
  }
  let segments;
  try {
    segments = endpoint.split(/[?#]/, 1)[0].split('/').map((segment) => decodeURIComponent(segment));
  } catch {
    throw new Error('余额接口路径包含无效编码');
  }
  const parsed = new URL(endpoint, 'http://balance-endpoint.invalid');
  if (parsed.origin !== 'http://balance-endpoint.invalid' || parsed.search || parsed.hash || segments.includes('..')) {
    throw new Error('余额接口路径只能包含同一上游下的路径，不能包含查询参数或跨域地址');
  }
  return parsed.pathname;
}

module.exports = {
  normalizeBalanceEndpoint,
  parseUpstreamBalance
};