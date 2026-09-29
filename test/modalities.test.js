const assert = require('node:assert/strict');
const { modalityMetadata, supportsInput, mapInputParts, inputMediaParts, assertMediaPreserved, normalizeTranslator } = require('../src/modalities');
const { anthropicToOpenAI, openAIToAnthropic, openAIRequestToResponses } = require('../src/protocol');

async function main() {
  const unknown = modalityMetadata({ id: 'gpt-4o' });
  assert.equal(unknown.inputModalities, null, '不能通过模型名猜测');
  assert.equal(supportsInput(unknown, 'image'), null);
  for (const raw of [
    { input_modalities: ['TEXT', 'vision', 'pdf'], output_modalities: ['text'] },
    { capabilities: { inputModalities: ['text', 'image', 'file'], outputModalities: ['text'] } },
    { architecture: { modality: 'text+image+file->text' } },
    { modalities: { input: ['text', 'image', 'document'], output: ['text'] } }
  ]) {
    const entry = modalityMetadata(raw);
    assert.deepEqual(entry.inputModalities, ['text', 'image', 'file']);
    assert.deepEqual(entry.outputModalities, ['text']);
    assert.equal(supportsInput(entry, 'audio'), false);
    assert.deepEqual(modalityMetadata(entry), entry, '归一化/导入不丢字段与来源');
    assert.deepEqual(modalityMetadata({ id: 'x' }, entry), entry, '缺少新元数据不抹掉原声明');
  }
  const partial = modalityMetadata({ vision: false });
  assert.equal(supportsInput(partial, 'image'), false);
  assert.equal(supportsInput(partial, 'audio'), null);
  assert.equal(supportsInput(modalityMetadata({ capabilities: { vision: true } }), 'image'), true);
  assert.equal(supportsInput(modalityMetadata({ input_modalities: ['text'] }, partial), 'image'), false);
  assert.equal(supportsInput(modalityMetadata({ input_modalities: ['text', 'image'] }, partial), 'image'), true);
  assert.equal(supportsInput(modalityMetadata({ vision: true }, modalityMetadata({ input_modalities: ['text'] })), 'image'), true, '新的部分声明覆盖旧的完整列表');
  assert.equal(modalityMetadata({ input_modalities: [null] }).inputModalities, null);
  assert.equal(normalizeTranslator('', 'one'), '');
  assert.throws(() => normalizeTranslator('ONE', 'one'), /自身/);
  assert.throws(() => normalizeTranslator({}, 'one'), /本地模型名/);

  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abcd' } };
  const input = { messages: [{ role: 'user', content: [{ type: 'text', text: 'before' }, image,
    { type: 'tool_result', tool_use_id: 't', content: [image, { type: 'text', text: 'after' }] }] }],
  tools: [{ input_schema: { type: 'image' } }], metadata: { type: 'image' } };
  const copy = JSON.stringify(input);
  const translated = await mapInputParts(input, 'anthropic', async () => ({ type: 'text', text: 'caption' }));
  assert.equal(JSON.stringify(input), copy);
  assert.equal(inputMediaParts(input, 'anthropic').length, 2);
  assert.equal(inputMediaParts(translated, 'anthropic').length, 0);
  assert.equal(translated.messages[0].content[2].tool_use_id, 't');
  assert.deepEqual(translated.tools, input.tools);
  const chat = anthropicToOpenAI({ messages: [{ role: 'user', content: [image] }] }, 'vision');
  assert.equal(chat.messages[0].content[0].image_url.url, 'data:image/png;base64,abcd');
  const roundtrip = openAIToAnthropic(chat, 'vision');
  assertMediaPreserved(chat, 'openai', roundtrip, 'anthropic');
  assertMediaPreserved(chat, 'openai', openAIRequestToResponses(chat, 'vision'), 'responses');
  assert.throws(() => assertMediaPreserved(chat, 'openai', { messages: [] }, 'openai'), /无损传递/);
  const responseInput = { input: [{ type: 'function_call_output', call_id: 'x', output: [{ type: 'input_image', image_url: 'url' }] }] };
  const responseOutput = await mapInputParts(responseInput, 'responses', async () => ({ type: 'input_text', text: 'caption' }));
  assert.equal(responseOutput.input[0].call_id, 'x');
  assert.equal(responseOutput.input[0].output[0].text, 'caption');
  assert.equal(inputMediaParts({ input: 'hi' }, 'responses').length, 0);
  const singleMessage = { input: { role: 'user', content: [{ type: 'input_image', image_url: 'https://example.test/image' }] } };
  assert.equal(inputMediaParts(singleMessage, 'responses').length, 1);
  assert.equal((await mapInputParts(singleMessage, 'responses', async () => ({ type: 'input_text', text: 'caption' }))).input.content[0].text, 'caption');
  const known = modalityMetadata({ input_modalities: ['text', 'image'], output_modalities: ['text'] });
  assert.deepEqual(modalityMetadata(unknown, known), known, '归一化的未知条目不覆盖已有能力');
  console.log('modality unit tests passed');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });