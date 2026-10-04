const { errorMessage, upstreamErrorDetails } = require('./errors');

function classifyEndpointError(status, body, network = false) {
  if (network) return 'network';
  const details = upstreamErrorDetails(body, status) || {};
  const code = `${details.code || ''} ${details.type || ''}`.toLowerCase();
  const message = errorMessage(body, '').toLowerCase();
  if (status === 401 || status === 403 || /authentication|permission|invalid_api_key/.test(code)) return 'auth';
  if (status === 429 || /rate_limit|quota|insufficient_quota/.test(code)) return 'rate';
  if (/invalid_request|validation|bad_request/.test(code) && !message) return 'request';
  const unsupported = /not supported|unsupported|not available|unavailable|not implemented|does not support|不支持|不兼容/.test(message);
  const endpoint = /\/v1\/(responses|messages|chat\/completions)|endpoint|\bresponses\b|chat completions|messages api|接口/.test(message);
  const toolsReasoning = /function|tool/.test(message) && /reasoning|thinking/.test(message);
  // 模型不存在不是端点不存在，换协议不能修复模型名或权限。
  if (/model_not_found|invalid_model/.test(code) || /model.*(not found|does not exist)/.test(message)) return 'request';
  // 明确的端点级不可用（404/405/501）才算接口能力问题。
  if (/unsupported_endpoint|unsupported_api/.test(code)) return 'capability';
  if (status === 405 || status === 501 || (status === 404 && (/not found|cannot post|404/.test(message) || !message))) return 'capability';
  if (unsupported && (endpoint || toolsReasoning)) {
    // 具体请求参数不被支持属于请求内容问题：换接口解决不了，应提示去掉该参数。
    if (/parameter|参数/.test(message) && status < 500) return 'request';
    // 5xx 的「暂时不可用」是服务端波动，不应立即冷却并切换接口。
    if (status >= 500) return 'server';
    return 'capability';
  }
  if (status === 408 || status === 425) return 'network';
  if ((status >= 400 && status < 500) || /invalid_request|invalid_argument|validation|bad_request/.test(code)) return 'request';
  return 'server';
}

// 不保存密钥、请求内容；配置更新/手工重置时清除，最多保留 4096 个模型接口状态。
function createEndpointHealth({ now = Date.now, limit = 4096 } = {}) {
  const states = new Map();
  const keyFor = (upstream, model, protocol) => JSON.stringify([upstream.id, upstream.baseUrl, model, protocol]);
  function stateFor(upstream, model, protocol) {
    const key = keyFor(upstream, model, protocol);
    if (!states.has(key)) {
      if (states.size >= limit) {
        const removable = [...states].find(([, state]) => !state.probing);
        if (!removable) return null;
        states.delete(removable[0]);
      }
      states.set(key, { upstreamId: upstream.id, failures: 0, openUntil: 0, probing: false, generation: 0 });
    }
    return states.get(key);
  }
  return {
    acquire(upstream, model, protocol) {
      const state = stateFor(upstream, model, protocol);
      if (!state || state.openUntil > now() || state.probing) return null;
      const probe = state.openUntil > 0;
      if (probe) state.probing = true;
      return { state, probe, generation: state.generation, settled: false };
    },
    release(lease) {
      if (!lease || lease.settled) return;
      if (lease.probe && lease.generation === lease.state.generation) lease.state.probing = false;
      lease.settled = true;
    },
    success(lease) {
      const state = lease?.state;
      if (!state || lease.settled || lease.generation !== state.generation) return;
      lease.settled = true;
      if (lease.probe || state.openUntil > 0) {
        // 恢复探测成功才算状态转换：解除冷却并推进代际，让冷却前的旧结果失效。
        Object.assign(state, { failures: 0, openUntil: 0, probing: false, generation: state.generation + 1 });
        return;
      }
      // 普通成功不推进代际，否则同批并发请求里稍后返回的失败会因代际过期被丢弃，冷却计数失效；
      // 只让失败计数自然回落，保留尚未返回的并发失败信号。
      if (state.failures > 0) state.failures -= 1;
    },
    failure(lease, kind, threshold, cooldown) {
      const state = lease.state;
      if (lease.settled || lease.generation !== state.generation) return state.openUntil > 0;
      lease.settled = true;
      if (kind !== 'capability' && kind !== 'server') {
        // 未完成的恢复探测不能立即放行并发探测。
        if (lease.probe) {
          state.openUntil = now() + cooldown;
          state.generation += 1;
        }
        state.probing = false;
        return false;
      }
      state.failures += 1;
      const open = kind === 'capability' || lease.probe || state.failures >= threshold;
      if (open) {
        state.openUntil = now() + cooldown;
        state.generation += 1;
      }
      state.probing = false;
      return open;
    },
    reset(upstreamId) {
      for (const [key, state] of states) {
        if (!upstreamId || state.upstreamId === upstreamId) states.delete(key);
      }
    }
  };
}

module.exports = { classifyEndpointError, createEndpointHealth };
