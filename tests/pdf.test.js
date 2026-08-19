import test from 'node:test';
import assert from 'node:assert/strict';
import './helpers/env.js';

import {
  joinLines, clusterValues, rowsFromItems, tablesFromRows, tablesFromPages,
} from '../js/parse/pdf-layout.js';
import { splitOnRepeatedHeader, extractFromGrid } from '../js/parse/norms.js';

// Координаты сняты с настоящего PDF приказа: шаг строки внутри ячейки 11,2,
// высота текста 9, столбцы на 49,5 / 216,8 / 325,7 / 439,2.
const H = 9;
const PITCH = 11.2;

/** Ячейка таблицы: строки текста идут сверху вниз с межстрочным шагом. */
function cell(x, top, lines) {
  return lines.map((text, index) => ({ text, x, y: top + index * PITCH, height: H }));
}

/** Строка таблицы: ячейки записываются слева направо, как это делает PDF. */
function row(top, cells) {
  return cells.flatMap(([x, lines]) => cell(x, top, lines));
}

const HEADER = row(158.2, [
  [49.5, ['Наименование категории', 'потребителей']],
  [216.8, ['Расчетная единица']],
  [325.7, ['куб.м в год']],
  [439.2, ['кг в год']],
]);

test('строки таблицы восстанавливаются по возврату левого края', () => {
  const items = [
    ...HEADER,
    ...row(207.0, [
      [49.5, ['Жилые помещения в', 'многоквартирных домах']],
      [216.8, ['на 1 человека']],
      [325.7, ['1,8555']],
      [439.2, ['219,34']],
    ]),
    ...row(240.7, [
      [49.5, ['Жилые дома']],
      [216.8, ['на 1 человека']],
      [325.7, ['2,16418']],
      [439.2, ['257,36']],
    ]),
  ];
  const { rows } = rowsFromItems(items);
  assert.equal(rows.length, 3, 'три строки: шапка и две строки данных');
  assert.deepEqual(rows[1].cells.map((one) => one.text),
    ['Жилые помещения в многоквартирных домах', 'на 1 человека', '1,8555', '219,34']);
  assert.deepEqual(rows[0].cells.map((one) => one.text),
    ['Наименование категории потребителей', 'Расчетная единица', 'куб.м в год', 'кг в год']);
});

test('таблица из PDF доходит до нормативов без потерь', () => {
  const items = [
    ...HEADER,
    ...row(207.0, [[49.5, ['Автомойка']], [216.8, ['на 1 кв. метр']],
      [325.7, ['0,05227']], [439.2, ['5,02154']]]),
    ...row(230.0, [[49.5, ['Гостиницы']], [216.8, ['на 1 кв. метр']],
      [325.7, ['0,17807']], [439.2, ['21,20018']]]),
  ];
  const [table] = tablesFromRows(rowsFromItems(items).rows, H);
  const result = extractFromGrid(table.grid, {});
  assert.equal(result.entries.length, 2);
  assert.deepEqual(result.entries.map((entry) => entry.name), ['Автомойка', 'Гостиницы']);
  assert.equal(result.entries[0].mass, 5.02154);
  assert.equal(result.entries[0].volume, 0.05227);
});

test('абзац между таблицами разделяет их и становится подписью', () => {
  const items = [
    ...row(100, [[49.5, ['Приложение 1. Нормативы для жилья']]]),
    ...HEADER,
    ...row(207.0, [[49.5, ['Жилые дома']], [216.8, ['на 1 человека']],
      [325.7, ['2,16418']], [439.2, ['257,36']]]),
  ];
  const tables = tablesFromRows(rowsFromItems(items).rows, H);
  assert.equal(tables.length, 1);
  assert.equal(tables[0].title, 'Приложение 1. Нормативы для жилья');
  assert.equal(tables[0].grid.length, 2);
});

