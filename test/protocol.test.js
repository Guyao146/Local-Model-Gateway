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
  chatRequestRequiresNative
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
assert.equal(chatNativeRequest.reasoning_effort, 'medium');
const chatNativeResponse = responsesResponseToOpenAI({
  id: 'resp_native',
  status: 'completed',
  output: [{ type: 'function_call', id: 'call_1', call_id: 'call_1', name: 'lookup', arguments: '{"key":"weather"}' }],
  usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 }
}, 'gpt-native');
assert.equal(chatNativeResponse.choices[0].message.tool_calls[0].function.name, 'lookup');
assert.equal(chatNativeResponse.choices[0].finish_reason, 'tool_calls');
assert.equal(chatRequestRequiresNative({ messages: [{ role: 'user', content: 'hello' }], tools: [{ type: 'function', function: { name: 'lookup' } }], reasoning_effort: 'medium' }), true);
assert.equal(chatRequestRequiresNative({ messages: [{ role: 'user', content: 'hello' }], tools: [{ type: 'function', function: { name: 'lookup' } }], reasoning_effort: 'none' }), false);
assert.equal(responseRequestRequiresNative({ model: 'plain', input: 'hello', max_output_tokens: 20 }), false);
assert.equal(responseRequestRequiresNative({ model: 'tools', input: 'hello', tools: [{ type: 'function', name: 'lookup' }], reasoning_effort: 'none' }), false);
assert.equal(responseRequestRequiresNative({ model: 'tools', input: 'hello', tools: [{ type: 'function', name: 'lookup' }], reasoning_effort: 'low' }), true);
assert.equal(responseRequestRequiresNative({ model: 'tools', input: 'hello', tools: [{ type: 'function', name: 'lookup' }], reasoning_effort: 'HIGH' }), true);
assert.equal(responseRequestRequiresNative({ model: 'agent', input: 'use the computer', tools: [{ type: 'computer' }] }), true);
assert.equal(responseRequestRequiresNative({ model: 'agent', previous_response_id: 'resp_previous', input: 'continue' }), true);
assert.equal(responseRequestRequiresNative({ model: 'agent', input: [{ type: 'computer_call_output', call_id: 'call_1', output: { type: 'computer_screenshot', image_url: 'data:image/png;base64,AA==' } }] }), true);

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

console.log('protocol tests passed');