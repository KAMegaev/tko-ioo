// OpenAI Responses API: исходные PDF/изображения и тот же структурированный результат.
import { buildAnthropicRequest } from './anthropic.js';

export const OPENAI_URL = 'https://api.openai.com/v1/responses';
export const OPENAI_MODEL = 'gpt-4.1-mini';

function strictSchema(value) {
  if (Array.isArray(value)) return value.map(strictSchema);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    // Общий поднабор Structured Outputs. Границы чисел и размера набора
    // проверяет существующий локальный валидатор, независимо от модели.
    if (['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
      'minItems', 'maxItems', 'minLength', 'maxLength', 'pattern', 'format'].includes(key)) continue;
    result[key] = strictSchema(child);
  }
  if (result.type === 'object') {
    result.additionalProperties = false;
    if (result.properties) result.required = Object.keys(result.properties);
  }
  return result;
}

export function buildOpenAIRequest(payload, model = OPENAI_MODEL) {
  const original = buildAnthropicRequest(payload);
  const source = original.messages[0].content;
  const blocks = typeof source === 'string' ? [{ type: 'text', text: source }] : source;
  const content = blocks.map((block) => {
    if (block.type === 'text') return { type: 'input_text', text: block.text };
    const data = `data:${block.source.media_type};base64,${block.source.data}`;
    if (block.type === 'document') return { type: 'input_file', filename: payload.document.name, file_data: data };
    return { type: 'input_image', image_url: data, detail: 'auto' };
  });
  const tool = original.tools[0];
  return {
    model,
    store: false,
    max_output_tokens: original.max_tokens,
    instructions: original.system,
    tools: [{ type: 'function', name: tool.name, description: tool.description,
      parameters: strictSchema(tool.input_schema), strict: true }],
    tool_choice: { type: 'function', name: tool.name },
    parallel_tool_calls: false,
    input: [{ role: 'user', content }],
  };
}

export function readOpenAIResult(data, toolName) {
  if (data.status === 'incomplete') {
    throw new Error('OpenAI не завершил ответ. Неполный результат не применён; повторите обработку или разделите документ.');
  }
  if (data.status !== 'completed') throw new Error('OpenAI не вернул завершённый результат');
  const block = (data.output || []).find((item) => item.type === 'function_call' && item.name === toolName);
  if (!block || block.status === 'incomplete') throw new Error('OpenAI не вернул структурированный результат');
  let result;
  try { result = JSON.parse(block.arguments); }
  catch { throw new Error('OpenAI вернул повреждённый или неполный результат'); }
  return { result, usage: data.usage, model: data.model };
}
