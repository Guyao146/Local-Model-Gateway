const state = { config: null, metrics: null, health: null, catalog: null, expandedProviders: null };
const $ = (selector) => document.querySelector(selector);

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function adminHeaders() {
  return { 'Content-Type': 'application/json', 'X-Admin-Token': $('#adminToken').value.trim() };
}

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { ...adminHeaders(), ...(options.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message || `请求失败（${response.status}）`);
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
  if (typeof dialog.close === 'function') dialog.close();
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

function thinkingLabel(level) {
  return { auto: '自动', off: '关闭', low: '低', medium: '中', high: '高' }[level] || '自动';
}

function catalogSelectionMap() {
  return new Map((state.catalog?.selections || []).map((item) => [`${item.upstreamId}:${item.upstreamModel}`, item]));
}

function filteredProviderModels(provider) {
  const search = $('#modelCatalogSearch')?.value.trim().toLowerCase() || '';
  const thinkingOnly = Boolean($('#showThinkingModelsOnly')?.checked);
  return provider.models.filter((model) => {
    const matchesSearch = !search || `${provider.name} ${model.id} ${model.name}`.toLowerCase().includes(search);
    return matchesSearch && (!thinkingOnly || model.supportsThinking === true);
  });
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
  if (state.expandedProviders === null) state.expandedProviders = new Set(catalog.upstreams.map((provider) => provider.id));
  const providers = catalog.upstreams.map((provider) => ({ provider, models: filteredProviderModels(provider) })).filter(({ provider, models }) => {
    const search = $('#modelCatalogSearch')?.value.trim() || '';
    return models.length || !search;
  });
  list.innerHTML = providers.length ? providers.map(({ provider, models }) => {
    const collapsed = state.expandedProviders.has(provider.id) ? '' : ' collapsed';
    const selectedCount = provider.models.filter((model) => selections.has(`${provider.id}:${model.id}`)).length;
    return `<section class="model-provider${collapsed}" data-provider-id="${escapeHtml(provider.id)}"><button class="model-provider-header" data-action="toggle-provider" data-provider-id="${escapeHtml(provider.id)}"><span class="provider-title"><span class="provider-arrow">⌄</span>${escapeHtml(provider.name)}<span class="tag">${escapeHtml(provider.protocol)}</span></span><span class="provider-meta">${selectedCount}/${provider.models.length} 已选 · ${provider.modelsSyncedAt ? `同步于 ${escapeHtml(formatTime(provider.modelsSyncedAt))}` : '手工模型'}</span></button><div class="model-provider-body">${models.length ? models.map((model) => {
      const key = `${provider.id}:${model.id}`;
      const selection = selections.get(key);
      const supportsThinking = model.supportsThinking !== false;
      return `<div class="model-row" data-model-key="${escapeHtml(key)}"><input type="checkbox" data-action="toggle-model" data-upstream-id="${escapeHtml(provider.id)}" data-upstream-model="${escapeHtml(model.id)}" ${selection ? 'checked' : ''}><div><div class="model-name" title="${escapeHtml(model.id)}">${escapeHtml(model.id)}${model.supportsThinking === true ? '<span class="thinking-badge">支持思考</span>' : model.supportsThinking === null ? '<span class="thinking-badge thinking-unknown">能力未知</span>' : '<span class="thinking-badge thinking-disabled">不支持思考</span>'}</div><div class="model-info">${escapeHtml(model.name !== model.id ? model.name : (model.ownedBy || ''))}</div></div><div class="model-controls"><input type="text" data-action="model-alias" data-upstream-id="${escapeHtml(provider.id)}" data-upstream-model="${escapeHtml(model.id)}" value="${escapeHtml(selection?.localModel || model.id)}" placeholder="本地模型别名"><select data-action="thinking-level" data-upstream-id="${escapeHtml(provider.id)}" data-upstream-model="${escapeHtml(model.id)}"><option value="auto" ${!selection || selection.thinkingLevel === 'auto' ? 'selected' : ''}>思考：自动</option><option value="off" ${selection?.thinkingLevel === 'off' ? 'selected' : ''}>思考：关闭</option><option value="low" ${selection?.thinkingLevel === 'low' ? 'selected' : ''}>思考：低</option><option value="medium" ${selection?.thinkingLevel === 'medium' ? 'selected' : ''}>思考：中</option><option value="high" ${selection?.thinkingLevel === 'high' ? 'selected' : ''}>思考：高</option></select></div></div>`;
    }).join('') : '<div class="empty">没有匹配的模型</div>'}</div></section>`;
  }).join('') : '<div class="empty">没有匹配的模型。</div>';
}

function render() {
  if (!state.config) return;
  const { upstreams, routes, localApiKeys } = state.config;
  const healthById = new Map((state.health?.items || []).map((item) => [item.upstreamId, item]));
  $('#upstreamList').innerHTML = upstreams.length ? upstreams.map((item) => `
    <article class="item-card">
      <div><div class="item-title">${escapeHtml(item.name)}</div>
        <div class="item-meta"><span class="tag ${item.enabled ? 'active' : 'off'}">${item.enabled ? '已启用' : '已停用'}</span><span class="tag">${item.protocol === 'anthropic' ? 'Anthropic' : 'OpenAI 兼容'}</span><span class="tag ${healthById.get(item.id)?.state === 'open' ? 'off' : 'active'}">${healthLabel(healthById.get(item.id))}</span><span>${escapeHtml(item.baseUrl)}</span></div>
        <div class="item-meta"><span>Key：${escapeHtml(item.apiKey)}</span><span>模型：${escapeHtml((item.models || []).join(', ') || '未填写（依赖路由）')}</span>${item.modelsSyncedAt ? `<span>同步于：${escapeHtml(formatTime(item.modelsSyncedAt))}</span>` : ''}${healthById.get(item.id)?.consecutiveFailures ? `<span>连续失败：${escapeHtml(healthById.get(item.id).consecutiveFailures)} 次</span>` : ''}${healthById.get(item.id)?.openUntil ? `<span>冷却至：${escapeHtml(formatTime(healthById.get(item.id).openUntil))}</span>` : ''}</div>
      </div><div class="item-actions"><button class="text-button" data-action="test-upstream" data-id="${escapeHtml(item.id)}">测试连接</button><button class="text-button" data-action="reset-health" data-id="${escapeHtml(item.id)}">重置状态</button><button class="text-button" data-action="sync-upstream" data-id="${escapeHtml(item.id)}">同步模型</button><button class="text-button" data-action="edit-upstream" data-id="${escapeHtml(item.id)}">编辑</button><button class="text-button delete" data-action="delete-upstream" data-id="${escapeHtml(item.id)}">删除</button></div>
    </article>`).join('') : '<div class="empty">还没有上游站点。添加一个 sub2api / newapi 地址后即可开始路由。</div>';

  $('#routeList').innerHTML = routes.length ? routes.map((item) => {
    const upstream = upstreams.find((candidate) => candidate.id === item.upstreamId);
    const fallbacks = (item.fallbackUpstreamIds || []).map((id) => upstreams.find((candidate) => candidate.id === id)?.name || '已删除').join(' → ');
    const strategy = { failover: '故障转移', round_robin: '轮询', weighted: '加权轮询', random: '随机' }[item.strategy || 'failover'] || '故障转移';
    return `<article class="item-card"><div><div class="item-title"><code>${escapeHtml(item.localModel)}</code> <span class="muted">→</span> <code>${escapeHtml(item.upstreamModel)}</code></div><div class="item-meta"><span class="tag ${item.enabled ? 'active' : 'off'}">${item.enabled ? '已启用' : '已停用'}</span><span class="tag">策略：${strategy}</span><span>主上游：${escapeHtml(upstream?.name || '已删除')}</span>${fallbacks ? `<span>备用：${escapeHtml(fallbacks)}</span>` : ''}</div></div><div class="item-actions"><button class="text-button" data-action="edit-route" data-id="${escapeHtml(item.id)}">编辑</button><button class="text-button delete" data-action="delete-route" data-id="${escapeHtml(item.id)}">删除</button></div></article>`;
  }).join('') : '<div class="empty">还没有路由。只有一个启用的上游时，未配置路由的模型会自动转发。</div>';

  $('#keyList').innerHTML = localApiKeys.length ? localApiKeys.map((item) => `<article class="item-card"><div><div class="item-title">${escapeHtml(item.name)}</div><div class="key-value">${escapeHtml(item.key)}</div><div class="item-meta"><span class="tag ${item.enabled ? 'active' : 'off'}">${item.enabled ? '已启用' : '已停用'}</span><span>创建于 ${escapeHtml(new Date(item.createdAt).toLocaleString())}</span></div></div><div class="item-actions"><button class="text-button" data-action="edit-key" data-id="${escapeHtml(item.id)}">编辑</button><button class="text-button" data-action="toggle-key" data-id="${escapeHtml(item.id)}">${item.enabled ? '停用' : '启用'}</button><button class="text-button delete" data-action="delete-key" data-id="${escapeHtml(item.id)}">删除</button></div></article>`).join('') : '<div class="empty">还没有本地调用 Key。</div>';

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
  $('#metricsEmpty').classList.toggle('hidden', logs.length > 0);
  const strategyLabels = { failover: '故障转移', round_robin: '轮询', weighted: '加权轮询', random: '随机' };
  $('#requestLogBody').innerHTML = logs.map((entry) => `<tr><td>${escapeHtml(formatTime(entry.finishedAt || entry.startedAt))}</td><td><code>${escapeHtml(entry.model)}</code></td><td>${escapeHtml(strategyLabels[entry.strategy] || entry.strategy || '故障转移')}</td><td>${escapeHtml(entry.upstream || '-')}</td><td>${escapeHtml(entry.status)}</td><td>${escapeHtml(entry.durationMs)} ms</td><td>${escapeHtml(entry.usage?.totalTokens || 0)}</td><td class="${entry.success ? 'success-text' : 'error-text'}">${entry.success ? '成功' : '失败'}${entry.failover ? '<span class="small-tag">已切换</span>' : ''}</td></tr>`).join('');
}

async function loadConfig() {
  setMessage('正在读取配置…');
  try {
    state.config = await api('/api/admin/config', { headers: { 'X-Admin-Token': $('#adminToken').value.trim() } });
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
      state.catalog = await api('/api/admin/model-catalog');
    } catch {
      state.catalog = null;
    }
    $('#dashboard').classList.remove('hidden');
    $('#rotateTokenButton').disabled = false;
    setMessage('配置已载入。', 'success');
    render();
  } catch (error) {
    $('#dashboard').classList.add('hidden');
    $('#rotateTokenButton').disabled = true;
    setMessage(error.message, 'error');
  }
}

