// Нормализация и нечёткое сравнение русскоязычных наименований категорий.

const STOPWORDS = new Set([
  'и', 'или', 'в', 'во', 'на', 'по', 'с', 'со', 'для', 'из', 'от', 'до', 'при',
  'а', 'также', 'том', 'числе', 'за', 'исключением', 'др', 'пр', 'прочие',
  'прочих', 'прочее', 'т', 'ч', 'иное', 'иные', 'то', 'ли', 'не',
]);

// Окончания снимаются от длинных к коротким; основа не короче 4 символов.
const ENDINGS = [
  'ическими', 'ическому', 'ическими', 'ическая', 'ические', 'ическую',
  'ованные', 'ующими', 'ующего', 'ающими', 'ающего',
  'иями', 'ями', 'ами', 'ией', 'ями', 'ыми', 'ими', 'его', 'ого', 'ему', 'ому',
  'ей', 'ой', 'ый', 'ий', 'ая', 'яя', 'ое', 'ее', 'ые', 'ие', 'ов', 'ев', 'ах',
  'ях', 'ам', 'ям', 'ом', 'ем', 'ух', 'юю', 'ую',
  'а', 'я', 'ы', 'и', 'у', 'ю', 'е', 'о', 'ь', 'й',
];

const MIN_STEM = 4;

/** Приводит строку к сравнимому виду: нижний регистр, ё→е, только буквы и цифры. */
export function normalize(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^0-9a-zа-я]+/gi, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Грубая основа слова: снимает типовые русские окончания. */
export function stem(word) {
  for (const ending of ENDINGS) {
    if (word.length - ending.length >= MIN_STEM && word.endsWith(ending)) {
      return word.slice(0, word.length - ending.length);
    }
  }
  return word;
}

/** Значимые основы слов наименования (без стоп-слов и односимвольного мусора). */
export function tokens(value) {
  return normalize(value)
    .split(' ')
    .filter((word) => word.length > 1 && !STOPWORDS.has(word))
    .map(stem);
}

/** Расстояние Левенштейна. */
export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;
  const curr = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = curr.slice();
  }
  return prev[b.length];
}

/** Похожесть строк 0..1 на базе расстояния Левенштейна. */
export function levenshteinRatio(a, b) {
  const longest = Math.max(a.length, b.length);
  if (!longest) return 1;
  return 1 - levenshtein(a, b) / longest;
}

/** Похожесть двух основ: длина общего префикса либо Левенштейн — что больше. */
function tokenSimilarity(a, b) {
  if (a === b) return 1;
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  const prefixRatio = prefix >= 3 ? prefix / Math.max(a.length, b.length) : 0;
  return Math.max(prefixRatio, levenshteinRatio(a, b));
}

/** Мягкий коэффициент Дайса: каждой основе ищется лучшая пара в другом наборе. */
export function softTokenSimilarity(tokensA, tokensB) {
  if (!tokensA.length || !tokensB.length) return 0;
  const best = (from, to) =>
    from.reduce((sum, t) => sum + Math.max(...to.map((o) => tokenSimilarity(t, o))), 0) / from.length;
  return (best(tokensA, tokensB) + best(tokensB, tokensA)) / 2;
}

/**
 * Итоговая похожесть наименований 0..1.
 * Полное совпадение нормализованных строк даёт ровно 1.
 */
export function similarity(a, b) {
  const normA = normalize(a);
  const normB = normalize(b);
  if (!normA || !normB) return 0;
  if (normA === normB) return 1;
  const soft = softTokenSimilarity(tokens(a), tokens(b));
  const lev = levenshteinRatio(normA, normB);
  return Math.max(soft * 0.85 + lev * 0.15, lev);
}

const NUMBER_RE = /^[+-]?(\d+([.]\d*)?|[.]\d+)([eE][+-]?\d+)?$/;

/**
 * Разбирает число из ячейки: поддерживает десятичную запятую, пробелы-разделители
 * разрядов и сноски вида «0,123 <*>». Любой другой текст даёт null.
 */
export function parseNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value === null || value === undefined) return null;
  const cleaned = String(value)
    .replace(/<[^>]*>/g, '')
    .replace(/\*/g, '')
    .replace(/\s/g, '')
    .replace(',', '.');
  if (!cleaned || !NUMBER_RE.test(cleaned)) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}
