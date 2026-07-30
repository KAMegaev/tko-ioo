import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { libs } from './helpers/env.js';
import { templateWorkbook, registryWorkbook, toFgisStyle, normsGrid } from './helpers/fixtures.js';

import { extractFromGrid } from '../js/parse/norms.js';
import { parseRegistryWorkbook, aggregateRegistry, detectColumns } from '../js/parse/registry.js';
import { parseTemplate } from '../js/parse/template.js';
import { templateCategories, matchNorms, matchRegistryCategories, matchZones } from '../js/lib/match.js';
import { buildResults, round } from '../js/lib/calc.js';
import { verify } from '../js/lib/verify.js';
import { fillTemplate } from '../js/export/fill.js';

const TEMPLATE_ROWS = [
  { zone: 'Вся территория', category: 'Автомойка', unit: 'Квадратный метр' },
  { zone: 'Вся территория', category: 'Гостиницы', unit: 'Квадратный метр' },
  { zone: 'Вся территория', category: 'Индивидуальные жилые дома', unit: 'Человек' },
  { zone: 'Вся территория', category: 'Кладбища', unit: 'Квадратный метр' },
];

const NORM_ROWS = [
  { name: 'Автомойка', volume: '0,05227', mass: '5,02154' },
  { name: 'Гостиницы', volume: '0,17807', mass: '21,20018' },
  { name: 'Жилые дома', volume: '2,16418', mass: '257,36' },
];

const REGISTRY_ROWS = [
  { category: 'Автомойка', units: 100, zone: 'Вся территория' },
  { category: 'Автомойка', units: 50.5, zone: 'Вся территория' },
  { category: 'Автомойка', units: 0, zone: 'Вся территория' },
  { category: 'Гостиницы', units: 200, zone: 'Вся территория' },
  { category: 'Индивидуальные жилые дома', units: 3, zone: 'Вся территория' },
  { category: 'Иная категория', units: 999, zone: 'Вся территория' },
];

function buildNorms() {
  const result = extractFromGrid(normsGrid(NORM_ROWS));
  return {
    fileName: 'Нормативы.docx',
    entries: result.entries.map((entry, index) => ({ ...entry, id: `n${index}`, file: 'Нормативы.docx' })),
    tables: [result.headerInfo],
    skipped: [],
  };
}

async function runPipeline({ fgis = true } = {}) {
  const norms = buildNorms();
  const templateBuffer = fgis
    ? await toFgisStyle(templateWorkbook(TEMPLATE_ROWS))
    : templateWorkbook(TEMPLATE_ROWS);
  const template = await parseTemplate(templateBuffer, 'Общие сведения.xlsx', JSZip);
  const registryFile = parseRegistryWorkbook(registryWorkbook(REGISTRY_ROWS), 'Реестр.xlsx', XLSX);
  const registry = aggregateRegistry([registryFile]);

  const categories = templateCategories(template.rows);
  const normMapping = matchNorms(categories, norms.entries);
  const registryMapping = matchRegistryCategories(registry.categories, categories);
  const { zoneMapping } = matchZones(registry.zones, template.rows);
  const normById = new Map(norms.entries.map((entry) => [entry.id, entry]));

  const results = buildResults({
    templateRows: template.rows,
    registryGroups: registry.groups,
    registryMapping,
    zoneMapping,
    normMapping,
    normById,
  });
  const verification = verify({ results, registry, normById, normMapping, templateRows: template.rows });
  return { template, norms, registry, categories, normMapping, registryMapping, normById, results, verification };
}

test('таблица нормативов из приказа разбирается вместе с размерностями', () => {
  const result = extractFromGrid(normsGrid(NORM_ROWS));
  assert.equal(result.entries.length, 3);
  assert.equal(result.entries[0].mass, 5.02154);
  assert.equal(result.entries[0].volume, 0.05227);
  assert.equal(result.headerInfo.massFactor, 1);
});

test('нормативы в тоннах приводятся к килограммам', () => {
  const result = extractFromGrid(normsGrid([{ name: 'Гостиницы', volume: '0,17807', mass: '0,02120018' }],
    { massHeader: 'т в год' }));
  assert.equal(round(result.entries[0].mass, 5), 21.20018);
});

test('расчётная единица берётся из отдельного столбца таблицы', () => {
  const result = extractFromGrid(normsGrid([{ name: 'Жилые дома', unit: 'на 1 человека', volume: '2,16418', mass: '257,36' }],
    { withUnitColumn: true }));
  assert.equal(result.entries[0].basis, 'person');
});

test('колонки реестра определяются по заголовкам в любом порядке', () => {
  const detected = detectColumns([
    ['Зона деятельности', 'Количество расчетных единиц', 'Категория потребителя'],
    ['Вся территория', 1, 'Автомойка'],
  ]);
  assert.deepEqual(detected.columns.category, 2);
  assert.deepEqual(detected.columns.units, 1);
  assert.deepEqual(detected.columns.zone, 0);
});

