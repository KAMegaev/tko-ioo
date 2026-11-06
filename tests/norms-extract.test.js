import test from 'node:test';
import assert from 'node:assert/strict';
import { libs } from './helpers/env.js';
import { prepareNormsDocument, validateExtractedNorms } from '../js/ai/norms-extract.js';
import { EXTRACTION_LIMITS, validateNormsDocument } from '../js/ai/norms-contract.js';
import { requestNormsExtraction } from '../js/ai/client.js';
import { buildNormsWorkbook } from '../js/export/report.js';
import worker from '../worker/index.js';
import { num } from '../js/ui/dom.js';

const measure = (value, unit, period = 'year', quantity = 1) => ({ value, unit, period, quantity });
const entry = (extra = {}) => ({
  name: 'Жилые дома', context: '', unit: 'на 1 человека',
  mass: measure(0.247027, 't'), volume: measure(2.073, 'm3'),
  source: { location: 'Приложение, таблица 1, строка 5', quote: 'Жилые дома: 2,073 м³, 0,247027 тонн на 1 проживающего человека в год' },
  ...extra,
});
const answer = (entries = [entry()], extra = {}) => ({ complete: true, entries, warnings: [], reason: 'Все приложения прочитаны', ...extra });
const pdf = { name: 'Скан.pdf', mediaType: 'application/pdf', data: btoa('%PDF-1.3\nscan without text') };
const buffer = (text) => new TextEncoder().encode(text).buffer;

test('PDF передаётся в модель исходным документом без зависимости от OCR', async () => {
  const data = buffer('%PDF-1.3\nscan without text');
  const document = await prepareNormsDocument({ name: 'Скан.pdf' }, data, {});
  assert.equal(document.mediaType, 'application/pdf');
  assert.equal(atob(document.data), new TextDecoder().decode(data));
});

