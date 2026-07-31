import test from 'node:test';
import assert from 'node:assert/strict';
import './helpers/env.js';

import { normalize, parseNumber, similarity, tokens } from '../js/lib/text.js';
import {
  massFactor, volumeFactor, isMassHeader, isVolumeHeader, unitBasis, parseMeasure,
} from '../js/lib/units.js';
import { evaluate, validate, referencedIds, humanize } from '../js/lib/formula.js';
import { round } from '../js/lib/calc.js';
import { rankCandidates, templateCategories } from '../js/lib/match.js';

test('нормализация приводит ё к е и убирает пунктуацию', () => {
  assert.equal(normalize('Мастерские по ремонту обуви, ключей, часов и пр.'),
    'мастерские по ремонту обуви ключей часов и пр');
  assert.equal(normalize('Ёлочный  базар'), 'елочный базар');
  assert.equal(normalize(null), '');
});

test('разбор чисел принимает запятую и отвергает текст', () => {
  assert.equal(parseNumber('0,08457'), 0.08457);
  assert.equal(parseNumber('1 234,5'), 1234.5);
  assert.equal(parseNumber('7,22619 <*>'), 7.22619);
  assert.equal(parseNumber(12.5), 12.5);
  // Текстовая шапка не должна выглядеть числом — иначе она попадёт в данные.
  assert.equal(parseNumber('кг на 1 кв. метр в год'), null);
  assert.equal(parseNumber('куб.м в год'), null);
  assert.equal(parseNumber(''), null);
  assert.equal(parseNumber('—'), null);
});

test('основы слов отбрасывают окончания и стоп-слова', () => {
  assert.deepEqual(tokens('Организации, оказывающие ритуальные услуги'),
    tokens('Организация, оказывающая ритуальные услуги'));
});

test('похожесть наименований различает близкие и далёкие категории', () => {
  assert.equal(similarity('Автомойка', 'Автомойка'), 1);
  assert.ok(similarity('Организация, оказывающая ритуальные услуги',
    'Организации, оказывающие ритуальные услуги') > 0.95);
  assert.ok(similarity('Мастерские по ремонту обуви, ключей, часов и пр.',
    'Мастерские по ремонту обуви, ключей, часов и прочие') > 0.95);
  assert.ok(similarity('Жилые помещения в многоквартирном доме',
    'Жилые помещения в многоквартирных домах') > 0.85);
  assert.ok(similarity('Автомойка', 'Кладбища') < 0.3);
});

test('размерности распознаются в кириллической шапке', () => {
  // Границы слов \b в JS не работают с кириллицей — проверяем именно это.
  assert.equal(massFactor('Норматив накопления ТКО кг в год'), 1);
  assert.equal(massFactor('Норматив накопления ТКО, т в год'), 1000);
  assert.equal(massFactor('куб.м в год'), null);
  assert.equal(volumeFactor('куб.м на 1 кв. метр в год'), 1);
  assert.equal(volumeFactor('м³ в год'), 1);
  assert.equal(volumeFactor('кг на 1 кв. метр в год'), null);
  assert.ok(isMassHeader('кг на 1 кв. метр в год'));
  assert.ok(!isMassHeader('куб.м в год'));
  assert.ok(isVolumeHeader('куб.м в год'));
});

test('расчётная единица определяется по тексту', () => {
  assert.equal(unitBasis('Человек'), 'person');
  assert.equal(unitBasis('на 1 человека'), 'person');
  assert.equal(unitBasis('Квадратный метр'), 'sqm');
  assert.equal(unitBasis('кг на 1 кв. метр в год'), 'sqm');
});

test('перевод тонн в килограммы при разборе шапки', () => {
  assert.equal(round(massFactor('т в год') * 0.25736, 5), 257.36);
});

