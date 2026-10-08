const assert = require('node:assert/strict');
const {
  resolveEndpoint,
  openAIToAnthropic,
  anthropicToOpenAI,
  anthropicResponseToOpenAI,
  openAIResponseToAnthropic,
  openAIRequestToResponses,
  responsesResponseToOpenAI,
  responseInputToOpenAI,
  openAIResponseToResponses,
  responseRequestRequiresNative,
  chatRequestRequiresNative,
  normalizeResponsesResponse,
  normalizeResponsesEvent,
  normalizeResponsesIds
} = require('../src/protocol');

assert.equal(resolveEndpoint('https://example.com/v1', '/v1/models'), 'https://example.com/v1/models');
assert.equal(resolveEndpoint('https://example.com', '/v1/models'), 'https://example.com/v1/models');

const anthropicRequest = openAIToAnthropic({
  model: 'claude-local',
  messages: [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'Call the weather tool.' }
  ],
  max_tokens: 200,
  tools: [{ type: 'function', function: { name: 'weather', description: 'Get weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }]
}, 'claude-actual');
assert.equal(anthropicRequest.model, 'claude-actual');
assert.equal(anthropicRequest.system, 'You are helpful.');
assert.equal(anthropicRequest.messages[0].role, 'user');
assert.equal(anthropicRequest.tools[0].name, 'weather');

const openAIRequest = anthropicToOpenAI({
  system: 'Be concise.',
  messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Done.' }] }],
  max_tokens: 100
}, 'gpt-actual');
assert.equal(openAIRequest.model, 'gpt-actual');
assert.deepEqual(openAIRequest.messages[0], { role: 'system', content: 'Be concise.' });
assert.deepEqual(openAIRequest.messages[1], { role: 'assistant', content: 'Done' + '.' });

const openAIResponse = anthropicResponseToOpenAI({
  id: 'msg_1',
  content: [{ type: 'text', text: 'Hello' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 3, output_tokens: 4 }
}, 'claude-local');
assert.equal(openAIResponse.choices[0].message.content, 'Hello');
assert.equal(openAIResponse.usage.total_tokens, 7);

const anthropicResponse = openAIResponseToAnthropic({
  id: 'chat_1',
  choices: [{ message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 3, completion_tokens: 4 }
}, 'claude-local');
assert.equal(anthropicResponse.type, 'message');
assert.equal(anthropicResponse.content[0].text, 'Hello');
assert.equal(anthropicResponse.usage.output_tokens, 4);

const responsesRequest = responseInputToOpenAI({
  model: 'responses-local',
  instructions: 'Be brief.',
  input: [{ role: 'user', content: [{ type: 'input_text', text: 'Hello' }] }],
  max_output_tokens: 80
}, 'gpt-responses');
assert.equal(responsesRequest.model, 'gpt-responses');
assert.deepEqual(responsesRequest.messages[0], { role: 'system', content: 'Be brief.' });
assert.deepEqual(responsesRequest.messages[1], { role: 'user', content: [{ type: 'text', text: 'Hello' }] });
assert.equal(responsesRequest.max_tokens, 80);
const chatNativeRequest = openAIRequestToResponses({
  messages: [
    { role: 'system', content: 'Be concise.' },
    { role: 'user', content: 'Look this up.' }
  ],
  tools: [{ type: 'function', function: { name: 'lookup', description: 'Look up a value', parameters: { type: 'object', properties: { key: { type: 'string' } } } } }],
  reasoning_effort: 'medium'
}, 'gpt-native');
assert.equal(chatNativeRequest.model, 'gpt-native');
assert.equal(chatNativeRequest.input[0].role, 'system');
assert.equal(chatNativeRequest.input[1].role, 'user');
assert.equal(chatNativeRequest.tools[0].name, 'lookup');
assert.deepEqual(chatNativeRequest.reasoning, { effort: 'none' });
assert.equal(chatNativeRequest.reasoning_effort, undefined);
const chatNativeResponse = responsesResponseToOpenAI({
  id: 'resp_native',
  status: 'completed',
  output: [{ type: 'function_call', id: 'call_1', call_id: 'call_1', name: 'lookup', arguments: '{"key":"weather"}' }],
  usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 }
}, 'gpt-native');
assert.equal(chatNativeResponse.choices[0].message.tool_calls[0].function.name, 'lookup');
assert.equal(chatNativeResponse.choices[0].finish_reason, 'tool_calls');
assert.equal(chatRequestRequiresNative({ messages: [{ role: 'user', content: 'hello' }], tools: [{ type: 'function', function: { name: 'lookup' } }], reasoning_effort: 'medium' }), false);
assert.equal(chatRequestRequiresNative({ messages: [{ role: 'user', content: 'hello' }], tools: [{ type: 'function', function: { name: 'lookup' } }], reasoning_effort: 'none' }), false);
assert.equal(responseRequestRequiresNative({ model: 'plain', input: 'hello', max_output_tokens: 20 }), false);
assert.equal(responseRequestRequiresNative({ model: 'tools', input: 'hello', tools: [{ type: 'function', name: 'lookup' }], reasoning_effort: 'none' }), false);
assert.equal(responseRequestRequiresNative({ model: 'tools', input: 'hello', tools: [{ type: 'function', name: 'lookup' }], reasoning_effort: 'low' }), false);
assert.equal(responseRequestRequiresNative({ model: 'tools', input: 'hello', tools: [{ type: 'function', name: 'lookup' }], reasoning_effort: 'HIGH' }), false);
assert.equal(responseRequestRequiresNative({ model: 'agent', input: 'use the computer', tools: [{ type: 'computer' }] }), true);
assert.equal(responseRequestRequiresNative({ model: 'agent', previous_response_id: 'resp_previous', input: 'continue' }), true);
assert.equal(responseRequestRequiresNative({ model: 'agent', input: [{ type: 'computer_call_output', call_id: 'call_1', output: { type: 'computer_screenshot', image_url: 'data:image/png;base64,AA==' } }] }), true);

const normalizedResponse = normalizeResponsesResponse({
  id: 123,
  output: [{ type: 'computer_call', id: null }, { type: 'function_call', id: 456, call_id: null }]
}, 'agent');
assert.equal(typeof normalizedResponse.id, 'string');
assert.equal(typeof normalizedResponse.output[0].id, 'string');
assert.equal(typeof normalizedResponse.output[1].id, 'string');
assert.equal(typeof normalizedResponse.output[1].call_id, 'string');
const normalizedPayload = normalizeResponsesIds({ input: [{ id: null, call_id: 42, nested: { item_id: 7 } }] });
assert.equal(typeof normalizedPayload.input[0].id, 'string');
assert.equal(typeof normalizedPayload.input[0].call_id, 'string');
assert.equal(typeof normalizedPayload.input[0].nested.item_id, 'string');
const deepEventState = {};
const deepItemEvent = normalizeResponsesEvent({ type: 'response.output_item.added', output_index: 2, item: { type: 'function_call', id: null, call_id: 91, arguments: [{ item_id: null }] } }, deepEventState);
assert.equal(typeof deepItemEvent.item.id, 'string');
assert.equal(typeof deepItemEvent.item.call_id, 'string');
assert.equal(typeof deepItemEvent.item.arguments[0].item_id, 'string');
const upstreamRequest = normalizeResponsesIds({
  model: 'gpt-native',
  input: [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }], id: null },
    { type: 'function_call', id: 77, call_id: null }
  ]
});
assert.equal(typeof upstreamRequest.input[0].id, 'string');
assert.equal(typeof upstreamRequest.input[1].id, 'string');
assert.equal(typeof upstreamRequest.input[1].call_id, 'string');
const responseEventState = {};
const createdEvent = normalizeResponsesEvent({ type: 'response.created', response: { id: null } }, responseEventState);
const itemEvent = normalizeResponsesEvent({ type: 'response.output_item.added', output_index: 0, item: { type: 'computer_call', id: null } }, responseEventState);
const completedEvent = normalizeResponsesEvent({ type: 'response.completed', response: { id: null, output: [{ type: 'computer_call', id: null }] } }, responseEventState);
assert.equal(typeof createdEvent.response.id, 'string');
assert.equal(completedEvent.response.id, createdEvent.response.id);
assert.equal(itemEvent.item.id, completedEvent.response.output[0].id);

