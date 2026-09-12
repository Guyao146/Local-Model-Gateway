const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const projectRoot = path.join(__dirname, '..');
const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'local-model-gateway-responses-native-'));
const gatewayPort = 23000 + Math.floor(Math.random() * 1000);

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
    child.once('exit', (code) => {
      if (code !== 0) reject(new Error(`网关退出（${code}）：${output}`));
    });
  });
}

function writeSse(res, data, eventName) {
  if (eventName) res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function main() {
  const received = [];
  let rejectNativeResponses = false;
  const upstream = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    received.push({ url: req.url, body: raw ? JSON.parse(raw) : {}, headers: req.headers });
    if (req.url === '/v1/models') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'native-agent-model' }] }));
      return;
    }
    if (req.url !== '/v1/responses') {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { message: 'wrong endpoint' } }));
      return;
    }
    const body = received.at(-1).body;
    res.setHeader('Content-Type', body.stream ? 'text/event-stream' : 'application/json');
    if (rejectNativeResponses) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { message: 'native responses unavailable' } }));
      return;
    }
    if (!body.stream) {
      if (Array.isArray(body.tools) && body.tools.some((tool) => tool.type === 'function')) {
        res.end(JSON.stringify({
          id: 'resp_function_001',
          object: 'response',
          created_at: 1700000001,
          status: 'completed',
          model: body.model,
          output: [{ type: 'function_call', id: 'call_function_001', call_id: 'call_function_001', name: body.tools[0].name, arguments: '{"key":"weather"}' }],
          output_text: '',
          usage: { input_tokens: 11, output_tokens: 6, total_tokens: 17 }
        }));
        return;
      }
      res.end(JSON.stringify({
        id: 'resp_native_001',
        object: 'response',
        created_at: 1700000000,
        status: 'completed',
        model: body.model,
        output: [{
          id: 'call_native_001',
          type: 'computer_call',
          status: 'completed',
          action: { type: 'click', x: 12, y: 34 }
        }],
        output_text: '',
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        custom_agent_state: { preserved: true }
      }));
      return;
    }
    if (Array.isArray(body.tools) && body.tools.some((tool) => tool.type === 'function')) {
      writeSse(res, { type: 'response.created', response: { id: 'resp_function_stream', object: 'response', status: 'in_progress', model: body.model } }, 'response.created');
      writeSse(res, { type: 'response.output_item.added', item: { id: 'call_function_stream', call_id: 'call_function_stream', type: 'function_call', name: body.tools[0].name, arguments: '' } }, 'response.output_item.added');
      writeSse(res, { type: 'response.function_call_arguments.delta', item_id: 'call_function_stream', delta: '{"key":"weather"}' }, 'response.function_call_arguments.delta');
      writeSse(res, { type: 'response.completed', response: { id: 'resp_function_stream', object: 'response', status: 'completed', usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } } }, 'response.completed');
      res.end();
      return;
    }
    writeSse(res, { type: 'response.created', response: { id: 'resp_native_stream', object: 'response', status: 'in_progress', model: body.model } }, 'response.created');
    writeSse(res, { type: 'response.output_item.added', item: { id: 'call_native_stream', type: 'computer_call', action: { type: 'screenshot' } } }, 'response.output_item.added');
    writeSse(res, { type: 'response.completed', response: { id: 'resp_native_stream', object: 'response', status: 'completed', output: [{ id: 'call_native_stream', type: 'computer_call', action: { type: 'screenshot' } }] } }, 'response.completed');
    res.end();
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = upstream.address().port;
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
    const added = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/upstreams`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ name: 'native-responses', baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, protocol: 'openai', authType: 'none', models: 'native-agent-model', responsesMode: 'auto' })
    });
    assert.equal(added.status, 201, output);
    const route = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/routes`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ localModel: 'agent-local', upstreamId: added.json.id, upstreamModel: 'native-agent-model' })
    });
    assert.equal(route.status, 201, JSON.stringify(route.json));
    const agentRequest = {
      model: 'agent-local',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'Click the button' }] }],
      tools: [{ type: 'computer', display: { type: 'computer' } }],
      previous_response_id: 'resp_previous',
      include: ['computer_call.action'],
      custom_agent_state: { keep: true }
    };
    const response = await requestJson(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
      method: 'POST', headers: { ...localHeaders, 'x-request-id': 'native-agent-001', 'OpenAI-Beta': 'responses=v1' }, body: JSON.stringify(agentRequest)
    });
    assert.equal(response.status, 200, JSON.stringify(response.json));
    assert.equal(response.json.id, 'resp_native_001');
    assert.equal(response.json.output[0].type, 'computer_call');
    assert.deepEqual(response.json.output[0].action, { type: 'click', x: 12, y: 34 });
    assert.deepEqual(response.json.custom_agent_state, { preserved: true });
    const nativeCall = received.find((item) => item.url === '/v1/responses');
    assert.ok(nativeCall);
    assert.deepEqual(nativeCall.body.tools, agentRequest.tools);
    assert.equal(nativeCall.body.previous_response_id, 'resp_previous');
    assert.deepEqual(nativeCall.body.include, agentRequest.include);
    assert.deepEqual(nativeCall.body.custom_agent_state, agentRequest.custom_agent_state);
    assert.equal(nativeCall.body.model, 'native-agent-model');
    assert.equal(nativeCall.headers['openai-beta'], 'responses=v1');
    const functionReasoningRequest = {
      model: 'agent-local',
      input: 'Use the lookup function',
      tools: [{ type: 'function', name: 'lookup', description: 'Look up a value', parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } }],
      reasoning_effort: 'medium'
    };
    const callsBeforeFunctionReasoning = received.length;
    const functionReasoningResponse = await requestJson(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
      method: 'POST', headers: localHeaders, body: JSON.stringify(functionReasoningRequest)
    });
    assert.equal(functionReasoningResponse.status, 200, JSON.stringify(functionReasoningResponse.json));
    const functionReasoningCalls = received.slice(callsBeforeFunctionReasoning);
    assert.equal(functionReasoningCalls.length, 1);
    assert.equal(functionReasoningCalls[0].url, '/v1/responses');
    assert.deepEqual(functionReasoningCalls[0].body.tools, functionReasoningRequest.tools);
    assert.equal(functionReasoningCalls[0].body.reasoning_effort, 'medium');
    const chatFunctionResponse = await requestJson(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST',
      headers: localHeaders,
      body: JSON.stringify({
        model: 'agent-local',
        messages: [{ role: 'user', content: 'Use the lookup function' }],
        tools: [{ type: 'function', function: { name: 'lookup', description: 'Look up a value', parameters: { type: 'object', properties: { key: { type: 'string' } } } } }],
        reasoning_effort: 'medium'
      })
    });
    assert.equal(chatFunctionResponse.status, 200, JSON.stringify(chatFunctionResponse.json));
    assert.equal(chatFunctionResponse.json.choices[0].finish_reason, 'tool_calls');
    assert.equal(chatFunctionResponse.json.choices[0].message.tool_calls[0].function.name, 'lookup');
    const chatFunctionCall = received.at(-1);
    assert.equal(chatFunctionCall.url, '/v1/responses');
    assert.equal(chatFunctionCall.body.reasoning_effort, 'medium');
    assert.equal(chatFunctionCall.body.tools[0].name, 'lookup');
    const chatFunctionStream = await request(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST',
      headers: localHeaders,
      body: JSON.stringify({
        model: 'agent-local',
        stream: true,
        messages: [{ role: 'user', content: 'Use the lookup function' }],
        tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: {} } } }],
        reasoning_effort: 'medium'
      })
    });
    assert.equal(chatFunctionStream.status, 200, chatFunctionStream.body);
    assert.match(chatFunctionStream.body, /"tool_calls"/);
    assert.match(chatFunctionStream.body, /lookup/);
    assert.match(chatFunctionStream.body, /data: \[DONE\]/);
    const streamResponse = await request(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
      method: 'POST', headers: { ...localHeaders, 'x-request-id': 'native-agent-stream-001' }, body: JSON.stringify({ ...agentRequest, stream: true })
    });
    assert.equal(streamResponse.status, 200, streamResponse.body);
    assert.match(streamResponse.body, /event: response\.output_item\.added/);
    assert.match(streamResponse.body, /"type":"computer_call"/);
    assert.match(streamResponse.body, /event: response\.completed/);
    assert.equal(streamResponse.headers['x-request-id'], 'native-agent-stream-001');
    rejectNativeResponses = true;
    const callsBeforeUnsupportedFunctionReasoning = received.length;
    const unsupportedFunctionReasoning = await requestJson(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
      method: 'POST', headers: localHeaders, body: JSON.stringify(functionReasoningRequest)
    });
    assert.equal(unsupportedFunctionReasoning.status, 400, JSON.stringify(unsupportedFunctionReasoning.json));
    assert.equal(unsupportedFunctionReasoning.json.error.type, 'unsupported_agent_capability');
    assert.match(unsupportedFunctionReasoning.json.error.message, /function tools 与 reasoning_effort/);
    const unsupportedFunctionReasoningCalls = received.slice(callsBeforeUnsupportedFunctionReasoning);
    assert.equal(unsupportedFunctionReasoningCalls.length, 1);
    assert.equal(unsupportedFunctionReasoningCalls[0].url, '/v1/responses');
    const unsupported = await requestJson(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
      method: 'POST', headers: localHeaders, body: JSON.stringify(agentRequest)
    });
    assert.equal(unsupported.status, 400, JSON.stringify(unsupported.json));
    assert.equal(unsupported.json.error.type, 'unsupported_agent_capability');
    assert.match(unsupported.json.error.message, /不支持此请求所需的 Responses API 原生能力/);
    assert.equal(received.some((item) => item.url === '/v1/chat/completions'), false);
    console.log('native responses integration tests passed');
  } catch (error) {
    throw new Error(`${error.message}\n${stderr}`);
  } finally {
    gateway.kill();
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});