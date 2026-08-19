import test from 'node:test';
import assert from 'node:assert/strict';
import './helpers/env.js';

import {
  joinWords, skewSlope, columnBands, bandsForCount, rowBounds, chooseSkeleton, tableFromWords,
} from '../js/parse/pdf-scan.js';
import { isScanned } from '../js/parse/pdf.js';
import { extractFromGrid } from '../js/parse/norms.js';

// Отсканированный приказ: распознавание отдаёт отдельные слова с координатами.
// Столбцы стоят на 108 / 140 / 290 / 390 / 486, высота текста 10, шаг строки 12.
const H = 10;

/** Слово. */
const w = (text, x, y) => ({ text, x, y, width: text.length * 5.2, height: H });

/** Ячейка: строки текста идут сверху вниз, отсчёт от центра строки. */
function cell(x, centre, lines) {
  const top = centre - ((lines.length - 1) * 12) / 2;
  return lines.flatMap((line, index) => {
    const words = [];
    let left = x;
    for (const word of line.split(' ')) {
      words.push(w(word, left, top + index * 12));
      left += word.length * 5.2 + 4; // слова в ячейке идут вплотную
    }
    return words;
  });
}

function row(centre, { number, name, unit, volume, mass }) {
  return [
    ...(number ? [w(number, 108, centre)] : []),
    ...cell(140, centre, name),
    ...(unit ? cell(290, centre, unit) : []),
    ...(volume ? [w(volume, 390, centre)] : []),
    ...(mass ? [w(mass, 486, centre)] : []),
  ];
}

const PAGE = [
  ...row(60, { name: ['Наименование'], unit: ['Расчетная единица'], volume: 'куб.м', mass: 'кг' }),
  ...row(100, {
    number: '1.1',
    name: ['Дошкольные образовательные', 'учреждения (детские садики)'],
    unit: ['1 ребенок'],
    volume: '0,21',
    mass: '24,86',
  }),
  ...row(180, {
    number: '1.2',
    name: ['Общеобразовательные учреждения,', 'учреждения начального и среднего',
      'профессионального образования'],
    unit: ['1 учащийся'],
    volume: '0,09',
    mass: '8,03',
  }),
  ...row(250, { number: '1.3', name: ['Бани, сауны'], unit: ['1 место'], volume: '0,13', mass: '15,52' }),
];

test('таблица скана собирается из отдельных слов', () => {
  const table = tableFromWords(PAGE);
  assert.ok(table, 'таблица восстановлена');
  assert.equal(table.bands.length, 5, 'пять столбцов');
  assert.equal(table.grid.length, 4, 'шапка и три строки данных');
  assert.deepEqual(table.grid[1], ['1.1', 'Дошкольные образовательные учреждения (детские садики)',
    '1 ребенок', '0,21', '24,86']);
  assert.deepEqual(table.grid[3], ['1.3', 'Бани, сауны', '1 место', '0,13', '15,52']);
});

test('высокая строка не забирает текст у соседней однострочной', () => {
  // Ячейки выровнены по центру, поэтому у длинного наименования своя высота,
  // а не половина расстояния до соседа.
  const { grid } = tableFromWords(PAGE);
  assert.match(grid[2][1], /^Общеобразовательные учреждения/);
  assert.match(grid[2][1], /профессионального образования$/);
  assert.equal(grid[1][1].includes('Общеобразовательные'), false);
});

test('нормативы читаются из восстановленной таблицы скана', () => {
  const { grid } = tableFromWords(PAGE);
  const result = extractFromGrid(grid, {});
  assert.equal(result.entries.length, 3);
  assert.deepEqual(result.entries.map((entry) => entry.mass), [24.86, 8.03, 15.52]);
  assert.deepEqual(result.entries.map((entry) => entry.volume), [0.21, 0.09, 0.13]);
  assert.deepEqual(result.entries.map((entry) => entry.name),
    ['Дошкольные образовательные учреждения (детские садики)',
      'Общеобразовательные учреждения, учреждения начального и среднего профессионального образования',
      'Бани, сауны']);
});

test('границы строк выводятся из центров и высот', () => {
  // Центры 100 и 180 при верхнем крае 90: первая строка низкая, вторая высокая.
  const bounds = rowBounds([100, 180], 90);
  assert.equal(bounds[0], 110);
  assert.equal(bounds[1], Infinity);
  // Граница не может оказаться выше собственного центра.
  assert.ok(rowBounds([100, 180], 130)[0] > 100);
});

test('столбцы находятся по сквозным просветам', () => {
  const lines = [
    { words: [w('1.1', 108, 100), w('Гостиницы', 140, 100), w('0,21', 390, 100)] },
    { words: [w('1.2', 108, 120), w('Кладбища', 140, 120), w('0,09', 390, 120)] },
    { words: [w('1.3', 108, 140), w('Автомойка', 140, 140), w('0,13', 390, 140)] },
  ];
  assert.equal(columnBands(lines, H).length, 3);
  // Если просвет замусорен, столбцы всё равно делятся по заданному числу.
  const noisy = [...lines, { words: [w('шум', 128, 160), w('0,5', 380, 160)] }];
  assert.equal(bandsForCount(noisy, H, 3).length, 3);
});

test('столбец с номером по порядку выбирается скелетом', () => {
  const columns = [
    [{ y: 1, text: '1' }, { y: 2, text: '1.1' }, { y: 3, text: '1.2' }],
    [{ y: 1, text: 'Гостиницы' }, { y: 2, text: 'Кладбища' }, { y: 3, text: 'Бани' }],
    [{ y: 1, text: '0,21' }, { y: 2, text: '0,09' }, { y: 3, text: '0,13' }, { y: 4, text: '0,4' }],
  ];
  // Значения норматива под номер по порядку не подходят: в них запятая.
  assert.equal(chooseSkeleton(columns), 0);
  const noNumbers = [
    [{ y: 1, text: 'Гостиницы' }, { y: 2, text: 'Кладбища' }, { y: 3, text: 'Бани' },
      { y: 4, text: 'и сауны' }],
    [{ y: 1, text: '0,21' }, { y: 2, text: '0,09' }, { y: 3, text: '0,13' }],
  ];
  assert.equal(chooseSkeleton(noNumbers), 1, 'без номеров берётся самый редкий столбец');
});

test('наклон скана определяется по числу строк', () => {
  // Пять строк по три слова: при верном наклоне они сходятся в пять строк,
  // при нулевом — рассыпаются на большее число.
  const straight = [0, 1, 2, 3, 4].flatMap((line) => [100, 300, 500]
    .map((x) => w('слово', x, 100 + line * 24)));
  assert.equal(skewSlope(straight, H), 0);
  const tilted = straight.map((word) => ({ ...word, y: word.y + word.x * 0.02 }));
  assert.ok(Math.abs(skewSlope(tilted, H) - 0.02) <= 0.004,
    `наклон определён как ${skewSlope(tilted, H)}`);
});

test('скан отличается от PDF, сделанного из редактора', () => {
  const words = [{ text: 'Гостиницы' }, { text: 'Кладбища' }, { text: 'Бани' }];
  const cells = [{ text: 'Предприятия общественного питания' }, { text: 'Бани, сауны' }];
  assert.equal(isScanned([words]), true);
  assert.equal(isScanned([cells]), false);
  assert.equal(isScanned([[]]), false);
});

test('распознавание отбивает знаки препинания — их возвращают на место', () => {
  assert.equal(joinWords(['Кафе', ',', 'бары', ',', 'столовые']), 'Кафе, бары, столовые');
  assert.equal(joinWords(['магазины', '(', 'оптика', ')']), 'магазины (оптика)');
});