const responsesResult = openAIResponseToResponses({
  id: 'chat_response',
  created: 123,
  choices: [{ message: { role: 'assistant', content: 'Hello responses' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 }
}, 'responses-local');
assert.equal(responsesResult.object, 'response');
assert.equal(responsesResult.output_text, 'Hello responses');
assert.equal(responsesResult.usage.total_tokens, 11);
assert.equal(responsesResult.output[0].content[0].type, 'output_text');

// 上游返回数字 id 时不能抛出 TypeError（否则整个请求会以 500 失败，表现为 “Inference request failed.”）。
const numericIdResult = openAIResponseToResponses({
  id: 12345,
  created: 124,
  choices: [{ message: { role: 'assistant', content: 'numeric id' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }
}, 'responses-local');
assert.equal(typeof numericIdResult.id, 'string');
assert.equal(numericIdResult.id, 'resp_12345');
assert.equal(numericIdResult.output_text, 'numeric id');

// 上游 tool call id 为 null 时必须回填字符串，否则 Responses 客户端报 “Expected 'id' to be a string.”。
const nullToolIdResult = openAIResponseToResponses({
  id: null,
  created: 125,
  choices: [{
    message: {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: null, type: 'function', function: { name: 'weather', arguments: '{"city":"x"}' } }]
    },
    finish_reason: 'tool_calls'
  }],
  usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 }
}, 'responses-local');
assert.equal(typeof nullToolIdResult.id, 'string');
const nullToolCall = nullToolIdResult.output.find((part) => part.type === 'function_call');
assert.equal(typeof nullToolCall.id, 'string');
assert.equal(typeof nullToolCall.call_id, 'string');
assert.equal(nullToolCall.id, nullToolCall.call_id);
assert.equal(nullToolCall.name, 'weather');

// 回退路径（Responses -> Chat Completions）中的 id 同样需要归一化。
const fallbackChatResult = responsesResponseToOpenAI({
  id: null,
  output: [{ type: 'function_call', id: null, call_id: 88, name: 'weather', arguments: '{"city":"x"}' }],
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
}, 'chat-local');
assert.equal(typeof fallbackChatResult.id, 'string');
assert.equal(typeof fallbackChatResult.choices[0].message.tool_calls[0].id, 'string');
assert.equal(fallbackChatResult.choices[0].message.tool_calls[0].id, '88');

const format = { type: 'json_schema', json_schema: { name: 'answer', strict: true, schema: { type: 'object', properties: { x: { type: 'number' } } } } };
const formatted = openAIRequestToResponses({ messages: [], max_completion_tokens: 123, response_format: format }, 'm');
assert.equal(formatted.max_output_tokens, 123);
assert.deepEqual(formatted.text.format, { type: 'json_schema', ...format.json_schema });
assert.deepEqual(responseInputToOpenAI({ input: 'hi', text: formatted.text }, 'm').response_format, format);
assert.equal(responseRequestRequiresNative({ input: 'hi', text: formatted.text }), false);
assert.equal(normalizeResponsesIds({ previous_response_id: null }).previous_response_id, null);
const parallel = responseInputToOpenAI({ input: [
  { type: 'function_call', call_id: 'one', name: 'first', arguments: '{}' },
  { type: 'function_call', call_id: 'two', name: 'second', arguments: '{}' },
  { type: 'function_call_output', call_id: 'one', output: '1' },
  { type: 'function_call_output', call_id: 'two', output: '2' }
] }, 'm');
assert.equal(parallel.messages[0].tool_calls.length, 2);
const parallelMessages = openAIToAnthropic(parallel, 'm');
assert.equal(parallelMessages.messages.length, 2);
assert.deepEqual(parallelMessages.messages[1].content.map((item) => item.tool_use_id), ['one', 'two']);
assert.equal(openAIResponseToResponses({ choices: [{ message: { content: 'partial' }, finish_reason: 'length' }] }, 'm').status, 'incomplete');
// CronDelete 的 properties.id 是 JSON Schema，不是需要归一化的协议 ID。
const cronDeleteSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Scheduled task ID' },
    call_id: { type: ['string', 'null'] },
    item_id: true,
    response_id: false,
    previous_response_id: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    tasks: { type: 'array', items: { $ref: '#/$defs/task' } }
  },
  required: ['id'],
  additionalProperties: false,
  $defs: {
    id: { type: 'string' },
    task: { type: 'object', properties: { id: { type: 'integer' } }, examples: [{ id: 7, call_id: null }] }
  }
};
const cronDeleteTool = { type: 'function', name: 'CronDelete', parameters: cronDeleteSchema };
const cronDeleteFormat = { type: 'json_schema', name: 'task_result', schema: cronDeleteSchema };
const cronDeleteRequest = {
  input: [{ type: 'function_call', id: null, call_id: 42, name: 'CronDelete', arguments: '{"id":"task-1"}' }],
  previous_response_id: null,
  // 第 5 个工具的 properties.id 曾被改成报错中的 id_5758bcd62951c1b9。
  tools: [...Array.from({ length: 4 }, (_, index) => ({ type: 'function', name: `other_${index}`, parameters: { type: 'object', properties: {} } })), cronDeleteTool],
  text: { format: cronDeleteFormat }
};
const originalCronDeleteRequest = JSON.parse(JSON.stringify(cronDeleteRequest));
const normalizedCronDelete = normalizeResponsesIds(cronDeleteRequest);
assert.deepEqual(normalizedCronDelete.tools, cronDeleteRequest.tools);
assert.deepEqual(normalizedCronDelete.text, cronDeleteRequest.text);
assert.equal(typeof normalizedCronDelete.input[0].id, 'string');
assert.equal(normalizedCronDelete.input[0].call_id, '42');
assert.equal(normalizedCronDelete.input[0].arguments, '{"id":"task-1"}');
assert.equal(normalizedCronDelete.previous_response_id, null);
assert.deepEqual(cronDeleteRequest, originalCronDeleteRequest, '归一化不能修改客户端原始请求');

