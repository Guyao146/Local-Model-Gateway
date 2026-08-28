const state = {
  config: null,
  metrics: null,
  health: null,
  balances: null,
  catalog: null,
  expandedPrefixes: new Set(),
  modelSelectionDraft: null,
  logPage: null,
  loadingMoreLogs: false
};
const $ = (selector) => document.querySelector(selector);
const { groupModelsByPrefix, mergeModelsById, modelGroupKey, modelPrefix, pooledUpstreamIds, setUnifiedModelsSelected, unifiedModelSelectionKey } = window.ModelGroups;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function adminHeaders() {
  return { 'Content-Type': 'application/json' };
}

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { ...adminHeaders(), ...(options.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && body.error?.loginUrl) window.location.assign(body.error.loginUrl);
    throw new Error(body.error?.message || `请求失败（${response.status}）`);
  }
  return body;
}

function setMessage(message, type = '') {
  const element = $('#authMessage');
  element.textContent = message;
  element.className = `form-message ${type}`;
}

function toast(message, type = '') {
  const element = $('#toast');
  element.textContent = message;
  element.className = `toast show ${type}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { element.className = 'toast'; }, 3600);
}

function openDialog(dialog) {
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
}

function closeDialog(dialog) {
  if (!dialog) return;
  if (typeof dialog.close === 'function' && dialog.open) dialog.close();
  else dialog.removeAttribute('open');
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString();
}

function formatTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString();
}

function healthLabel(item) {
  if (!item) return '健康';
  if (item.state === 'open') return '已熔断';
  if (item.state === 'half-open') return '半开探测';
  return '健康';
}

function clientIdentityLabel(item) {
  return {
    default: '默认客户端',
    claude_code: 'Claude Code',
    codex_cli: 'Codex CLI',
    cherry_studio: 'Cherry Studio',
    custom: item?.customUserAgent || '自定义客户端'
  }[item?.clientIdentityPreset || 'default'] || '默认客户端';
}

function formatBalanceNumber(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '-';
  return Number(value).toLocaleString(undefined, { maximumFractionDigits: 6 });
}

function balanceDetails(item) {
  if (!item || item.state === 'idle') return '<span class="balance-status muted">余额：尚未查询</span>';
  if (item.state !== 'ok' || !item.balance) {
    const label = item.state === 'unsupported' ? '不支持余额查询' : '余额查询失败';
    const status = item.httpStatus ? `（HTTP ${item.httpStatus}）` : '';
    return `<span class="balance-status error-text">余额：${label}${escapeHtml(status)}</span><span class="balance-error-message" title="${escapeHtml(item.message || label)}">${escapeHtml(item.message || label)}</span>${item.checkedAt ? `<span>查询于：${escapeHtml(formatTime(item.checkedAt))}</span>` : ''}`;
  }
  if (item.balance.type === 'platform-quotas') {
    const windows = (item.balance.platforms || []).flatMap((platform) => (platform.windows || []).map((window) => {
      const limit = window.limit === null ? '未设上限' : `$${formatBalanceNumber(window.limit)}`;
      const remaining = window.remaining === null ? '' : ` · 剩余 $${formatBalanceNumber(window.remaining)}`;
      const reset = window.resetAt ? ` · ${formatTime(window.resetAt)} 重置` : '';
      return `${platform.platform} ${window.period}：已用 $${formatBalanceNumber(window.used)} / ${limit}${remaining}${reset}`;
    }));
    return `<span class="balance-status success-text">额度：${escapeHtml(windows.join('；') || '未设置平台额度')}</span><span>查询于：${escapeHtml(formatTime(item.checkedAt))}</span>`;
  }
  const balance = item.balance;
  const unit = balance.unit ? ` ${balance.unit}` : '';
  const remaining = balance.unlimited ? '无限' : `${formatBalanceNumber(balance.remaining)}${unit}`;
  const parts = [`剩余：${remaining}`];
  if (balance.used !== null) parts.push(`已用：${formatBalanceNumber(balance.used)}${unit}`);
  if (balance.granted !== null) parts.push(`总额度：${formatBalanceNumber(balance.granted)}${unit}`);
  if (balance.expiresAt) parts.push(`到期：${formatTime(balance.expiresAt)}`);
  return `<span class="balance-status success-text">${escapeHtml(parts.join(' · '))}</span><span>查询于：${escapeHtml(formatTime(item.checkedAt))}</span>`;
}

function thinkingLabel(level) {
  return { auto: '自动', off: '关闭', low: '低', medium: '中', high: '高' }[level] || '自动';
}

function catalogSelectionMap() {
  if (!(state.modelSelectionDraft instanceof Map)) {
    state.modelSelectionDraft = new Map();
    for (const item of state.catalog?.selections || []) {
      const key = unifiedModelSelectionKey(item.upstreamModel);
      if (!key) continue;
      const previous = state.modelSelectionDraft.get(key);
      const itemIds = Array.isArray(item.upstreamIds) && item.upstreamIds.length ? item.upstreamIds : [item.upstreamId];
      if (previous) {
        const upstreamIds = [...new Set([...(previous.upstreamIds || [previous.upstreamId]), ...itemIds].filter(Boolean))];
        state.modelSelectionDraft.set(key, {
          ...previous,
          upstreamId: upstreamIds[0],
          upstreamIds,
          upstreamMode: upstreamIds.length > 1 ? 'auto' : previous.upstreamMode
        });
        continue;
      }
      state.modelSelectionDraft.set(key, {
        ...item,
        upstreamMode: item.upstreamMode === 'auto' ? 'auto' : 'fixed',
        upstreamIds: itemIds
      });
    }
  }
  return state.modelSelectionDraft;
}

function reconcileModelSelectionDraft(catalog, reset = false) {
  if (reset) state.modelSelectionDraft = null;
  const selections = new Map(catalogSelectionMap());
  const models = mergeModelsById(catalog?.upstreams || []);
  const modelsById = new Map(models.map((model) => [model.id, model]));
  const reconciled = new Map();
  for (const [key, selection] of selections) {
    const model = modelsById.get(key);
    if (!model) continue;
    const providerIds = model.providers.map((provider) => provider.id);
    if (selection.upstreamMode === 'auto' && providerIds.length > 1) {
      // Keep the saved round-robin pool; only drop stations that no longer offer the model.
      const pooledIds = pooledUpstreamIds(selection, providerIds);
      reconciled.set(key, { ...selection, upstreamId: pooledIds[0], upstreamIds: pooledIds, upstreamMode: 'auto' });
    } else if (providerIds.includes(selection.upstreamId)) {
      reconciled.set(key, { ...selection, upstreamIds: [selection.upstreamId], upstreamMode: 'fixed' });
    }
  }
  state.modelSelectionDraft = reconciled;
}

function syncRenderedModelDraft() {
  const draft = catalogSelectionMap();
  for (const row of document.querySelectorAll('.model-row')) {
    const checkbox = row.querySelector('[data-action="toggle-model"]');
    if (!checkbox) continue;
    const modelId = checkbox.dataset.modelId;
    const key = unifiedModelSelectionKey(modelId);
    if (!checkbox.checked) {
      draft.delete(key);
      continue;
    }
    const previous = draft.get(key) || {};
    const upstreamSelect = row.querySelector('[data-action="model-upstream"]');
    const providerIds = [...upstreamSelect.options].map((option) => option.value).filter((value) => value !== '__auto__');
    const automatic = upstreamSelect.value === '__auto__' && providerIds.length > 1;
    let pooledIds = providerIds;
    if (automatic) {
      const checked = [...row.querySelectorAll('[data-action="pool-provider"]')].filter((box) => box.checked).map((box) => box.dataset.providerId);
      // Keep at least two stations in the pool; fall back to all when the user unchecked too many.
      pooledIds = checked.length >= 2 ? providerIds.filter((id) => checked.includes(id)) : providerIds;
    }
    const upstreamId = automatic ? pooledIds[0] : upstreamSelect.value;
    draft.set(key, {
      ...previous,
      upstreamId,
      upstreamIds: automatic ? pooledIds : [upstreamId],
      upstreamMode: automatic ? 'auto' : 'fixed',
      upstreamModel: modelId,
      localModel: row.querySelector('[data-action="model-alias"]')?.value.trim() || modelId,
      thinkingLevel: row.querySelector('[data-action="thinking-level"]')?.value || 'auto',
      enabled: true
    });
  }
}

function allUnifiedModels() {
  return mergeModelsById(state.catalog?.upstreams || []);
}

function filteredUnifiedModels(models) {
  const search = $('#modelCatalogSearch')?.value.trim().toLowerCase() || '';
  const thinkingOnly = Boolean($('#showThinkingModelsOnly')?.checked);
  return models.filter((model) => {
    const providerNames = model.providers.map((provider) => provider.name).join(' ');
    const matchesSearch = !search || `${providerNames} ${model.id} ${model.name} ${modelPrefix(model.id)}`.toLowerCase().includes(search);
    return matchesSearch && (!thinkingOnly || model.supportsThinking === true);
  });
}

function renderModelRow(model, selections) {
  const key = unifiedModelSelectionKey(model.id);
  const selection = selections.get(key);
  const selectedProvider = selection?.upstreamMode === 'auto' && model.providers.length > 1 ? '__auto__' : (selection?.upstreamId || (model.providers.length > 1 ? '__auto__' : model.providers[0]?.id));
  const providerOptions = `${model.providers.length > 1 ? `<option value="__auto__" ${selectedProvider === '__auto__' ? 'selected' : ''}>自动选择（${model.providers.length} 个站）</option>` : ''}${model.providers.map((provider) => `<option value="${escapeHtml(provider.id)}" ${selectedProvider === provider.id ? 'selected' : ''}>${escapeHtml(provider.name)} · ${escapeHtml(provider.protocol)}${provider.enabled ? '' : '（已停用）'}</option>`).join('')}`;
  const providerNames = model.providers.map((provider) => provider.name).join('、');
  const isAuto = selectedProvider === '__auto__';
  const providerIds = model.providers.map((provider) => provider.id);
  const pooledIds = new Set(isAuto ? pooledUpstreamIds(selection, providerIds) : []);
  const poolMarkup = model.providers.length > 1
    ? `<div class="model-pool${isAuto ? '' : ' hidden'}" data-role="model-pool"><span class="model-pool-label">轮询站点：</span>${model.providers.map((provider) => `<label class="model-pool-item${provider.enabled ? '' : ' disabled'}"><input type="checkbox" data-action="pool-provider" data-provider-id="${escapeHtml(provider.id)}" ${pooledIds.has(provider.id) ? 'checked' : ''}>${escapeHtml(provider.name)}${provider.enabled ? '' : '（已停用）'}</label>`).join('')}</div>`
    : '';
  return `<div class="model-row" data-model-key="${escapeHtml(key)}"><input type="checkbox" data-action="toggle-model" data-model-id="${escapeHtml(model.id)}" ${selection ? 'checked' : ''}><div><div class="model-name" title="${escapeHtml(model.id)}">${escapeHtml(model.id)}${model.providers.length > 1 ? `<span class="source-count-badge">${model.providers.length} 个站</span>` : ''}${model.supportsThinking === true ? '<span class="thinking-badge">支持思考</span>' : model.supportsThinking === null ? '<span class="thinking-badge thinking-unknown">能力未知</span>' : '<span class="thinking-badge thinking-disabled">不支持思考</span>'}</div><div class="model-info" title="${escapeHtml(providerNames)}">来源：${escapeHtml(providerNames)}</div></div><div class="model-controls"><select data-action="model-upstream" aria-label="${escapeHtml(model.id)} 的上游站点">${providerOptions}</select><input type="text" data-action="model-alias" value="${escapeHtml(selection?.localModel || model.id)}" placeholder="本地模型别名"><select data-action="thinking-level"><option value="auto" ${!selection || selection.thinkingLevel === 'auto' ? 'selected' : ''}>思考：自动</option><option value="off" ${selection?.thinkingLevel === 'off' ? 'selected' : ''}>思考：关闭</option><option value="low" ${selection?.thinkingLevel === 'low' ? 'selected' : ''}>思考：低</option><option value="medium" ${selection?.thinkingLevel === 'medium' ? 'selected' : ''}>思考：中</option><option value="high" ${selection?.thinkingLevel === 'high' ? 'selected' : ''}>思考：高</option></select></div>${poolMarkup}</div>`;
}

function renderPrefixGroup(prefix, visibleModels, allModels, selections) {
  const prefixKey = modelGroupKey('unified', prefix);
  const completeModels = allModels.filter((model) => modelPrefix(model.id) === prefix);
  const selectedCount = completeModels.filter((model) => selections.has(unifiedModelSelectionKey(model.id))).length;
  const collapsed = state.expandedPrefixes.has(prefixKey) ? '' : ' collapsed';
  return `<section class="model-prefix${collapsed}" data-prefix-key="${escapeHtml(prefixKey)}"><div class="model-prefix-header"><button type="button" class="model-prefix-toggle" data-action="toggle-prefix" data-prefix-key="${escapeHtml(prefixKey)}" aria-expanded="${state.expandedPrefixes.has(prefixKey)}"><span class="prefix-title"><span class="prefix-arrow" aria-hidden="true"></span><code>${escapeHtml(prefix)}</code></span><span class="prefix-meta">${selectedCount}/${completeModels.length} 已选</span></button><div class="model-group-actions"><button type="button" class="text-button" data-action="select-prefix" data-prefix="${escapeHtml(prefix)}">全部勾选</button><button type="button" class="text-button" data-action="clear-prefix" data-prefix="${escapeHtml(prefix)}">全部取消</button></div></div><div class="model-prefix-body">${visibleModels.map((model) => renderModelRow(model, selections)).join('')}</div></section>`;
}

function renderModelCatalog() {
  const list = $('#modelCatalogList');
  if (!list) return;
  const catalog = state.catalog;
  if (!catalog?.upstreams?.length) {
    list.innerHTML = '<div class="empty">暂无模型目录。请先添加上游，然后点击“拉取全部模型”；Anthropic 上游需要在上游表单中手工填写模型。</div>';
    return;
  }
  const selections = catalogSelectionMap();
  const allModels = allUnifiedModels();
  const visibleModels = filteredUnifiedModels(allModels);
  const prefixGroups = groupModelsByPrefix(visibleModels);
  list.innerHTML = prefixGroups.length ? prefixGroups.map((group) => renderPrefixGroup(group.prefix, group.models, allModels, selections)).join('') : '<div class="empty">没有匹配的模型。</div>';
}

function render() {
  if (!state.config) return;
  const { upstreams, routes, localApiKeys } = state.config;
  const healthById = new Map((state.health?.items || []).map((item) => [item.upstreamId, item]));
  const balanceById = new Map((state.balances?.items || []).map((item) => [item.upstreamId, item]));
  $('#upstreamList').innerHTML = upstreams.length ? upstreams.map((item) => `
    <article class="item-card">
      <div><div class="item-title">${escapeHtml(item.name)}</div>
        <div class="item-meta"><span class="tag ${item.enabled ? 'active' : 'off'}">${item.enabled ? '已启用' : '已停用'}</span><span class="tag">${item.protocol === 'anthropic' ? 'Anthropic' : 'OpenAI 兼容'}</span><span class="tag">${escapeHtml(clientIdentityLabel(item))}</span><span class="tag ${healthById.get(item.id)?.state === 'open' ? 'off' : 'active'}">${healthLabel(healthById.get(item.id))}</span><span>${escapeHtml(item.baseUrl)}</span></div>
        <div class="item-meta"><span>Key：${escapeHtml(item.apiKey)}</span><span>模型：${escapeHtml((item.models || []).join(', ') || '未填写（依赖路由）')}</span>${item.modelsSyncedAt ? `<span>同步于：${escapeHtml(formatTime(item.modelsSyncedAt))}</span>` : ''}${healthById.get(item.id)?.consecutiveFailures ? `<span>连续失败：${escapeHtml(healthById.get(item.id).consecutiveFailures)} 次</span>` : ''}${healthById.get(item.id)?.openUntil ? `<span>冷却至：${escapeHtml(formatTime(healthById.get(item.id).openUntil))}</span>` : ''}</div>
        <div class="item-meta balance-meta">${balanceDetails(balanceById.get(item.id))}</div>
      </div><div class="item-actions"><button class="text-button" data-action="query-upstream-balance" data-id="${escapeHtml(item.id)}">查询余额</button><button class="text-button" data-action="test-upstream" data-id="${escapeHtml(item.id)}">测试连接</button><button class="text-button" data-action="reset-health" data-id="${escapeHtml(item.id)}">重置状态</button><button class="text-button" data-action="sync-upstream" data-id="${escapeHtml(item.id)}">同步模型</button><button class="text-button" data-action="edit-upstream" data-id="${escapeHtml(item.id)}">编辑</button><button class="text-button delete" data-action="delete-upstream" data-id="${escapeHtml(item.id)}">删除</button></div>
    </article>`).join('') : '<div class="empty">还没有上游站点。添加一个 sub2api / newapi 地址后即可开始路由。</div>';

  $('#routeList').innerHTML = routes.length ? routes.map((item) => {
    const upstream = upstreams.find((candidate) => candidate.id === item.upstreamId);
    const fallbacks = (item.fallbackUpstreamIds || []).map((id) => upstreams.find((candidate) => candidate.id === id)?.name || '已删除').join(' → ');
    const strategy = { failover: '故障转移', round_robin: '轮询', weighted: '加权轮询', random: '随机' }[item.strategy || 'failover'] || '故障转移';
    return `<article class="item-card"><div><div class="item-title"><code>${escapeHtml(item.localModel)}</code> <span class="muted">→</span> <code>${escapeHtml(item.upstreamModel)}</code></div><div class="item-meta"><span class="tag ${item.enabled ? 'active' : 'off'}">${item.enabled ? '已启用' : '已停用'}</span><span class="tag">策略：${strategy}</span><span>主上游：${escapeHtml(upstream?.name || '已删除')}</span>${fallbacks ? `<span>备用：${escapeHtml(fallbacks)}</span>` : ''}</div></div><div class="item-actions"><button class="text-button" data-action="edit-route" data-id="${escapeHtml(item.id)}">编辑</button><button class="text-button delete" data-action="delete-route" data-id="${escapeHtml(item.id)}">删除</button></div></article>`;
  }).join('') : '<div class="empty">还没有路由。只有一个启用的上游时，未配置路由的模型会自动转发。</div>';

  $('#keyList').innerHTML = localApiKeys.length ? localApiKeys.map((item) => `<article class="item-card"><div><div class="item-title">${escapeHtml(item.name)}</div><div class="key-value">${escapeHtml(item.key)}</div><div class="item-meta"><span class="tag ${item.enabled ? 'active' : 'off'}">${item.enabled ? '已启用' : '已停用'}</span><span>创建于 ${escapeHtml(new Date(item.createdAt).toLocaleString())}</span></div></div><div class="item-actions"><button class="text-button" data-action="copy-key" data-id="${escapeHtml(item.id)}">复制</button><button class="text-button" data-action="edit-key" data-id="${escapeHtml(item.id)}">编辑</button><button class="text-button" data-action="toggle-key" data-id="${escapeHtml(item.id)}">${item.enabled ? '停用' : '启用'}</button><button class="text-button delete" data-action="delete-key" data-id="${escapeHtml(item.id)}">删除</button></div></article>`).join('') : '<div class="empty">还没有本地调用 Key。</div>';

  const settings = state.config.settings || {};
  $('#upstreamTimeoutMs').value = settings.upstreamTimeoutMs ?? 600000;
  $('#maxFallbackAttempts').value = settings.maxFallbackAttempts ?? 0;
  $('#retryDelayMs').value = settings.retryDelayMs ?? 0;
  $('#circuitBreakerFailureThreshold').value = settings.circuitBreakerFailureThreshold ?? 3;
  $('#circuitBreakerCooldownMs').value = settings.circuitBreakerCooldownMs ?? 60000;
  $('#maxConcurrentRequests').value = settings.maxConcurrentRequests ?? 0;
  $('#requestsPerMinute').value = settings.requestsPerMinute ?? 0;

  renderMetrics();
  renderModelCatalog();

  const origin = window.location.origin;
  $('#openaiEndpoint').textContent = `${origin}/v1`;
  $('#anthropicEndpoint').textContent = `${origin}/v1`;
  $('#modelsEndpoint').textContent = `${origin}/v1/models`;
}

function downloadJson(fileName, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function renderMetrics() {
  const metrics = state.metrics;
  if (!metrics) {
    $('#statsGrid').innerHTML = '<div class="empty">统计暂时不可用。</div>';
    $('#upstreamStats').innerHTML = '';
    $('#requestLogBody').innerHTML = '';
    $('#metricsEmpty').classList.remove('hidden');
    $('#requestLogMore')?.classList.add('hidden');
    if ($('#requestLogSummary')) $('#requestLogSummary').textContent = '仅记录元数据';
    return;
  }
  const totals = metrics.totals || {};
  const successRate = totals.requests ? `${((totals.successful / totals.requests) * 100).toFixed(1)}%` : '0%';
  $('#statsGrid').innerHTML = [
    ['请求总数', formatNumber(totals.requests)],
    ['成功率', successRate],
    ['故障转移', formatNumber(totals.failovers)],
    ['总 Token', formatNumber(totals.totalTokens)],
    ['输入 / 输出', `${formatNumber(totals.promptTokens)} / ${formatNumber(totals.completionTokens)}`]
  ].map(([label, value]) => `<div class="stat-card"><div class="stat-value">${escapeHtml(value)}</div><div class="stat-label">${escapeHtml(label)}</div></div>`).join('');

  const upstreamEntries = Object.entries(metrics.byUpstream || {});
  $('#upstreamStats').innerHTML = upstreamEntries.length ? upstreamEntries.map(([name, item]) => `<div class="upstream-stat"><strong title="${escapeHtml(name)}">${escapeHtml(name)}</strong><span>请求 ${formatNumber(item.requests)} · 成功 ${formatNumber(item.successful)} · 失败 ${formatNumber(item.failed)}<br>Token ${formatNumber(item.totalTokens)}</span></div>`).join('') : '<div class="empty">还没有上游请求统计。</div>';

  const logs = metrics.logs || [];
  state.logPage = metrics.logPage || { offset: 0, limit: logs.length, total: logs.length, hasMore: false, maxLogs: logs.length };
  $('#metricsEmpty').classList.toggle('hidden', logs.length > 0);
  $('#requestLogBody').innerHTML = logs.map(renderLogRow).join('');
  updateLogSummary();
}

const STRATEGY_LABELS = { failover: '故障转移', round_robin: '轮询', weighted: '加权轮询', random: '随机' };

function renderLogRow(entry) {
  return `<tr><td>${escapeHtml(formatTime(entry.finishedAt || entry.startedAt))}</td><td><code>${escapeHtml(entry.model)}</code></td><td>${escapeHtml(STRATEGY_LABELS[entry.strategy] || entry.strategy || '故障转移')}</td><td>${escapeHtml(entry.upstream || '-')}</td><td>${escapeHtml(entry.status)}</td><td>${escapeHtml(entry.durationMs)} ms</td><td>${escapeHtml(entry.usage?.totalTokens || 0)}</td><td class="${entry.success ? 'success-text' : 'error-text'}">${entry.success ? '成功' : '失败'}${entry.failover ? '<span class="small-tag">已切换</span>' : ''}</td></tr>`;
}

function updateLogSummary() {
  const page = state.logPage || {};
  const shown = $('#requestLogBody').querySelectorAll('tr').length;
  const summary = $('#requestLogSummary');
  if (summary) {
    const maxLabel = page.maxLogs ? `，最多保留最近 ${formatNumber(page.maxLogs)} 条` : '';
    summary.textContent = page.total ? `已显示 ${formatNumber(shown)} / ${formatNumber(page.total)} 条${maxLabel}，仅记录元数据` : '仅记录元数据';
  }
  const more = $('#requestLogMore');
  if (more) more.classList.toggle('hidden', !page.hasMore);
}

async function loadMoreLogs() {
  if (state.loadingMoreLogs || !state.logPage?.hasMore) return;
  state.loadingMoreLogs = true;
  const button = $('#loadMoreLogsButton');
  if (button) { button.disabled = true; button.textContent = '加载中…'; }
  const shown = $('#requestLogBody').querySelectorAll('tr').length;
  try {
    const page = await api(`/api/admin/metrics/logs?offset=${shown}&limit=100`);
    $('#requestLogBody').insertAdjacentHTML('beforeend', (page.items || []).map(renderLogRow).join(''));
    state.logPage = { ...state.logPage, offset: page.offset, total: page.total, hasMore: page.hasMore, maxLogs: page.maxLogs };
    updateLogSummary();
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    state.loadingMoreLogs = false;
    if (button) { button.disabled = false; button.textContent = '加载更多'; }
  }
}

async function loadConfig() {
  setMessage('正在读取配置…');
  try {
    state.config = await api('/api/admin/config');
    try {
      state.metrics = await api('/api/admin/metrics');
    } catch {
      state.metrics = null;
    }
    try {
      state.health = await api('/api/admin/upstream-status');
    } catch {
      state.health = null;
    }
    try {
      state.balances = await api('/api/admin/upstream-balances');
    } catch {
      state.balances = null;
    }
    try {
      state.catalog = await api('/api/admin/model-catalog');
      reconcileModelSelectionDraft(state.catalog);
    } catch {
      state.catalog = null;
      state.modelSelectionDraft = null;
    }
    $('#dashboard').classList.remove('hidden');
    setMessage('配置已载入。', 'success');
    render();
  } catch (error) {
    $('#dashboard').classList.add('hidden');
    setMessage(error.message, 'error');
  }
}

async function initializeAdminAccess() {
  try {
    const response = await fetch('/auth/status', { headers: { Accept: 'application/json' } });
    const status = await response.json().catch(() => ({}));
    if (!response.ok || !status.authenticated) {
      $('#adminIdentity').textContent = '尚未认证';
      $('#authModeLabel').textContent = status.error?.message || '需要 Authentik 登录';
      setMessage(status.error?.message || `认证状态检查失败（${response.status}）`, 'error');
      return;
    }
    if (status.mode === 'local') {
      $('#adminIdentity').textContent = '本机管理员';
      $('#authModeLabel').textContent = '本机回环访问 · 无需认证';
      $('#logoutButton').classList.add('hidden');
    } else {
      const identity = status.user?.name || status.user?.username || status.user?.email || 'Authentik 用户';
      $('#adminIdentity').textContent = identity;
      $('#authModeLabel').textContent = `Authentik 已认证 · ${status.user?.username || identity}`;
      $('#logoutButton').classList.remove('hidden');
    }
    await loadConfig();
  } catch (error) {
    $('#adminIdentity').textContent = '认证状态不可用';
    $('#authModeLabel').textContent = '无法连接管理认证接口';
    setMessage(error.message, 'error');
  }
}

function collectModelSelections() {
  syncRenderedModelDraft();
  return [...catalogSelectionMap().values()];
}

async function saveModelSelections() {
  const message = $('#modelSelectionMessage');
  try {
    const selections = collectModelSelections();
    state.catalog = await api('/api/admin/model-selections', { method: 'PUT', body: JSON.stringify({ selections }) });
    reconcileModelSelectionDraft(state.catalog, true);
    await loadConfig();
    message.textContent = `已保存 ${selections.length} 个本地模型。未勾选模型不会再出现在 /v1/models。`;
    message.className = 'form-message success';
    toast(`已暴露 ${selections.length} 个本地模型`);
  } catch (error) {
    message.textContent = error.message;
    message.className = 'form-message error';
    toast(error.message, 'error');
  }
}

async function syncAllModels() {
  const button = $('#syncAllModelsButton');
  button.disabled = true;
  button.textContent = '拉取中…';
  try {
    const result = await api('/api/admin/model-catalog/sync', { method: 'POST', body: '{}' });
    state.catalog = result.catalog;
    reconcileModelSelectionDraft(state.catalog);
    renderModelCatalog();
    const failed = result.results.filter((item) => !item.ok && !item.skipped);
    toast(failed.length ? `模型拉取完成，但有 ${failed.length} 个上游失败` : '全部上游模型已拉取');
  } catch (error) { toast(error.message, 'error'); }
  button.disabled = false;
  button.textContent = '拉取全部模型';
}

async function queryAllBalances() {
  const button = $('#queryAllBalancesButton');
  button.disabled = true;
  button.textContent = '查询中…';
  try {
    state.balances = await api('/api/admin/upstream-balances/query', { method: 'POST', body: '{}' });
    render();
    const succeeded = state.balances.items.filter((item) => item.state === 'ok').length;
    const unsupported = state.balances.items.filter((item) => item.state === 'unsupported').length;
    const failed = state.balances.items.length - succeeded - unsupported;
    toast(`余额查询完成：成功 ${succeeded}，不支持 ${unsupported}，失败 ${failed}${failed ? '；请查看上游卡片详情' : ''}`, failed ? 'error' : '');
  } catch (error) {
    toast(`查询全部余额失败：${error.message}`, 'error');
  } finally {
    button.disabled = false;
    button.textContent = '查询全部余额';
  }
}

function setBalanceResult(result) {
  const items = (state.balances?.items || []).filter((item) => item.upstreamId !== result.upstreamId);
  state.balances = { items: [...items, result] };
}

function togglePrefix(prefixKey) {
  syncRenderedModelDraft();
  if (state.expandedPrefixes.has(prefixKey)) state.expandedPrefixes.delete(prefixKey);
  else state.expandedPrefixes.add(prefixKey);
  renderModelCatalog();
}

function expandModelGroups(expanded) {
  syncRenderedModelDraft();
  state.expandedPrefixes = expanded
    ? new Set(groupModelsByPrefix(allUnifiedModels()).map((group) => modelGroupKey('unified', group.prefix)))
    : new Set();
  renderModelCatalog();
}

function batchSelectModels(prefix, selected) {
  syncRenderedModelDraft();
  const models = allUnifiedModels().filter((model) => modelPrefix(model.id) === prefix);
  state.modelSelectionDraft = setUnifiedModelsSelected(catalogSelectionMap(), models, selected);
  renderModelCatalog();
  toast(`${prefix} 已${selected ? '全部勾选' : '全部取消'}`);
}

function updateClientIdentityFields() {
  const custom = $('#upstreamClientIdentityPreset').value === 'custom';
  $('#customUserAgentLabel').classList.toggle('hidden', !custom);
  $('#upstreamCustomUserAgent').required = custom;
}

function fillUpstreamForm(item = null) {
  $('#upstreamDialogTitle').textContent = item ? '编辑上游' : '添加上游';
  $('#upstreamId').value = item?.id || '';
  $('#upstreamName').value = item?.name || '';
  $('#upstreamBaseUrl').value = item?.baseUrl || '';
  $('#upstreamProtocol').value = item?.protocol || 'openai';
  $('#upstreamAuthType').value = item?.authType || (item?.protocol === 'anthropic' ? 'x-api-key' : 'bearer');
  $('#upstreamApiKey').value = '';
  $('#upstreamApiKey').placeholder = item ? '留空表示保留原 Key' : '输入上游 API Key';
  $('#upstreamClientIdentityPreset').value = item?.clientIdentityPreset || 'default';
  $('#upstreamCustomUserAgent').value = item?.customUserAgent || '';
  updateClientIdentityFields();
  $('#upstreamBalanceEndpoint').value = item?.balanceEndpoint || '';
  $('#upstreamModels').value = (item?.models || []).join('\n');
  $('#upstreamModelFetchMessage').textContent = '从上游的 /v1/models 自动获取';
  $('#upstreamModelFetchMessage').className = 'muted';
  $('#upstreamEnabled').checked = item?.enabled !== false;
  openDialog($('#upstreamDialog'));
}

function fillRouteForm(item = null) {
  $('#routeDialogTitle').textContent = item ? '编辑路由' : '添加路由';
  $('#routeId').value = item?.id || '';
  $('#localModel').value = item?.localModel || '';
  $('#routeUpstreamId').innerHTML = state.config.upstreams.map((upstream) => `<option value="${escapeHtml(upstream.id)}">${escapeHtml(upstream.name)} (${escapeHtml(upstream.protocol)})</option>`).join('');
  $('#routeUpstreamId').value = item?.upstreamId || state.config.upstreams[0]?.id || '';
  $('#routeUpstreamModel').value = item?.upstreamModel || '';
  $('#routeThinkingLevel').value = item?.thinkingLevel || 'auto';
  $('#routeStrategy').value = item?.strategy || 'failover';
  $('#routeFallbackIds').innerHTML = state.config.upstreams.map((upstream) => `<option value="${escapeHtml(upstream.id)}">${escapeHtml(upstream.name)} (${escapeHtml(upstream.protocol)})</option>`).join('');
  for (const option of $('#routeFallbackIds').options) option.selected = (item?.fallbackUpstreamIds || []).includes(option.value);
  $('#routeWeights').innerHTML = state.config.upstreams.map((upstream) => `<div class="route-weight-row"><span>${escapeHtml(upstream.name)}</span><input type="number" min="1" max="1000" step="1" data-upstream-id="${escapeHtml(upstream.id)}" value="${escapeHtml(item?.upstreamWeights?.[upstream.id] || 1)}"></div>`).join('');
  $('#routeEnabled').checked = item?.enabled !== false;
  openDialog($('#routeDialog'));
}

function fillKeyEditForm(item) {
  $('#editKeyId').value = item.id;
  $('#editKeyName').value = item.name;
  $('#editKeyEnabled').checked = item.enabled !== false;
  openDialog($('#keyEditDialog'));
}

function upstreamPayloadFromForm() {
  return {
    name: $('#upstreamName').value.trim(), baseUrl: $('#upstreamBaseUrl').value.trim(), protocol: $('#upstreamProtocol').value,
    authType: $('#upstreamAuthType').value, apiKey: $('#upstreamApiKey').value, models: $('#upstreamModels').value,
    clientIdentityPreset: $('#upstreamClientIdentityPreset').value,
    customUserAgent: $('#upstreamClientIdentityPreset').value === 'custom' ? $('#upstreamCustomUserAgent').value.trim() : '',
    balanceEndpoint: $('#upstreamBalanceEndpoint').value.trim(),
    enabled: $('#upstreamEnabled').checked
  };
}

async function fetchUpstreamModels() {
  const button = $('#fetchUpstreamModelsButton');
  const message = $('#upstreamModelFetchMessage');
  const payload = upstreamPayloadFromForm();
  if (!payload.baseUrl) {
    message.textContent = '请先填写上游地址';
    message.className = 'error';
    return;
  }
  if (payload.authType !== 'none' && !payload.apiKey && !$('#upstreamId').value) {
    message.textContent = '请先填写上游 API Key';
    message.className = 'error';
    return;
  }
  button.disabled = true;
  button.textContent = '拉取中…';
  message.textContent = '正在请求上游模型列表…';
  message.className = 'muted';
  try {
    const result = await api('/api/admin/model-catalog/preview', {
      method: 'POST',
      body: JSON.stringify({ ...payload, upstreamId: $('#upstreamId').value })
    });
    $('#upstreamModels').value = result.models.join('\n');
    message.textContent = `已拉取 ${result.count} 个模型，请点击“保存上游”完成保存`;
    message.className = 'success';
    toast(`已从上游拉取 ${result.count} 个模型`);
  } catch (error) {
    message.textContent = error.message;
    message.className = 'error';
    toast(`拉取模型失败：${error.message}`, 'error');
  } finally {
    button.disabled = false;
    button.textContent = '拉取模型';
  }
}

async function saveUpstream(event) {
  event.preventDefault();
  const id = $('#upstreamId').value;
  const payload = upstreamPayloadFromForm();
  try {
    await api(id ? `/api/admin/upstreams/${encodeURIComponent(id)}` : '/api/admin/upstreams', { method: id ? 'PUT' : 'POST', body: JSON.stringify(payload) });
    closeDialog($('#upstreamDialog'));
    await loadConfig();
    toast('上游已保存');
  } catch (error) { toast(error.message, 'error'); }
}

async function saveRoute(event) {
  event.preventDefault();
  const id = $('#routeId').value;
  const upstreamWeights = Object.fromEntries([...$('#routeWeights').querySelectorAll('input[data-upstream-id]')].map((input) => [input.dataset.upstreamId, Number(input.value)]));
  const payload = { localModel: $('#localModel').value.trim(), upstreamId: $('#routeUpstreamId').value, upstreamModel: $('#routeUpstreamModel').value.trim(), thinkingLevel: $('#routeThinkingLevel').value, strategy: $('#routeStrategy').value, fallbackUpstreamIds: [...$('#routeFallbackIds').selectedOptions].map((option) => option.value), upstreamWeights, enabled: $('#routeEnabled').checked };
  try {
    await api(id ? `/api/admin/routes/${encodeURIComponent(id)}` : '/api/admin/routes', { method: id ? 'PUT' : 'POST', body: JSON.stringify(payload) });
    closeDialog($('#routeDialog'));
    await loadConfig();
    toast('路由已保存');
  } catch (error) { toast(error.message, 'error'); }
}

async function deleteItem(kind, id, label) {
  if (!window.confirm(`确定删除${label}吗？`)) return;
  try {
    await api(`/api/admin/${kind}/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await loadConfig();
    toast(`${label}已删除`);
  } catch (error) { toast(error.message, 'error'); }
}

