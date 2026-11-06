import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOpenAIRequest, readOpenAIResult, OPENAI_URL, OPENAI_MODEL } from '../js/ai/openai.js';
import {
  setBrowserApiKey, getBrowserProvider, getBrowserModel, validateBrowserApiKey,
  requestNormsExtraction, requestRegistryMarkup,
} from '../js/ai/client.js';
import { validateExtractedNorms } from '../js/ai/norms-extract.js';

const key = 'sk-proj-fake-openai-key-for-tests';
const pdf = { name: 'Приказ.pdf', mediaType: 'application/pdf', data: btoa('%PDF-1.4\nscan') };
const norm = { name: 'Жилые дома', context: '', unit: '1 человек',
  mass: { value: 200, unit: 'kg', period: 'year', quantity: 1 }, volume: null,
  source: { location: 'Страница 2', quote: 'Жилые дома — 200 кг на человека в год' } };
const result = { complete: true, entries: [norm], warnings: [], reason: 'Все страницы прочитаны' };
const response = (name = 'extract_tko_norms', value = result) => ({ status: 'completed', model: OPENAI_MODEL,
  output: [{ type: 'function_call', name, status: 'completed', arguments: JSON.stringify(value) }] });

function storage(t) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const map = new Map();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (name) => map.get(name) ?? null,
    setItem: (name, value) => map.set(name, value), removeItem: (name) => map.delete(name),
  } });
  setBrowserApiKey('');
  t.after(() => {
    setBrowserApiKey('');
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else delete globalThis.localStorage;
  });
  return map;
}

test('OpenAI получает исходный PDF как input_file и функцию со строгой схемой', () => {
  const body = buildOpenAIRequest({ task: 'norms-extract', document: pdf });
  assert.equal(body.model, OPENAI_MODEL);
  assert.equal(body.store, false);
  assert.equal(body.tool_choice.name, 'extract_tko_norms');
  assert.equal(body.parallel_tool_calls, false);
  assert.equal(body.tools[0].strict, true);
  assert.equal(body.tools[0].parameters.additionalProperties, false);
  const file = body.input[0].content.find((item) => item.type === 'input_file');
  assert.equal(file.filename, pdf.name);
  assert.equal(file.file_data, `data:application/pdf;base64,${pdf.data}`);
  assert.match(body.instructions, /САМИ нормативы/);
});

test('текст DOCX/Excel и вложенные изображения передаются в OpenAI без обрезки', () => {
  const text = 'Последняя категория в документе: 21,20018 кг';
  const image = { mediaType: 'image/png', data: btoa('test-image') };
  const body = buildOpenAIRequest({ task: 'norms-extract', document: {
    name: 'Приказ.docx', mediaType: 'text/plain', text, images: [image],
  } });
  assert.ok(body.input[0].content.some((item) => item.type === 'input_text' && item.text === text));
  assert.ok(body.input[0].content.some((item) => item.type === 'input_image'
    && item.image_url === `data:image/png;base64,${image.data}`));
});

test('результат OpenAI принимает существующий валидатор нормативов', () => {
  const answer = readOpenAIResult(response(), 'extract_tko_norms');
  assert.equal(validateExtractedNorms(pdf.name, answer.result).ok, true);
});

test('неполные, повреждённые ответы и ответы без нужной функции отклоняются', () => {
  assert.throws(() => readOpenAIResult({ ...response(), status: 'incomplete' }, 'extract_tko_norms'), /не завершил ответ/);
  assert.throws(() => readOpenAIResult({ ...response(), output: [] }, 'extract_tko_norms'), /структурированный/);
  const bad = response(); bad.output[0].arguments = '{';
  assert.throws(() => readOpenAIResult(bad, 'extract_tko_norms'), /повреждённый/);
  const partial = response(); partial.output[0].status = 'incomplete';
  assert.throws(() => readOpenAIResult(partial, 'extract_tko_norms'), /структурированный/);
});

