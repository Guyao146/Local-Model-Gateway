const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const projectRoot = path.join(__dirname, '..');
const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'local-model-gateway-selection-'));
const gatewayPort = 21000 + Math.floor(Math.random() * 1000);

function requestJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
    }, (response) => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { raw += chunk; });
      response.on('end', () => {
        let body = {};
        try { body = raw ? JSON.parse(raw) : {}; } catch { body = { raw }; }
        resolve({ status: response.statusCode, headers: response.headers, body });
      });
    });
    request.on('error', reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}

function waitForOutput(child, marker) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`等待网关启动超时：${output}`)), 10000);
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

function jsonResponse(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

async function main() {
  const observed = { openai: [], anthropic: [] };
  const openai = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    if (req.url === '/v1/models') {
      jsonResponse(res, 200, {
        object: 'list',
        data: [
          { id: 'o3-mini', owned_by: 'mock', supports_thinking: true, reasoning_effort: ['low', 'medium', 'high'], supported_parameters: ['reasoning_effort'] },
          { id: 'gpt-plain', owned_by: 'mock', supports_thinking: false }
        ]
      });
      return;
    }
    if (req.url === '/v1/chat/completions') {
      const body = JSON.parse(raw);
      observed.openai.push(body);
      jsonResponse(res, 200, {
        id: 'selection-openai',
        model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: `openai-thinking:${body.reasoning_effort || 'none'}` }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 }
      });
      return;
    }
    jsonResponse(res, 404, { error: { message: 'not found' } });
  });
  const anthropic = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    if (req.url === '/v1/models') {
      jsonResponse(res, 200, {
        data: [{ id: 'claude-3-7-sonnet', capabilities: { thinking: true, thinking_levels: ['low', 'medium', 'high'] } }]
      });
      return;
    }
    if (req.url === '/v1/messages') {
      const body = JSON.parse(raw);
      observed.anthropic.push(body);
      jsonResponse(res, 200, {
        id: 'selection-anthropic',
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [{ type: 'text', text: `anthropic-budget:${body.thinking?.budget_tokens || 'none'}` }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 4, output_tokens: 5 }
      });
      return;
    }
    jsonResponse(res, 404, { error: { message: 'not found' } });
  });
  await new Promise((resolve) => openai.listen(0, '127.0.0.1', resolve));
  await new Promise((resolve) => anthropic.listen(0, '127.0.0.1', resolve));
  const openaiPort = openai.address().port;
  const anthropicPort = anthropic.address().port;
  const gateway = spawn(process.execPath, ['src/server.js'], {
    cwd: projectRoot,
    env: { ...process.env, PORT: String(gatewayPort), LOCAL_MODEL_GATEWAY_DATA_DIR: dataDirectory },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  gateway.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  try {
    const output = await waitForOutput(gateway, '管理 Token：');
    const config = JSON.parse(fs.readFileSync(path.join(dataDirectory, 'config.json'), 'utf8'));
    const adminHeaders = { 'X-Admin-Token': config.adminToken };
    const localHeaders = { Authorization: `Bearer ${config.localApiKeys[0].key}` };
    const addUpstream = (name, port, protocol, models) => requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/upstreams`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ name, baseUrl: `http://127.0.0.1:${port}/v1`, protocol, authType: 'none', apiKey: '', models })
    });
    const openaiUpstream = await addUpstream('OpenAI Model Catalog', openaiPort, 'openai', 'o3-mini,gpt-plain');
    const anthropicUpstream = await addUpstream('Anthropic Model Catalog', anthropicPort, 'anthropic', 'claude-3-7-sonnet');
    assert.equal(openaiUpstream.status, 201, output);
    assert.equal(anthropicUpstream.status, 201, output);

    const sync = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/model-catalog/sync`, {
      method: 'POST', headers: adminHeaders, body: '{}'
    });
    assert.equal(sync.status, 200, JSON.stringify(sync.body));
    const openaiCatalog = sync.body.catalog.upstreams.find((item) => item.id === openaiUpstream.body.id);
    const anthropicCatalog = sync.body.catalog.upstreams.find((item) => item.id === anthropicUpstream.body.id);
    assert.equal(openaiCatalog.models.find((item) => item.id === 'o3-mini').supportsThinking, true);
    assert.equal(openaiCatalog.models.find((item) => item.id === 'gpt-plain').supportsThinking, false);
    assert.equal(anthropicCatalog.models.find((item) => item.id === 'claude-3-7-sonnet').supportsThinking, true);

    const selections = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/model-selections`, {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({ selections: [
        { upstreamId: openaiUpstream.body.id, upstreamModel: 'o3-mini', localModel: 'my-o3', thinkingLevel: 'high' },
        { upstreamId: anthropicUpstream.body.id, upstreamModel: 'claude-3-7-sonnet', localModel: 'my-claude', thinkingLevel: 'medium' }
      ] })
    });
    assert.equal(selections.status, 200, JSON.stringify(selections.body));
    assert.equal(selections.body.selectionMode, true);
    assert.equal(selections.body.selections.length, 2);

    const models = await requestJson(`http://127.0.0.1:${gatewayPort}/v1/models`, { headers: localHeaders });
    assert.equal(models.status, 200, JSON.stringify(models.body));
    assert.deepEqual(models.body.data.map((item) => item.id).sort(), ['my-claude', 'my-o3']);

    const openaiRequest = await requestJson(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST', headers: localHeaders, body: JSON.stringify({ model: 'my-o3', messages: [{ role: 'user', content: 'hello' }] })
    });
    assert.equal(openaiRequest.status, 200, JSON.stringify(openaiRequest.body));
    assert.equal(openaiRequest.body.choices[0].message.content, 'openai-thinking:high');
    assert.equal(observed.openai.at(-1).reasoning_effort, 'high');
    assert.equal(observed.openai.at(-1).thinkingLevel, undefined);

    const explicitOverride = await requestJson(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST', headers: localHeaders, body: JSON.stringify({ model: 'my-o3', reasoning_effort: 'low', messages: [{ role: 'user', content: 'hello' }] })
    });
    assert.equal(explicitOverride.status, 200, JSON.stringify(explicitOverride.body));
    assert.equal(observed.openai.at(-1).reasoning_effort, 'low');

    const anthropicRequest = await requestJson(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST', headers: localHeaders, body: JSON.stringify({ model: 'my-claude', max_tokens: 100, messages: [{ role: 'user', content: 'hello' }] })
    });
    assert.equal(anthropicRequest.status, 200, JSON.stringify(anthropicRequest.body));
    assert.equal(anthropicRequest.body.choices[0].message.content, 'anthropic-budget:4096');
    assert.equal(observed.anthropic.at(-1).thinking.type, 'enabled');
    assert.equal(observed.anthropic.at(-1).thinking.budget_tokens, 4096);
    assert.ok(observed.anthropic.at(-1).max_tokens >= 5120);

    const exported = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/config/export`, { headers: adminHeaders });
    assert.equal(exported.status, 200, JSON.stringify(exported.body));
    assert.equal(exported.body.config.modelSelectionMode, true);
    assert.equal(exported.body.config.modelSelections.length, 2);
    console.log('model selection integration tests passed');
  } catch (error) {
    throw new Error(`${error.message}\n${stderr}`);
  } finally {
    gateway.kill();
    await Promise.all([
      new Promise((resolve) => openai.close(resolve)),
      new Promise((resolve) => anthropic.close(resolve))
    ]);
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});