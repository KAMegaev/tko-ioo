// Два способа подключения: серверный прокси или ключ в текущем браузере.

import { ANTHROPIC_URL, ANTHROPIC_MODEL, buildAnthropicRequest, readAnthropicResult } from './anthropic.js';
import { OPENAI_URL, OPENAI_MODEL, buildOpenAIRequest, readOpenAIResult } from './openai.js';

const TIMEOUT = 40000;
const ENDPOINT_KEY = 'tko-ioo.ai-endpoint.v1';
const LEGACY_API_KEY = 'tko-ioo.anthropic-api-key.v1';
const BROWSER_CONNECTION = 'tko-ioo.ai-connection.v2';
let connectionMemory = null;
export const BROWSER_PROVIDERS = { openai: 'OpenAI', anthropic: 'Anthropic' };
export const DEFAULT_MODELS = { openai: OPENAI_MODEL, anthropic: ANTHROPIC_MODEL };

function connection() {
  if (connectionMemory !== null) return connectionMemory;
  try {
    const stored = localStorage.getItem(BROWSER_CONNECTION);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (Object.hasOwn(BROWSER_PROVIDERS, parsed.provider) && typeof parsed.key === 'string') {
        return { provider: parsed.provider, key: parsed.key, model: parsed.model || DEFAULT_MODELS[parsed.provider] };
      }
    }
    const legacy = localStorage.getItem(LEGACY_API_KEY);
    if (legacy) {
      const provider = legacy.startsWith('sk-ant-') ? 'anthropic' : 'openai';
      return { provider, key: legacy, model: DEFAULT_MODELS[provider] };
    }
  } catch { /* Без хранилища работает настройка в памяти страницы. */ }
  return { provider: 'openai', key: '', model: OPENAI_MODEL };
}

export function getBrowserApiKey() {
  return connection().key;
}

export const getBrowserProvider = () => connection().provider;
export const getBrowserModel = () => connection().model;

export const hasBrowserApiKey = () => Boolean(getBrowserApiKey());

export function validateBrowserApiKey(value, provider, model) {
  if (!value.trim()) return 'Введите API-ключ';
  if (/\s/.test(value.trim()) || value.trim().length > 2000) return 'Ключ должен быть одной строкой без пробелов';
  if (provider && !Object.hasOwn(BROWSER_PROVIDERS, provider)) return 'Выберите OpenAI или Anthropic';
  if (provider === 'openai' && value.trim().startsWith('sk-ant-')) return 'Это ключ Anthropic. Выберите Anthropic или вставьте ключ OpenAI.';
  if (provider === 'anthropic' && !value.trim().startsWith('sk-ant-')) return 'Для этого ключа выберите OpenAI. Ключи Anthropic начинаются с sk-ant-.';
  if (model !== undefined && !/^[a-zA-Z0-9._:-]{1,100}$/.test(model)) return 'Укажите имя модели без пробелов';
  return null;
}

/** Ключ остаётся на этом компьютере; не включается в файлы правил и URL. */
export function setBrowserApiKey(value, provider, model) {
  const key = value.trim();
  provider ||= key ? (key.startsWith('sk-ant-') ? 'anthropic' : 'openai') : getBrowserProvider();
  connectionMemory = { provider, key, model: model || DEFAULT_MODELS[provider] };
  try {
    if (key) localStorage.setItem(BROWSER_CONNECTION, JSON.stringify(connectionMemory));
    else localStorage.removeItem(BROWSER_CONNECTION);
    localStorage.removeItem(LEGACY_API_KEY);
    return true;
  } catch {
    return false; // Прямое подключение работает до перезагрузки страницы.
  }
}

function detailMessage(detail) {
  if (typeof detail !== 'string') return '';
  try {
    const parsed = JSON.parse(detail);
    return parsed.error?.message || parsed.message || '';
  } catch {
    return detail.startsWith('<') ? '' : detail.slice(0, 300);
  }
}

/**
 * Прокси, развёрнутый для этого приложения. Помощник работает сразу,
 * без настройки; поле в интерфейсе нужно лишь для замены на свой прокси.
 */
