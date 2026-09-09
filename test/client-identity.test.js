const assert = require('node:assert/strict');
const {
  clientIdentityHeaders,
  normalizeClientIdentity
} = require('../src/client-identity');

assert.deepEqual(normalizeClientIdentity(undefined, undefined), { preset: 'default', userAgent: '' });
assert.deepEqual(clientIdentityHeaders({ clientIdentityPreset: 'default' }), {});
assert.deepEqual(clientIdentityHeaders({ clientIdentityPreset: 'claude_code' }), { 'User-Agent': 'claude-code' });
assert.deepEqual(clientIdentityHeaders({ clientIdentityPreset: 'codex_cli' }), {
  'User-Agent': 'codex_cli_rs',
  originator: 'codex_cli_rs'
});
assert.deepEqual(clientIdentityHeaders({ clientIdentityPreset: 'cherry_studio' }), { 'User-Agent': 'CherryStudio' });
assert.deepEqual(clientIdentityHeaders({ clientIdentityPreset: 'custom', customUserAgent: 'MyClient/1.2' }), { 'User-Agent': 'MyClient/1.2' });
assert.throws(() => normalizeClientIdentity('unknown-client', ''), /不支持的客户端兼容标识/);
assert.throws(() => normalizeClientIdentity('custom', ''), /必须填写 User-Agent/);
assert.throws(() => normalizeClientIdentity('custom', 'safe\r\ninjected: value'), /控制字符/);
assert.throws(() => normalizeClientIdentity('custom', 'safe\tvalue'), /控制字符/);
assert.throws(() => normalizeClientIdentity('custom', 'x'.repeat(301)), /300 个字符/);

const fs = require('node:fs');
const path = require('node:path');
const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
assert.ok(htmlSource.includes('id="upstreamClientIdentityPreset"'));
assert.ok(htmlSource.includes('id="upstreamCustomUserAgent"'));
assert.ok(htmlSource.includes('id="upstreamResponsesMode"'));
for (const mode of ['auto', 'native', 'chat']) {
  assert.ok(htmlSource.includes(`value="${mode}"`), `Responses API 表单缺少模式：${mode}`);
}
for (const preset of ['claude_code', 'codex_cli', 'cherry_studio', 'custom']) {
  assert.ok(htmlSource.includes(`value="${preset}"`), `表单缺少客户端预设：${preset}`);
}
assert.ok(appSource.includes("$('#upstreamClientIdentityPreset').addEventListener('change', updateClientIdentityFields)"));
assert.ok(appSource.includes("clientIdentityPreset: $('#upstreamClientIdentityPreset').value"));

console.log('client identity tests passed');