const crypto = require('node:crypto');

function stripTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function resolveEndpoint(baseUrl, path) {
  const base = stripTrailingSlash(baseUrl);
  const target = path.startsWith('/') ? path : `/${path}`;
  if (base.endsWith('/v1') && target.startsWith('/v1/')) {
    return `${base}${target.slice(3)}`;
  }
  return `${base}${target}`;
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part && (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text' || typeof part.text === 'string'))
    .map((part) => part.text || '')
    .join('');
}

function anthropicContentToOpenAI(content, role = 'assistant') {
  if (typeof content === 'string') return { content, tool_calls: undefined };
  const blocks = Array.isArray(content) ? content : [];
  let text = '';
  const toolCalls = [];
  for (const block of blocks) {
    if (block.type === 'text') text += block.text || '';
    if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id || `call_${crypto.randomBytes(5).toString('hex')}`,
        type: 'function',
        function: {
          name: block.name,
          arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input || {})
        }
      });
    }
  }
  const message = { role, content: text || null };
  if (toolCalls.length) message.tool_calls = toolCalls;
  return { content: message.content, tool_calls: message.tool_calls };
}

function openAIContentToAnthropic(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (part.type === 'text' || typeof part.text === 'string') {
      return { type: 'text', text: part.text || '' };
    }
    if (part.type === 'image_url' && part.image_url?.url) {
      const url = part.image_url.url;
      const match = url.match(/^data:([^;]+);base64,(.+)$/);
      if (match) {
        return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } };
      }
      return { type: 'image', source: { type: 'url', url } };
    }
    return null;
  }).filter(Boolean);
}

function openAIToolsToAnthropic(tools) {
  if (!Array.isArray(tools)) return undefined;
  return tools
    .filter((tool) => tool && tool.type === 'function' && tool.function)
    .map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters || { type: 'object', properties: {} }
    }));
}

function openAIToAnthropic(input, model) {
  const messages = Array.isArray(input.messages) ? input.messages : [];
  const systemParts = messages
    .filter((message) => message.role === 'system' || message.role === 'developer')
    .map((message) => textFromContent(message.content))
    .filter(Boolean);
  const converted = [];

  for (const message of messages.filter((item) => item.role !== 'system' && item.role !== 'developer')) {
    if (message.role === 'tool') {
      converted.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: message.tool_call_id,
          content: openAIContentToAnthropic(message.content)
        }]
      });
      continue;
    }

    const content = openAIContentToAnthropic(message.content);
    const blocks = Array.isArray(content) ? [...content] : (content ? [{ type: 'text', text: content }] : []);
    if (message.tool_calls) {
      for (const call of message.tool_calls) {
        let inputValue = {};
        try {
          inputValue = JSON.parse(call.function?.arguments || '{}');
        } catch {
          inputValue = { raw_arguments: call.function?.arguments || '' };
        }
        blocks.push({
          type: 'tool_use',
          id: call.id,
          name: call.function?.name,
          input: inputValue
        });
      }
    }
    converted.push({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: blocks.length ? blocks : [{ type: 'text', text: '' }]
    });
  }

  const result = {
    model,
    messages: converted,
    max_tokens: input.max_tokens ?? input.max_completion_tokens ?? 4096,
    stream: Boolean(input.stream)
  };
  if (systemParts.length) result.system = systemParts.join('\n\n');
  if (input.temperature !== undefined) result.temperature = input.temperature;
  if (input.top_p !== undefined) result.top_p = input.top_p;
  if (input.stop !== undefined) result.stop_sequences = Array.isArray(input.stop) ? input.stop : [input.stop];
  if (input.thinking) result.thinking = input.thinking;
  if (input.reasoning_effort && !input.thinking) {
    const budgets = { low: 2048, medium: 4096, high: 8192 };
    result.thinking = { type: 'enabled', budget_tokens: budgets[input.reasoning_effort] || budgets.medium };
  }
  const tools = openAIToolsToAnthropic(input.tools);
  if (tools?.length) result.tools = tools;
  if (input.tool_choice) {
    if (input.tool_choice === 'auto' || input.tool_choice === 'none') {
      result.tool_choice = { type: input.tool_choice === 'auto' ? 'auto' : 'none' };
    } else if (input.tool_choice === 'required') {
      result.tool_choice = { type: 'any' };
    } else if (input.tool_choice.function?.name) {
      result.tool_choice = { type: 'tool', name: input.tool_choice.function.name };
    }
  }
  return result;
}