export const DEFAULT_ENDPOINT = 'https://tko-ioo-ai.kamegaev.workers.dev';

/** Действующий адрес прокси: заданный пользователем либо встроенный. */
export function getEndpoint() {
  try {
    return localStorage.getItem(ENDPOINT_KEY) || DEFAULT_ENDPOINT;
  } catch {
    return DEFAULT_ENDPOINT;
  }
}

/** Задан ли адрес, отличный от встроенного. */
export function isCustomEndpoint(url) {
  return Boolean(url) && url !== DEFAULT_ENDPOINT;
}

export function setEndpoint(url) {
  try {
    if (url) localStorage.setItem(ENDPOINT_KEY, url);
    else localStorage.removeItem(ENDPOINT_KEY);
  } catch {
    // Приватный режим браузера: адрес проживёт до перезагрузки страницы.
  }
}

/** Проверяет, что адрес похож на прокси и работает по HTTPS. */
export function validateEndpoint(url) {
  if (!url) return 'Адрес не задан';
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return 'Это не похоже на адрес';
  }
  const local = ['localhost', '127.0.0.1'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !local) return 'Адрес должен начинаться с https://';
  return null;
}

/**
 * Выполняет задачу через прокси или напрямую через выбранного провайдера.
 * @param {string} endpoint адрес прокси
 * @param {object} payload задача и исходный документ либо образец реестра
 * @returns {Promise<{result: object, usage: object, model: string}>}
 */
async function request(endpoint, payload, timeout = TIMEOUT) {
  const { key: apiKey, provider, model } = connection();
  const providerName = BROWSER_PROVIDERS[provider];
  const direct = Boolean(apiKey) && payload.task !== 'norms-markup';
  const openai = provider === 'openai';
  const body = direct ? (openai ? buildOpenAIRequest(payload, model) : buildAnthropicRequest(payload, model)) : payload;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(direct ? (openai ? OPENAI_URL : ANTHROPIC_URL) : endpoint, {
      method: 'POST',
      headers: !direct ? { 'Content-Type': 'application/json' } : openai ? {
        'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`,
      } : {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    let data;
    try {
      data = await response.json();
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      throw new Error(`Помощник ответил неразборчиво (код ${response.status})`);
    }
    if (!response.ok || data.error) {
      if (direct) {
        const message = data.error?.message || `HTTP ${response.status}`;
        const hint = response.status === 403
          ? ` Проверьте доступ аккаунта и сети к ${providerName}: запрос выполнен напрямую, без Cloudflare.` : '';
        throw new Error(`${providerName} (${response.status}): ${message}.${hint}`);
      }
      if (payload.task === 'norms-extract' && data.error === 'Неизвестная задача') {
        throw new Error('Прокси ещё не поддерживает извлечение нормативов. Обновите Cloudflare Worker из папки worker.');
      }
      const detail = detailMessage(data.detail);
      throw new Error((data.error || `Помощник ответил ошибкой (код ${response.status})`) + (detail ? `: ${detail}` : ''));
    }
    if (direct) return openai ? readOpenAIResult(data, body.tool_choice.name) : readAnthropicResult(data, body.tool_choice.name);
    if (!data.result) throw new Error('Помощник не вернул результат');
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(`Помощник не ответил за ${timeout / 1000} секунд. Повторите обработку или разделите документ.`);
    if (direct && error instanceof TypeError) {
      throw new Error(`Не удалось напрямую подключиться к ${providerName}. Проверьте доступ к API в этой сети и настройки браузера.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export const requestMarkup = (endpoint, task, tables) => request(endpoint, { task, tables });

/** Полное извлечение из документа, включая визуальное чтение PDF и изображений. */
export const requestNormsExtraction = (endpoint, document) =>
  request(endpoint, { task: 'norms-extract', document }, 300000);

/** Разметка таблиц нормативов. */
export const requestNormsMarkup = (endpoint, tables) => requestMarkup(endpoint, 'norms-markup', tables);

/** Разметка выгрузки реестра. */
export const requestRegistryMarkup = (endpoint, sheets) => requestMarkup(endpoint, 'registry-markup', sheets);
