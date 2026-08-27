const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const projectRoot = path.join(__dirname, '..');
const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'local-model-gateway-'));
const gatewayPort = 19000 + Math.floor(Math.random() * 1000);

function requestJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } }, (response) => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { raw += chunk; });
      response.on('end', () => {
        let body = {};
        try { body = raw ? JSON.parse(raw) : {}; } catch { body = { raw }; }
        resolve({ status: response.statusCode, headers: response.headers, body });
      });
    });
    request.on('error', reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}

function waitForOutput(process, text) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`等待网关启动超时，输出：${output}`)), 10000);
    const onData = (chunk) => {
      output += chunk.toString();
      if (output.includes(text)) {
        clearTimeout(timer);
        process.stdout?.removeListener('data', onData);
        resolve(output);
      }
    };
    process.stdout.on('data', onData);
    process.once('error', (error) => { clearTimeout(timer); reject(error); });
    process.once('exit', (code) => {
      if (code !== 0) { clearTimeout(timer); reject(new Error(`网关退出（${code}）：${output}`)); }
    });
  });
}

async function main() {
  const observedRequestIds = [];
  const observedBalanceAuth = [];
  let slowStartedResolve;
  const slowStarted = new Promise((resolve) => { slowStartedResolve = resolve; });
  const primary = http.createServer(async (req, res) => {
    if (req.headers['x-request-id']) observedRequestIds.push({ upstream: 'primary', value: req.headers['x-request-id'] });
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
    if (req.url === '/api/usage/token') {
      observedBalanceAuth.push(req.headers.authorization || '');
      res.statusCode = req.headers.authorization === 'Bearer upstream-balance-secret' ? 200 : 401;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(res.statusCode === 200
        ? { code: true, data: { object: 'token_usage', total_granted: 1000000, total_used: 250000, total_available: 750000, unlimited_quota: false, expires_at: 1893456000 } }
        : { error: { message: 'invalid upstream key' } }));
      return;
    }
    if (req.url === '/v1/chat/completions' && ['rr-upstream', 'weighted-upstream'].includes(body.model)) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ id: 'primary-success', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'served-by-primary' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      return;
    }
    res.statusCode = req.url === '/v1/chat/completions' ? 503 : 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url === '/v1/chat/completions'
      ? { error: { message: 'primary unavailable' } }
      : { object: 'list', data: [{ id: 'primary-synced-model' }] }));
  });
  const fallback = http.createServer(async (req, res) => {
    if (req.headers['x-request-id']) observedRequestIds.push({ upstream: 'fallback', value: req.headers['x-request-id'] });
    let raw = '';
    for await (const chunk of req) raw += chunk;
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/usage/token' || req.url === '/api/v1/user/platform-quotas') {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: { message: `invalid credential: ${req.headers.authorization || ''}` } }));
      return;
    }
    if (req.url === '/v1/chat/completions') {
      const body = JSON.parse(raw);
      if (raw.includes('slow-concurrency-test')) {
        slowStartedResolve();
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      res.end(JSON.stringify({ id: 'fallback-result', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'served-by-fallback' }, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } }));
      return;
    }
    res.end(JSON.stringify({ object: 'list', data: [] }));
  });
  await new Promise((resolve) => primary.listen(0, '127.0.0.1', resolve));
  await new Promise((resolve) => fallback.listen(0, '127.0.0.1', resolve));
  const primaryPort = primary.address().port;
  const fallbackPort = fallback.address().port;
  const gateway = spawn(process.execPath, ['src/server.js'], {
    cwd: projectRoot,
    env: { ...process.env, PORT: String(gatewayPort), LOCAL_MODEL_GATEWAY_DATA_DIR: dataDirectory },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  gateway.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  try {
    const output = await waitForOutput(gateway, '本地管理访问：无需认证');
    const config = JSON.parse(fs.readFileSync(path.join(dataDirectory, 'config.json'), 'utf8'));
    const adminHeaders = {};
    const visibleConfig = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/config`, { headers: adminHeaders });
    assert.equal(visibleConfig.status, 200, JSON.stringify(visibleConfig.body));
    assert.equal(visibleConfig.body.localApiKeys[0].key, config.localApiKeys[0].key, '管理后台应返回完整本地调用 Key');
    const add = (name, port, authType = 'none', apiKey = '') => requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/upstreams`, {
      method: 'POST', headers: adminHeaders, body: JSON.stringify({ name, baseUrl: `http://127.0.0.1:${port}/v1`, protocol: 'openai', authType, apiKey, models: 'test-model' })
    });
    const invalidBalanceEndpoint = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/upstreams`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ name: 'invalid-balance-endpoint', baseUrl: `http://127.0.0.1:${primaryPort}/v1`, protocol: 'openai', authType: 'none', apiKey: '', models: 'test-model', balanceEndpoint: 'https://evil.example/balance' })
    });
    assert.equal(invalidBalanceEndpoint.status, 400, JSON.stringify(invalidBalanceEndpoint.body));
    const primaryResult = await add('primary', primaryPort, 'bearer', 'upstream-balance-secret');
    const fallbackResult = await add('fallback', fallbackPort, 'bearer', 'fallback-balance-secret');
    const initialSettings = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/settings`, { headers: adminHeaders });
    assert.equal(initialSettings.status, 200, JSON.stringify(initialSettings.body));
    assert.equal(initialSettings.body.maxFallbackAttempts, 0);
    const updatedSettings = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/settings`, {
      method: 'PUT', headers: adminHeaders, body: JSON.stringify({ upstreamTimeoutMs: 120000, maxFallbackAttempts: 1, retryDelayMs: 0, circuitBreakerFailureThreshold: 1, circuitBreakerCooldownMs: 60000 })
    });
    assert.equal(updatedSettings.status, 200, JSON.stringify(updatedSettings.body));
    assert.equal(updatedSettings.body.upstreamTimeoutMs, 120000);
    assert.equal(updatedSettings.body.maxFallbackAttempts, 1);
    assert.equal(updatedSettings.body.circuitBreakerFailureThreshold, 1);
    assert.equal(primaryResult.status, 201, output);
    assert.equal(fallbackResult.status, 201, output);
    assert.equal(primaryResult.body.apiKey.includes('upstream-balance-secret'), false, '管理接口不得返回完整上游 Key');
    const initialBalances = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/upstream-balances`, { headers: adminHeaders });
    assert.equal(initialBalances.status, 200, JSON.stringify(initialBalances.body));
    assert.equal(initialBalances.body.items.find((item) => item.upstreamId === primaryResult.body.id).state, 'idle');
    const primaryBalance = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/upstreams/${encodeURIComponent(primaryResult.body.id)}/balance`, {
      method: 'POST', headers: adminHeaders, body: '{}'
    });
    assert.equal(primaryBalance.status, 200, JSON.stringify(primaryBalance.body));
    assert.equal(primaryBalance.body.state, 'ok');
    assert.equal(primaryBalance.body.endpoint, '/api/usage/token');
    assert.equal(primaryBalance.body.balance.type, 'quota');
    assert.equal(primaryBalance.body.balance.remaining, 750000);
    assert.equal(primaryBalance.body.balance.used, 250000);
    assert.equal(JSON.stringify(primaryBalance.body).includes('upstream-balance-secret'), false);
    assert.deepEqual(observedBalanceAuth, ['Bearer upstream-balance-secret']);
    const cachedBalances = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/upstream-balances`, { headers: adminHeaders });
    assert.equal(cachedBalances.body.items.find((item) => item.upstreamId === primaryResult.body.id).balance.granted, 1000000);
    const allBalances = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/upstream-balances/query`, {
      method: 'POST', headers: adminHeaders, body: '{}'
    });
    assert.equal(allBalances.status, 200, JSON.stringify(allBalances.body));
    assert.equal(allBalances.body.items.find((item) => item.upstreamId === primaryResult.body.id).state, 'ok');
    const failedBalance = allBalances.body.items.find((item) => item.upstreamId === fallbackResult.body.id);
    assert.equal(failedBalance.state, 'error');
    assert.match(failedBalance.message, /\[已隐藏\]/);
    assert.equal(JSON.stringify(failedBalance).includes('fallback-balance-secret'), false);
    const sync = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/upstreams/${encodeURIComponent(primaryResult.body.id)}/sync-models`, {
      method: 'POST', headers: adminHeaders, body: '{}'
    });
    assert.equal(sync.status, 200, JSON.stringify(sync.body));
    assert.equal(sync.body.count, 2);
    assert.deepEqual(sync.body.models, ['primary-synced-model', 'test-model']);
    const route = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/routes`, {
      method: 'POST', headers: adminHeaders, body: JSON.stringify({ localModel: 'test-local', upstreamId: primaryResult.body.id, upstreamModel: 'test-model', fallbackUpstreamIds: [fallbackResult.body.id] })
    });
    assert.equal(route.status, 201, JSON.stringify(route.body));
    const response = await requestJson(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST', headers: { Authorization: `Bearer ${config.localApiKeys[0].key}`, 'x-request-id': 'client-request-001' }, body: JSON.stringify({ model: 'test-local', messages: [{ role: 'user', content: 'hello' }] })
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.choices[0].message.content, 'served-by-fallback');
    assert.equal(response.headers['x-request-id'], 'client-request-001');
    assert.deepEqual(observedRequestIds.slice(0, 2), [
      { upstream: 'primary', value: 'client-request-001' },
      { upstream: 'fallback', value: 'client-request-001' }
    ]);
    const healthAfterFirst = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/upstream-status`, { headers: adminHeaders });
    assert.equal(healthAfterFirst.status, 200, JSON.stringify(healthAfterFirst.body));
    const primaryHealthAfterFirst = healthAfterFirst.body.items.find((item) => item.name === 'primary');
    assert.equal(primaryHealthAfterFirst.state, 'open');
    assert.equal(primaryHealthAfterFirst.consecutiveFailures, 1);
    assert.equal(JSON.stringify(primaryHealthAfterFirst).includes('18890'), false);
    assert.equal(JSON.stringify(primaryHealthAfterFirst).includes('test-key'), false);
    const directFallbackResponse = await requestJson(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST', headers: { Authorization: `Bearer ${config.localApiKeys[0].key}`, 'x-request-id': 'client-request-002' }, body: JSON.stringify({ model: 'test-local', messages: [{ role: 'user', content: 'hello again' }] })
    });
    assert.equal(directFallbackResponse.status, 200, JSON.stringify(directFallbackResponse.body));
    assert.equal(directFallbackResponse.body.choices[0].message.content, 'served-by-fallback');
    assert.deepEqual(observedRequestIds.slice(2, 3), [{ upstream: 'fallback', value: 'client-request-002' }]);
    const resetHealth = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/upstreams/${encodeURIComponent(primaryResult.body.id)}/reset-health`, {
      method: 'POST', headers: adminHeaders, body: '{}'
    });
    assert.equal(resetHealth.status, 200, JSON.stringify(resetHealth.body));
    assert.equal(resetHealth.body.state, 'closed');
    const afterResetResponse = await requestJson(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST', headers: { Authorization: `Bearer ${config.localApiKeys[0].key}`, 'x-request-id': 'client-request-003' }, body: JSON.stringify({ model: 'test-local', messages: [{ role: 'user', content: 'after reset' }] })
    });
    assert.equal(afterResetResponse.status, 200, JSON.stringify(afterResetResponse.body));
    assert.equal(afterResetResponse.body.choices[0].message.content, 'served-by-fallback');
    assert.deepEqual(observedRequestIds.slice(3, 5), [
      { upstream: 'primary', value: 'client-request-003' },
      { upstream: 'fallback', value: 'client-request-003' }
    ]);
    const metrics = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/metrics`, { headers: adminHeaders });
    assert.equal(metrics.status, 200, JSON.stringify(metrics.body));
    assert.equal(metrics.body.totals.requests, 3);
    assert.equal(metrics.body.totals.successful, 3);
    assert.equal(metrics.body.totals.failed, 0);
    assert.equal(metrics.body.totals.failovers, 2);
    assert.equal(metrics.body.totals.promptTokens, 33);
    assert.equal(metrics.body.totals.completionTokens, 21);
    assert.equal(metrics.body.totals.totalTokens, 54);
    assert.equal(metrics.body.logs[0].failover, true);
    assert.equal(metrics.body.logs.find((entry) => entry.id && entry.attempts.length === 1).attempts[0].upstream, 'fallback');
    assert.equal(metrics.body.logs.find((entry) => entry.id && entry.attempts.length === 1).attempts[0].status, 200);
    assert.equal(metrics.body.byUpstream.primary.failed, 2);
    assert.equal(metrics.body.byUpstream.fallback.successful, 3);
    assert.equal(metrics.body.byUpstream.fallback.totalTokens, 54);
    const responsesResponse = await requestJson(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
      method: 'POST', headers: { Authorization: `Bearer ${config.localApiKeys[0].key}` }, body: JSON.stringify({ model: 'test-local', instructions: 'Be concise', input: 'hello responses', max_output_tokens: 40 })
    });
    assert.equal(responsesResponse.status, 200, JSON.stringify(responsesResponse.body));
    assert.equal(responsesResponse.body.object, 'response');
    assert.equal(responsesResponse.body.output_text, 'served-by-fallback');
    assert.equal(responsesResponse.body.usage.total_tokens, 18);
    const exported = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/config/export`, { headers: adminHeaders });
    assert.equal(exported.status, 200, JSON.stringify(exported.body));
    assert.equal(exported.body.exportVersion, 1);
    assert.equal(exported.body.config.adminToken, config.adminToken);
    assert.equal(exported.body.config.localApiKeys[0].key, config.localApiKeys[0].key);
    assert.equal(exported.body.config.upstreams.length, 2);
    const importedBackup = JSON.parse(JSON.stringify(exported.body));
    importedBackup.config.adminToken = 'admin_imported_should_not_replace_current';
    importedBackup.config.localApiKeys[0].key = 'sk-local_imported_should_not_replace_current';
    const imported = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/config/import`, {
      method: 'POST', headers: adminHeaders, body: JSON.stringify({ ...importedBackup, preserveCredentials: true })
    });
    assert.equal(imported.status, 200, JSON.stringify(imported.body));
    const afterImport = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/config`, { headers: adminHeaders });
    assert.equal(afterImport.status, 200, JSON.stringify(afterImport.body));
    assert.equal(afterImport.body.routes.length, 1);
    const importedResponse = await requestJson(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
      method: 'POST', headers: { Authorization: `Bearer ${config.localApiKeys[0].key}` }, body: JSON.stringify({ model: 'test-local', input: 'after import' })
    });
    assert.equal(importedResponse.status, 200, JSON.stringify(importedResponse.body));
    assert.equal(importedResponse.body.output_text, 'served-by-fallback');
    const resetForStrategies = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/upstreams/${encodeURIComponent(primaryResult.body.id)}/reset-health`, {
      method: 'POST', headers: adminHeaders, body: '{}'
    });
    assert.equal(resetForStrategies.status, 200, JSON.stringify(resetForStrategies.body));
    const roundRobinRoute = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/routes`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ localModel: 'round-robin-local', upstreamId: primaryResult.body.id, upstreamModel: 'rr-upstream', fallbackUpstreamIds: [fallbackResult.body.id], strategy: 'round_robin' })
    });
    assert.equal(roundRobinRoute.status, 201, JSON.stringify(roundRobinRoute.body));
    const beforeRoundRobin = observedRequestIds.length;
    for (const requestId of ['rr-request-001', 'rr-request-002']) {
      const result = await requestJson(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
        method: 'POST', headers: { Authorization: `Bearer ${config.localApiKeys[0].key}`, 'x-request-id': requestId }, body: JSON.stringify({ model: 'round-robin-local', messages: [{ role: 'user', content: requestId }] })
      });
      assert.equal(result.status, 200, JSON.stringify(result.body));
    }
    assert.deepEqual(observedRequestIds.slice(beforeRoundRobin, beforeRoundRobin + 2), [
      { upstream: 'primary', value: 'rr-request-001' },
      { upstream: 'fallback', value: 'rr-request-002' }
    ]);
    const weightedRoute = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/routes`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ localModel: 'weighted-local', upstreamId: primaryResult.body.id, upstreamModel: 'weighted-upstream', fallbackUpstreamIds: [fallbackResult.body.id], strategy: 'weighted', upstreamWeights: { [primaryResult.body.id]: 2, [fallbackResult.body.id]: 1 } })
    });
    assert.equal(weightedRoute.status, 201, JSON.stringify(weightedRoute.body));
    const beforeWeighted = observedRequestIds.length;
    for (const requestId of ['weighted-request-001', 'weighted-request-002', 'weighted-request-003']) {
      const result = await requestJson(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
        method: 'POST', headers: { Authorization: `Bearer ${config.localApiKeys[0].key}`, 'x-request-id': requestId }, body: JSON.stringify({ model: 'weighted-local', messages: [{ role: 'user', content: requestId }] })
      });
      assert.equal(result.status, 200, JSON.stringify(result.body));
    }
    assert.deepEqual(observedRequestIds.slice(beforeWeighted, beforeWeighted + 3), [
      { upstream: 'primary', value: 'weighted-request-001' },
      { upstream: 'fallback', value: 'weighted-request-002' },
      { upstream: 'primary', value: 'weighted-request-003' }
    ]);
    const strategyMetrics = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/metrics`, { headers: adminHeaders });
    assert.equal(strategyMetrics.status, 200, JSON.stringify(strategyMetrics.body));
    assert.equal(strategyMetrics.body.logs.find((entry) => entry.model === 'round-robin-local').strategy, 'round_robin');
    assert.equal(strategyMetrics.body.logs.find((entry) => entry.model === 'weighted-local').strategy, 'weighted');
    const concurrentSettings = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/settings`, {
      method: 'PUT', headers: adminHeaders, body: JSON.stringify({ maxConcurrentRequests: 1, requestsPerMinute: 0 })
    });
    assert.equal(concurrentSettings.status, 200, JSON.stringify(concurrentSettings.body));
    assert.equal(concurrentSettings.body.maxConcurrentRequests, 1);
    const slowRequest = requestJson(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST', headers: { Authorization: `Bearer ${config.localApiKeys[0].key}`, 'x-request-id': 'concurrency-slow-001' }, body: JSON.stringify({ model: 'test-local', messages: [{ role: 'user', content: 'slow-concurrency-test' }] })
    });
    await Promise.race([
      slowStarted,
      new Promise((_, reject) => setTimeout(() => reject(new Error('慢请求没有到达 mock 上游')), 3000))
    ]);
    const observedBeforeConcurrentDenied = observedRequestIds.length;
    const concurrentDenied = await requestJson(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST', headers: { Authorization: `Bearer ${config.localApiKeys[0].key}`, 'x-request-id': 'concurrency-denied-001' }, body: JSON.stringify({ model: 'test-local', messages: [{ role: 'user', content: 'should-be-rejected' }] })
    });
    assert.equal(concurrentDenied.status, 429, JSON.stringify(concurrentDenied.body));
    assert.equal(concurrentDenied.headers['x-request-id'], 'concurrency-denied-001');
    assert.equal(concurrentDenied.headers['retry-after'], '1');
    assert.equal(observedRequestIds.length, observedBeforeConcurrentDenied);
    const slowResult = await slowRequest;
    assert.equal(slowResult.status, 200, JSON.stringify(slowResult.body));
    const releasedRequest = await requestJson(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST', headers: { Authorization: `Bearer ${config.localApiKeys[0].key}` }, body: JSON.stringify({ model: 'test-local', messages: [{ role: 'user', content: 'slot-released' }] })
    });
    assert.equal(releasedRequest.status, 200, JSON.stringify(releasedRequest.body));
    const rateSettings = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/settings`, {
      method: 'PUT', headers: adminHeaders, body: JSON.stringify({ maxConcurrentRequests: 0, requestsPerMinute: 1 })
    });
    assert.equal(rateSettings.status, 200, JSON.stringify(rateSettings.body));
    const rateAllowed = await requestJson(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST', headers: { Authorization: `Bearer ${config.localApiKeys[0].key}` }, body: JSON.stringify({ model: 'test-local', messages: [{ role: 'user', content: 'rate-allowed' }] })
    });
    assert.equal(rateAllowed.status, 200, JSON.stringify(rateAllowed.body));
    const observedBeforeRateDenied = observedRequestIds.length;
    const rateDenied = await requestJson(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST', headers: { Authorization: `Bearer ${config.localApiKeys[0].key}`, 'x-request-id': 'rate-denied-001' }, body: JSON.stringify({ model: 'test-local', messages: [{ role: 'user', content: 'should-be-rate-limited' }] })
    });
    assert.equal(rateDenied.status, 429, JSON.stringify(rateDenied.body));
    assert.equal(rateDenied.headers['x-request-id'], 'rate-denied-001');
    assert.ok(Number(rateDenied.headers['retry-after']) >= 1);
    assert.equal(observedRequestIds.length, observedBeforeRateDenied);
    const unlimitedSettings = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/settings`, {
      method: 'PUT', headers: adminHeaders, body: JSON.stringify({ maxConcurrentRequests: 0, requestsPerMinute: 0 })
    });
    assert.equal(unlimitedSettings.status, 200, JSON.stringify(unlimitedSettings.body));
    const createdKey = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/local-keys`, {
      method: 'POST', headers: adminHeaders, body: JSON.stringify({ name: 'visible-after-create' })
    });
    assert.equal(createdKey.status, 201, JSON.stringify(createdKey.body));
    assert.match(createdKey.body.item.key, /^sk-local_/);
    const configAfterKeyCreate = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/config`, { headers: adminHeaders });
    assert.equal(configAfterKeyCreate.status, 200, JSON.stringify(configAfterKeyCreate.body));
    assert.equal(
      configAfterKeyCreate.body.localApiKeys.find((item) => item.id === createdKey.body.item.id)?.key,
      createdKey.body.item.key,
      '新建后重新读取配置仍应返回完整本地 Key'
    );
    const deleteCreatedKey = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/local-keys/${encodeURIComponent(createdKey.body.item.id)}`, {
      method: 'DELETE', headers: adminHeaders
    });
    assert.equal(deleteCreatedKey.status, 200, JSON.stringify(deleteCreatedKey.body));
    const keyId = config.localApiKeys[0].id;
    const disabledKey = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/local-keys/${encodeURIComponent(keyId)}`, {
      method: 'PUT', headers: adminHeaders, body: JSON.stringify({ name: 'disabled-key', enabled: false })
    });
    assert.equal(disabledKey.status, 200, JSON.stringify(disabledKey.body));
    assert.equal(disabledKey.body.key, config.localApiKeys[0].key, '更新本地 Key 后仍应返回完整值');
    const disabledRequest = await requestJson(`http://127.0.0.1:${gatewayPort}/v1/models`, {
      headers: { Authorization: `Bearer ${config.localApiKeys[0].key}` }
    });
    assert.equal(disabledRequest.status, 401);
    const enabledKey = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/local-keys/${encodeURIComponent(keyId)}`, {
      method: 'PUT', headers: adminHeaders, body: JSON.stringify({ name: 're-enabled-key', enabled: true })
    });
    assert.equal(enabledKey.status, 200, JSON.stringify(enabledKey.body));
    const lastKeyDelete = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/local-keys/${encodeURIComponent(keyId)}`, {
      method: 'DELETE', headers: adminHeaders
    });
    assert.equal(lastKeyDelete.status, 400, JSON.stringify(lastKeyDelete.body));
    console.log('gateway integration tests passed');
  } catch (error) {
    throw new Error(`${error.message}\n${stderr}`);
  } finally {
    gateway.kill();
    await Promise.all([
      new Promise((resolve) => primary.close(resolve)),
      new Promise((resolve) => fallback.close(resolve))
    ]);
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});