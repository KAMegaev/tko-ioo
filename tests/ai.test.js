import test from 'node:test';
import assert from 'node:assert/strict';
import './helpers/env.js';
import { normsGrid } from './helpers/fixtures.js';

import { extractFromGrid, applyLayouts } from '../js/parse/norms.js';
import { buildSample, describeSample, validateMarkup, compare } from '../js/ai/norms-markup.js';

const HOUSING_ROWS = [
  { name: 'Жилые помещения в многоквартирных домах', unit: 'на 1 человека', volume: '1,8555', mass: '219,34' },
  { name: 'Жилые дома', unit: 'на 1 человека', volume: '2,16418', mass: '257,36' },
];
const OTHER_ROWS = [
  { name: 'Автомойка', volume: '0,05227', mass: '5,02154' },
  { name: 'Гостиницы', volume: '0,17807', mass: '21,20018' },
  { name: 'Кладбища', volume: '0,00291', mass: '0,29775' },
];

/** Файл нормативов: служебная таблица, жильё и прочие категории. */
function normsFile() {
  const rawTables = [
    { index: 0, title: '', grid: [['Список изменяющих документов']] },
    { index: 1, title: 'Приложение 1', grid: normsGrid(HOUSING_ROWS, { withUnitColumn: true }) },
    {
      index: 2,
      title: 'Приложение 2',
      grid: normsGrid(OTHER_ROWS, {
        volumeHeader: 'куб.м на 1 кв. метр в год',
        massHeader: 'кг на 1 кв. метр в год',
      }),
    },
  ];
  const entries = [];
  for (const table of rawTables) {
    const result = extractFromGrid(table.grid, { title: table.title });
    if (!result) continue;
    for (const entry of result.entries) entries.push({ ...entry, id: `n${entries.length}` });
  }
  return { fileName: 'Нормативы.docx', entries, rawTables, tables: [], skipped: [], source: 'эвристика' };
}

const HOUSING_MARKUP = {
  tableIndex: 1, headerRowCount: 2, nameColumn: 0, unitColumn: 1, volumeColumn: 2, massColumn: 3,
  massUnit: 'кг в год', volumeUnit: 'куб.м в год', basis: 'person',
};
const OTHER_MARKUP = {
  tableIndex: 2, headerRowCount: 2, nameColumn: 0, unitColumn: -1, volumeColumn: 1, massColumn: 2,
  massUnit: 'кг', volumeUnit: 'куб.м', basis: 'sqm',
};

const answer = (tables, extra = {}) => ({ tables, confidence: 0.9, reason: 'проверка', ...extra });

test('в образец попадают только шапки и первые строки, без данных реестра', () => {
  const sample = buildSample(normsFile());
  assert.equal(sample.length, 2, 'таблица из одной строки в образец не идёт');
  assert.ok(sample.every((table) => table.rows.length <= 6));
  const text = describeSample(sample);
  assert.ok(text.includes('Жилые дома'));
  assert.ok(new Blob([text]).size < 8000, 'образец должен оставаться небольшим');
});

test('разметка нескольких таблиц объединяет нормативы', () => {
  const norms = normsFile();
  const checked = validateMarkup(norms, answer([HOUSING_MARKUP, OTHER_MARKUP]));
  assert.ok(checked.ok, checked.problems.join('; '));
  assert.equal(checked.preview.entries.length, 5);
  assert.equal(checked.summary.tables.length, 2);
  const housing = checked.preview.entries.find((entry) => entry.name === 'Жилые дома');
  assert.equal(housing.mass, 257.36);
  assert.equal(housing.basis, 'person');
  const other = checked.preview.entries.find((entry) => entry.name === 'Автомойка');
  assert.equal(other.basis, 'sqm');
});

test('потеря таблицы видна в сравнении с прежним разбором', () => {
  const norms = normsFile();
  const checked = validateMarkup(norms, answer([OTHER_MARKUP]));
  assert.ok(checked.ok);
  const diff = compare(norms, checked.preview);
  assert.deepEqual(diff.removed.sort(), ['Жилые дома', 'Жилые помещения в многоквартирных домах']);
  assert.equal(diff.countBefore, 5);
  assert.equal(diff.countAfter, 3);
});

test('несуществующий столбец отклоняется', () => {
  const checked = validateMarkup(normsFile(), answer([{ ...OTHER_MARKUP, massColumn: 7 }]));
  assert.equal(checked.ok, false);
  assert.match(checked.problems.join(' '), /столбца массы № 7 нет/);
});