test('штамп рядом с таблицей не приклеивается к ней', () => {
  // «Список изменяющих документов» стоит вплотную к таблице, но по другим
  // столбцам — значит, это отдельная таблица, а не её строка.
  const items = [
    ...row(60, [[120, ['Список изменяющих документов']], [300, ['(в ред. от 25.04.2024)']]]),
    ...row(80, [[120, ['Список изменяющих документов']], [300, ['(в ред. от 05.08.2021)']]]),
    ...HEADER,
    ...row(207.0, [[49.5, ['Жилые дома']], [216.8, ['на 1 человека']],
      [325.7, ['2,16418']], [439.2, ['257,36']]]),
  ];
  const tables = tablesFromRows(rowsFromItems(items).rows, H);
  assert.equal(tables.length, 2, 'штамп и таблица нормативов разделены');
  assert.equal(tables[1].grid.length, 2);
  assert.deepEqual(tables[1].grid[1], ['Жилые дома', 'на 1 человека', '2,16418', '257,36']);
});

test('таблица, разорванная разрывом страницы, склеивается обратно', () => {
  const first = [
    ...HEADER,
    ...row(207.0, [[49.5, ['Жилые дома']], [216.8, ['на 1 человека']],
      [325.7, ['2,16418']], [439.2, ['257,36']]]),
    ...row(240.7, [[49.5, ['Гостиницы, мотели и иные', 'средства размещения']],
      [216.8, ['на 1 кв. метр']], [325.7, ['0,17807']], [439.2, ['21,20018']]]),
  ];
  // Вторая страница начинается с хвоста разрезанного наименования.
  const second = [
    ...row(60, [[49.5, ['для временного проживания']]]),
    ...row(90, [[49.5, ['Кладбища']], [216.8, ['на 1 кв. метр']],
      [325.7, ['0,0264']], [439.2, ['2,53']]]),
  ];
  const tables = tablesFromPages([first, second]);
  assert.equal(tables.length, 1, 'одна таблица, а не две');
  assert.equal(tables[0].grid.length, 4);
  assert.equal(tables[0].grid[2][0],
    'Гостиницы, мотели и иные средства размещения для временного проживания',
    'хвост наименования с новой страницы дописан в свою же строку');
  assert.deepEqual(tables[0].grid[3], ['Кладбища', 'на 1 кв. метр', '0,0264', '2,53']);
});

test('повторная шапка с единицами делит склеенную таблицу', () => {
  // Иначе множитель массы из первой шапки применился бы ко второй половине.
  const grid = [
    ['Наименование', 'Расчетная единица', 'куб.м в год', 'кг в год'],
    ['Жилые дома', 'на 1 человека', '2,16418', '257,36'],
    ['Наименование', '', 'куб.м на 1 кв. метр в год', 'т на 1 кв. метр в год'],
    ['Гостиницы', '', '0,17807', '0,02120'],
  ];
  const parts = splitOnRepeatedHeader(grid);
  assert.equal(parts.length, 2);
  assert.deepEqual(parts[0][0], grid[0]);
  assert.deepEqual(parts[1][0], grid[2]);

  const housing = extractFromGrid(parts[0], {});
  const rest = extractFromGrid(parts[1], {});
  assert.equal(housing.entries[0].mass, 257.36, 'килограммы остаются килограммами');
  assert.equal(rest.entries[0].mass, 21.2, 'тонны второй шапки переводятся в килограммы');
});

test('одна шапка таблицу не делит', () => {
  const grid = [
    ['Наименование', 'куб.м в год', 'кг в год'],
    ['Жилые дома', '2,16418', '257,36'],
    ['Гостиницы', '0,17807', '21,20018'],
  ];
  assert.equal(splitOnRepeatedHeader(grid).length, 1);
});

test('перенос по дефису склеивается без пробела, а тире остаётся тире', () => {
  assert.equal(joinLines(['торгово-', 'развлекательные комплексы']),
    'торгово-развлекательные комплексы');
  assert.equal(joinLines(['культурно -', 'развлекательные']), 'культурно - развлекательные');
  assert.equal(joinLines(['Жилые помещения в', 'многоквартирных домах']),
    'Жилые помещения в многоквартирных домах');
});

test('близкие значения собираются в один столбец', () => {
  assert.deepEqual(clusterValues([49.5, 49.7, 216.8, 217.0, 325.7], 4.5), [49.5, 216.8, 325.7]);
  assert.deepEqual(clusterValues([], 1), []);
});

test('пустая страница таблиц не даёт', () => {
  assert.deepEqual(rowsFromItems([]).rows, []);
  assert.deepEqual(rowsFromItems([{ text: '   ', x: 1, y: 1, height: 9 }]).rows, []);
  assert.deepEqual(tablesFromPages([[]]), []);
});
