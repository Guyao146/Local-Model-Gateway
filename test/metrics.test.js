const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// metrics.js 在加载时读取数据目录，必须先指向临时目录再 require。
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-model-gateway-metrics-'));
process.env.LOCAL_MODEL_GATEWAY_DATA_DIR = dataDir;
process.env.LOCAL_MODEL_GATEWAY_MAX_LOGS = '100';

const { recordRequest, getLogs, importUsageRecords, clearMetrics } = require('../src/metrics');

const longText = 'x'.repeat(800);

function main() {
  const entry = recordRequest({
    id: 'req_metrics_failure',
    protocol: 'openai',
    model: 'test-local',
    upstream: 'fallback',
    upstreamModel: 'test-model',
    status: 400,
    success: false,
    stream: false,
    strategy: 'failover',
    error: longText,
    upstreamError: {
      status: 400,
      code: 'upstream_request_rejected',
      type: 'invalid_request_error',
      param: 'messages',
      message: longText,
      extra: '不应保留的字段'
    },
    attempts: [
      { upstream: 'primary', status: 503, error: { status: 503, message: 'primary unavailable' } },
      { upstream: 'fallback', status: 400, error: { status: 400, code: 'upstream_request_rejected', type: 'invalid_request_error', param: 'messages', message: longText } }
    ],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
  });

  assert.equal(entry.error.length, 500, '错误信息截断到 500 字符');
  assert.deepEqual(entry.upstreamError, {
    status: 400,
    code: 'upstream_request_rejected',
    type: 'invalid_request_error',
    param: 'messages',
    message: longText.slice(0, 300)
  }, '上游错误只保留约定字段并截断');
  assert.equal(entry.attempts[0].error.message, 'primary unavailable', '每次尝试都记录上游错误');
  assert.equal(entry.attempts[1].error.message.length, 300, '单次尝试的错误信息同样截断');

  const page = getLogs({ limit: 10 });
  const stored = page.items.find((item) => item.id === 'req_metrics_failure');
  assert.ok(stored, '分页接口应返回该记录');
  assert.deepEqual(stored.upstreamError, entry.upstreamError, '分页接口返回的上游错误必须与记录一致');
  assert.deepEqual(stored.attempts[1].error, entry.attempts[1].error, '克隆不能丢失每次尝试的上游错误');

  const success = recordRequest({ id: 'req_metrics_success', model: 'test-local', upstream: 'fallback', status: 200, success: true, usage: { total_tokens: 1 } });
  assert.equal('upstreamError' in success, false, '成功请求不记录上游错误');
  assert.equal('error' in success, false, '成功请求不记录错误信息');

  // 导入的用量记录同样要收敛 upstreamError，旧导出里混入的脏字段不能进日志。
  const imported = importUsageRecords([
    {
      id: 'req_metrics_imported',
      model: 'test-local',
      upstream: 'fallback',
      status: 429,
      success: false,
      error: '导入的失败记录',
      upstreamError: { status: 429, code: 'rate_limited', message: 'too many requests', dirty: true },
      usage: {},
      attempts: []
    }
  ]);
  assert.equal(imported.imported, 1);
  const importedEntry = getLogs({ limit: 10 }).items.find((item) => item.id === 'req_metrics_imported');
  assert.deepEqual(importedEntry.upstreamError, { status: 429, code: 'rate_limited', message: 'too many requests' });

  clearMetrics();
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log('metrics log tests passed');
}

try {
  main();
} catch (error) {
  try { clearMetrics(); } catch { /* 清理失败不应掩盖真正的测试失败 */ }
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.error(error.stack || error.message);
  process.exitCode = 1;
}