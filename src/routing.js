const STRATEGIES = new Set(['failover', 'round_robin', 'random', 'weighted']);
const roundRobinCursors = new Map();
const weightedStates = new Map();

function strategyFor(route) {
  return route && STRATEGIES.has(route.strategy) ? route.strategy : 'failover';
}

function routeKey(route, candidates) {
  return `${route?.id || 'implicit'}:${candidates.map((item) => item.id).join(',')}:${JSON.stringify(route?.upstreamWeights || {})}`;
}

function randomOrder(candidates) {
  const result = [...candidates];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function weightedOrder(route, candidates) {
  const weights = route?.upstreamWeights || {};
  const totalWeight = candidates.reduce((sum, candidate) => sum + Math.max(1, Number(weights[candidate.id]) || 1), 0);
  const key = routeKey(route, candidates);
  const state = weightedStates.get(key) || new Map();
  let selected = null;
  let selectedScore = -Infinity;
  for (const candidate of candidates) {
    const weight = Math.max(1, Number(weights[candidate.id]) || 1);
    const score = (state.get(candidate.id) || 0) + weight;
    state.set(candidate.id, score);
    if (score > selectedScore) {
      selected = candidate;
      selectedScore = score;
    }
  }
  state.set(selected.id, (state.get(selected.id) || 0) - totalWeight);
  weightedStates.set(key, state);
  return [selected, ...candidates.filter((candidate) => candidate !== selected)];
}

function orderCandidates(route, candidates) {
  if (candidates.length < 2) return [...candidates];
  const strategy = strategyFor(route);
  if (strategy === 'random') return randomOrder(candidates);
  if (strategy === 'weighted') return weightedOrder(route, candidates);
  if (strategy === 'round_robin') {
    const key = route?.id || 'implicit';
    const start = (roundRobinCursors.get(key) || 0) % candidates.length;
    roundRobinCursors.set(key, start + 1);
    return candidates.slice(start).concat(candidates.slice(0, start));
  }
  return [...candidates];
}

function resetRoutingState(routeId) {
  if (!routeId) {
    roundRobinCursors.clear();
    weightedStates.clear();
    return;
  }
  roundRobinCursors.delete(routeId);
  for (const key of weightedStates.keys()) {
    if (key.startsWith(`${routeId}:`)) weightedStates.delete(key);
  }
}

module.exports = {
  STRATEGIES,
  strategyFor,
  orderCandidates,
  resetRoutingState
};