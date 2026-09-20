function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(body, fallback = '上游请求失败') {
  const messages = [body?.error?.message, body?.response?.error?.message, body?.message, body?.error, body?.response?.error, body];
  return messages.find((message) => typeof message === 'string' && message.length > 0) ?? fallback;
}

function errorCode(body, status) {
  // type 是协议错误类别，不充当错误码；0 也是有效的上游 code。
  const codes = [body?.error?.code, body?.response?.error?.code, body?.code];
  for (const code of codes) {
    if (typeof code === 'string' && code.trim()) return code.trim();
    if (typeof code === 'number' && Number.isFinite(code)) return String(code);
  }
  const httpStatus = Number(status);
  return Number.isInteger(httpStatus) && httpStatus >= 400 && httpStatus <= 599 ? String(httpStatus) : '502';
}

function isErrorPayload(body, eventName = '') {
  if (!isObject(body)) return false;
  return Boolean(body.error || body.response?.error)
    || body.type === 'error' || eventName === 'error'
    || body.type === 'response.failed' || eventName === 'response.failed'
    || body.status === 'failed' || body.response?.status === 'failed';
}

function formatErrorMessage(message, { prefix = '', requestId, code }) {
  const context = `[request_id=${requestId}] [code=${code}]`;
  const label = prefix ? `${prefix} ` : '';
  let text = String(message ?? '');
  const header = `${label}${context}`;
  if (text === header || text.startsWith(`${header} `)) return text;
  // 兼容已加过前缀的错误，避免 JSON/流式出口重复装饰同一条消息。
  if (prefix && (text === prefix || text.startsWith(label))) text = text.slice(label.length);
  if (text === context || text.startsWith(`${context} `)) return `${label}${text}`;
  return `${header}${text ? ` ${text}` : ''}`;
}

function formatErrorPayload(body, { prefix = '', requestId, status, eventName = '' }) {
  const source = isObject(body) ? body : { message: errorMessage(body) };
  const fallback = Number(status) >= 400 ? `上游返回 HTTP ${status}` : '上游请求失败';
  const message = formatErrorMessage(errorMessage(source, fallback), {
    prefix, requestId, code: errorCode(source, status)
  });
  // 仅拷贝错误所在层：保留 Responses 的 response.failed 和顶层 error 事件形态。
  let result;
  if (source.error !== undefined && source.error !== null) {
    result = { ...source, error: { ...(isObject(source.error) ? source.error : {}), message } };
  } else if (isObject(source.response) && (source.response.error || source.response.status === 'failed'
    || source.type === 'response.failed' || eventName === 'response.failed')) {
    result = { ...source, response: { ...source.response, error: { ...(isObject(source.response.error) ? source.response.error : {}), message } } };
  } else {
    result = { ...source, message };
  }
  // request_id 属于当前网关请求，不能被上游自己的追踪 ID 覆盖。
  return { ...result, request_id: requestId };
}

function errorForProtocol(localProtocol, body, status) {
  const source = isObject(body) ? body : {};
  const details = isObject(source.error) ? source.error
    : isObject(source.response?.error) ? source.response.error
      : {
          ...(source.code !== undefined ? { code: source.code } : {}),
          ...(source.param !== undefined ? { param: source.param } : {}),
          ...(source.type && source.type !== 'error' ? { type: source.type } : {})
        };
  const error = { ...details, message: errorMessage(body, `上游返回 HTTP ${status}`) };
  if (localProtocol === 'anthropic') {
    return { ...(source.error ? source : {}), type: 'error', error: { type: 'api_error', ...error } };
  }
  return source.error ? { ...source, error } : { error: { type: 'upstream_error', ...error } };
}

function streamErrorForProtocol(localProtocol, body, status = 502) {
  const payload = errorForProtocol(localProtocol, body, status);
  if (localProtocol !== 'responses') return payload;
  // Responses SSE 的 error 事件使用顶层 code/message，而不是 Chat 的 error 对象。
  return {
    ...payload.error,
    type: 'error',
    code: payload.error.code ?? errorCode(body, status),
    param: payload.error.param ?? null
  };
}

module.exports = {
  errorMessage,
  errorCode,
  isErrorPayload,
  formatErrorMessage,
  formatErrorPayload,
  errorForProtocol,
  streamErrorForProtocol
};