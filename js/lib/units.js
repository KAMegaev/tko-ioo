// Распознавание расчётных единиц и размерностей нормативов.
// Границы слов (\b) в JS не работают с кириллицей, поэтому сравнение — пословное.

import { normalize } from './text.js';

function words(value) {
  return normalize(value).split(' ').filter(Boolean);
}

function hasWord(list, ...variants) {
  return list.some((word) => variants.includes(word));
}

function hasPrefix(list, ...prefixes) {
  return list.some((word) => prefixes.some((prefix) => word.startsWith(prefix)));
}

/** Тип расчётной единицы, к которой привязан норматив. */
export function unitBasis(value) {
  const list = words(value);
  if (!list.length) return null;
  if (hasPrefix(list, 'человек', 'чел', 'проживающ', 'жител', 'учащ', 'воспитанник', 'сотрудник',
    'работник', 'посадочн', 'койк', 'мест', 'участник', 'член', 'абонент', 'посетител')) {
    if (hasPrefix(list, 'койк') || (hasPrefix(list, 'мест') && !hasPrefix(list, 'человек', 'чел'))) {
      return 'place';
    }
    return 'person';
  }
  if (hasWord(list, 'м2', 'кв', 'квадратный', 'квадратных', 'квадратном')) return 'sqm';
  if (hasPrefix(list, 'квадратн') || (hasWord(list, 'кв') && hasPrefix(list, 'метр', 'м'))) return 'sqm';
  // «метр общей площади», «1 м общей площади» — площадь без слова «квадратный».
  if (hasPrefix(list, 'площад') && hasPrefix(list, 'метр', 'м2', 'м')) return 'sqm';
  if (hasPrefix(list, 'погонн')) return 'linear';
  if (hasWord(list, 'участок', 'участка', 'участке', 'участки', 'участков') || hasPrefix(list, 'надел')) {
    return 'plot';
  }
  return 'other';
}

export const BASIS_LABELS = {
  person: 'на 1 человека',
  place: 'на 1 место',
  sqm: 'на 1 м²',
  linear: 'на 1 пог. м',
  plot: 'на 1 участок',
  other: 'иная',
};

/** Множитель приведения массы к килограммам, либо null, если это не масса. */
export function massFactor(header) {
  const list = words(header);
  if (hasWord(list, 'кг') || hasPrefix(list, 'килограмм')) return 1;
  if (hasWord(list, 'т') || hasPrefix(list, 'тонн')) return 1000;
  if (hasWord(list, 'г') || hasPrefix(list, 'грамм')) return 0.001;
  return null;
}

/** Множитель приведения объёма к кубическим метрам, либо null, если это не объём. */
export function volumeFactor(header) {
  const raw = String(header ?? '').toLowerCase();
  if (/м\s*[3³]/.test(raw)) return 1;
  const list = words(header);
  if (hasWord(list, 'куб', 'м3', 'кубм') || hasPrefix(list, 'кубическ', 'кубометр')) return 1;
  if (hasWord(list, 'л') || hasPrefix(list, 'литр')) return 0.001;
  return null;
}

/** Признак столбца массы в шапке таблицы нормативов. */
export function isMassHeader(header) {
  return massFactor(header) !== null && volumeFactor(header) === null;
}

/** Признак столбца объёма в шапке таблицы нормативов. */
export function isVolumeHeader(header) {
  return volumeFactor(header) !== null;
}

/**
 * Разбирает ячейку вида «2,073 м3/1 проживающего человека в год»:
 * значение, размерность и расчётная единица указаны прямо в ней.
 *
 * Приказы разных регионов оформлены по-разному: в одних размерность вынесена
 * в шапку столбца, в других стоит в каждой ячейке и меняется от строки к строке.
 *
 * @returns {{value: number, kind: 'mass'|'volume'|null, factor: number|null,
 *            basis: string|null, unitText: string}|null}
 */
export function parseMeasure(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  // Число обязано стоять в начале ячейки: иначе шапка «куб.м на 1 кв. метр
  // в год» была бы прочитана как значение 1.
  const match = /^[\s("'«]*([+-]?\d[\d  ]*(?:[.,]\d+)?)/.exec(raw);
  if (!match) return null;
  const value = Number(match[1].replace(/[\s ]/g, '').replace(',', '.'));
  if (!Number.isFinite(value)) return null;

  const tail = raw.slice(match.index + match[0].length);
  // Размерность стоит до косой черты, расчётная единица — после неё.
  const [dimension = '', per = ''] = tail.split(/\s*(?:\/|\bна\s+1\b|\bза\s+1\b)\s*/, 2);
  const mass = massFactor(dimension);
  const volume = volumeFactor(dimension);

  let kind = null;
  let factor = null;
  if (volume !== null) {
    kind = 'volume';
    factor = volume;
  } else if (mass !== null) {
    kind = 'mass';
    factor = mass;
  }

  const basis = unitBasis(per || tail);
  return { value, kind, factor, basis: basis === 'other' ? null : basis, unitText: tail.trim() };
}
