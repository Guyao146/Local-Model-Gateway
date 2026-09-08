const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  groupModelsByPrefix,
  mergeModelsById,
  modelGroupKey,
  modelPrefix,
  modelSelectionKey,
  pooledUpstreamIds,
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

const threeStationModel = mergeModelsById([
  { id: 'up-1', name: '站点一', protocol: 'openai', models: [{ id: 'pool-model' }] },
  { id: 'up-2', name: '站点二', protocol: 'openai', models: [{ id: 'pool-model' }] },
  { id: 'up-3', name: '站点三', protocol: 'openai', models: [{ id: 'pool-model' }] }
]).find((model) => model.id === 'pool-model');
const threeStationIds = ['up-1', 'up-2', 'up-3'];
assert.deepEqual(pooledUpstreamIds({ upstreamIds: ['up-1', 'up-3'] }, threeStationIds), ['up-1', 'up-3'], '应保留用户勾选的轮询站点');
assert.deepEqual(pooledUpstreamIds({ upstreamIds: ['up-1', 'gone'] }, threeStationIds), threeStationIds, '仅剩一个有效站点时回退为全部站点');
assert.deepEqual(pooledUpstreamIds({}, threeStationIds), threeStationIds, '没有保存过轮询池时使用全部站点');
assert.deepEqual(pooledUpstreamIds({ upstreamIds: ['up-3', 'up-1'] }, threeStationIds), ['up-3', 'up-1'], '轮询池应保留用户设置的站点优先级');

const narrowedDraft = new Map([['pool-model', {
  upstreamId: 'up-1',
  upstreamIds: ['up-1', 'up-3'],
  upstreamMode: 'auto',
  upstreamModel: 'pool-model',
  localModel: 'pool-model',
  thinkingLevel: 'auto',
  enabled: true
}]]);
const narrowedAfterBatch = setUnifiedModelsSelected(narrowedDraft, [threeStationModel], true).get('pool-model');
assert.equal(narrowedAfterBatch.upstreamMode, 'auto');
assert.deepEqual(narrowedAfterBatch.upstreamIds, ['up-1', 'up-3'], '批量勾选不应把已缩小的轮询池恢复为全部站点');

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
assert.ok(appSource.includes('data-action="pool-provider"'), '自动选择应支持勾选参与轮询的上游站点');
assert.ok(appSource.includes('/api/admin/metrics/logs'), '应支持分页加载请求日志');
assert.ok(appSource.includes('/api/admin/metrics/export?scope='), '应支持导出近 100 条和全部用量记录');
assert.ok(appSource.includes('provider-priority'), '模型应支持调整来源站使用优先级');
assert.ok(appSource.includes("event.key === 'F5'"), '管理页面应支持 F5 刷新');
assert.equal(appSource.includes('upstreamIds: providerIds'), false, '保存后不应把轮询池重置为全部站点');
assert.ok(appSource.includes('pooledUpstreamIds(selection, providerIds)'), '重建草稿时应沿用已保存的轮询池');

console.log('model group tests passed');