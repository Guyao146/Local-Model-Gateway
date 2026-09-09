const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const projectRoot = path.join(__dirname, '..');
const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'local-model-gateway-stream-'));
const gatewayPort = 20000 + Math.floor(Math.random() * 1000);

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const requestObject = http.request(url, { ...options, headers: { ...(options.headers || {}) } }, (response) => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { raw += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: raw }));
    });
    requestObject.on('error', reject);
    if (options.body) requestObject.write(options.body);
    requestObject.end();
  });
}

function requestJson(url, options = {}) {
  return request(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  }).then((result) => ({ ...result, json: result.body ? JSON.parse(result.body) : {} }));
}

function waitForOutput(child, marker) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`等待启动超时：${output}`)), 10000);
    const onData = (chunk) => {
      output += chunk.toString();
      if (output.includes(marker)) {
        clearTimeout(timer);
        child.stdout.removeListener('data', onData);
        resolve(output);
      }
    };
    child.stdout.on('data', onData);
    child.once('error', reject);
  });
}

function parseSse(body) {
  return body.split(/\r?\n\r?\n/).filter(Boolean).map((frame) => {
    const event = { name: '', data: '' };
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith('event:')) event.name = line.slice(6).trim();
      if (line.startsWith('data:')) event.data += (event.data ? '\n' : '') + line.slice(5).trimStart();
    }
    return event;
  });
}

function writeSse(res, data, eventName) {
  if (eventName) res.write(`event: ${eventName}\n`);
  res.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
}

