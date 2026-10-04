const { classifyEndpointError } = require('./endpoint-routing');
const { isErrorPayload } = require('./errors');

// 暂存至首个 data 帧或累计 64 KiB（可能多出一个网络分片），之后逐字回放，不缓存整段生成。
// 仅兼容性错误会在提交客户端响应前抛出，普通流错误仍按原协议返回。
async function inspectStreamStart(response) {
  if (!response.body) return response;
  const reader = response.body.getReader();
  const chunks = [];
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  let ended = false;
  let readError;
  try {
    while (size < 65536) {
      const { done, value } = await reader.read();
      ended = done;
      if (value) { chunks.push(value); size += value.byteLength; }
      text += decoder.decode(value || new Uint8Array(), { stream: !done });
      const frames = text.split(/\r?\n\r?\n/);
      text = done ? '' : frames.pop();
      let seenData = false;
      for (const frame of frames) {
        const lines = frame.split(/\r?\n/);
        const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
        if (!data) continue;
        seenData = true;
        let body;
        try { body = JSON.parse(data); } catch { break; }
        const eventName = lines.find((line) => line.startsWith('event:'))?.slice(6).trim();
        if (isErrorPayload(body, eventName)
          && classifyEndpointError(response.status, body) === 'capability') {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
          throw Object.assign(new Error('Endpoint capability error before stream output'), { upstreamBody: body });
        }
        break;
      }
      if (seenData || done) break;
    }
  } catch (error) {
    if (error.upstreamBody) throw error;
    readError = error;
  }
  // 保留网络错误的流语义，避免把已经读取的字节遗失。
  let index = 0;
  const { ReadableStream } = require('node:stream/web');
  const body = new ReadableStream({
    async pull(controller) {
      if (index < chunks.length) { controller.enqueue(chunks[index++]); return; }
      if (readError) { controller.error(readError); reader.releaseLock(); return; }
      if (ended) { controller.close(); reader.releaseLock(); return; }
      try {
        const { done, value } = await reader.read();
        if (done) { controller.close(); reader.releaseLock(); }
        else controller.enqueue(value);
      } catch (error) { controller.error(error); reader.releaseLock(); }
    },
    async cancel() { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  });
  return { ok: response.ok, status: response.status, headers: response.headers, body, cleanup: response.cleanup, cancelUpstream: response.cancelUpstream };
}

module.exports = { inspectStreamStart };
