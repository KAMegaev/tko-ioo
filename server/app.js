// VPS: отдаёт сайт и выполняет обращения к OpenAI с серверным ключом.
import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOpenAIRequest, readOpenAIResult, OPENAI_URL, OPENAI_MODEL } from '../js/ai/openai.js';
import { EXTRACTION_LIMITS } from '../js/ai/norms-contract.js';

const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2', '.map': 'application/json' };
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
  + "img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; "
  + "object-src 'none'; base-uri 'self'; frame-ancestors 'none'";

function failure(status, message) { return Object.assign(new Error(message), { status }); }
const digest = (value) => createHash('sha256').update(value).digest();
const dayFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' });
const currentDay = () => dayFormatter.format(new Date());

export function loadConfig(env) {
  for (const name of ['OPENAI_API_KEY', 'PUBLIC_ORIGIN']) {
    if (!env[name]) throw new Error(`Задайте ${name} в закрытом файле окружения сервера`);
  }
  if (!['true', 'false'].includes(env.TKO_PUBLIC_ACCESS || 'false')) throw new Error('TKO_PUBLIC_ACCESS: true или false');
  const publicAccess = env.TKO_PUBLIC_ACCESS === 'true';
  if (!publicAccess) {
    if (!env.TKO_USERNAME || !env.TKO_PASSWORD) throw new Error('Для закрытого доступа задайте TKO_USERNAME и TKO_PASSWORD');
    if (env.TKO_PASSWORD.length < 12) throw new Error('TKO_PASSWORD должен содержать не менее 12 символов');
    if (env.TKO_USERNAME.includes(':')) throw new Error('TKO_USERNAME не должен содержать двоеточие');
  }
  if (publicAccess && !env.USAGE_FILE) throw new Error('Для открытого доступа задайте USAGE_FILE, чтобы сохранять суточный лимит');
  const origin = new URL(env.PUBLIC_ORIGIN);
  if (!['https:', 'http:'].includes(origin.protocol) || origin.origin !== env.PUBLIC_ORIGIN) {
    throw new Error('PUBLIC_ORIGIN должен быть адресом сайта без пути и завершающего слеша');
  }
  if (origin.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(origin.hostname)) {
    throw new Error('Для публичного адреса сайта нужен HTTPS');
  }
  if (!/^[a-zA-Z0-9._:-]{1,100}$/.test(env.OPENAI_MODEL || OPENAI_MODEL)) throw new Error('Неверное имя OPENAI_MODEL');
  const concurrency = Number(env.MAX_CONCURRENT_REQUESTS || 2);
  const timeout = Number(env.OPENAI_TIMEOUT_MS || 280000);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 10) throw new Error('MAX_CONCURRENT_REQUESTS: от 1 до 10');
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 600000) throw new Error('OPENAI_TIMEOUT_MS: от 1000 до 600000');
  const dailyLimit = Number(env.MAX_DAILY_REQUESTS || 50);
  if (!Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 10000) throw new Error('MAX_DAILY_REQUESTS: от 1 до 10000');
  return { key: env.OPENAI_API_KEY, model: env.OPENAI_MODEL || OPENAI_MODEL,
    credential: publicAccess ? null : digest(`${env.TKO_USERNAME}:${env.TKO_PASSWORD}`),
    publicAccess, dailyLimit, usageFile: env.USAGE_FILE || null, origin: origin.origin, concurrency, timeout };
}

function authenticated(request, config) {
  if (!config.credential) return false;
  const header = request.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  const value = Buffer.from(header.slice(6), 'base64').toString('utf8');
  return timingSafeEqual(digest(value), config.credential);
}

function json(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(payload));
}

function readJSON(request) {
  const limit = EXTRACTION_LIMITS.bodyBytes;
  if (Number(request.headers['content-length'] || 0) > limit) {
    request.resume();
    return Promise.reject(failure(413, 'Слишком большой запрос'));
  }
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    request.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > limit) {
        failed = true;
        chunks.length = 0;
        reject(failure(413, 'Слишком большой запрос'));
      } else chunks.push(chunk);
    });
    request.on('end', () => {
      if (failed) return;
      try { resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(failure(400, 'Не удалось разобрать JSON запроса')); }
    });
    request.on('error', () => reject(failure(400, 'Не удалось получить запрос')));
  });
}

function registrySample(tables) {
  if (!Array.isArray(tables) || !tables.length || tables.length > 12) throw failure(400, 'Ожидался образец листов реестра');
  return tables.map((sheet, index) => {
    if (!sheet || !Array.isArray(sheet.rows) || sheet.rows.length > 25) throw failure(400, 'Слишком большой образец реестра');
    const rows = sheet.rows.map((row) => {
      if (!Array.isArray(row) || row.length > 32) throw failure(400, 'Неверная строка образца реестра');
      return row.map((cell) => {
        const text = String(cell ?? '');
        if (text.length > 1000) throw failure(400, 'Слишком длинная ячейка образца');
        return text;
      });
    });
    return { index: Number.isInteger(sheet.index) ? sheet.index : index,
      title: String(sheet.title || '').slice(0, 300), rows };
  });
}