function collectModelSelections() {
  const selected = new Map((state.catalog?.selections || []).map((item) => [`${item.upstreamId}:${item.upstreamModel}`, { ...item }]));
  for (const row of document.querySelectorAll('.model-row')) {
    const checkbox = row.querySelector('[data-action="toggle-model"]');
    if (!checkbox) continue;
    const key = `${checkbox.dataset.upstreamId}:${checkbox.dataset.upstreamModel}`;
    if (!checkbox.checked) {
      selected.delete(key);
      continue;
    }
    const aliasInput = row.querySelector('[data-action="model-alias"]');
    const thinkingSelect = row.querySelector('[data-action="thinking-level"]');
    selected.set(key, {
      ...(selected.get(key) || {}),
      upstreamId: checkbox.dataset.upstreamId,
      upstreamModel: checkbox.dataset.upstreamModel,
      localModel: aliasInput?.value.trim() || checkbox.dataset.upstreamModel,
      thinkingLevel: thinkingSelect?.value || 'auto',
      enabled: true
    });
  }
  return [...selected.values()];
}

async function saveModelSelections() {
  const message = $('#modelSelectionMessage');
  try {
    const selections = collectModelSelections();
    state.catalog = await api('/api/admin/model-selections', { method: 'PUT', body: JSON.stringify({ selections }) });
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
    renderModelCatalog();
    const failed = result.results.filter((item) => !item.ok && !item.skipped);
    toast(failed.length ? `模型拉取完成，但有 ${failed.length} 个上游失败` : '全部上游模型已拉取');
  } catch (error) { toast(error.message, 'error'); }
  button.disabled = false;
  button.textContent = '拉取全部模型';
}