test('столбец с текстом вместо чисел отклоняется', () => {
  // Столбец наименований указан и как источник значений массы.
  const checked = validateMarkup(normsFile(), answer([{ ...OTHER_MARKUP, massColumn: 0 }]));
  assert.equal(checked.ok, false);
  assert.match(checked.problems.join(' '), /совпадает со столбцом наименований/);
});

test('единица из шапки файла главнее названной помощником', () => {
  // Шапка таблицы — «кг на 1 кв. метр в год», помощник называет её иначе.
  const checked = validateMarkup(normsFile(), answer([
    HOUSING_MARKUP, { ...OTHER_MARKUP, massUnit: 'пудов в год' },
  ]));
  assert.ok(checked.ok, checked.problems.join('; '));
  const wash = checked.preview.entries.find((entry) => entry.name === 'Автомойка');
  assert.equal(wash.mass, 5.02154, 'значение пересчитано по шапке, а не по ответу помощника');
});

test('расхождение единицы с шапкой отклоняется — иначе масса выросла бы в тысячу раз', () => {
  const checked = validateMarkup(normsFile(), answer([{ ...OTHER_MARKUP, massUnit: 'т' }]));
  assert.equal(checked.ok, false);
  assert.match(checked.problems.join(' '), /расхождение в 1000 раз/);
});

test('единица неизвестна и в шапке, и в ответе — разметка отклоняется', () => {
  const norms = normsFile();
  norms.rawTables[2].grid = normsGrid(OTHER_ROWS, {
    massHeader: 'пудов в год', volumeHeader: 'куб.м на 1 кв. метр в год',
  });
  const checked = validateMarkup(norms, answer([{ ...OTHER_MARKUP, massUnit: 'пудов' }]));
  assert.equal(checked.ok, false);
  assert.match(checked.problems.join(' '), /единица массы .* неизвестна/);
});

test('тонны приводятся к килограммам по указанной единице', () => {
  const norms = normsFile();
  norms.rawTables[2].grid = normsGrid(
    [{ name: 'Гостиницы', volume: '0,17807', mass: '0,02120018' }],
    { massHeader: 'т на 1 кв. метр в год', volumeHeader: 'куб.м на 1 кв. метр в год' },
  );
  const checked = validateMarkup(norms, answer([
    HOUSING_MARKUP, { ...OTHER_MARKUP, massUnit: 'т' },
  ]));
  assert.ok(checked.ok, checked.problems.join('; '));
  const hotel = checked.preview.entries.find((entry) => entry.name === 'Гостиницы');
  assert.ok(Math.abs(hotel.mass - 21.20018) < 1e-6, `получено ${hotel.mass}`);
});

test('шапка глубже таблицы отклоняется', () => {
  const checked = validateMarkup(normsFile(), answer([{ ...OTHER_MARKUP, headerRowCount: 99 }]));
  assert.equal(checked.ok, false);
  assert.match(checked.problems.join(' '), /не помещается в таблицу/);
});

test('пустой список таблиц не применяется, причина сохраняется', () => {
  const checked = validateMarkup(normsFile(), answer([], { reason: 'Таблиц с нормативами нет' }));
  assert.equal(checked.ok, false);
  assert.deepEqual(checked.problems, ['Таблиц с нормативами нет']);
});

test('одна и та же таблица дважды отклоняется', () => {
  const checked = validateMarkup(normsFile(), answer([OTHER_MARKUP, OTHER_MARKUP]));
  assert.equal(checked.ok, false);
  assert.match(checked.problems.join(' '), /указана дважды/);
});

test('мусор вместо ответа не роняет проверку', () => {
  for (const bad of [null, undefined, 'текст', 42, {}, { tables: 'нет' }]) {
    const checked = validateMarkup(normsFile(), bad);
    assert.equal(checked.ok, false);
    assert.ok(checked.problems.length);
  }
});

test('применение разметки не изменяет исходный разбор', () => {
  const norms = normsFile();
  const before = norms.entries.length;
  const result = applyLayouts(norms, {
    tables: [{ tableIndex: 2, layout: { headerRowCount: 2, nameColumn: 0, volumeColumn: 1, massColumn: 2 } }],
  });
  assert.equal(norms.entries.length, before, 'исходный объект остаётся прежним');
  assert.equal(result.entries.length, 3);
  assert.equal(result.source, 'разметка');
  assert.equal(result.skipped.length, 2);
});