async function main() {
  const openAI = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    res.setHeader('Content-Type', 'text/event-stream');
    if (req.url === '/v1/responses') {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ error: { message: 'Responses API is not supported' } }));
    }
    if (req.url !== '/v1/chat/completions') return res.end('data: {"object":"list","data":[]}\n\n');
    const body = JSON.parse(raw);
    writeSse(res, { id: 'stream-chat', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
    writeSse(res, { id: 'stream-chat', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { content: 'hello ' }, finish_reason: null }] });
    writeSse(res, { id: 'stream-chat', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { content: 'stream' }, finish_reason: null }] });
    writeSse(res, { id: 'stream-chat', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } });
    writeSse(res, '[DONE]');
    res.end();
  });
  const anthropic = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    res.setHeader('Content-Type', 'text/event-stream');
    if (req.url !== '/v1/messages') return res.end();
    const body = JSON.parse(raw);
    writeSse(res, { type: 'message_start', message: { id: 'anthropic-stream', usage: { input_tokens: 7 } } }, 'message_start');
    writeSse(res, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, 'content_block_start');
    writeSse(res, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello anthropic' } }, 'content_block_delta');
    writeSse(res, { type: 'content_block_stop', index: 0 }, 'content_block_stop');
    writeSse(res, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } }, 'message_delta');
    writeSse(res, { type: 'message_stop' }, 'message_stop');
    // A real Anthropic stream ends with message_stop rather than [DONE].
    void body;
    res.end();
  });
  await new Promise((resolve) => openAI.listen(0, '127.0.0.1', resolve));
  await new Promise((resolve) => anthropic.listen(0, '127.0.0.1', resolve));
  const openAIPort = openAI.address().port;
  const anthropicPort = anthropic.address().port;
  const gateway = spawn(process.execPath, ['src/server.js'], {
    cwd: projectRoot,
    env: { ...process.env, PORT: String(gatewayPort), LOCAL_MODEL_GATEWAY_DATA_DIR: dataDirectory },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  gateway.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  try {
    const output = await waitForOutput(gateway, '本地管理访问：无需认证');
    const config = JSON.parse(fs.readFileSync(path.join(dataDirectory, 'config.json'), 'utf8'));
    const adminHeaders = {};
    const localHeaders = { Authorization: `Bearer ${config.localApiKeys[0].key}` };
    const add = (name, port, protocol, model) => requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/upstreams`, {
      method: 'POST', headers: adminHeaders, body: JSON.stringify({ name, baseUrl: `http://127.0.0.1:${port}/v1`, protocol, authType: 'none', apiKey: '', models: model })
    });
    const openAIUpstream = await add('openai-stream', openAIPort, 'openai', 'openai-stream-model');
    const anthropicUpstream = await add('anthropic-stream', anthropicPort, 'anthropic', 'anthropic-stream-model');
    assert.equal(openAIUpstream.status, 201, output);
    assert.equal(anthropicUpstream.status, 201, output);
    const addRoute = (localModel, upstreamId, upstreamModel) => requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/routes`, {
      method: 'POST', headers: adminHeaders, body: JSON.stringify({ localModel, upstreamId, upstreamModel })
    });
    assert.equal((await addRoute('openai-stream-local', openAIUpstream.json.id, 'openai-stream-model')).status, 201);
    assert.equal((await addRoute('anthropic-stream-local', anthropicUpstream.json.id, 'anthropic-stream-model')).status, 201);
    const openAIStream = await request(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST', headers: { ...localHeaders, 'x-request-id': 'stream-openai-001' }, body: JSON.stringify({ model: 'openai-stream-local', stream: true, messages: [{ role: 'user', content: 'hi' }] })
    });
    assert.equal(openAIStream.status, 200, openAIStream.body);
    assert.equal(openAIStream.headers['x-request-id'], 'stream-openai-001');
    const openAIEvents = parseSse(openAIStream.body);
    assert.equal(openAIEvents.filter((event) => event.data === '[DONE]').length, 1);
    assert.equal(openAIEvents.map((event) => event.data).filter((data) => data.includes('hello stream')).length, 0);
    const openAIJsonEvents = openAIEvents.map((event) => { try { return JSON.parse(event.data); } catch { return null; } }).filter(Boolean);
    assert.equal(new Set(openAIJsonEvents.map((event) => event.id)).size, 1);
    const openAIText = openAIJsonEvents.map((event) => event.choices?.[0]?.delta?.content || '').join('');
    assert.equal(openAIText, 'hello stream');
    const anthropicStream = await request(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST', headers: { ...localHeaders, 'x-request-id': 'stream-anthropic-001' }, body: JSON.stringify({ model: 'anthropic-stream-local', stream: true, messages: [{ role: 'user', content: 'hi' }] })
    });
    assert.equal(anthropicStream.status, 200, anthropicStream.body);
    assert.equal(anthropicStream.headers['x-request-id'], 'stream-anthropic-001');
    const anthropicEvents = parseSse(anthropicStream.body);
    assert.equal(anthropicEvents.filter((event) => event.data === '[DONE]').length, 1);
    const anthropicJsonEvents = anthropicEvents.map((event) => { try { return JSON.parse(event.data); } catch { return null; } }).filter(Boolean);
    assert.equal(new Set(anthropicJsonEvents.map((event) => event.id)).size, 1);
    const anthropicText = anthropicJsonEvents.map((event) => event.choices?.[0]?.delta?.content || '').join('');
    assert.equal(anthropicText, 'hello anthropic');
    const responseStream = await request(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
      method: 'POST', headers: { ...localHeaders, 'x-request-id': 'stream-responses-001' }, body: JSON.stringify({ model: 'openai-stream-local', stream: true, input: 'hi' })
    });
    assert.equal(responseStream.status, 200, responseStream.body);
    assert.equal(responseStream.headers['x-request-id'], 'stream-responses-001');
    const responseEvents = parseSse(responseStream.body);
    assert.ok(responseEvents.some((event) => event.name === 'response.created'));
    assert.ok(responseEvents.some((event) => event.name === 'response.output_text.delta'));
    assert.equal(responseEvents.filter((event) => event.name === 'response.completed').length, 1);
    const completed = JSON.parse(responseEvents.find((event) => event.name === 'response.completed').data);
    assert.equal(completed.response.output_text, 'hello stream');
    const metrics = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/metrics`, { headers: adminHeaders });
    assert.equal(metrics.status, 200, JSON.stringify(metrics.json));
    assert.equal(metrics.json.totals.requests, 3);
    assert.equal(metrics.json.totals.promptTokens, 11);
    assert.equal(metrics.json.totals.completionTokens, 10);
    assert.equal(metrics.json.totals.totalTokens, 21);
    assert.equal(metrics.json.logs.every((entry) => entry.stream), true);
    console.log('stream integration tests passed');
  } catch (error) {
    throw new Error(`${error.message}\n${stderr}`);
  } finally {
    gateway.kill();
    await Promise.all([
      new Promise((resolve) => openAI.close(resolve)),
      new Promise((resolve) => anthropic.close(resolve))
    ]);
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});