function anthropicToOpenAI(input, model) {
  const result = {
    model,
    messages: [],
    max_tokens: input.max_tokens ?? input.max_completion_tokens ?? 4096,
    stream: Boolean(input.stream)
  };
  if (input.system) {
    result.messages.push({ role: 'system', content: textFromContent(input.system) });
  }
  for (const message of Array.isArray(input.messages) ? input.messages : []) {
    if (message.role === 'user' && Array.isArray(message.content)) {
      const toolResults = message.content.filter((block) => block.type === 'tool_result');
      for (const block of toolResults) {
        result.messages.push({
          role: 'tool',
          tool_call_id: block.tool_use_id,
          content: textFromContent(block.content)
        });
      }
      const normalBlocks = message.content.filter((block) => block.type !== 'tool_result');
      if (normalBlocks.length) {
        result.messages.push({ role: 'user', content: normalBlocks.map((block) => (
          block.type === 'text' ? block : block
        )) });
      }
      continue;
    }
    const converted = anthropicContentToOpenAI(message.content, message.role);
    result.messages.push({
      role: message.role,
      content: converted.content,
      ...(converted.tool_calls ? { tool_calls: converted.tool_calls } : {})
    });
  }
  if (input.temperature !== undefined) result.temperature = input.temperature;
  if (input.top_p !== undefined) result.top_p = input.top_p;
  if (input.stop_sequences !== undefined) result.stop = input.stop_sequences;
  if (input.reasoning_effort !== undefined) result.reasoning_effort = input.reasoning_effort;
  if (input.thinking?.type === 'enabled' && input.thinking.budget_tokens) {
    const budget = Number(input.thinking.budget_tokens);
    result.reasoning_effort = budget >= 8192 ? 'high' : budget >= 4096 ? 'medium' : 'low';
  }
  if (Array.isArray(input.tools)) {
    result.tools = input.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema || { type: 'object', properties: {} }
      }
    }));
  }
  return result;
}

function openAIResponseToAnthropic(input, model) {
  const choice = input.choices?.[0] || {};
  const message = choice.message || {};
  const content = [];
  if (message.content) content.push({ type: 'text', text: textFromContent(message.content) });
  for (const call of message.tool_calls || []) {
    let parsedInput = {};
    try {
      parsedInput = JSON.parse(call.function?.arguments || '{}');
    } catch {
      parsedInput = { raw_arguments: call.function?.arguments || '' };
    }
    content.push({
      type: 'tool_use',
      id: call.id,
      name: call.function?.name,
      input: parsedInput
    });
  }
  const finishReason = choice.finish_reason;
  return {
    id: input.id || `msg_${crypto.randomBytes(8).toString('hex')}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: finishReason === 'tool_calls' ? 'tool_use' : (finishReason === 'length' ? 'max_tokens' : 'end_turn'),
    stop_sequence: null,
    usage: {
      input_tokens: input.usage?.prompt_tokens || 0,
      output_tokens: input.usage?.completion_tokens || 0
    }
  };
}

function anthropicResponseToOpenAI(input, model) {
  const text = (input.content || []).filter((part) => part.type === 'text').map((part) => part.text || '').join('');
  const toolCalls = (input.content || []).filter((part) => part.type === 'tool_use').map((part) => ({
    id: part.id,
    type: 'function',
    function: { name: part.name, arguments: JSON.stringify(part.input || {}) }
  }));
  return {
    id: input.id || `chatcmpl_${crypto.randomBytes(8).toString('hex')}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
      finish_reason: input.stop_reason === 'tool_use' ? 'tool_calls' : (input.stop_reason === 'max_tokens' ? 'length' : 'stop')
    }],
    usage: {
      prompt_tokens: input.usage?.input_tokens || 0,
      completion_tokens: input.usage?.output_tokens || 0,
      total_tokens: (input.usage?.input_tokens || 0) + (input.usage?.output_tokens || 0)
    }
  };
}

function responsesContentToOpenAI(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (!part || typeof part !== 'object') return null;
    if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') {
      return { type: 'text', text: part.text || '' };
    }
    if (part.type === 'input_image' && (part.image_url || part.image?.url)) {
      return { type: 'image_url', image_url: { url: part.image_url || part.image.url } };
    }
    return null;
  }).filter(Boolean);
}

