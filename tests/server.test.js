import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, loadConfig } from '../server/app.js';
import { EXTRACTION_LIMITS } from '../js/ai/norms-contract.js';

const key = 'sk-proj-fake-server-key';
const password = 'fake-site-password-123';
const env = { OPENAI_API_KEY: key, TKO_USERNAME: 'tester', TKO_PASSWORD: password,
  PUBLIC_ORIGIN: 'https://tko.megaev.ru', OPENAI_MODEL: 'gpt-4.1-mini' };
const authorization = `Basic ${Buffer.from(`tester:${password}`).toString('base64')}`;
const pdf = { name: 'Скан.pdf', mediaType: 'application/pdf', data: btoa('%PDF-1.4\nscan') };
const payload = { task: 'norms-extract', document: pdf };
const result = { complete: true, entries: [], warnings: [], reason: 'test' };
const apiResponse = (name = 'extract_tko_norms', input = result) => Response.json({
  status: 'completed', model: 'test-model', output: [{ type: 'function_call', name,
    arguments: JSON.stringify(input), status: 'completed' }],
});

async function app(t, options = {}) {
  const server = createApp({ env: { ...env, ...options.env }, fetchImpl: options.fetchImpl || (async () => apiResponse()) });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body = payload, headers = {}) => fetch(`${base}/api/ai`, { method: 'POST',
    headers: { authorization, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { server, base, post };
}

test('без ключа и пароля сервер не запускается, публичному адресу требуется HTTPS', () => {
  assert.throws(() => loadConfig({}), /OPENAI_API_KEY/);
  assert.throws(() => loadConfig({ ...env, TKO_PASSWORD: 'short' }), /12 символов/);
  assert.throws(() => loadConfig({ ...env, PUBLIC_ORIGIN: 'http://tko.megaev.ru' }), /HTTPS/);
});

test('сайт и API закрыты паролем, healthz не раскрывает конфигурацию', async (t) => {
  const { base } = await app(t);
  for (const path of ['/', '/api/ai', '/js/runtime-config.js']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 401);
    assert.match(response.headers.get('www-authenticate'), /Basic/);
    assert.ok(!(await response.text()).includes(key));
  }
  assert.deepEqual(await (await fetch(base + '/healthz')).json(), { status: 'ok' });
});

test('открытый сайт доступен без пароля, суточный предел сохраняется между запусками', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tko-public-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const publicEnv = { TKO_PUBLIC_ACCESS: 'true', TKO_USERNAME: '', TKO_PASSWORD: '',
    USAGE_FILE: join(directory, 'usage.json'), MAX_DAILY_REQUESTS: '1' };
  const first = await app(t, { env: publicEnv });
  assert.equal((await fetch(first.base)).status, 200);
  const options = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) };
  assert.equal((await fetch(first.base + '/api/ai', options)).status, 200);
  assert.equal((await fetch(first.base + '/api/ai', options)).status, 429);
  const restarted = await app(t, { env: publicEnv });
  const response = await fetch(restarted.base + '/api/ai', options);
  assert.equal(response.status, 429);
  assert.match((await response.json()).error, /по московскому времени/);
});

