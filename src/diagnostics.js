const { responseId } = require('./protocol');

// 客户端（Codex 等严格反序列化的 SDK）要求 id/call_id 等字段必须是字符串。
// 上游有时返回数字、null 或对象，网关在输出前统一归一化，并把“修过哪里”记进日志。
const ID_KEYS = new Set(['id', 'call_id', 'item_id', 'response_id', 'previous_response_id']);
const MAX_FRAMES = 12;
const MAX_FRAME_CHARS = 1000;
const MAX_SAMPLE_CHARS = 3000;
const MAX_WARNINGS = 10;
const MAX_WARNING_CHARS = 300;

function createDiagnostics() {
  return {
    upstreamPath: '',
    nativeResponses: false,
    responsesMode: '',
    upstreamRequest: '',
    upstreamResponse: [],
    output: [],
    warnings: []
  };
}

// 只保留流开头若干帧：id 类问题总在最前面出现，丢掉尾部即可。
function sample(list, text) {
  if (!Array.isArray(list) || list.length >= MAX_FRAMES) return;
  const frame = String(text || '');
  if (!frame) return;
  list.push(frame.length > MAX_FRAME_CHARS ? `${frame.slice(0, MAX_FRAME_CHARS)}…` : frame);
  let total = list.reduce((sum, item) => sum + item.length, 0);
  while (list.length > 1 && total > MAX_SAMPLE_CHARS) {
    const dropped = list.pop();
    total -= dropped.length;
  }
}

function warn(diag, message) {
  if (!diag || !Array.isArray(diag.warnings) || diag.warnings.length >= MAX_WARNINGS) return;
  const text = String(message).slice(0, MAX_WARNING_CHARS);
  if (text && !diag.warnings.includes(text)) diag.warnings.push(text);
}

// 递归找出所有“存在但不是字符串”的 id 类字段。
function scanIds(value, path, bad) {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) scanIds(value[index], `${path}[${index}]`, bad);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      const childPath = `${path}.${key}`;
      if (ID_KEYS.has(key) && item !== null && item !== undefined && typeof item !== 'string') {
        bad.push({ path: childPath, value: item });
      }
      scanIds(item, childPath, bad);
    }
  }
}

// 就地把非字符串 id 改成字符串（数字直接转，对象序列化）。
function normalizeIdsInPlace(value) {
  if (Array.isArray(value)) {
    for (const item of value) normalizeIdsInPlace(item);
    return;
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      if (ID_KEYS.has(key)) {
        const item = value[key];
        if (item !== null && item !== undefined && typeof item !== 'string') {
          value[key] = responseId(item, JSON.stringify(item));
        }
      }
      normalizeIdsInPlace(value[key]);
    }
  }
}

function captureUpstreamRequest(diag, requestInfo) {
  if (!diag || !requestInfo) return;
  try {
    const url = String(requestInfo.endpoint || '');
    diag.upstreamPath = url.replace(/^https?:\/\/[^/]+/, '').slice(0, 200);
  } catch {
    diag.upstreamPath = '';
  }
  diag.nativeResponses = !!requestInfo.nativeResponses;
  diag.responsesMode = String(requestInfo.responsesMode || '');
  try {
    const json = JSON.stringify(requestInfo.body);
    diag.upstreamRequest = json.length > 2000 ? `${json.slice(0, 2000)}…` : json;
  } catch {
    diag.upstreamRequest = '<无法序列化>';
  }
}

function captureUpstreamEvent(diag, parsed) {
  if (!diag) return;
  try {
    sample(diag.upstreamResponse, JSON.stringify(parsed));
  } catch {
    // 非可序列化的事件体不影响转发，也不影响采样。
  }
}

// 包装 res.write/res.end：采样发给客户端的每一帧，并就地修正非字符串 id。
// 对正常流是透传（逐字不变），只有在解析出非字符串 id 时才重写该帧。
function attachOutputCapture(res, diag) {
  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);
  let buffer = '';
  let active = true;

  // 采样层绝不把异常抛给调用方：写入失败只记录，不影响响应链。
  const safeWrite = (text) => {
    try { originalWrite(text); } catch (error) { warn(diag, `输出写入失败：${error.message}`); }
  };

  const processFrame = (frame) => {
    const lines = frame.split(/\r?\n/);
    let eventName = '';
    const dataLines = [];
    for (const line of lines) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (!dataLines.length) return frame;
    const data = dataLines.join('\n');
    sample(diag.output, frame);
    if (data === '[DONE]') return frame;
    let parsed;
    try { parsed = JSON.parse(data); } catch { return frame; }
    const bad = [];
    scanIds(parsed, '$', bad);
    if (!bad.length) return frame;
    normalizeIdsInPlace(parsed);
    for (const item of bad) {
      warn(diag, `输出帧含非字符串 id：${item.path} = ${JSON.stringify(item.value)}（已自动修正为字符串）`);
    }
    return `${eventName ? `event: ${eventName}\n` : ''}data: ${JSON.stringify(parsed)}`;
  };

  const processText = (text) => {
    buffer += text;
    // 用捕获组保留分隔符，透传帧才能逐字还原（连同 \n\n 一起）。
    const parts = buffer.split(/(\r?\n\r?\n)/);
    buffer = parts.pop() || '';
    for (let index = 0; index < parts.length; index += 2) {
      const frame = parts[index];
      const separator = parts[index + 1] || '';
      const out = processFrame(frame);
      if (out !== null && out !== undefined) safeWrite(out + separator);
    }
  };

  const flush = () => {
    if (buffer) {
      const out = processFrame(buffer);
      buffer = '';
      if (out !== null && out !== undefined) safeWrite(out);
    }
  };

  res.write = (chunk, ...rest) => {
    if (!active || chunk === undefined || chunk === null) {
      try { return originalWrite(chunk, ...rest); } catch (error) { warn(diag, `输出写入失败：${error.message}`); return true; }
    }
    try {
      processText(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    } catch (error) {
      active = false;
      warn(diag, `输出采样失败，已退化为透传：${error.message}`);
      try { return originalWrite(chunk, ...rest); } catch (fallbackError) { warn(diag, `输出写入失败：${fallbackError.message}`); }
    }
    return true;
  };

  res.end = (...args) => {
    try {
      if (args.length && args[0] !== undefined && args[0] !== null) {
        processText(Buffer.isBuffer(args[0]) ? args[0].toString('utf8') : String(args[0]));
      }
      flush();
    } catch (error) {
      active = false;
      warn(diag, `输出采样失败，已退化为透传：${error.message}`);
    }
    try { return originalEnd(...args); } catch (error) { warn(diag, `输出结束失败：${error.message}`); }
  };
}

module.exports = {
  createDiagnostics,
  sample,
  warn,
  scanIds,
  normalizeIdsInPlace,
  captureUpstreamRequest,
  captureUpstreamEvent,
  attachOutputCapture
};