function toggleProvider(providerId) {
  if (state.expandedProviders.has(providerId)) state.expandedProviders.delete(providerId);
  else state.expandedProviders.add(providerId);
  renderModelCatalog();
}

function expandProviders(expanded) {
  const providers = state.catalog?.upstreams || [];
  state.expandedProviders = expanded ? new Set(providers.map((provider) => provider.id)) : new Set();
  renderModelCatalog();
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
  $('#upstreamModels').value = (item?.models || []).join('\n');
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

async function saveUpstream(event) {
  event.preventDefault();
  const id = $('#upstreamId').value;
  const payload = {
    name: $('#upstreamName').value.trim(), baseUrl: $('#upstreamBaseUrl').value.trim(), protocol: $('#upstreamProtocol').value,
    authType: $('#upstreamAuthType').value, apiKey: $('#upstreamApiKey').value, models: $('#upstreamModels').value,
    enabled: $('#upstreamEnabled').checked
  };
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

async function handleListClick(event) {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const item = (button.dataset.action.includes('upstream') ? state.config.upstreams : button.dataset.action.includes('route') ? state.config.routes : state.config.localApiKeys).find((candidate) => candidate.id === button.dataset.id);
  if (button.dataset.action === 'edit-upstream') fillUpstreamForm(item);
  if (button.dataset.action === 'edit-route') fillRouteForm(item);
  if (button.dataset.action === 'edit-key') fillKeyEditForm(item);
  if (button.dataset.action === 'toggle-key') await toggleKey(item);
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
  if (button.dataset.action === 'copy-key') {
    // The API intentionally never returns an existing full key after the initial creation.
    toast('出于安全原因，已有 Key 只显示掩码；如需复制请新建一个 Key。', 'error');
  }
}

async function createKey(event) {
  event.preventDefault();
  try {
    const result = await api('/api/admin/local-keys', { method: 'POST', body: JSON.stringify({ name: $('#keyName').value.trim() }) });
    closeDialog($('#keyDialog'));
    $('#keyName').value = '';
    await loadConfig();
    const createdKey = result.item.key;
    try { await navigator.clipboard.writeText(createdKey); } catch { /* clipboard permission is optional */ }
    window.prompt('本地 Key 已创建，请复制并妥善保存（之后只显示掩码）：', createdKey);
  } catch (error) { toast(error.message, 'error'); }
}

async function rotateAdminToken() {
  if (!window.confirm('轮换后当前管理员 Token 会立即失效，确定继续吗？')) return;
  try {
    const result = await api('/api/admin/admin-token/rotate', { method: 'POST', body: '{}' });
    $('#adminToken').value = result.adminToken;
    toast('管理员 Token 已轮换，新 Token 已填入输入框');
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
      if (!window.confirm('确定导入这个配置吗？当前的上游和路由会被替换；当前管理员 Token 和本地 Key 会保留。')) return;
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
$('#adminToken').addEventListener('keydown', (event) => { if (event.key === 'Enter') loadConfig(); });
$('#rotateTokenButton').addEventListener('click', rotateAdminToken);
$('#addUpstreamButton').addEventListener('click', () => fillUpstreamForm());
$('#addRouteButton').addEventListener('click', () => {
  if (!state.config.upstreams.length) return toast('请先添加至少一个上游站点', 'error');
  fillRouteForm();
});
$('#addKeyButton').addEventListener('click', () => openDialog($('#keyDialog')));
$('#upstreamForm').addEventListener('submit', saveUpstream);
$('#routeForm').addEventListener('submit', saveRoute);
$('#keyForm').addEventListener('submit', createKey);
$('#keyEditForm').addEventListener('submit', saveKeyEdit);
$('#upstreamList').addEventListener('click', handleListClick);
$('#routeList').addEventListener('click', handleListClick);
$('#keyList').addEventListener('click', handleListClick);
$('#clearMetricsButton').addEventListener('click', clearMetrics);
$('#syncAllModelsButton').addEventListener('click', syncAllModels);
$('#saveModelSelectionsButton').addEventListener('click', saveModelSelections);
$('#modelCatalogSearch').addEventListener('input', renderModelCatalog);
$('#showThinkingModelsOnly').addEventListener('change', renderModelCatalog);
$('#expandAllModelsButton').addEventListener('click', () => expandProviders(true));
$('#collapseAllModelsButton').addEventListener('click', () => expandProviders(false));
$('#modelCatalogList').addEventListener('click', (event) => {
  const button = event.target.closest('[data-action="toggle-provider"]');
  if (button) toggleProvider(button.dataset.providerId);
});
$('#saveSettingsButton').addEventListener('click', saveSettings);
$('#exportConfigButton').addEventListener('click', exportConfig);
$('#importConfigButton').addEventListener('click', () => $('#configFileInput').click());
$('#configFileInput').addEventListener('change', (event) => {
  importConfigFile(event.target.files[0]);
  event.target.value = '';
});
checkHealth();