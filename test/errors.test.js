const assert = require('node:assert/strict');
const {
  errorMessage,
  errorCode,
  isErrorPayload,
  formatErrorMessage,
  formatErrorPayload,
  errorForProtocol,
  streamErrorForProtocol
} = require('../src/errors');

const context = { prefix: '[TestGateway]', requestId: 'req_test', status: 429 };
const source = Object.freeze({
  request_id: 'upstream_request',
  error: Object.freeze({ message: '配额不足\n请稍后重试', code: 'quota_exceeded', type: 'rate_limit_error', param: null }),
  extra: 'preserved'
});
const formatted = formatErrorPayload(source, context);
assert.deepEqual(formatted, {
  ...source,
  request_id: 'req_test',
  error: { ...source.error, message: '[TestGateway] [request_id=req_test] [code=quota_exceeded] 配额不足\n请稍后重试' }
});
assert.equal(source.error.message, '配额不足\n请稍后重试');
assert.equal(source.request_id, 'upstream_request');
assert.deepEqual(formatErrorPayload(formatted, context), formatted, '重复格式化不能重复前缀或请求信息');
assert.equal(formatErrorMessage('[TestGateway] already prefixed', { ...context, code: '502' }),
  '[TestGateway] [request_id=req_test] [code=502] already prefixed');
assert.equal(formatErrorMessage('[request_id=req_test] [code=502] original', { ...context, code: '502' }),
  '[TestGateway] [request_id=req_test] [code=502] original');
assert.equal(formatErrorMessage('original', { prefix: '', requestId: 'req_test', code: '400' }),
  '[request_id=req_test] [code=400] original');

for (const [body, status, expected] of [
  [{ error: { code: 'quota', type: 'rate_limit_error' }, code: 'outer' }, 429, 'quota'],
  [{ error: { code: 0 } }, 400, '0'],
  [{ error: { code: 123 } }, 400, '123'],
  [{ response: { error: { code: 'server_error' } } }, 200, 'server_error'],
  [{ code: 'top_level' }, 200, 'top_level'],
  [{ error: { code: null }, code: 'outer' }, 400, 'outer'],
  [{ error: { code: '', type: 'authentication_error' } }, 401, '401'],
  [{ error: { code: '   ' } }, 404, '404'],
  [{ error: { code: false } }, 400, '400'],
  [{ error: { code: {} } }, 503, '503'],
  [{ error: { type: 'overloaded_error' } }, 200, '502'],
  [null, undefined, '502']
]) assert.equal(errorCode(body, status), expected);

assert.equal(errorMessage({ error: 'string error' }), 'string error');
assert.equal(errorMessage('text error'), 'text error');
assert.equal(errorMessage({ response: { error: { message: 'failed response' } } }), 'failed response');
assert.equal(errorMessage(null, 'fallback'), 'fallback');
for (const body of [source, { type: 'error', message: 'failed' }, { type: 'response.failed' }, { response: { status: 'failed' } }]) {
  assert.equal(isErrorPayload(body), true);
}
assert.equal(isErrorPayload({ message: 'failed' }, 'error'), true);
for (const body of [null, 'text', { error: null }, { type: 'response.completed', response: { error: null, status: 'completed' } }, { choices: [] }]) {
  assert.equal(isErrorPayload(body), false);
}

const nativeFailure = {
  type: 'response.failed', sequence_number: 7,
  response: { id: 'resp_not_request_id', status: 'failed', output: [], error: { code: 'server_error', message: 'failed response' } }
};
const nativeFormatted = formatErrorPayload(nativeFailure, { ...context, status: 200 });
assert.equal(nativeFormatted.type, 'response.failed');
assert.equal(nativeFormatted.sequence_number, 7);
assert.equal(nativeFormatted.response.id, 'resp_not_request_id');
assert.equal(nativeFormatted.response.error.code, 'server_error');
assert.equal(nativeFormatted.response.error.message, '[TestGateway] [request_id=req_test] [code=server_error] failed response');
assert.equal(nativeFailure.response.error.message, 'failed response');
assert.deepEqual(formatErrorPayload(nativeFormatted, { ...context, status: 200 }), nativeFormatted);

const flatError = { type: 'error', code: 'invalid_request', message: 'bad parameter', param: 'model', sequence_number: 1 };
const flatFormatted = formatErrorPayload(flatError, context);
assert.equal(flatFormatted.error, undefined);
assert.equal(flatFormatted.message, '[TestGateway] [request_id=req_test] [code=invalid_request] bad parameter');
assert.equal(flatFormatted.param, 'model');
assert.equal(flatFormatted.sequence_number, 1);

for (const protocol of ['openai', 'responses', 'anthropic']) {
  const converted = errorForProtocol(protocol, source, 429);
  assert.deepEqual(converted.error, source.error);
  assert.equal(converted.extra, 'preserved');
  if (protocol === 'anthropic') assert.equal(converted.type, 'error');
  const textError = errorForProtocol(protocol, 'unavailable', 502);
  assert.equal(textError.error.message, 'unavailable');
  assert.equal(textError.error.type, protocol === 'anthropic' ? 'api_error' : 'upstream_error');
  const nativeConverted = errorForProtocol(protocol, nativeFailure, 502);
  assert.equal(nativeConverted.error.message, 'failed response');
  assert.equal(nativeConverted.error.code, 'server_error');
}
assert.deepEqual(streamErrorForProtocol('responses', source), {
  type: 'error', code: 'quota_exceeded', message: source.error.message, param: null
});
assert.equal(streamErrorForProtocol('responses', { error: { message: 'connection reset' } }).code, '502');
assert.equal(streamErrorForProtocol('anthropic', source).error.type, 'rate_limit_error');
assert.equal(streamErrorForProtocol('openai', source).error.code, 'quota_exceeded');

console.log('error formatting tests passed');