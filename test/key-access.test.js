const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeKeyAccess, modelRoute, keyAccessModels, isKeyModelAllowed } = require('../public/key-access');

assert.deepEqual(normalizeKeyAccess(), { modelAccessMode: 'all', allowedGroups: [], allowedModels: [] });
const custom = normalizeKeyAccess({ modelAccessMode: 'custom', allowedGroups: [' GPT ', 'gpt'], allowedModels: [' GPT-4o ', 'gpt-4O'] });
assert.deepEqual(custom, { modelAccessMode: 'custom', allowedGroups: ['gpt'], allowedModels: ['GPT-4o'] });
assert.deepEqual(normalizeKeyAccess({ name: 'renamed' }, custom), custom);
assert.deepEqual(normalizeKeyAccess({ allowedModels: [] }, custom).allowedModels, []);
for (const input of [{ modelAccessMode: 'oops' }, { modelAccessMode: null }, { allowedGroups: 'gpt' }, { allowedModels: null }, { allowedModels: [null] }, { allowedGroups: [' '] }, { allowedModels: [{}] }]) {
  assert.throws(() => normalizeKeyAccess(input), { statusCode: 400 });
}
const config = {
  upstreams: [{ models: ['gpt-4o', 'GPT-4O', 'claude-sonnet'] }, { enabled: false, models: ['hidden-model'] }],
  routes: [
    { localModel: 'assistant', upstreamModel: 'gpt-4o' },
    { localModel: 'other-alias', upstreamModel: 'gpt-4o' },
    { localModel: 'off-alias', upstreamModel: 'gpt-4o', enabled: false }
  ],
  modelSelections: []
};
const models = keyAccessModels(config);
assert.deepEqual(models.map((model) => model.id), ['assistant', 'other-alias', 'gpt-4o', 'claude-sonnet']);
assert.equal(models[0].group, 'gpt');
assert.equal(modelRoute(config, 'ASSISTANT'), config.routes[0]);
assert.equal(isKeyModelAllowed({}, 'anything', config), true, '旧 Key 不限制');
assert.equal(isKeyModelAllowed(null, 'gpt-4o', config), false);
assert.equal(isKeyModelAllowed({ modelAccessMode: 'bad' }, 'gpt-4o', config), false);
assert.equal(isKeyModelAllowed(custom, 'gpt-4o', config), true);
assert.equal(isKeyModelAllowed(custom, 'GPT-4O', config), true);
assert.equal(isKeyModelAllowed(custom, 'assistant', config), false, '上游 ID 授权不扩展到别名');
const alias = { ...custom, allowedModels: ['assistant'] };
assert.equal(isKeyModelAllowed(alias, 'ASSISTANT', config), true);
for (const id of ['gpt-4o', 'other-alias', 'off-alias', 'hidden-model', 'not-known']) assert.equal(isKeyModelAllowed(alias, id, config), false, id);
assert.equal(isKeyModelAllowed({ ...alias, allowedGroups: [] }, 'assistant', config), false);
assert.equal(isKeyModelAllowed({ ...alias, allowedModels: [] }, 'assistant', config), false);
assert.equal(isKeyModelAllowed({ ...alias, allowedGroups: ['assistant'] }, 'assistant', config), false, '分组取目标模型前缀');
assert.deepEqual(keyAccessModels({ ...config, modelSelectionMode: true }).map((model) => model.id), ['assistant', 'other-alias']);
assert.equal(isKeyModelAllowed(custom, 'gpt-4o', { ...config, modelSelectionMode: true }), false, '自定义 Key 只允许已发布模型');
const wildcard = { ...config, routes: [...config.routes, { localModel: '*', upstreamModel: 'claude-sonnet' }] };
assert.equal(isKeyModelAllowed(custom, 'gpt-4o', wildcard), false, '通配路由改变目标时不能沿用原分组');
assert.equal(isKeyModelAllowed(alias, 'assistant', wildcard), true, '精确路由优先');
assert.equal(isKeyModelAllowed({ ...alias, allowedModels: ['unknown'] }, 'unknown', wildcard), false);
const renamedTarget = { ...config, routes: [{ localModel: 'assistant', upstreamModel: 'claude-sonnet' }] };
assert.equal(isKeyModelAllowed(alias, 'assistant', renamedTarget), false, '跨组改路由不会自动放权');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
assert.ok(html.indexOf('/model-groups.js') < html.indexOf('/key-access.js'));
assert.ok(html.indexOf('/key-access.js') < html.indexOf('/app.js'));
const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
for (const action of ['key-toggle-group', 'key-select-group', 'key-clear-group']) assert.ok(app.includes(`data-action="${action}"`));
for (const form of ['keyForm', 'keyEditForm']) {
  assert.ok(app.includes(`...keyAccessPayload($('#${form}'))`));
  assert.ok(app.includes(`bindKeyAccessForm($('#${form}'))`));
}
assert.ok(app.includes('!input.disabled'), '未启用分组下保持勾选的模型不能计入权限');
console.log('key access tests passed');
