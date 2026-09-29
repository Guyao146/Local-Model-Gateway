// 能力声明与请求内容检查独立于路由；未知不等于不支持，不用模型名猜测模态。
const ALIASES = { vision: 'image', images: 'image', document: 'file', documents: 'file', pdf: 'file' };
function normalizeModalities(value) {
  if (!Array.isArray(value) && typeof value !== 'string') return null;
  const items = Array.isArray(value) ? value : value.split(/[,+\s]+/);
  if (items.some((item) => typeof item !== 'string')) return null;
  return [...new Set(items.map((item) => item.trim().toLowerCase()).filter(Boolean).map((item) => Object.hasOwn(ALIASES, item) ? ALIASES[item] : item))];
}

function modalityMetadata(raw = {}, existing = {}) {
  const own = typeof raw.inputModalitySource === 'string';
  const caps = raw.capabilities || {};
  const architecture = raw.architecture || {};
  const arrow = typeof architecture.modality === 'string' ? architecture.modality.split('->') : [];
  const result = {};
  let hasInputDeclaration = false;
  for (const direction of ['input', 'output']) {
    const field = `${direction}Modalities`;
    const source = `${direction}ModalitySource`;
    const declared = own ? null : normalizeModalities(
      raw[`${direction}_modalities`] ?? raw[field] ?? raw[`supported_${direction}_modalities`]
      ?? caps[`${direction}_modalities`] ?? caps[field] ?? raw.modalities?.[direction]
      ?? caps.modalities?.[direction] ?? architecture[`${direction}_modalities`]
      ?? (arrow.length === 2 ? arrow[direction === 'input' ? 0 : 1] : undefined)
    );
    const stored = own ? normalizeModalities(raw[field]) : null;
    result[field] = declared ?? stored ?? normalizeModalities(existing[field]);
    if (direction === 'input') hasInputDeclaration = declared !== null;
    result[source] = declared !== null ? 'metadata' : ((stored !== null ? raw[source] : existing[source]) || 'unknown');
  }
  // vision: false 只声明图片不支持，不能把音频/文件一并判成不支持。
  result.inputModalitySupport = { ...(existing.inputModalitySupport || {}), ...(own ? raw.inputModalitySupport || {} : {}) };
  if (!own) {
    for (const modality of ['image', 'audio', 'video', 'file']) {
      const value = raw[`supports_${modality}`] ?? caps[`supports_${modality}`] ?? caps[modality]
        ?? (modality === 'image' ? raw.vision ?? caps.vision : undefined);
      if (typeof value === 'boolean') {
        result.inputModalitySupport[modality] = value;
        if (!hasInputDeclaration && Array.isArray(result.inputModalities)) {
          result.inputModalities = result.inputModalities.filter((item) => item !== modality);
          if (value) result.inputModalities.push(modality);
        }
      }
    }
  }
  if (result.inputModalities !== null) {
    result.inputModalitySupport = Object.fromEntries(['text', 'image', 'audio', 'video', 'file'].map((item) => [item, result.inputModalities.includes(item)]));
  }
  if (Object.keys(result.inputModalitySupport).length) result.inputModalitySource = 'metadata';
  result.modalitySource = result.inputModalitySource === 'metadata' || result.outputModalitySource === 'metadata' ? 'metadata' : 'unknown';
  return result;
}

function supportsInput(entry, modality) {
  if (Array.isArray(entry?.inputModalities)) return entry.inputModalities.includes(modality);
  return typeof entry?.inputModalitySupport?.[modality] === 'boolean' ? entry.inputModalitySupport[modality] : null;
}

function partModality(part) {
  const types = { image_url: 'image', input_image: 'image', image: 'image', input_audio: 'audio', audio: 'audio',
    video_url: 'video', input_video: 'video', video: 'video', file: 'file', input_file: 'file', document: 'file' };
  return Object.hasOwn(types, part?.type) ? types[part.type] : null;
}

// 只遍历协议规定的内容位置，绝不将工具参数、JSON schema 或 metadata 当成附件。
async function mapInputParts(input, protocol, transform) {
  async function content(value, role) {
    if (!Array.isArray(value)) return value;
    const result = [];
    for (const part of value) {
      if (partModality(part)) result.push(await transform(part, role));
      else if (part?.type === 'tool_result') result.push({ ...part, content: await content(part.content, role) });
      else result.push(part);
    }
    return result;
  }
  const field = protocol === 'responses' ? 'input' : 'messages';
  const isArray = Array.isArray(input[field]);
  const items = isArray ? input[field] : protocol === 'responses' && input[field] && typeof input[field] === 'object' ? [input[field]] : null;
  if (!items) return input;
  const messages = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') { messages.push(item); continue; }
    if (protocol === 'responses' && partModality(item)) messages.push(await transform(item, 'user'));
    else if (item.type === 'function_call_output') messages.push({ ...item, output: await content(item.output, 'tool') });
    else if (Array.isArray(item.content)) messages.push({ ...item, content: await content(item.content, item.role) });
    else messages.push(item);
  }
  return { ...input, [field]: isArray ? messages : messages[0] };
}

function inputMediaParts(input, protocol) {
  const parts = [];
  const content = (items) => {
    for (const item of Array.isArray(items) ? items : []) {
      if (partModality(item)) parts.push(item);
      else if (item?.type === 'tool_result') content(item.content);
    }
  };
  const items = protocol === 'responses' && input.input && typeof input.input === 'object' && !Array.isArray(input.input)
    ? [input.input] : protocol === 'responses' ? input.input : input.messages;
  for (const item of Array.isArray(items) ? items : []) {
    if (partModality(item)) parts.push(item);
    else if (item?.type === 'function_call_output') content(item.output);
    else content(item?.content);
  }
  return parts;
}

function assertMediaPreserved(input, protocol, body, targetProtocol) {
  const before = inputMediaParts(input, protocol);
  const after = inputMediaParts(body, targetProtocol);
  if (before.length !== after.length || before.some((part, index) => partModality(part) !== partModality(after[index]))) {
    throw Object.assign(new Error('当前协议转换无法无损传递此附件，请使用相同协议的上游或配置可处理该输入的路由'), { statusCode: 400, code: 'unsupported_modality_conversion' });
  }
}

function normalizeTranslator(value, localModel) {
  if (value == null || value === '') return '';
  if (typeof value !== 'string' || !value.trim() || value.trim() === '*' || value.length > 200) {
    throw Object.assign(new Error('模态转译模型必须是有效的本地模型名'), { statusCode: 400 });
  }
  if (value.trim().toLowerCase() === localModel.toLowerCase()) {
    throw Object.assign(new Error('模态转译模型不能指向自身'), { statusCode: 400 });
  }
  return value.trim();
}

module.exports = { normalizeModalities, modalityMetadata, supportsInput, partModality, mapInputParts, inputMediaParts, assertMediaPreserved, normalizeTranslator };