test('формулы вычисляются без eval', () => {
  const values = { n1: 10, n2: 4, n3: null };
  const resolve = (id) => values[id];
  assert.equal(evaluate('[n1] + [n2]', resolve), 14);
  assert.equal(evaluate('[n1] - [n2]', resolve), 6);
  assert.equal(evaluate('0,5*[n1]', resolve), 5);
  assert.equal(evaluate('([n1] + [n2]) / 2', resolve), 7);
  assert.equal(evaluate('[n1] + [n3]', resolve), null, 'неизвестный норматив обнуляет результат');
  assert.deepEqual(referencedIds('[n1] + [n2]'), ['n1', 'n2']);
  assert.throws(() => evaluate('[n1] +', resolve));
  assert.throws(() => evaluate('[n1] / 0', resolve));
  assert.throws(() => evaluate('alert(1)', resolve));
});

test('проверка формулы сообщает о неизвестных нормативах', () => {
  const known = new Set(['n1']);
  assert.equal(validate('[n1] + 2', known), null);
  assert.match(validate('[n9]', known), /Неизвестные нормативы/);
  assert.equal(humanize('[n1] + 2', () => 'Гостиницы'), '«Гостиницы» + 2');
});

test('округление не страдает от двоичного представления', () => {
  assert.equal(round(1.005, 2), 1.01);
  assert.equal(round(2.675, 2), 2.68);
  assert.equal(round(1051527.6, 0), 1051528);
  assert.equal(round(null, 2), null);
});

test('кандидаты ранжируются с учётом расчётной единицы', () => {
  const pool = [
    { id: 'a', name: 'Жилые дома', basis: 'person' },
    { id: 'b', name: 'Жилые помещения в многоквартирных домах', basis: 'person' },
    { id: 'c', name: 'Гаражи, парковки закрытого типа', basis: 'sqm' },
  ];
  const [best] = rankCandidates('Индивидуальные жилые дома', pool, 'person');
  assert.equal(best.id, 'a');
  const mismatch = rankCandidates('Жилые дома', pool, 'sqm')[0];
  assert.ok(mismatch.basisMismatch || mismatch.id !== 'a' || mismatch.score < 1);
});

test('категории шаблона собираются с учётом повторов', () => {
  const categories = templateCategories([
    { index: 0, category: 'Автомойка', unit: 'Квадратный метр', zone: 'Зона 1' },
    { index: 1, category: 'Автомойка', unit: 'Квадратный метр', zone: 'Зона 2' },
    { index: 2, category: 'Гостиницы', unit: 'Квадратный метр', zone: 'Зона 1' },
  ]);
  assert.equal(categories.length, 2);
  assert.deepEqual(categories[0].rows, [0, 1]);
  assert.equal(categories[0].basis, 'sqm');
});

test('размерность и расчётная единица читаются прямо из ячейки', () => {
  // Приказ Кузбасса: «2,073 м3/1 проживающего человека в год».
  const volume = parseMeasure('2,073 м3/1 проживающего человека в год');
  assert.equal(volume.value, 2.073);
  assert.equal(volume.kind, 'volume');
  assert.equal(volume.factor, 1);
  assert.equal(volume.basis, 'person');

  const mass = parseMeasure('0,247027 тонн/1 проживающего человека в год');
  assert.equal(mass.kind, 'mass');
  assert.equal(mass.factor, 1000, 'тонны приводятся к килограммам');

  assert.equal(parseMeasure('0,341 м3/1 место в год').basis, 'place');
  assert.equal(parseMeasure('0,319 м3/1 м2 общей площади в год').basis, 'sqm');
  assert.equal(parseMeasure('0,012 м3/1 метр общей площади в год').basis, 'sqm');
  assert.equal(parseMeasure('2,360 м3/1 участник (член) в год').basis, 'person',
    'участник товарищества — человек, а не земельный участок');
});

test('шапка и прочерк за значение не принимаются', () => {
  // Иначе шапка «куб.м на 1 кв. метр в год» была бы прочитана как значение 1.
  assert.equal(parseMeasure('куб.м на 1 кв. метр в год'), null);
  assert.equal(parseMeasure('кг в год'), null);
  assert.equal(parseMeasure('-'), null);
  assert.equal(parseMeasure(''), null);
  assert.equal(parseMeasure('Норматив накопления твердых коммунальных отходов'), null);
  assert.equal(parseMeasure('0,08457').value, 0.08457, 'чистое число остаётся значением');
});
