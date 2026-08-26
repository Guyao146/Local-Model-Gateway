const assert = require('node:assert/strict');
const { strategyFor, orderCandidates, resetRoutingState } = require('../src/routing');

const candidates = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

assert.equal(strategyFor({ id: 'legacy' }), 'failover');
assert.deepEqual(orderCandidates({ id: 'failover', strategy: 'failover' }, candidates).map((item) => item.id), ['a', 'b', 'c']);

resetRoutingState();
const roundRobinRoute = { id: 'round-robin-test', strategy: 'round_robin' };
assert.deepEqual(orderCandidates(roundRobinRoute, candidates).map((item) => item.id), ['a', 'b', 'c']);
assert.deepEqual(orderCandidates(roundRobinRoute, candidates).map((item) => item.id), ['b', 'c', 'a']);
assert.deepEqual(orderCandidates(roundRobinRoute, candidates).map((item) => item.id), ['c', 'a', 'b']);
resetRoutingState(roundRobinRoute.id);
assert.deepEqual(orderCandidates(roundRobinRoute, candidates).map((item) => item.id), ['a', 'b', 'c']);

resetRoutingState();
const weightedRoute = { id: 'weighted-test', strategy: 'weighted', upstreamWeights: { a: 2, b: 1, c: 1 } };
const weightedFirstCandidates = [];
for (let index = 0; index < 8; index += 1) {
  weightedFirstCandidates.push(orderCandidates(weightedRoute, candidates)[0].id);
}
assert.equal(weightedFirstCandidates.filter((id) => id === 'a').length, 4);
assert.equal(weightedFirstCandidates.filter((id) => id === 'b').length, 2);
assert.equal(weightedFirstCandidates.filter((id) => id === 'c').length, 2);

resetRoutingState();
const invalidRoute = { id: 'invalid', strategy: 'unknown' };
assert.deepEqual(orderCandidates(invalidRoute, candidates).map((item) => item.id), ['a', 'b', 'c']);

console.log('routing tests passed');