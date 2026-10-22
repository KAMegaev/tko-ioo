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
import { registryMappingTable } from '../js/export/report.js';
import { normalize, similarity } from '../js/lib/text.js';

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

test('единица измерения не принимается за количество расчётных единиц', () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['Категория потребителя', 'Единица измерения расчетных единиц', 'Зона деятельности', 'Количество расчетных единиц'],
    ['Гостиницы', 'Человек', 'Вся территория', 7],
  ]), 'Реестр');
  const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
  const parsed = parseRegistryWorkbook(buffer, 'Реестр.xlsx', XLSX);
  assert.equal(parsed.columns.unitName, 1);
  assert.equal(parsed.columns.units, 3);
  assert.equal(parsed.rows[0].unitName, 'Человек');
  assert.equal(parsed.rows[0].units, 7);
});

test('категории с разными единицами сопоставляются и рассчитываются независимо', () => {
  const registry = aggregateRegistry([
    { fileName: 'Реестр 1.xlsx', rows: [
      { category: 'Гостиницы', unitName: 'Человек', zone: 'Вся территория', units: 3 },
      { category: 'Гостиницы', unitName: 'м²', zone: 'Вся территория', units: 100 },
      { category: 'Гостиницы', unitName: 'Человек', zone: 'Вся территория', units: 0 },
    ] },
    { fileName: 'Реестр 2.xlsx', rows: [
      { category: 'Гостиницы', unitName: ' человек ', zone: 'Вся территория', units: 2 },
      { category: 'Гостиницы', unitName: 'м2', zone: 'Вся территория', units: 50 },
    ] },
  ]);
  assert.equal(registry.categories.length, 2);
  assert.equal(registry.groups.size, 2);
  const person = registry.categories.find((item) => item.unitName === 'Человек');
  const area = registry.categories.find((item) => item.unitName === 'м²');
  assert.equal(person.rows, 3);
  assert.equal(person.units, 5);
  assert.equal(area.rows, 2);
  assert.equal(area.units, 150);
  assert.notEqual(person.key, area.key);

  const templateRows = [
    { index: 0, excelRow: 4, category: 'Гостиницы', unit: 'Человек', zone: 'Вся территория' },
    { index: 1, excelRow: 5, category: 'Гостиницы по площади', unit: 'м²', zone: 'Вся территория' },
  ];
  const categories = templateCategories(templateRows);
  const registryMapping = matchRegistryCategories(registry.categories, categories);
  registryMapping.set(area.key, {
    ...registryMapping.get(area.key), templateKey: normalize('Гостиницы по площади'), auto: false, status: 'manual',
  });
  assert.equal(registryMapping.get(person.key).templateKey, normalize('Гостиницы'));
  const { zoneMapping } = matchZones(registry.zones, templateRows);
  const calculate = () => buildResults({
    templateRows, registryGroups: registry.groups, registryMapping, zoneMapping,
    normMapping: new Map(categories.map((item) => [item.key, { mode: 'manual', manualMass: 100, manualVolume: 2 }])),
    normById: new Map(),
  });
  const results = calculate();
  assert.deepEqual(results.rows.map((row) => [row.sources, row.units, row.mass, row.volume]), [
    [2, 5, 0.5, 10], [2, 150, 15, 300],
  ]);
  assert.equal(results.unassigned.length, 0);

  const report = registryMappingTable({
    registry, registryMapping, categoryByKey: new Map(categories.map((item) => [item.key, item])),
  });
  const unitColumn = report[0].indexOf('Единица измерения');
  const scoreColumn = report[0].indexOf('% соответствия');
  assert.equal(unitColumn, report[0].indexOf('Сумма расчётных единиц') + 1);
  assert.equal(scoreColumn, report[0].indexOf('Категория (Выгрузка общих сведений)') + 1);
  const personReport = report.find((row) => row[unitColumn] === 'Человек');
  const areaReport = report.find((row) => row[unitColumn] === 'м²');
  assert.equal(personReport[scoreColumn], '100 %');
  assert.equal(areaReport[scoreColumn], `${Math.round(similarity('Гостиницы', 'Гостиницы по площади') * 100)} %`,
    'процент относится к выбранной вручную категории, а не к первоначальному кандидату');

  registryMapping.get(person.key).templateKey = null;
  const excluded = calculate();
  assert.equal(excluded.rows[0].units, 0);
  assert.equal(excluded.rows[1].units, 150, 'исключение одной единицы не меняет другую');
  assert.equal(excluded.unassigned[0].units, 5);
  const excludedReport = registryMappingTable({
    registry, registryMapping, categoryByKey: new Map(categories.map((item) => [item.key, item])),
  });
  assert.equal(excludedReport.find((row) => row[unitColumn] === 'Человек')[scoreColumn], '');
});

