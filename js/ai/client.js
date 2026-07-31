// Обращение к прокси помощника. Ключа в браузере нет — он хранится на прокси.

const TIMEOUT = 40000;
const ENDPOINT_KEY = 'tko-ioo.ai-endpoint.v1';

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
 * Запрашивает разметку у прокси.
 * @param {string} endpoint адрес прокси
 * @param {string} task 'norms-markup' или 'registry-markup'
 * @param {Array} tables образец: таблицы приказа либо листы книги
 * @returns {Promise<{result: object, usage: object, model: string}>}
 */
export async function requestMarkup(endpoint, task, tables) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task, tables }),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    if (error.name === 'AbortError') throw new Error('Помощник не ответил за 40 секунд');
    throw new Error(`Не удалось обратиться к помощнику: ${error.message}`);
  }
  clearTimeout(timer);

  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(`Помощник ответил неразборчиво (код ${response.status})`);
  }
  if (!response.ok || data.error) {
    throw new Error(data.error || `Помощник ответил ошибкой (код ${response.status})`);
  }
  if (!data.result) throw new Error('Помощник не вернул разметку');
  return data;
}

/** Разметка таблиц нормативов. */
export const requestNormsMarkup = (endpoint, tables) => requestMarkup(endpoint, 'norms-markup', tables);

/** Разметка выгрузки реестра. */
export const requestRegistryMarkup = (endpoint, sheets) => requestMarkup(endpoint, 'registry-markup', sheets);
