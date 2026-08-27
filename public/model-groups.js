(function exposeModelGroups(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ModelGroups = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  function modelPrefix(modelId) {
    const id = String(modelId || '').trim();
    const match = id.match(/^([^-_:/]+)/);
    return String(match?.[1] || '其他').toLowerCase();
  }

  function modelSelectionKey(upstreamId, modelId) {
    return JSON.stringify([String(upstreamId || ''), String(modelId || '')]);
  }

  function modelGroupKey(upstreamId, prefix) {
    return JSON.stringify([String(upstreamId || ''), String(prefix || '')]);
  }

  function groupModelsByPrefix(models) {
    const groups = new Map();
    for (const model of Array.isArray(models) ? models : []) {
      const prefix = modelPrefix(model?.id);
      if (!groups.has(prefix)) groups.set(prefix, []);
      groups.get(prefix).push(model);
    }
    return [...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([prefix, items]) => ({ prefix, models: items }));
  }

  function setModelsSelected(draft, upstreamId, models, selected) {
    const next = new Map(draft instanceof Map ? draft : []);
    for (const model of Array.isArray(models) ? models : []) {
      const modelId = String(model?.id || '').trim();
      if (!modelId) continue;
      const key = modelSelectionKey(upstreamId, modelId);
      if (!selected) {
        next.delete(key);
        continue;
      }
      const previous = next.get(key) || {};
      next.set(key, {
        ...previous,
        upstreamId: String(upstreamId),
        upstreamModel: modelId,
        localModel: previous.localModel || modelId,
        thinkingLevel: previous.thinkingLevel || 'auto',
        enabled: true
      });
    }
    return next;
  }

  return { groupModelsByPrefix, modelGroupKey, modelPrefix, modelSelectionKey, setModelsSelected };
}));