test('шаблон ФГИС читается несмотря на префикс и заниженный dimension', async () => {
  const { template } = await runPipeline({ fgis: true });
  assert.equal(template.sheetName, 'Общие сведения');
  assert.equal(template.headerRow, 1);
  assert.equal(template.metaRows.length, 2, 'служебные строки не попадают в данные');
  assert.equal(template.rows.length, TEMPLATE_ROWS.length);
  assert.equal(template.rows[0].excelRow, 4);
  assert.equal(template.columns.sources, 6);
  assert.equal(template.columns.density, 10);
  assert.equal(template.lastHeaderColumn, 11);
});

test('источники с нулевым количеством не увеличивают счётчик источников', async () => {
  const { results } = await runPipeline();
  const washing = results.rows.find((row) => row.templateRow.category === 'Автомойка');
  assert.equal(washing.sources, 2, 'три строки реестра, одна из них с нулём');
  assert.equal(washing.units, 150.5);
  assert.equal(washing.zeroSources, 1);
});

test('масса переводится в тонны, объём и плотность считаются от точной суммы', async () => {
  const { results } = await runPipeline();
  const washing = results.rows.find((row) => row.templateRow.category === 'Автомойка');
  assert.equal(round(washing.mass, 2), round((5.02154 * 150.5) / 1000, 2));
  assert.equal(round(washing.volume, 2), round(0.05227 * 150.5, 2));
  assert.equal(round(washing.density, 2), round(washing.mass / washing.volume, 2));
});

test('категория без данных реестра даёт нули, а не пустые ячейки', async () => {
  const { results } = await runPipeline();
  const cemetery = results.rows.find((row) => row.templateRow.category === 'Кладбища');
  assert.equal(cemetery.sources, 0);
  assert.equal(cemetery.units, 0);
  assert.equal(round(cemetery.mass, 2) ?? 0, 0);
});

test('несопоставленная категория реестра не теряется, а попадает в замечания', async () => {
  const { results, verification } = await runPipeline();
  assert.equal(results.unassigned.length, 1);
  assert.equal(results.unassigned[0].category, 'Иная категория');
  const issue = verification.issues.find((item) => item.code === 'unassigned');
  assert.ok(issue, 'должно быть замечание о непопавших данных');
  assert.equal(issue.level, 'error');
  assert.ok(verification.checks.every((check) => check.ok), 'баланс должен сходиться');
});

test('выгрузка сохраняет строки, столбцы A-E и форматирование', async () => {
  const { template, results } = await runPipeline();
  const blob = await fillTemplate(template, results);
  const zip = await JSZip.loadAsync(blob);
  const sheet = await zip.file('xl/worksheets/sheet1.xml').async('string');

  const workbook = XLSX.read(blob, { type: 'buffer' });
  const grid = XLSX.utils.sheet_to_json(workbook.Sheets['Общие сведения'], { header: 1, defval: null });

  assert.equal(grid.length, 3 + TEMPLATE_ROWS.length, 'число строк не изменилось');
  assert.equal(grid[0][3], 'Категория потребителя');
  assert.equal(grid[3][0], 'Омская область', 'столбец A не тронут');
  assert.equal(grid[3][3], 'Автомойка', 'столбец D не тронут');
  assert.equal(grid[3][5], 2, 'F: количество источников');
  assert.equal(grid[3][6], 151, 'G: расчётные единицы округлены до целых');
  assert.equal(grid[3][7], 0.76, 'H: масса в тоннах');
  assert.equal(grid[3][10], null, 'K не заполняется');
  assert.equal(grid[0][11], 'Норматив по массе, кг/год');
  assert.equal(grid[0][12], 'Норматив по объему, м³/год');
  assert.equal(grid[3][11], 5.02154);

  assert.ok(sheet.includes('<x:dimension ref="A1:S7"'), 'dimension охватывает все строки');
  const styles = await zip.file('xl/styles.xml').async('string');
  assert.match(styles, /horizontal="center"/);
  assert.match(styles, /vertical="center"/);
});

test('повторная обработка уже заполненного файла не плодит столбцы', async () => {
  const first = await runPipeline();
  const blob = await fillTemplate(first.template, first.results);
  const buffer = await blob.arrayBuffer ? await new Response(blob).arrayBuffer() : blob;

  const template = await parseTemplate(buffer, 'Общие сведения.xlsx', JSZip);
  assert.equal(template.columns.normMass, 12);
  assert.equal(template.columns.normVolume, 13);
  assert.equal(template.rows.length, TEMPLATE_ROWS.length);
});