test('DOCX сохраняет текст вне таблиц, все строки, объединения и сноски', async () => {
  const zip = new libs.JSZip();
  const p = (text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
  const cell = (text, props = '') => `<w:tc><w:tcPr>${props}</w:tcPr>${p(text)}</w:tc>`;
  const row = (cells) => `<w:tr>${cells}</w:tr>`;
  const start = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>';
  const rows = Array.from({ length: 501 }, (_, i) => row(cell(`Категория ${i}`) + cell(`${i},12345`))).join('');
  zip.file('word/document.xml', start + p('Приказ и территориальные условия')
    + '<w:tbl>' + row(cell('Объединённая шапка', '<w:gridSpan w:val="2"/>'))
    + row(cell('1 кв. метр', '<w:vMerge w:val="restart"/>'))
    + row(cell('', '<w:vMerge/>')) + rows + '</w:tbl>'
    + p('Норматив вне таблицы: 21,20018 кг в год') + '</w:body></w:document>');
  zip.file('word/footnotes.xml', start + p('Сноска: значения в тоннах') + '</w:body></w:document>');
  const document = await prepareNormsDocument({ name: 'Приказ.docx' }, await zip.generateAsync({ type: 'arraybuffer' }), libs);
  assert.ok(document.text.includes('Приказ и территориальные условия'));
  assert.ok(document.text.includes('Категория 500'));
  assert.ok(document.text.includes('500,12345'));
  assert.ok(document.text.includes('Норматив вне таблицы: 21,20018'));
  assert.ok(document.text.includes('Сноска: значения в тоннах'));
  assert.ok(document.text.includes('"columns":2'));
  assert.ok(document.text.includes('"verticalMerge":"continue"'));
});

test('Excel передаёт все листы, включая хвост таблицы после прежнего лимита строк', async () => {
  const book = libs.XLSX.utils.book_new();
  for (let i = 0; i < 14; i += 1) {
    const rows = Array.from({ length: 450 }, (_, j) => [`Категория ${i}/${j}`, 0.12345]);
    libs.XLSX.utils.book_append_sheet(book, libs.XLSX.utils.aoa_to_sheet(rows), `Лист${i}`);
  }
  const document = await prepareNormsDocument({ name: 'Нормативы.xlsx' },
    libs.XLSX.write(book, { type: 'array', bookType: 'xlsx' }), libs);
  assert.ok(document.text.includes('Лист "Лист13"'));
  assert.ok(document.text.includes('Категория 13/449'));
  assert.ok(document.text.includes('0.12345'));
});

test('слишком большой документ отклоняется целиком, без усечения', async () => {
  assert.throws(() => validateNormsDocument({ name: 'Приказ', mediaType: 'text/plain',
    text: 'я'.repeat(EXTRACTION_LIMITS.textChars + 1) }), /не был обрезан/);
  await assert.rejects(() => prepareNormsDocument({ name: 'Приказ.pdf' },
    new ArrayBuffer(EXTRACTION_LIMITS.fileBytes + 1), {}), /16 МБ/);
  assert.throws(() => validateNormsDocument({ ...pdf, data: 'повреждено' }), /Повреждённые/);
});

test('тонны Кузбасса, периоды и количество расчётных единиц приводятся программой', () => {
  const checked = validateExtractedNorms('Кузбасс.docx', answer([
    entry(), entry({ name: 'Магазины', unit: 'м²', mass: null, volume: measure(2, 'l', 'day', 2) }),
    entry({ name: 'Иная категория', mass: measure(200, 'g', 'month', 100), volume: null }),
  ]));
  assert.equal(checked.ok, true);
  assert.ok(Math.abs(checked.preview.entries[0].mass - 247.027) < 1e-10);
  assert.equal(checked.preview.entries[0].volume, 2.073);
  assert.equal(checked.preview.entries[1].mass, null, 'отсутствующая масса не выдумывается');
  assert.equal(checked.preview.entries[1].basis, 'sqm');
  assert.equal(checked.preview.entries[1].volume, 0.365);
  assert.ok(Math.abs(checked.preview.entries[2].mass - 0.024) < 1e-10);
});

test('малый норматив из постановления РИ отображается точно, а не как ноль', () => {
  assert.equal(num(4.233e-6, true), '0,000004233');
  assert.equal(num(0.0002046, true), '0,0002046');
  assert.equal(num(260.36578, true), '260,36578');
  assert.equal(num(0, true), '0');
  assert.equal(num(null, true), '—');
});

test('территориальные варианты и одинаковые категории с разными единицами не теряются', () => {
  const checked = validateExtractedNorms('Приказ.pdf', answer([
    entry({ context: 'Городские населённые пункты' }),
    entry({ context: 'Сельские населённые пункты' }),
    entry({ context: 'Сельские населённые пункты', unit: 'м²', mass: measure(5, 'kg') }),
  ]));
  assert.equal(checked.ok, true);
  assert.equal(checked.preview.entries.length, 3);
  assert.equal(new Set(checked.preview.entries.map((item) => item.id)).size, 3);
  assert.match(checked.preview.entries[1].name, /Сельские/);
  assert.equal(checked.preview.entries[2].unitText, 'м²');
});

test('неполный ответ не применяется, объяснение ИИ сохраняется', () => {
  const checked = validateExtractedNorms('Скан.pdf', answer([entry()], {
    complete: false, warnings: ['Страница 5 не читается'],
  }));
  assert.equal(checked.ok, false);
  assert.ok(checked.problems.includes('Страница 5 не читается'));
  assert.equal(checked.preview, undefined);
});

test('ошибочная запись отклоняет весь набор и не изменяет резервный разбор', () => {
  const fallback = { entries: [{ name: 'Резерв' }], rawTables: [] };
  const invalid = [
    entry({ mass: measure(-1, 'kg') }), entry({ volume: measure(1, 'kg') }),
    entry({ mass: measure(1, 'kg', 'season') }), entry({ mass: measure(1, 'kg', 'year', 0) }),
    entry({ mass: measure('2', 'kg') }), entry({ mass: measure(NaN, 'kg') }),
    entry({ unit: '' }), entry({ source: null }), null,
  ];
  for (const bad of invalid) {
    assert.equal(validateExtractedNorms('Файл', answer([entry(), bad]), fallback).ok, false);
  }
  for (const bad of [null, {}, { entries: [] }, { entries: 'нет' }]) {
    assert.equal(validateExtractedNorms('Файл', bad).ok, false);
  }
  assert.deepEqual(fallback.entries, [{ name: 'Резерв' }]);
  const zero = validateExtractedNorms('Файл', answer([entry({ mass: measure(0, 'kg'), volume: null })]));
  assert.equal(zero.ok, true);
  assert.equal(zero.preview.entries[0].mass, 0);
});

test('прочерки в трёх строках постановления РИ № 184 не отклоняют остальные нормативы', () => {
  // 39 категорий + 5 дополнительных расчётных единиц; индексы из реального ответа ИИ.
  const rows = Array.from({ length: 44 }, (_, i) => entry({ name: `Категория ${i + 1}` }));
  for (const [index, name] of [[14, 'Палатки, киоски'], [39, 'Общежития'], [41, 'Садоводческие кооперативы']]) {
    rows[index] = entry({ name, unit: index === 39 ? '1 койко-место' : '1 кв. метр общей площади',
      mass: null, volume: null, source: { location: `Приложение, запись ${index + 1}`, quote: `${name} | - | -` } });
  }
  rows[19] = entry({ name: 'Автостоянки', unit: '1 машино-место',
    mass: measure(0, 'kg'), volume: measure(0, 'm3'),
    source: { location: 'Страница 3, строка 16', quote: 'Автостоянки | 1 машино-место | 0 | 0' } });
  rows[30] = entry({ name: 'Туристические базы', unit: '1 кв. метр общей площади',
    mass: measure(0.0002046, 'kg'), volume: measure(4.233e-6, 'm3'),
    source: { location: 'Страница 3, строка 27', quote: 'Туристические базы | 0,0002046 | 4,233E-06' } });
  const checked = validateExtractedNorms('Постановление РИ № 184.pdf', answer(rows));
  assert.equal(checked.ok, true);
  assert.equal(checked.preview.entries.length, 44);
  assert.equal(checked.summary.withMass, 41);
  assert.equal(checked.summary.withVolume, 41);
  assert.equal(checked.summary.withoutValues, 3);
  assert.equal(checked.preview.entries[14].mass, null);
  assert.equal(checked.preview.entries[14].volume, null);
  assert.equal(checked.preview.entries[19].mass, 0);
  assert.equal(checked.preview.entries[19].volume, 0);
  assert.equal(checked.preview.entries[30].volume, 0.000004233);
  assert.match(checked.summary.warnings.join(' '), /Палатки, киоски.*Общежития.*Садоводческие кооперативы/);
  const book = libs.XLSX.read(buildNormsWorkbook(checked.preview, libs.XLSX), { type: 'array' });
  const grid = libs.XLSX.utils.sheet_to_json(book.Sheets['Нормативы'], { header: 1, defval: null });
  assert.equal(grid.length, 45);
  assert.equal(grid[15][2], '');
  assert.equal(grid[15][3], '');
  assert.equal(grid[15][9], 'Не указаны в документе');
  assert.equal(grid[20][2], 0);
  assert.equal(grid[20][3], 0);
  assert.equal(grid[20][9], 'Указаны');
});

test('справочник Excel доступен без шаблона и реестра, сохраняет единицы и источник', () => {
  const checked = validateExtractedNorms('Кузбасс.docx', answer());
  const bytes = buildNormsWorkbook(checked.preview, libs.XLSX);
  const book = libs.XLSX.read(bytes, { type: 'array' });
  const rows = libs.XLSX.utils.sheet_to_json(book.Sheets['Нормативы'], { header: 1 });
  assert.equal(rows[1][0], 'Жилые дома');
  assert.equal(rows[1][1], 'на 1 человека');
  assert.ok(Math.abs(rows[1][2] - 247.027) < 1e-10);
  assert.equal(rows[1][7], entry().source.location);
  assert.equal(rows[1][8], entry().source.quote);
});

const workerRequest = (payload) => new Request('https://worker.example/', {
  method: 'POST', headers: { Origin: 'https://kamegaev.github.io', 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
});
const modelResponse = (result, stop = 'tool_use') => Response.json({
  content: [{ type: 'tool_use', name: 'extract_tko_norms', input: result }], stop_reason: stop,
});

test('Worker передаёт исходный PDF модели, использует схему извлечения и достаточный ответ', async (t) => {
  let upstream;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    upstream = { url, body: JSON.parse(options.body) };
    return modelResponse(answer());
  });
  const response = await worker.fetch(workerRequest({ task: 'norms-extract', document: pdf }), { ANTHROPIC_API_KEY: 'test' });
  assert.equal(response.status, 200);
  assert.equal(upstream.body.max_tokens, 32000);
  assert.equal(upstream.body.tool_choice.name, 'extract_tko_norms');
  assert.equal(upstream.body.messages[0].content[1].type, 'document');
  assert.equal(upstream.body.messages[0].content[1].source.data, pdf.data);
  assert.match(upstream.body.system, /САМИ нормативы/);
  assert.match(upstream.body.system, /только данные/);
  const result = await response.json();
  assert.equal(validateExtractedNorms('Скан.pdf', result.result).ok, true);
});

test('обрезанный ответ модели отклоняется, даже если его JSON удалось прочитать', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => modelResponse(answer(), 'max_tokens'));
  const response = await worker.fetch(workerRequest({ task: 'norms-extract', document: pdf }), { ANTHROPIC_API_KEY: 'test' });
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /не поместился целиком/);
});

test('некорректный документ не отправляется модели', async (t) => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests += 1; return modelResponse(answer()); });
  for (const document of [null, {}, { ...pdf, mediaType: 'arbitrary' }, { ...pdf, data: '' }]) {
    const response = await worker.fetch(workerRequest({ task: 'norms-extract', document }), {});
    assert.equal(response.status, 400);
  }
  assert.equal(requests, 0);
});

test('старый прокси вызывает понятное сообщение о необходимости обновить Worker', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'Неизвестная задача' }, { status: 400 }));
  await assert.rejects(() => requestNormsExtraction('https://worker.example', pdf), /Обновите Cloudflare Worker/);
});