async function saveKeyEdit(event) {
  event.preventDefault();
  const id = $('#editKeyId').value;
  try {
    await api(`/api/admin/local-keys/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ name: $('#editKeyName').value.trim(), enabled: $('#editKeyEnabled').checked }) });
    closeDialog($('#keyEditDialog'));
    await loadConfig();
    toast('本地 Key 已更新');
  } catch (error) { toast(error.message, 'error'); }
}

async function toggleKey(item) {
  try {
    await api(`/api/admin/local-keys/${encodeURIComponent(item.id)}`, { method: 'PUT', body: JSON.stringify({ name: item.name, enabled: item.enabled === false }) });
    await loadConfig();
    toast(`本地 Key 已${item.enabled === false ? '启用' : '停用'}`);
  } catch (error) { toast(error.message, 'error'); }
}

async function copyLocalKey(item) {
  try {
    await navigator.clipboard.writeText(item.key);
    toast(`${item.name} 的 Key 已复制`);
  } catch {
    window.prompt('浏览器无法自动写入剪贴板，请手工复制：', item.key);
  }
}

async function handleListClick(event) {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const item = (button.dataset.action.includes('upstream') ? state.config.upstreams : button.dataset.action.includes('route') ? state.config.routes : state.config.localApiKeys).find((candidate) => candidate.id === button.dataset.id);
  if (button.dataset.action === 'edit-upstream') fillUpstreamForm(item);
  if (button.dataset.action === 'edit-route') fillRouteForm(item);
  if (button.dataset.action === 'edit-key') fillKeyEditForm(item);
  if (button.dataset.action === 'toggle-key') await toggleKey(item);
  if (button.dataset.action === 'copy-key') await copyLocalKey(item);
  if (button.dataset.action === 'query-upstream-balance') {
    button.disabled = true;
    button.textContent = '查询中…';
    try {
      const result = await api(`/api/admin/upstreams/${encodeURIComponent(button.dataset.id)}/balance`, { method: 'POST', body: '{}' });
      setBalanceResult(result);
      render();
      if (result.state === 'ok') toast(`${item?.name || '上游'} 余额查询成功`);
      else toast(`${item?.name || '上游'}：${result.message || '未能查询余额'}`, result.state === 'unsupported' ? '' : 'error');
    } catch (error) {
      toast(`${item?.name || '上游'} 余额查询失败：${error.message}`, 'error');
    } finally {
      if (button.isConnected) {
        button.disabled = false;
        button.textContent = '查询余额';
      }
    }
  }
  if (button.dataset.action === 'reset-health') {
    button.disabled = true;
    try {
      await api(`/api/admin/upstreams/${encodeURIComponent(button.dataset.id)}/reset-health`, { method: 'POST', body: '{}' });
      await loadConfig();
      toast(`${item?.name || '上游'} 健康状态已重置`);
    } catch (error) { toast(error.message, 'error'); }
    button.disabled = false;
  }
  if (button.dataset.action === 'test-upstream') {
    button.disabled = true;
    button.textContent = '测试中…';
    try {
      const result = await api(`/api/admin/upstreams/${encodeURIComponent(button.dataset.id)}/test`, { method: 'POST', body: '{}' });
      toast(`${item.name} 测试成功（HTTP ${result.status}）`);
    } catch (error) { toast(`${item?.name || '上游'} 测试失败：${error.message}`, 'error'); }
    button.disabled = false;
    button.textContent = '测试连接';
  }
  if (button.dataset.action === 'sync-upstream') {
    button.disabled = true;
    button.textContent = '同步中…';
    try {
      const result = await api(`/api/admin/upstreams/${encodeURIComponent(button.dataset.id)}/sync-models`, { method: 'POST', body: '{}' });
      await loadConfig();
      toast(`${item?.name || '上游'} 已同步 ${result.count} 个模型`);
    } catch (error) { toast(`${item?.name || '上游'} 同步失败：${error.message}`, 'error'); }
    button.disabled = false;
    button.textContent = '同步模型';
  }
  if (button.dataset.action === 'delete-upstream') await deleteItem('upstreams', button.dataset.id, '上游');
  if (button.dataset.action === 'delete-route') await deleteItem('routes', button.dataset.id, '路由');
  if (button.dataset.action === 'delete-key') await deleteItem('local-keys', button.dataset.id, '本地 Key');
}

async function createKey(event) {
  event.preventDefault();
  try {
    await api('/api/admin/local-keys', { method: 'POST', body: JSON.stringify({ name: $('#keyName').value.trim() }) });
    closeDialog($('#keyDialog'));
    $('#keyName').value = '';
    await loadConfig();
    toast('本地 Key 已创建，可在列表中查看或复制');
  } catch (error) { toast(error.message, 'error'); }
}

async function clearMetrics() {
  if (!window.confirm('确定清空所有请求统计和最近日志吗？此操作不可撤销。')) return;
  try {
    state.metrics = await api('/api/admin/metrics', { method: 'DELETE' });
    renderMetrics();
    toast('请求统计已清空');
  } catch (error) { toast(error.message, 'error'); }
}

async function saveSettings() {
  const payload = {
    upstreamTimeoutMs: Number($('#upstreamTimeoutMs').value),
    maxFallbackAttempts: Number($('#maxFallbackAttempts').value),
    retryDelayMs: Number($('#retryDelayMs').value),
    circuitBreakerFailureThreshold: Number($('#circuitBreakerFailureThreshold').value),
    circuitBreakerCooldownMs: Number($('#circuitBreakerCooldownMs').value),
    maxConcurrentRequests: Number($('#maxConcurrentRequests').value),
    requestsPerMinute: Number($('#requestsPerMinute').value)
  };
  try {
    const settings = await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify(payload) });
    state.config.settings = settings;
    $('#settingsMessage').textContent = '设置已保存。';
    $('#settingsMessage').className = 'form-message success';
    toast('可靠性设置已保存');
  } catch (error) {
    $('#settingsMessage').textContent = error.message;
    $('#settingsMessage').className = 'form-message error';
  }
}

async function exportConfig() {
  try {
    const backup = await api('/api/admin/config/export');
    downloadJson(`local-model-gateway-backup-${new Date().toISOString().slice(0, 10)}.json`, backup);
    toast('配置已导出，请妥善保存备份文件');
  } catch (error) { toast(error.message, 'error'); }
}

function importConfigFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const backup = JSON.parse(reader.result);
      if (!backup.config && !backup.upstreams) throw new Error('文件不是有效的网关配置备份');
      if (!window.confirm('确定导入这个配置吗？当前的上游和路由会被替换；当前本地 Key 会保留。')) return;
      await api('/api/admin/config/import', { method: 'POST', body: JSON.stringify({ ...backup, preserveCredentials: true }) });
      await loadConfig();
      toast('配置已导入；监听地址或端口变更需要重启服务后生效');
    } catch (error) { toast(`导入失败：${error.message}`, 'error'); }
  };
  reader.readAsText(file);
}

async function checkHealth() {
  try {
    const response = await fetch('/health');
    if (!response.ok) throw new Error('offline');
    $('#healthText').textContent = '服务正常';
    $('.status-dot').classList.add('ok');
  } catch {
    $('#healthText').textContent = '服务异常';
    $('.status-dot').classList.add('error');
  }
}

$('#loadButton').addEventListener('click', loadConfig);
$('#logoutButton').addEventListener('click', () => { window.location.assign('/auth/logout'); });
$('#addUpstreamButton').addEventListener('click', () => fillUpstreamForm());
$('#addRouteButton').addEventListener('click', () => {
  if (!state.config.upstreams.length) return toast('请先添加至少一个上游站点', 'error');
  fillRouteForm();
});
$('#addKeyButton').addEventListener('click', () => openDialog($('#keyDialog')));
$('#fetchUpstreamModelsButton').addEventListener('click', fetchUpstreamModels);
$('#queryAllBalancesButton').addEventListener('click', queryAllBalances);
$('#upstreamClientIdentityPreset').addEventListener('change', updateClientIdentityFields);
document.querySelectorAll('[data-dialog-close]').forEach((button) => {
  button.addEventListener('click', () => closeDialog(document.getElementById(button.dataset.dialogClose)));
});
$('#upstreamForm').addEventListener('submit', saveUpstream);
$('#routeForm').addEventListener('submit', saveRoute);
$('#keyForm').addEventListener('submit', createKey);
$('#keyEditForm').addEventListener('submit', saveKeyEdit);
$('#upstreamList').addEventListener('click', handleListClick);
$('#routeList').addEventListener('click', handleListClick);
$('#keyList').addEventListener('click', handleListClick);
$('#clearMetricsButton').addEventListener('click', clearMetrics);
$('#loadMoreLogsButton').addEventListener('click', loadMoreLogs);
$('#syncAllModelsButton').addEventListener('click', syncAllModels);
$('#saveModelSelectionsButton').addEventListener('click', saveModelSelections);
$('#modelCatalogSearch').addEventListener('input', () => { syncRenderedModelDraft(); renderModelCatalog(); });
$('#showThinkingModelsOnly').addEventListener('change', () => { syncRenderedModelDraft(); renderModelCatalog(); });
$('#expandAllModelsButton').addEventListener('click', () => expandModelGroups(true));
$('#collapseAllModelsButton').addEventListener('click', () => expandModelGroups(false));
$('#modelCatalogList').addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  if (button.dataset.action === 'toggle-prefix') togglePrefix(button.dataset.prefixKey);
  if (button.dataset.action === 'select-prefix') batchSelectModels(button.dataset.prefix, true);
  if (button.dataset.action === 'clear-prefix') batchSelectModels(button.dataset.prefix, false);
});
$('#modelCatalogList').addEventListener('change', (event) => {
  if (event.target.matches('[data-action="model-upstream"]')) {
    const row = event.target.closest('.model-row');
    const pool = row?.querySelector('[data-role="model-pool"]');
    if (pool) pool.classList.toggle('hidden', event.target.value !== '__auto__');
  }
  syncRenderedModelDraft();
});
$('#modelCatalogList').addEventListener('input', (event) => {
  if (event.target.matches('[data-action="model-alias"]')) syncRenderedModelDraft();
});
$('#saveSettingsButton').addEventListener('click', saveSettings);
$('#exportConfigButton').addEventListener('click', exportConfig);
$('#importConfigButton').addEventListener('click', () => $('#configFileInput').click());
$('#configFileInput').addEventListener('change', (event) => {
  importConfigFile(event.target.files[0]);
  event.target.value = '';
});
checkHealth();
initializeAdminAccess();