// 所有 schema 入口整棵保留，包括旧 Chat 格式、Anthropic/MCP 工具和结构化输出。
for (const key of ['parameters', 'input_schema', 'schema', 'json_schema']) {
  const normalized = normalizeResponsesIds({ id: 7, nested: { [key]: cronDeleteSchema } });
  assert.equal(normalized.id, '7');
  assert.deepEqual(normalized.nested[key], cronDeleteSchema, `${key} 中的对象和布尔 schema 必须原样保留`);
}
const cronDeleteChat = {
  messages: [{ role: 'user', content: 'Delete the scheduled task' }],
  tools: [{ type: 'function', function: { name: 'CronDelete', parameters: cronDeleteSchema } }],
  response_format: { type: 'json_schema', json_schema: { name: 'task_result', schema: cronDeleteSchema } }
};
const cronDeleteAnthropic = anthropicToOpenAI({
  messages: cronDeleteChat.messages,
  tools: [{ name: 'CronDelete', input_schema: cronDeleteSchema }]
}, 'gpt-6-astra');
for (const input of [cronDeleteChat, cronDeleteAnthropic]) {
  const normalized = normalizeResponsesIds(openAIRequestToResponses(input, 'gpt-6-astra'));
  assert.deepEqual(normalized.tools[0].parameters, cronDeleteSchema);
  if (input.response_format) assert.deepEqual(normalized.text.format, cronDeleteFormat);
}