function responsesToolsToOpenAI(tools) {
  if (!Array.isArray(tools)) return undefined;
  return tools.filter((tool) => tool && tool.type === 'function').map((tool) => ({
    type: 'function',
    function: {
      name: tool.name || tool.function?.name,
      description: tool.description || tool.function?.description,
      parameters: tool.parameters || tool.input_schema || tool.function?.parameters || { type: 'object', properties: {} },
      ...(tool.strict !== undefined ? { strict: tool.strict } : {})
    }
  }));
}

function responseInputToOpenAI(input, model) {
  const result = {
    model,
    messages: [],
    max_tokens: input.max_output_tokens ?? input.max_tokens ?? 4096,
    stream: Boolean(input.stream)
  };
  if (input.instructions) result.messages.push({ role: 'system', content: textFromContent(input.instructions) });

  const items = Array.isArray(input.input)
    ? input.input
    : [input.input && typeof input.input === 'object'
      ? input.input
      : { role: 'user', content: input.input ?? '' }];
  for (const item of items) {
    if (typeof item === 'string') {
      result.messages.push({ role: 'user', content: item });
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'function_call_output') {
      result.messages.push({
        role: 'tool',
        tool_call_id: item.call_id || item.id,
        content: textFromContent(item.output)
      });
      continue;
    }
    if (item.type === 'function_call') {
      let argumentsValue = item.arguments || '{}';
      if (typeof argumentsValue !== 'string') argumentsValue = JSON.stringify(argumentsValue);
      result.messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [{ id: item.call_id || item.id, type: 'function', function: { name: item.name, arguments: argumentsValue } }]
      });
      continue;
    }
    const role = item.role || (item.type === 'message' ? 'user' : 'user');
    const content = item.content === undefined ? item.text : responsesContentToOpenAI(item.content);
    result.messages.push({ role, content: content === undefined ? '' : content });
  }
  if (input.temperature !== undefined) result.temperature = input.temperature;
  if (input.top_p !== undefined) result.top_p = input.top_p;
  if (input.reasoning_effort !== undefined) result.reasoning_effort = input.reasoning_effort;
  if (input.thinking !== undefined) result.thinking = input.thinking;
  if (input.tools) result.tools = responsesToolsToOpenAI(input.tools);
  if (input.tool_choice !== undefined) result.tool_choice = input.tool_choice;
  if (input.stop !== undefined) result.stop = input.stop;
  return result;
}

function openAIResponseToResponses(input, model) {
  const choice = input.choices?.[0] || {};
  const message = choice.message || {};
  const output = [];
  const messageId = `msg_${crypto.randomBytes(8).toString('hex')}`;
  const content = [];
  if (message.content) {
    content.push({ type: 'output_text', text: textFromContent(message.content), annotations: [] });
  }
  for (const call of message.tool_calls || []) {
    content.push({
      type: 'function_call',
      id: call.id,
      call_id: call.id,
      name: call.function?.name,
      arguments: call.function?.arguments || ''
    });
  }
  if (content.length) {
    output.push({
      id: messageId,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content
    });
  }
  const text = content.filter((part) => part.type === 'output_text').map((part) => part.text).join('');
  const usage = {
    input_tokens: input.usage?.prompt_tokens || 0,
    output_tokens: input.usage?.completion_tokens || 0,
    total_tokens: input.usage?.total_tokens || (input.usage?.prompt_tokens || 0) + (input.usage?.completion_tokens || 0)
  };
  return {
    id: input.id ? `resp_${input.id.replace(/^(resp_)+/, '')}` : `resp_${crypto.randomBytes(8).toString('hex')}`,
    object: 'response',
    created_at: input.created || Math.floor(Date.now() / 1000),
    status: 'completed',
    model,
    output,
    output_text: text,
    usage
  };
}

function responsesResponseFromOpenAI(input, model) {
  return openAIResponseToResponses(input, model);
}

function responsesResponseSkeleton(id, model) {
  return {
    id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'in_progress',
    model,
    output: [],
    output_text: null,
    usage: null
  };
}

module.exports = {
  resolveEndpoint,
  openAIToAnthropic,
  anthropicToOpenAI,
  openAIContentToAnthropic,
  openAIResponseToAnthropic,
  anthropicResponseToOpenAI,
  responseInputToOpenAI,
  openAIResponseToResponses,
  responsesResponseFromOpenAI,
  responsesResponseSkeleton,
  textFromContent
};