test('публичный режим требует постоянного счётчика, ошибка его записи не вызывает OpenAI', async (t) => {
  assert.throws(() => loadConfig({ ...env, TKO_PUBLIC_ACCESS: 'true' }), /USAGE_FILE/);
  const directory = mkdtempSync(join(tmpdir(), 'tko-bad-counter-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let calls = 0;
  const { post } = await app(t, { env: { TKO_PUBLIC_ACCESS: 'true', USAGE_FILE: join(directory, 'missing', 'usage.json') },
    fetchImpl: async () => { calls += 1; return apiResponse(); } });
  assert.equal((await post()).status, 503);
  assert.equal(calls, 0);
});

test('runtime-конфигурация включает только серверный режим и не раскрывает секреты', async (t) => {
  const { base } = await app(t);
  const response = await fetch(base + '/js/runtime-config.js', { headers: { authorization } });
  assert.equal(response.status, 200);
  const source = await response.text();
  assert.match(source, /"serverMode":true/);
  assert.match(source, /"provider":"openai"/);
  assert.ok(!source.includes(key));
  assert.ok(!source.includes(password));
  assert.match(response.headers.get('content-security-policy'), /connect-src 'self'/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('браузер отправляет документ на сервер, сервер подставляет свой ключ и фиксированную модель', async (t) => {
  const { post } = await app(t, { fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(options.headers.Authorization, `Bearer ${key}`);
    const body = JSON.parse(options.body);
    assert.equal(body.model, env.OPENAI_MODEL);
    assert.ok(!options.body.includes(key));
    assert.equal(body.input[0].content[1].file_data, `data:application/pdf;base64,${pdf.data}`);
    return apiResponse();
  } });
  const response = await post({ ...payload, model: 'client-model', apiKey: 'client-key', url: 'https://evil.example' });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data.result, result);
  assert.ok(!JSON.stringify(data).includes(key));
});

test('образец реестра обрабатывается сервером с прежней схемой', async (t) => {
  const markup = { sheet: 0, headerRow: 0, category: 0, units: 1 };
  const { post } = await app(t, { fetchImpl: async (url, options) => {
    assert.equal(JSON.parse(options.body).tool_choice.name, 'razmetka_reestra');
    return apiResponse('razmetka_reestra', markup);
  } });
  const response = await post({ task: 'registry-markup', tables: [
    { index: 0, title: 'Реестр', rows: [['Категория', 'Количество'], ['Жилые дома', 3]] },
  ] });
  assert.deepEqual((await response.json()).result, markup);
});

test('чужой Origin, неверный тип данных, неизвестная задача и большие образцы не вызывают OpenAI', async (t) => {
  let calls = 0;
  const { post, base } = await app(t, { fetchImpl: async () => { calls += 1; return apiResponse(); } });
  assert.equal((await post(payload, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post(payload, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post({ task: '__proto__' })).status, 400);
  assert.equal((await post({ task: 'norms-extract', document: { ...pdf, data: '' } })).status, 400);
  assert.equal((await post({ task: 'registry-markup', tables: [{ rows: Array.from({ length: 26 }, () => ['data']) }] })).status, 400);
  const bad = await fetch(base + '/api/ai', { method: 'POST', headers: { authorization,
    'Content-Type': 'application/json' }, body: '{' });
  assert.equal(bad.status, 400);
  assert.equal(calls, 0);
});

test('файлы окружения и код сервера недоступны через HTTP, включая обход через закодированный путь', async (t) => {
  const { base } = await app(t);
  for (const path of ['/server/app.js', '/server/.env.example', '/.git/config', '/.env',
    '/js/..%2fserver/app.js', '/js/..%2f.git/config']) {
    const response = await fetch(base + path, { headers: { authorization } });
    assert.equal(response.status, 404, path);
  }
  const index = await fetch(base, { headers: { authorization } });
  assert.equal(index.status, 200);
  assert.match(await index.text(), /js\/runtime-config.js/);
});

test('причина 403 возвращается браузеру без серверного ключа', async (t) => {
  const { post } = await app(t, { fetchImpl: async () => Response.json({
    error: { message: `Request not allowed for ${key}` },
  }, { status: 403 }) });
  const response = await post();
  const text = await response.text();
  assert.equal(response.status, 502);
  assert.match(text, /403/);
  assert.match(text, /Request not allowed/);
  assert.ok(!text.includes(key));
});

test('сервер отклоняет незавершённый ответ OpenAI', async (t) => {
  const { post } = await app(t, { fetchImpl: async () => Response.json({ status: 'incomplete', output: [] }) });
  const response = await post();
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /не завершил ответ/);
});

test('параллелизм ограничен, слот освобождается после обработки', async (t) => {
  let release;
  let started;
  let calls = 0;
  const inFlight = new Promise((resolve) => { started = resolve; });
  const { post } = await app(t, { env: { MAX_CONCURRENT_REQUESTS: '1' }, fetchImpl: async () => {
    calls += 1;
    if (calls === 1) {
      started();
      await new Promise((resolve) => { release = resolve; });
    }
    return apiResponse();
  } });
  const first = post();
  await inFlight;
  assert.equal((await post()).status, 429);
  release();
  assert.equal((await first).status, 200);
  assert.equal((await post()).status, 200);
});

test('двадцать первый запрос с одного адреса ограничивается', async (t) => {
  const { post } = await app(t);
  for (let i = 0; i < 20; i += 1) assert.equal((await post()).status, 200);
  const response = await post();
  assert.equal(response.status, 429);
  assert.match((await response.json()).error, /через минуту/);
});

test('на VPS старый ключ браузера игнорируется, обращения идут только на /api/ai', async (t) => {
  const before = globalThis.TKO_RUNTIME;
  const client = await import('../js/ai/client.js');
  client.setBrowserApiKey('sk-proj-fake-old-browser', 'openai');
  globalThis.TKO_RUNTIME = { serverMode: true, model: 'server-model' };
  t.after(() => {
    globalThis.TKO_RUNTIME = before;
    client.setBrowserApiKey('');
  });
  assert.equal(client.hasBrowserApiKey(), false);
  assert.equal(client.getEndpoint(), '/api/ai');
  assert.throws(() => client.setBrowserApiKey('new-key'), /только на сервере/);
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, '/api/ai');
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.headers['x-api-key'], undefined);
    assert.ok(!options.body.includes('sk-proj-fake-old-browser'));
    return Response.json({ result });
  });
  const response = await client.requestNormsExtraction('https://ignored.example', pdf);
  assert.deepEqual(response.result, result);
  assert.equal(EXTRACTION_LIMITS.bodyBytes, 24 * 1024 * 1024);
});