// 上游回显的工具定义和结构化输出 schema 也不能在 JSON/SSE 响应中被改写。
const responseWithSchema = {
  id: 123,
  tools: [cronDeleteTool],
  text: { format: cronDeleteFormat },
  output: [{ type: 'function_call', id: 456, call_id: 789, name: 'CronDelete', arguments: '{"id":"task-1"}' }]
};
const normalizedSchemaResponse = normalizeResponsesResponse(responseWithSchema, 'gpt-6-astra');
assert.deepEqual(normalizedSchemaResponse.tools, responseWithSchema.tools);
assert.deepEqual(normalizedSchemaResponse.text, responseWithSchema.text);
assert.equal(normalizedSchemaResponse.id, '123');
assert.equal(normalizedSchemaResponse.output[0].id, '456');
assert.equal(normalizedSchemaResponse.output[0].call_id, '789');
for (const type of ['response.created', 'response.completed', 'response.incomplete']) {
  const event = normalizeResponsesEvent({ type, response: responseWithSchema }, {});
  assert.deepEqual(event.response.tools, responseWithSchema.tools);
  assert.deepEqual(event.response.text, responseWithSchema.text);
  assert.equal(event.response.id, '123');
  assert.equal(event.response.output[0].call_id, '789');
}
console.log('protocol tests passed');