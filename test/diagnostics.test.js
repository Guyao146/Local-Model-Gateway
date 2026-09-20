const assert = require('node:assert/strict');
const {
  createDiagnostics,
  sample,
  scanIds,
  normalizeIdsInPlace,
  captureUpstreamRequest,
  captureUpstreamEvent,
  attachOutputCapture
} = require('../src/diagnostics');

// 模拟一个可写的 SSE 响应：收集所有写入，不真正发送。
function fakeResponse() {
  const written = [];
  let ended = false;
  return {
    write: (chunk) => { written.push(String(chunk)); return true; },
    end: (chunk) => { if (chunk !== undefined && chunk !== null) written.push(String(chunk)); ended = true; },
    __written: written,
    __ended: ended
  };
}

function main() {
  // scanIds 能定位数字、布尔、对象类型的 id 字段；null/undefined 视为可空、不报告。
  const bad = [];
  scanIds({ id: 12345, choices: [{ delta: { tool_calls: [{ id: null, call_id: 7 }] } }], ok: 'fine' }, '$', bad);
  assert.equal(bad.length, 2, `应发现 2 处非字符串 id（数字 id 与数字 call_id），实际 ${bad.length}`);
  assert.ok(bad.some((item) => item.path === '$.id' && item.value === 12345));
  assert.ok(bad.some((item) => item.path === '$.choices[0].delta.tool_calls[0].call_id' && item.value === 7));
  // 字符串 id 与不存在的 id 字段都不算问题。
  const clean = [];
  scanIds({ id: 'chatcmpl_ok', choices: [{ delta: { tool_calls: [{ index: 0 }] } }] }, '$', clean);
  assert.equal(clean.length, 0);

  // normalizeIdsInPlace 把数字转成字符串，对象序列化，字符串保持不变。
  const target = { id: 12345, output: [{ call_id: { weird: true }, item_id: 'keep' }] };
  normalizeIdsInPlace(target);
  assert.equal(typeof target.id, 'string');
  assert.equal(target.id, '12345');
  assert.equal(typeof target.output[0].call_id, 'string');
  assert.equal(target.output[0].item_id, 'keep');

  // attachOutputCapture：坏帧被改写并告警，好帧逐字透传。
  const res = fakeResponse();
  const diag = createDiagnostics();
  attachOutputCapture(res, diag);
  res.write('data: {"id": 67890, "object": "chat.completion.chunk", "choices": []}\n\n');
  res.write('event: response.created\ndata: {"type": "response.created", "response": {"id": "resp_ok"}}\n\n');
  res.write(': keepalive comment\n\n');
  res.write('data: not-json-at-all\n\n');
  res.end('data: [DONE]\n\n');
  const output = res.__written.join('');
  assert.ok(!output.includes('"id": 67890'), '数字 id 不应出现在输出中');
  assert.ok(output.includes('"id":"67890"'), '数字 id 应被改写为字符串');
  assert.ok(/data: \{"id":"67890"[^\n]*\}\n\n/.test(output), '修正后的帧仍应以 \\n\\n 帧分隔符结尾');
  assert.ok(output.includes('event: response.created\ndata: {"type": "response.created", "response": {"id": "resp_ok"}}\n\n'), '正常帧应连同分隔符逐字透传');
  assert.ok(output.includes('data: [DONE]'));
  assert.ok(diag.warnings.length >= 1, '应记录至少一条警告');
  assert.ok(diag.warnings.some((message) => message.includes('$.id') && message.includes('67890')), `警告应指出字段路径，实际：${JSON.stringify(diag.warnings)}`);
  assert.ok(diag.output.length >= 1, '应采样输出帧');

  // 正常帧语义不变（字段、值逐项相等），坏帧被改写。
  const goodFrame = res.__written.find((frame) => frame.includes('resp_ok'));
  const goodData = goodFrame.split('\n').find((line) => line.startsWith('data:')).slice(5).trim();
  assert.deepEqual(JSON.parse(goodData), { type: 'response.created', response: { id: 'resp_ok' } });
  assert.ok(diag.warnings.length >= 1, '应记录至少一条警告');
  assert.ok(diag.warnings.some((message) => message.includes('$.id') && message.includes('67890')), `警告应指出字段路径，实际：${JSON.stringify(diag.warnings)}`);
  assert.ok(diag.output.length >= 1, '应采样输出帧');

  // sample 只保留开头若干帧并做总量截断。
  const list = [];
  for (let index = 0; index < 50; index += 1) sample(list, `frame-${index}-padding`.padEnd(50, 'x'));
  assert.ok(list.length <= 12, `采样帧数应受上限约束，实际 ${list.length}`);
  assert.equal(list[0], 'frame-0-padding'.padEnd(50, 'x'), '应保留最早的帧');

  // captureUpstreamRequest 记录路径、协议与请求体。
  const diag2 = createDiagnostics();
  captureUpstreamRequest(diag2, {
    endpoint: 'https://aggregator.example.com/v1/responses',
    body: { model: 'm', reasoning: { effort: 'medium' }, tools: [] },
    nativeResponses: true,
    responsesMode: 'auto'
  });
  assert.equal(diag2.upstreamPath, '/v1/responses');
  assert.equal(diag2.nativeResponses, true);
  assert.ok(diag2.upstreamRequest.includes('"reasoning":{"effort":"medium"}'));

  // captureUpstreamEvent 采样上游事件。
  const diag3 = createDiagnostics();
  captureUpstreamEvent(diag3, { type: 'response.created', response: { id: 12345 } });
  assert.equal(diag3.upstreamResponse.length, 1);
  assert.ok(diag3.upstreamResponse[0].includes('12345'));

  // 捕获抛异常时必须退化透传，不能吞掉响应。
  const boom = fakeResponse();
  boom.write = () => { throw new Error('boom'); };
  const diag4 = createDiagnostics();
  attachOutputCapture(boom, diag4);
  // 用一个无法 JSON.parse 但能触发流程的帧；内部 originalWrite 抛错时应记录告警而不中断。
  let survived = true;
  try {
    boom.write('data: {"id": 1}\n\n');
  } catch {
    survived = false;
  }
  assert.ok(survived, '采样失败不应把异常抛给调用方');
  assert.ok(diag4.warnings.length >= 1);

  console.log('diagnostics tests passed');
}

main();