/** Параметр fetchImpl используется тестами; адрес OpenAI задаётся только в коде. */
export function createApp({ env = process.env, root = PROJECT, fetchImpl = globalThis.fetch } = {}) {
  const config = loadConfig(env);
  const rootPath = resolve(root);
  let active = 0;
  const attempts = new Map();
  let usage = { day: currentDay(), count: 0 };
  if (config.usageFile && existsSync(config.usageFile)) {
    try {
      usage = JSON.parse(readFileSync(config.usageFile, 'utf8'));
      if (typeof usage.day !== 'string' || !Number.isInteger(usage.count) || usage.count < 0) throw new Error();
    } catch { throw new Error('Не удалось прочитать файл суточного лимита USAGE_FILE'); }
  }
  const reserveRequest = () => {
    const day = currentDay();
    const count = usage.day === day ? usage.count : 0;
    if (count >= config.dailyLimit) throw failure(429, 'На сегодня достигнут общий лимит запросов к ИИ. Лимит обновится в полночь по московскому времени.');
    const next = { day, count: count + 1 };
    if (config.usageFile) {
      try {
        writeFileSync(config.usageFile + '.tmp', JSON.stringify(next), { mode: 0o600 });
        renameSync(config.usageFile + '.tmp', config.usageFile);
      } catch { throw failure(503, 'Не удалось сохранить счётчик запросов. Обратитесь к администратору сайта.'); }
    }
    usage = next;
  };
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Security-Policy', CSP);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'same-origin');
    response.setHeader('Cache-Control', 'no-store');
    try {
      const path = new URL(request.url, 'http://localhost').pathname;
      if (path === '/healthz' && request.method === 'GET') return json(response, 200, { status: 'ok' });
      if (!config.publicAccess && !authenticated(request, config)) {
        response.setHeader('WWW-Authenticate', 'Basic realm="TKO", charset="UTF-8"');
        return json(response, 401, { error: 'Нужны логин и пароль для входа на сайт' });
      }

      if (path === '/api/ai') {
        if (request.method !== 'POST') throw failure(405, 'Поддерживается только POST');
        const origin = request.headers.origin;
        if (origin && origin !== config.origin) throw failure(403, 'Запрос разрешён только с адреса этого сайта');
        if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) throw failure(415, 'Ожидался application/json');
        const ip = String(request.headers['x-real-ip'] || request.socket.remoteAddress);
        const now = Date.now();
        for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
        if (attempts.size >= 10000 && !attempts.has(ip)) throw failure(429, 'Сервер занят. Повторите запрос позже.');
        const counter = attempts.get(ip) || { count: 0, until: now + 60000 };
        counter.count += 1;
        attempts.set(ip, counter);
        if (counter.count > 20) throw failure(429, 'Слишком часто. Повторите запрос через минуту.');
        if (active >= config.concurrency) throw failure(429, 'Сервер обрабатывает другие документы. Повторите запрос чуть позже.');
        active += 1;
        try {
          const incoming = await readJSON(request);
          let payload;
          if (incoming?.task === 'norms-extract') payload = { task: incoming.task, document: incoming.document };
          else if (incoming?.task === 'registry-markup') payload = { task: incoming.task, tables: registrySample(incoming.tables) };
          else throw failure(400, 'Неизвестная задача');
          let body;
          try { body = buildOpenAIRequest(payload, config.model); }
          catch (error) { throw failure(400, error.message); }
          reserveRequest();
          const disconnected = new AbortController();
          const onClose = () => { if (!response.writableEnded) disconnected.abort(); };
          response.once('close', onClose);
          const signal = AbortSignal.any([AbortSignal.timeout(config.timeout), disconnected.signal]);
          let upstream;
          let data;
          try {
            upstream = await fetchImpl(OPENAI_URL, {
              method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.key}` },
              body: JSON.stringify(body), signal,
            });
            data = await upstream.json();
          } catch {
            throw failure(signal.aborted ? 504 : 502,
              signal.aborted ? 'OpenAI не ответил вовремя. Повторите запрос или разделите документ.' : 'Сервер не смог получить ответ OpenAI');
          } finally { response.off('close', onClose); }
          if (!upstream.ok || data.error) {
            const message = String(data.error?.message || 'Запрос отклонён провайдером').replaceAll(config.key, '[скрыто]');
            return json(response, 502, { error: `OpenAI недоступен (${upstream.status})`,
              detail: JSON.stringify({ error: { message: message.slice(0, 500) } }) });
          }
          let result;
          try { result = readOpenAIResult(data, body.tool_choice.name); }
          catch (error) { throw failure(502, error.message); }
          return json(response, 200, { ok: true, ...result });
        } finally { active -= 1; }
      }

      if (!['GET', 'HEAD'].includes(request.method)) throw failure(405, 'Метод не поддерживается');
      if (path === '/js/runtime-config.js') {
        response.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-store' });
        return response.end(`globalThis.TKO_RUNTIME = Object.freeze(${JSON.stringify({ serverMode: true, provider: 'openai', model: config.model })});`);
      }
      const relative = decodeURIComponent(path === '/' ? '/index.html' : path).slice(1);
      if (relative.split(/[\\/]/).some((part) => part === '.' || part === '..' || part.startsWith('.'))) {
        throw failure(404, 'Файл не найден');
      }
      if (!(relative === 'index.html' || /^(css|js|images|vendor)\//.test(relative))) throw failure(404, 'Файл не найден');
      const target = resolve(rootPath, relative);
      if (!target.startsWith(rootPath + sep)) throw failure(404, 'Файл не найден');
      const actual = await realpath(target);
      if (!actual.startsWith(rootPath + sep)) throw failure(404, 'Файл не найден');
      if (!(await stat(actual)).isFile()) throw failure(404, 'Файл не найден');
      response.writeHead(200, { 'Content-Type': MIME[extname(actual)] || 'application/octet-stream' });
      response.end(request.method === 'HEAD' ? undefined : await readFile(actual));
    } catch (error) {
      if (response.destroyed) return;
      if (response.headersSent) { response.end(); return; }
      const status = error.status || (['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error.code) ? 404 : 500);
      json(response, status, { error: status === 500 ? 'Внутренняя ошибка сервера' : error.message });
    }
  });
  server.requestTimeout = 120000;
  server.headersTimeout = 30000;
  return server;
}
