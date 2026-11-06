import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getBrowserApiKey, hasBrowserApiKey, setBrowserApiKey, validateBrowserApiKey,
  requestNormsExtraction, requestRegistryMarkup,
} from '../js/ai/client.js';
import { ANTHROPIC_URL } from '../js/ai/anthropic.js';

const testKey = 'sk-ant-fake-key-for-tests';
const document = { name: 'Скан.pdf', mediaType: 'application/pdf', data: btoa('%PDF-1.3\nscan') };
const result = { complete: true, entries: [], warnings: [], reason: 'test' };
const modelResponse = (name, input = result, stop = 'tool_use') => Response.json({
  content: [{ type: 'tool_use', name, input }], model: 'test-model', stop_reason: stop,
});

function storage(t) {
  const before = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const items = new Map();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => items.set(key, value),
    removeItem: (key) => items.delete(key),
  } });
  setBrowserApiKey('');
  t.after(() => {
    setBrowserApiKey('');
    if (before) Object.defineProperty(globalThis, 'localStorage', before);
    else delete globalThis.localStorage;
  });
  return items;
}

test('ключ сохраняется в браузере, доступен после перезагрузки модуля и удаляется', async (t) => {
  const items = storage(t);
  assert.equal(hasBrowserApiKey(), false);
  assert.equal(validateBrowserApiKey(''), 'Введите API-ключ Anthropic');
  assert.ok(validateBrowserApiKey('a\nb'));
  assert.equal(validateBrowserApiKey(testKey), null);
  assert.equal(setBrowserApiKey(` ${testKey} `), true);
  assert.equal(hasBrowserApiKey(), true);
  const fresh = await import('../js/ai/client.js?storage-check');
  assert.equal(fresh.getBrowserApiKey(), testKey);
  setBrowserApiKey('');
  assert.equal(getBrowserApiKey(), '');
  assert.equal(fresh.getBrowserApiKey(), '');
  assert.equal(items.size, 0);
});

test('при недоступном localStorage ключ работает в памяти страницы', (t) => {
  storage(t);
  globalThis.localStorage.setItem = () => { throw new Error('blocked'); };
  assert.equal(setBrowserApiKey(testKey), false);
  assert.equal(getBrowserApiKey(), testKey);
  setBrowserApiKey('');
  assert.equal(hasBrowserApiKey(), false);
});

test('PDF отправляется прямо в Anthropic, ключ только в заголовке и браузерный доступ включён', async (t) => {
  storage(t);
  setBrowserApiKey(testKey);
  let called = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    called += 1;
    assert.equal(url, ANTHROPIC_URL);
    assert.equal(options.headers['x-api-key'], testKey);
    assert.equal(options.headers['anthropic-dangerous-direct-browser-access'], 'true');
    assert.equal(options.headers['anthropic-version'], '2023-06-01');
    assert.ok(!url.includes(testKey));
    assert.ok(!options.body.includes(testKey));
    const payload = JSON.parse(options.body);
    assert.equal(payload.tool_choice.name, 'extract_tko_norms');
    assert.equal(payload.max_tokens, 32000);
    assert.equal(payload.messages[0].content[1].source.data, document.data);
    return modelResponse('extract_tko_norms');
  });
  const answer = await requestNormsExtraction('https://unused-proxy.example/', document);
  assert.deepEqual(answer.result, result);
  assert.equal(called, 1);
});

test('разметка реестра тоже работает напрямую с прежней схемой результата', async (t) => {
  storage(t);
  setBrowserApiKey(testKey);
  const markup = { sheet: 0, headerRow: 0, category: 0, units: 1 };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, ANTHROPIC_URL);
    const body = JSON.parse(options.body);
    assert.equal(body.tool_choice.name, 'razmetka_reestra');
    assert.equal(body.max_tokens, 1024);
    assert.match(body.messages[0].content, /Категория/);
    return modelResponse('razmetka_reestra', markup);
  });
  const answer = await requestRegistryMarkup('https://unused-proxy.example/', [
    { index: 0, title: 'Реестр', rows: [['Категория', 'Количество'], ['Гостиницы', 3]] },
  ]);
  assert.deepEqual(answer.result, markup);
});

test('403 от Anthropic показывается с причиной и не вызывает скрытый повтор через прокси', async (t) => {
  storage(t);
  setBrowserApiKey(testKey);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls += 1;
    assert.equal(url, ANTHROPIC_URL);
    return Response.json({ error: { type: 'permission_error', message: 'Request not allowed' } }, { status: 403 });
  });
  await assert.rejects(() => requestNormsExtraction('https://unused-proxy.example/', document), /Anthropic \(403\): Request not allowed/);
  assert.equal(calls, 1);
});

test('после удаления ключа используется прокси без отправки ему ключа', async (t) => {
  storage(t);
  setBrowserApiKey(testKey);
  setBrowserApiKey('');
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://proxy.example/');
    assert.equal(options.headers['x-api-key'], undefined);
    assert.ok(!options.body.includes(testKey));
    assert.equal(JSON.parse(options.body).task, 'norms-extract');
    return Response.json({ result });
  });
  assert.deepEqual((await requestNormsExtraction('https://proxy.example/', document)).result, result);
});

test('причина отказа провайдера видна и в ответе серверного прокси', async (t) => {
  storage(t);
  t.mock.method(globalThis, 'fetch', async () => Response.json({
    error: 'Модель недоступна (403)', detail: JSON.stringify({ error: { message: 'Request not allowed' } }),
  }, { status: 502 }));
  await assert.rejects(() => requestNormsExtraction('https://proxy.example/', document),
    /Модель недоступна \(403\): Request not allowed/);
});

test('прямой режим также отклоняет оборванный ответ модели', async (t) => {
  storage(t);
  setBrowserApiKey(testKey);
  t.mock.method(globalThis, 'fetch', async () => modelResponse('extract_tko_norms', result, 'max_tokens'));
  await assert.rejects(() => requestNormsExtraction('https://proxy.example/', document), /не поместился целиком/);
});