test('ключ OpenAI отправляется только в Authorization на api.openai.com', async (t) => {
  storage(t);
  setBrowserApiKey(key, 'openai', 'gpt-4.1-mini');
  assert.equal(getBrowserProvider(), 'openai');
  assert.equal(getBrowserModel(), 'gpt-4.1-mini');
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, OPENAI_URL);
    assert.equal(options.headers.Authorization, `Bearer ${key}`);
    assert.equal(options.headers['x-api-key'], undefined);
    assert.equal(options.headers['anthropic-version'], undefined);
    assert.ok(!options.body.includes(key));
    assert.ok(!url.includes(key));
    return Response.json(response());
  });
  assert.deepEqual((await requestNormsExtraction('https://unused.example', pdf)).result, result);
});

test('провайдер и выбранная модель сохраняются вместе с ключом и заменяют старую настройку', async (t) => {
  const map = storage(t);
  map.set('tko-ioo.anthropic-api-key.v1', 'sk-ant-fake-old');
  setBrowserApiKey(key, 'openai', 'gpt-4.1-mini-2025-04-14');
  assert.equal(map.has('tko-ioo.anthropic-api-key.v1'), false);
  const fresh = await import('../js/ai/client.js?openai-custom-model');
  assert.equal(fresh.getBrowserProvider(), 'openai');
  assert.equal(fresh.getBrowserModel(), 'gpt-4.1-mini-2025-04-14');
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, OPENAI_URL);
    assert.equal(JSON.parse(options.body).model, 'gpt-4.1-mini-2025-04-14');
    return Response.json(response());
  });
  await fresh.requestNormsExtraction('https://unused.example', pdf);
});

test('реестр обрабатывается через OpenAI с прежними ролями столбцов', async (t) => {
  storage(t); setBrowserApiKey(key, 'openai');
  const markup = { sheet: 0, headerRow: 0, category: 0, units: 1 };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, OPENAI_URL);
    const body = JSON.parse(options.body);
    assert.equal(body.tool_choice.name, 'razmetka_reestra');
    assert.equal(body.tools[0].parameters.additionalProperties, false);
    assert.equal(body.max_output_tokens, 1024);
    return Response.json(response('razmetka_reestra', markup));
  });
  const answer = await requestRegistryMarkup('https://unused.example', [
    { index: 0, title: 'Реестр', rows: [['Категория', 'Количество'], ['Жилые дома', 3]] },
  ]);
  assert.deepEqual(answer.result, markup);
});

test('старый сохранённый ключ OpenAI автоматически направляется в OpenAI', async (t) => {
  const map = storage(t);
  map.set('tko-ioo.anthropic-api-key.v1', key);
  const legacy = await import('../js/ai/client.js?openai-legacy');
  assert.equal(legacy.getBrowserProvider(), 'openai');
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, OPENAI_URL);
    assert.equal(options.headers.Authorization, `Bearer ${key}`);
    return Response.json(response());
  });
  await legacy.requestNormsExtraction('https://unused.example', pdf);
});

test('старый ключ Anthropic сохраняет провайдера Anthropic', async (t) => {
  const map = storage(t);
  map.set('tko-ioo.anthropic-api-key.v1', 'sk-ant-fake-legacy');
  const legacy = await import('../js/ai/client.js?anthropic-legacy');
  assert.equal(legacy.getBrowserProvider(), 'anthropic');
  assert.equal(legacy.getBrowserApiKey(), 'sk-ant-fake-legacy');
});

test('неверно выбранный провайдер не принимает чужой ключ', () => {
  assert.match(validateBrowserApiKey('sk-ant-fake', 'openai', OPENAI_MODEL), /ключ Anthropic/);
  assert.match(validateBrowserApiKey(key, 'anthropic'), /выберите OpenAI/);
  assert.equal(validateBrowserApiKey(key, 'openai', OPENAI_MODEL), null);
  assert.ok(validateBrowserApiKey(key, 'openai', 'bad model'));
});

test('ошибка OpenAI отображается с причиной без повторной отправки в Anthropic или прокси', async (t) => {
  storage(t); setBrowserApiKey(key, 'openai');
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls += 1; assert.equal(url, OPENAI_URL);
    return Response.json({ error: { message: 'Invalid API key', code: 'invalid_api_key' } }, { status: 401 });
  });
  await assert.rejects(() => requestNormsExtraction('https://unused.example', pdf), /OpenAI \(401\): Invalid API key/);
  assert.equal(calls, 1);
});
