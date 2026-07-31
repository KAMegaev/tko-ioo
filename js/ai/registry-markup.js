// Помощник разметки выгрузки реестра ИОО.
//
// Модель указывает, где лежат категория, количество единиц, зона и МО.
// Сами данные — сотни тысяч строк — не отправляются: только первые строки
// каждого листа. Ответ проверяется повторным разбором настоящего файла.

import { parseRegistryWorkbook } from '../parse/registry.js';
import { parseNumber } from '../lib/text.js';

export const SAMPLE_LIMITS = { rows: 6, columns: 14, cell: 120 };

const ROLES = ['category', 'units', 'zone', 'municipality', 'unitName'];

const ROLE_LABELS = {
  category: 'категория потребителя',
  units: 'количество расчётных единиц',
  zone: 'зона деятельности',
  municipality: 'муниципальное образование',
  unitName: 'единица измерения',
};

/** Человекочитаемый вид того, что уходит из браузера. */
export function describeSample(sample) {
  return sample.map((sheet) => {
    const lines = [`Лист ${sheet.index}${sheet.title ? ` — название: «${sheet.title}»` : ''}`];
    sheet.rows.forEach((row, rowIndex) => {
      lines.push(`  строка ${rowIndex}: ${row.map((cell, col) => `[${col}] ${cell || '—'}`).join(' | ')}`);
    });
    return lines.join('\n');
  }).join('\n\n');
}

const int = (value) => (Number.isFinite(value) ? Math.trunc(value) : NaN);

/**
 * Проверяет ответ помощника, заново разбирая файл по предложенной разметке.
 *
 * @param {ArrayBuffer} arrayBuffer исходный файл
 * @param {object} sample образец, отправленный помощнику
 * @param {object} answer ответ помощника
 * @param {object} XLSXLib
 */
export function validateMarkup(arrayBuffer, sample, answer, fileName, XLSXLib) {
  const problems = [];
  if (!answer || typeof answer !== 'object') {
    return { ok: false, problems: ['Пустой ответ помощника'] };
  }

  const sheet = int(answer.sheet);
  if (sheet === -1) {
    return { ok: false, problems: [answer.reason || 'Помощник не нашёл лист с данными реестра'] };
  }
  const sampleSheet = sample.find((item) => item.index === sheet);
  if (!sampleSheet) return { ok: false, problems: [`В книге нет листа № ${answer.sheet}`] };

  const width = Math.max(0, ...sampleSheet.rows.map((row) => row.length));
  const headerRow = int(answer.headerRow);
  if (!(headerRow >= 0) || headerRow >= sampleSheet.rows.length) {
    problems.push(`Строки заголовка № ${answer.headerRow} на листе нет`);
  }

  const columns = {};
  for (const role of ROLES) {
    const value = int(answer[role]);
    if (value === -1 || Number.isNaN(value)) continue;
    if (value < 0 || value >= width) {
      problems.push(`Столбца № ${answer[role]} (${ROLE_LABELS[role]}) на листе нет`);
      continue;
    }
    columns[role] = value;
  }
  if (columns.category === undefined) problems.push('Не указан столбец категории потребителя');

  const used = Object.entries(columns);
  for (const [role, column] of used) {
    const twin = used.find(([other, value]) => other !== role && value === column);
    if (twin) problems.push(`Столбец № ${column} назначен и как ${ROLE_LABELS[role]}, и как ${ROLE_LABELS[twin[0]]}`);
  }
  if (problems.length) return { ok: false, problems: [...new Set(problems)] };

  const markup = { sheet, headerRow, columns, source: 'помощник' };
  let parsed;
  try {
    parsed = parseRegistryWorkbook(arrayBuffer, fileName, XLSXLib, markup);
  } catch (error) {
    return { ok: false, problems: [error.message] };
  }

  if (!parsed.rows.length) {
    return { ok: false, problems: ['По этой разметке в файле не нашлось ни одной строки с категорией'] };
  }

  // Категория должна быть текстом, а количество единиц — числом,
  // иначе разметка указывает не на те столбцы.
  const probe = parsed.rows.slice(0, 200);
  const numericCategories = probe.filter((row) => parseNumber(row.category) !== null).length;
  if (numericCategories > probe.length / 2) {
    problems.push('В столбце категории почти всюду числа — похоже, это не категории');
  }
  if (columns.units !== undefined) {
    const withUnits = probe.filter((row) => Number.isFinite(row.units) && row.units > 0).length;
    if (!withUnits) problems.push('В столбце количества расчётных единиц нет ни одного положительного числа');
  }
  if (problems.length) return { ok: false, problems };

  const distinct = (key) => new Set(parsed.rows.map((row) => row[key]).filter(Boolean)).size;
  return {
    ok: true,
    problems: [],
    markup,
    parsed,
    summary: {
      sheet: parsed.sheetName,
      rows: parsed.rows.length,
      hasUnits: parsed.hasUnits,
      categories: distinct('category'),
      zones: distinct('zone'),
      municipalities: distinct('municipality'),
      roles: Object.fromEntries(Object.entries(columns).map(([role, column]) => [ROLE_LABELS[role], column])),
      confidence: Number.isFinite(answer.confidence) ? answer.confidence : null,
      reason: String(answer.reason || ''),
    },
  };
}

export { ROLE_LABELS };
