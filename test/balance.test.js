const assert = require('node:assert/strict');
const { normalizeBalanceEndpoint, parseUpstreamBalance } = require('../src/balance');

const newApi = parseUpstreamBalance({
  code: true,
  data: {
    object: 'token_usage',
    total_granted: 1000000,
    total_used: 250000,
    total_available: 750000,
    unlimited_quota: false,
    expires_at: 1893456000
  }
});
assert.deepEqual(newApi, {
  type: 'quota',
  unit: '额度',
  remaining: 750000,
  granted: 1000000,
  used: 250000,
  unlimited: false,
  expiresAt: '2030-01-01T00:00:00.000Z'
});

const calculated = parseUpstreamBalance({ data: { quota: '20', used_quota: '7.5' } });
assert.equal(calculated.remaining, 20);
assert.equal(calculated.granted, 27.5);
assert.equal(calculated.used, 7.5);

const sub2api = parseUpstreamBalance({
  data: {
    platform_quotas: [{
      platform: 'anthropic',
      daily_usage_usd: 1.25,
      daily_limit_usd: 5,
      daily_window_resets_at: '2030-01-02T00:00:00Z',
      weekly_usage_usd: 6,
      weekly_limit_usd: 20,
      monthly_usage_usd: 9,
      monthly_limit_usd: null
    }]
  }
});
assert.equal(sub2api.type, 'platform-quotas');
assert.equal(sub2api.unit, 'USD');
assert.equal(sub2api.platforms[0].platform, 'anthropic');
assert.deepEqual(sub2api.platforms[0].windows[0], {
  period: '日',
  used: 1.25,
  limit: 5,
  remaining: 3.75,
  resetAt: '2030-01-02T00:00:00.000Z'
});
assert.equal(sub2api.platforms[0].windows[2].limit, null);
assert.equal(sub2api.platforms[0].windows[2].remaining, null);

assert.equal(parseUpstreamBalance({ data: [{ id: 'gpt-4o' }] }), null);
assert.equal(parseUpstreamBalance(null), null);

assert.equal(normalizeBalanceEndpoint(''), '');
assert.equal(normalizeBalanceEndpoint('/api/usage/token'), '/api/usage/token');
for (const endpoint of [
  'https://evil.example/balance',
  '//evil.example/balance',
  '/api/balance?key=secret',
  '/api/balance#fragment',
  '/api/../secret',
  '/api/%2e%2e/secret',
  '/api\\balance'
]) {
  assert.throws(() => normalizeBalanceEndpoint(endpoint), /余额接口路径/);
}

const fs = require('node:fs');
const path = require('node:path');
const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
assert.ok(appSource.includes('/api/admin/upstream-balances/query'));
assert.ok(appSource.includes('data-action="query-upstream-balance"'));
assert.ok(htmlSource.includes('id="queryAllBalancesButton"'));
assert.ok(htmlSource.includes('id="upstreamBalanceEndpoint"'));

console.log('balance tests passed');