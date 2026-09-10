const assert = require('node:assert/strict');
const {
  isLoopbackAddress,
  normalizeAddress,
  requestSource,
  trustedProxySet
} = require('../src/admin-auth');

function request(remoteAddress, headers = {}) {
  return { socket: { remoteAddress }, headers };
}

assert.equal(normalizeAddress('::ffff:127.0.0.1'), '127.0.0.1');
assert.equal(normalizeAddress('::1%0'), '::1');
assert.equal(isLoopbackAddress('127.0.0.25'), true);
assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
assert.equal(isLoopbackAddress('192.168.1.10'), false);

assert.deepEqual(requestSource(request('127.0.0.1')), {
  address: '127.0.0.1',
  socketAddress: '127.0.0.1',
  viaTrustedProxy: false,
  untrustedForwarding: false
});

const spoofed = requestSource(request('127.0.0.1', { 'x-forwarded-for': '127.0.0.1' }));
assert.equal(spoofed.address, '');
assert.equal(spoofed.untrustedForwarding, true);
assert.equal(isLoopbackAddress(spoofed.address), false);

const trusted = trustedProxySet('127.0.0.1, ::1');
const remote = requestSource(request('::ffff:127.0.0.1', { 'x-forwarded-for': '203.0.113.25' }), trusted);
assert.equal(remote.address, '203.0.113.25');
assert.equal(remote.viaTrustedProxy, true);
assert.equal(isLoopbackAddress(remote.address), false);

const proxiedLocal = requestSource(request('127.0.0.1', { 'x-forwarded-for': '127.0.0.8' }), trusted);
assert.equal(proxiedLocal.address, '127.0.0.8');
assert.equal(isLoopbackAddress(proxiedLocal.address), true);

const chain = requestSource(request('127.0.0.1', { 'x-forwarded-for': '198.51.100.20, 127.0.0.1' }), trusted);
assert.equal(chain.address, '198.51.100.20');

const diagnosticSource = requestSource(request('172.22.0.1', { 'x-forwarded-for': '203.0.113.10' }), trustedProxySet('127.0.0.1'));
assert.equal(diagnosticSource.socketAddress, '172.22.0.1');
assert.equal(diagnosticSource.viaTrustedProxy, false);

console.log('admin auth tests passed');