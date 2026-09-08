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

  function unifiedModelSelectionKey(modelId) {
    return String(modelId || '').trim();
  }

  // Round-robin pool for a model: keep the stations that were already picked, drop
  // stations that no longer provide the model, and fall back to every provider when
  // fewer than two remain (a pool of one cannot round-robin).
  function pooledUpstreamIds(selection, providerIds) {
    const saved = Array.isArray(selection?.upstreamIds) ? selection.upstreamIds.map(String) : [];
    const kept = providerIds.filter((id) => saved.includes(id));
    return kept.length >= 2 ? saved.filter((id) => kept.includes(id)) : providerIds;
  }

  function mergeModelsById(upstreams) {
    const merged = new Map();
    for (const upstream of Array.isArray(upstreams) ? upstreams : []) {
      for (const model of Array.isArray(upstream?.models) ? upstream.models : []) {
        const id = String(model?.id || '').trim();
        if (!id) continue;
        if (!merged.has(id)) {
          merged.set(id, {
            id,
            name: String(model.name || id),
            ownedBy: String(model.ownedBy || ''),
            supportsThinking: model.supportsThinking,
            providers: []
          });
        }
        const item = merged.get(id);
        if (model.supportsThinking === true) item.supportsThinking = true;
        else if (item.supportsThinking !== true && model.supportsThinking === null) item.supportsThinking = null;
        item.providers.push({
          id: String(upstream.id),
          name: String(upstream.name || upstream.id),
          protocol: String(upstream.protocol || ''),
          enabled: upstream.enabled !== false,
          model
        });
      }
    }
    return [...merged.values()].sort((left, right) => left.id.localeCompare(right));
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

  function setUnifiedModelsSelected(draft, models, selected) {
    const next = new Map(draft instanceof Map ? draft : []);
    for (const model of Array.isArray(models) ? models : []) {
      const modelId = String(model?.id || '').trim();
      if (!modelId) continue;
      const key = unifiedModelSelectionKey(modelId);
      if (!selected) {
        next.delete(key);
        continue;
      }
      const providerIds = (model.providers || []).map((provider) => String(provider.id));
      if (!providerIds.length) continue;
      const previous = next.get(key) || {};
      const previousProviderId = providerIds.includes(previous.upstreamId) ? previous.upstreamId : providerIds[0];
      const automatic = providerIds.length > 1 && (!previous.upstreamMode || previous.upstreamMode === 'auto');
      // Batch selection must not widen an existing round-robin pool back to every station.
      const pooledIds = pooledUpstreamIds(previous, providerIds);
      next.set(key, {
        ...previous,
        upstreamId: automatic ? pooledIds[0] : previousProviderId,
        upstreamIds: automatic ? pooledIds : [previousProviderId],
        upstreamMode: automatic ? 'auto' : 'fixed',
        upstreamModel: modelId,
        localModel: previous.localModel || modelId,
        thinkingLevel: previous.thinkingLevel || 'auto',
        enabled: true
      });
    }
    return next;
  }

  return {
    groupModelsByPrefix,
    mergeModelsById,
    modelGroupKey,
    modelPrefix,
    modelSelectionKey,
    pooledUpstreamIds,
    setModelsSelected,
    setUnifiedModelsSelected,
    unifiedModelSelectionKey
  };
}));