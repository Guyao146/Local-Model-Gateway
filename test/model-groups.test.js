const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  groupModelsByPrefix,
  modelGroupKey,
  modelPrefix,
  modelSelectionKey,
  setModelsSelected
} = require('../public/model-groups');

assert.equal(modelPrefix('gpt-4o'), 'gpt');
assert.equal(modelPrefix('GPT_5'), 'gpt');
assert.equal(modelPrefix('claude:sonnet'), 'claude');
assert.equal(modelPrefix('openai/gpt-4o'), 'openai');
assert.equal(modelPrefix('o3-mini'), 'o3');
assert.equal(modelPrefix('model'), 'model');
assert.equal(modelPrefix('/invalid'), '其他');

const models = [
  { id: 'gpt-4o' },
  { id: 'claude-3-7-sonnet' },
  { id: 'gpt-4.1' },
  { id: 'o3-mini' }
];
const groups = groupModelsByPrefix(models);
assert.deepEqual(groups.map((group) => group.prefix), ['claude', 'gpt', 'o3']);
assert.deepEqual(groups.find((group) => group.prefix === 'gpt').models.map((model) => model.id), ['gpt-4o', 'gpt-4.1']);

const existingKey = modelSelectionKey('up-1', 'gpt-4o');
const original = new Map([[existingKey, {
  upstreamId: 'up-1',
  upstreamModel: 'gpt-4o',
  localModel: 'my-gpt',
  thinkingLevel: 'high'
}]]);
const selected = setModelsSelected(original, 'up-1', groups.find((group) => group.prefix === 'gpt').models, true);
assert.equal(selected.size, 2);
assert.equal(selected.get(existingKey).localModel, 'my-gpt');
assert.equal(selected.get(existingKey).thinkingLevel, 'high');
assert.equal(selected.get(modelSelectionKey('up-1', 'gpt-4.1')).localModel, 'gpt-4.1');
assert.equal(original.size, 1, '批量操作不应原地修改已有草稿');

const cleared = setModelsSelected(selected, 'up-1', groups.find((group) => group.prefix === 'gpt').models, false);
assert.equal(cleared.size, 0);
assert.notEqual(modelGroupKey('up-1', 'gpt'), modelGroupKey('up-2', 'gpt'));

const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
assert.match(appSource, /expandedProviders: new Set\(\)/, '上游默认应全部收起');
assert.match(appSource, /expandedPrefixes: new Set\(\)/, '前缀默认应全部收起');
for (const action of ['toggle-provider', 'toggle-prefix', 'select-provider', 'clear-provider', 'select-prefix', 'clear-prefix']) {
  assert.ok(appSource.includes(`data-action="${action}"`), `缺少模型目录操作：${action}`);
}
assert.ok(appSource.includes('aria-expanded="${state.expandedProviders.has(provider.id)}"'));
assert.ok(appSource.includes('aria-expanded="${state.expandedPrefixes.has(prefixKey)}"'));

console.log('model group tests passed');