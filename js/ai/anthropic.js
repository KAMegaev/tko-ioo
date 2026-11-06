// Прямое подключение: те же задачи и схемы, что у серверного прокси.
import { EXTRACTION_SYSTEM, EXTRACTION_TOOL, extractionContent } from './norms-prompt.js';
import { REGISTRY_SYSTEM, REGISTRY_TOOL } from './registry-prompt.js';
import { describeSample } from './registry-markup.js';

export const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';

export function buildAnthropicRequest(payload, model = ANTHROPIC_MODEL) {
  const norms = payload.task === 'norms-extract';
  if (!norms && payload.task !== 'registry-markup') throw new Error('Эта задача не поддерживает прямое подключение');
  const tool = norms ? EXTRACTION_TOOL : REGISTRY_TOOL;
  return {
    model,
    max_tokens: norms ? 32000 : 1024,
    system: norms ? EXTRACTION_SYSTEM : REGISTRY_SYSTEM,
    tools: [tool],
    tool_choice: { type: 'tool', name: tool.name },
    messages: [{ role: 'user', content: norms ? extractionContent(payload.document) : describeSample(payload.tables) }],
  };
}

export function readAnthropicResult(data, toolName) {
  if (data.stop_reason === 'max_tokens') {
    throw new Error('Ответ ИИ не поместился целиком. Разделите документ на части; неполный результат не применён.');
  }
  const block = (data.content || []).find((item) => item.type === 'tool_use' && item.name === toolName);
  if (!block) throw new Error('Модель не вернула структурированный результат');
  return { result: block.input, usage: data.usage, model: data.model };
}
