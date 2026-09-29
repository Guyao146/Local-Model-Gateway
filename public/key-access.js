(function exposeKeyAccess(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./model-groups'));
  else root.KeyAccess = factory(root.ModelGroups);
}(typeof globalThis !== 'undefined' ? globalThis : this, ({ modelPrefix, unifiedModelSelectionKey: modelKey }) => {
  function normalizeKeyAccess(input = {}, existing = {}) {
    const mode = input.modelAccessMode !== undefined ? input.modelAccessMode : (existing.modelAccessMode ?? 'all');
    const invalid = (message) => { throw Object.assign(new Error(message), { statusCode: 400 }); };
    if (!['all', 'custom'].includes(mode)) invalid('模型访问范围必须是 all 或 custom');
    const list = (field, lowerCase) => {
      const values = input[field] !== undefined ? input[field] : (existing[field] ?? []);
      if (!Array.isArray(values) || values.some((value) => typeof value !== 'string' || !value.trim())) {
        invalid(`${field} 必须是非空字符串组成的数组`);
      }
      const seen = new Set();
      return values.map((value) => lowerCase ? modelKey(value) : value.trim()).filter((value) => {
        const key = modelKey(value);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    };
    return { modelAccessMode: mode, allowedGroups: list('allowedGroups', true), allowedModels: list('allowedModels', false) };
  }

  // 鉴权与实际转发共用路由优先级，不能通过别名或改变大小写落到另一条路由。
  function modelRoute(config, model) {
    const routes = (config.routes || []).filter((route) => route.enabled !== false);
    return routes.find((route) => route.localModel === model)
      || routes.find((route) => route.localModel !== '*' && modelKey(route.localModel) === modelKey(model))
      || routes.find((route) => route.localModel === '*');
  }

  function keyAccessModels(config = {}) {
    const models = new Map();
    const add = (id) => {
      if (typeof id !== 'string' || !id.trim() || id === '*') return;
      const key = modelKey(id);
      if (models.has(key)) return;
      const route = modelRoute(config, id);
      const upstreamModel = route?.upstreamModel || id;
      models.set(key, { id, upstreamModel, group: modelPrefix(upstreamModel) });
    };
    for (const route of config.routes || []) if (route.enabled !== false) add(route.localModel);
    if (config.modelSelectionMode !== true) {
      for (const upstream of config.upstreams || []) {
        if (upstream.enabled !== false) for (const id of upstream.models || []) add(id);
      }
    }
    for (const selection of config.modelSelections || []) if (selection.enabled !== false) add(selection.localModel);
    return [...models.values()];
  }

  function isKeyModelAllowed(key, model, config, models = keyAccessModels(config)) {
    if (!key) return false;
    if (key.modelAccessMode === undefined || key.modelAccessMode === 'all') return true;
    if (key.modelAccessMode !== 'custom') return false;
    const entry = models.find((item) => modelKey(item.id) === modelKey(model));
    if (!entry) return false;
    // 模型名必须独立勾选；授权一个别名不隐含授权其上游 ID 或其他别名。
    const group = modelPrefix(modelRoute(config, model)?.upstreamModel || entry.upstreamModel);
    return (key.allowedGroups || []).some((item) => modelKey(item) === group)
      && (key.allowedModels || []).some((item) => modelKey(item) === modelKey(model));
  }

  return { normalizeKeyAccess, modelRoute, keyAccessModels, isKeyModelAllowed };
}));