test('пустая единица остаётся отдельной группой, а м² и м³ не объединяются', () => {
  const registry = aggregateRegistry([{ fileName: 'Реестр.xlsx', rows: [
    { category: 'Иная категория', zone: 'Зона', units: 4 },
    { category: 'Иная категория', unitName: ' ', zone: 'Зона', units: null },
    { category: 'Иная категория', unitName: 'м²', zone: 'Зона', units: 10 },
    { category: 'Иная категория', unitName: 'м³', zone: 'Зона', units: 20 },
  ] }]);
  assert.equal(registry.categories.length, 3);
  assert.equal(registry.groups.size, 3);
  const unknown = registry.categories.find((item) => item.unitName === '');
  assert.equal(unknown.key, normalize('Иная категория'));
  assert.equal(unknown.rows, 2);
  assert.equal(unknown.units, 4);
  assert.equal(unknown.unitsKnown, false);
  assert.equal(registry.rowsWithoutUnits, 1);
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

test('несопоставленные данные сводятся в одно замечание на зону и категорию', () => {
  // Реестр делится в том числе по муниципальным образованиям, а форма их не
  // различает. Без сведения одна категория дала бы замечание на каждый район,
  // и все они выглядели бы одинаково: района в тексте замечания нет.
  const group = (municipality, rows, units, sources) => ([
    `з1||мо-${municipality}||иная`,
    {
      zoneKey: 'з1',
      municipalityKey: `мо-${municipality}`,
      categoryKey: 'иная',
      zone: 'Зона №1',
      municipality,
      category: 'Иная категория',
      rows,
      units,
      sources,
      unitsKnown: true,
    },
  ]);
  const registryGroups = new Map([
    group('Ровенский район', 11, 492.25, 11),
    group('Перелюбский район', 9, 783.68, 9),
    group('Городской округ Саратов', 101, 12803.47, 101),
  ]);

  const results = buildResults({
    templateRows: TEMPLATE_ROWS.map((row, index) => ({ ...row, index })),
    registryGroups,
    registryMapping: new Map([['иная', { templateKey: null }]]),
    zoneMapping: new Map([['з1', { templateKey: 'вся территория' }]]),
    normMapping: new Map(),
    normById: new Map(),
  });

  assert.equal(results.unassigned.length, 1, 'одно замечание вместо трёх');
  const [item] = results.unassigned;
  assert.equal(item.rows, 121);
  assert.equal(round(item.units, 2), 14079.4);
  assert.equal(item.sources, 121);
  assert.equal(item.groups, 3, 'счёт групп реестра сохранён');
  assert.equal(item.municipalities.length, 3);

  const verification = verify({
    results,
    registry: { groups: registryGroups, totalRows: 121, zeroRows: 0, categories: [], hasUnits: true },
    normById: new Map(),
    normMapping: new Map(),
    templateRows: TEMPLATE_ROWS,
  });
  const unassigned = verification.issues.filter((one) => one.code === 'unassigned');
  assert.equal(unassigned.length, 1);
  assert.match(unassigned[0].detail, /собраны по 3 муниципальным образованиям/);
  assert.equal(verification.summary.unassignedGroups, 3);
  assert.ok(verification.checks.every((check) => check.ok), 'балансы сходятся');
});
