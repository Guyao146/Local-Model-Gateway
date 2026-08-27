const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  groupModelsByPrefix,
  mergeModelsById,
  modelGroupKey,
  modelPrefix,
  modelSelectionKey,
  setModelsSelected,
  setUnifiedModelsSelected,
  unifiedModelSelectionKey
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

const merged = mergeModelsById([
  { id: 'up-1', name: '站点一', protocol: 'openai', models: [{ id: 'shared-model', supportsThinking: false }, { id: 'only-one' }] },
  { id: 'up-2', name: '站点二', protocol: 'anthropic', models: [{ id: 'shared-model', supportsThinking: true }] }
]);
assert.deepEqual(merged.map((model) => model.id).sort(), ['only-one', 'shared-model'].sort());
const shared = merged.find((model) => model.id === 'shared-model');
assert.equal(shared.providers.length, 2, '同名模型应合并来源站');
assert.deepEqual(shared.providers.map((provider) => provider.name), ['站点一', '站点二']);
assert.equal(shared.supportsThinking, true, '任一来源支持思考时合并模型应标记支持');

const unifiedSelected = setUnifiedModelsSelected(new Map(), merged, true);
const sharedSelection = unifiedSelected.get(unifiedModelSelectionKey('shared-model'));
assert.equal(sharedSelection.upstreamMode, 'auto');
assert.deepEqual(sharedSelection.upstreamIds, ['up-1', 'up-2']);
assert.equal(unifiedSelected.get('only-one').upstreamMode, 'fixed');
const fixedDraft = new Map([['shared-model', { ...sharedSelection, upstreamMode: 'fixed', upstreamId: 'up-2', upstreamIds: ['up-2'] }]]);
const fixedSelected = setUnifiedModelsSelected(fixedDraft, [shared], true).get('shared-model');
assert.equal(fixedSelected.upstreamMode, 'fixed', '已固定的站点选择应保留');
assert.deepEqual(fixedSelected.upstreamIds, ['up-2']);

const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
assert.match(appSource, /expandedPrefixes: new Set\(\)/, '前缀默认应全部收起');
for (const action of ['toggle-prefix', 'select-prefix', 'clear-prefix', 'model-upstream']) {
  assert.ok(appSource.includes(`data-action="${action}"`), `缺少模型目录操作：${action}`);
}
assert.ok(appSource.includes('aria-expanded="${state.expandedPrefixes.has(prefixKey)}"'));
assert.equal(appSource.includes('⌄'), false, '折叠箭头不应再使用文字字符');
assert.ok(appSource.includes('class="prefix-arrow" aria-hidden="true"'));
assert.ok(appSource.includes('自动选择（${model.providers.length} 个站）'));
assert.equal(appSource.includes('data-action="toggle-provider"'), false, '模型目录不应再按上游重复分组');

console.log('model group tests passed');