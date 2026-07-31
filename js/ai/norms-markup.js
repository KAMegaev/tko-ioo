// Помощник разметки таблиц нормативов.
//
// Модель указывает, где лежат значения; числа она не видит и не считает.
// Любой её ответ проверяется по настоящему файлу и только после этого
// предлагается пользователю — применяет разметку человек.

import { applyLayouts, significantRows, headerTexts } from '../parse/norms.js';
import { massFactor, volumeFactor } from '../lib/units.js';

export const SAMPLE_LIMITS = { tables: 12, rows: 6, columns: 12, cell: 200 };

const BASIS_VALUES = new Set(['person', 'sqm', 'place', 'other']);

/**
 * Готовит образец таблиц для отправки: подписи и первые строки.
 * Данные реестра сюда не попадают — в этой задаче он не участвует.
 */
export function buildSample(norms) {
  return (norms.rawTables || [])
    .filter((table) => significantRows(table.grid).length > 1)
    .slice(0, SAMPLE_LIMITS.tables)
    .map((table) => ({
      index: table.index,
      title: String(table.title || '').slice(0, SAMPLE_LIMITS.cell),
      rows: significantRows(table.grid)
        .slice(0, SAMPLE_LIMITS.rows)
        .map((row) => row.slice(0, SAMPLE_LIMITS.columns)
          .map((cell) => String(cell ?? '').slice(0, SAMPLE_LIMITS.cell))),
    }));
}

/** Человекочитаемый вид того, что уходит из браузера. */
export function describeSample(sample) {
  return sample.map((table) => {
    const lines = [`Таблица ${table.index}${table.title ? ` — подпись: «${table.title}»` : ''}`];
    table.rows.forEach((row, rowIndex) => {
      lines.push(`  строка ${rowIndex}: ${row.map((cell, col) => `[${col}] ${cell || '—'}`).join(' | ')}`);
    });
    return lines.join('\n');
  }).join('\n\n');
}

const int = (value) => (Number.isFinite(value) ? Math.trunc(value) : NaN);

/** Проверяет разметку одной таблицы и переводит её в вид, понятный разбору. */
function checkTable(norms, item, problems) {
  const where = `таблица № ${item && item.tableIndex}`;
  const table = (norms.rawTables || []).find((raw) => raw.index === int(item.tableIndex));
  if (!table) {
    problems.push(`В файле нет таблицы № ${item.tableIndex}`);
    return null;
  }

  const rows = significantRows(table.grid);
  const width = Math.max(0, ...rows.map((row) => row.length));
  const headerRowCount = int(item.headerRowCount);
  const nameColumn = int(item.nameColumn);
  const massColumn = int(item.massColumn);
  const volumeColumn = int(item.volumeColumn);
  const unitColumn = int(item.unitColumn);
  const before = problems.length;

  if (!(headerRowCount >= 1) || headerRowCount >= rows.length) {
    problems.push(`${where}: шапка из ${item.headerRowCount} строк не помещается в таблицу из ${rows.length} строк`);
  }
  const inRange = (value) => value >= 0 && value < width;
  if (!inRange(nameColumn)) problems.push(`${where}: столбца наименований № ${item.nameColumn} нет`);
  if (massColumn !== -1 && !inRange(massColumn)) problems.push(`${where}: столбца массы № ${item.massColumn} нет`);
  if (volumeColumn !== -1 && !inRange(volumeColumn)) problems.push(`${where}: столбца объёма № ${item.volumeColumn} нет`);
  if (massColumn === -1 && volumeColumn === -1) problems.push(`${where}: не указан ни столбец массы, ни столбец объёма`);
  if (massColumn !== -1 && massColumn === nameColumn) problems.push(`${where}: столбец массы совпадает со столбцом наименований`);
  if (volumeColumn !== -1 && volumeColumn === nameColumn) problems.push(`${where}: столбец объёма совпадает со столбцом наименований`);
  if (massColumn !== -1 && massColumn === volumeColumn) problems.push(`${where}: столбцы массы и объёма совпадают`);
  if (problems.length > before) return null;

  // Размерности. Шапка самого файла главнее того, что назвал помощник:
  // подмена «кг» на «т» завысила бы массу в тысячу раз.
  const headers = headerTexts(rows, headerRowCount);
  const units = (label, column, claimedText, factorOf) => {
    if (column === -1) return null;
    const fromFile = factorOf(headers[column]);
    const claimed = factorOf(claimedText);
    if (fromFile === null && claimed === null) {
      problems.push(`${where}: единица ${label} «${claimedText}» неизвестна — пересчёт невозможен`);
      return null;
    }
    if (fromFile !== null && claimed !== null && fromFile !== claimed) {
      problems.push(`${where}: помощник считает единицей ${label} «${claimedText}», `
        + `а в шапке файла указано «${headers[column]}» — расхождение в ${Math.max(fromFile, claimed) / Math.min(fromFile, claimed)} раз`);
      return null;
    }
    return fromFile ?? claimed;
  };
  const toMass = units('массы', massColumn, item.massUnit, massFactor);
  const toVolume = units('объёма', volumeColumn, item.volumeUnit, volumeFactor);
  if (problems.length > before) return null;

  return {
    tableIndex: table.index,
    title: table.title,
    massUnit: item.massUnit,
    volumeUnit: item.volumeUnit,
    layout: {
      headerRowCount,
      nameColumn,
      unitColumn: inRange(unitColumn) ? unitColumn : -1,
      massColumn,
      volumeColumn,
      massFactor: toMass,
      volumeFactor: toVolume,
      basis: BASIS_VALUES.has(item.basis) ? item.basis : null,
    },
  };
}

/**
 * Проверяет ответ помощника по настоящему файлу.
 * @returns {{ok: boolean, problems: string[], markup?: object, preview?: object, summary?: object}}
 */
export function validateMarkup(norms, answer) {
  if (!answer || typeof answer !== 'object') {
    return { ok: false, problems: ['Пустой ответ помощника'] };
  }
  const list = Array.isArray(answer.tables) ? answer.tables : [];
  if (!list.length) {
    return { ok: false, problems: [answer.reason || 'Помощник не нашёл таблиц с нормативами'] };
  }

  const problems = [];
  const checked = list.map((item) => checkTable(norms, item, problems)).filter(Boolean);
  if (problems.length) return { ok: false, problems };

  const seen = new Set();
  for (const item of checked) {
    if (seen.has(item.tableIndex)) problems.push(`Таблица № ${item.tableIndex} указана дважды`);
    seen.add(item.tableIndex);
  }
  if (problems.length) return { ok: false, problems };

  const markup = {
    tables: checked.map((item) => ({ tableIndex: item.tableIndex, layout: item.layout })),
    source: 'помощник',
  };

  let preview;
  try {
    preview = applyLayouts(norms, markup);
  } catch (error) {
    return { ok: false, problems: [error.message] };
  }

  // Значения должны читаться как числа, иначе разметка указывает не на те столбцы.
  const withMass = preview.entries.filter((entry) => Number.isFinite(entry.mass)).length;
  const withVolume = preview.entries.filter((entry) => Number.isFinite(entry.volume)).length;
  const wantsMass = checked.some((item) => item.layout.massColumn !== -1);
  const wantsVolume = checked.some((item) => item.layout.volumeColumn !== -1);
  if (wantsMass && !withMass) problems.push('В указанных столбцах массы нет ни одного числа');
  if (wantsVolume && !withVolume) problems.push('В указанных столбцах объёма нет ни одного числа');
  if (preview.entries.length < 2) problems.push('По этой разметке нашлась только одна строка — похоже на ошибку');
  if (problems.length) return { ok: false, problems };

  return {
    ok: true,
    problems: [],
    markup,
    preview,
    summary: {
      tables: checked.map((item) => ({
        title: item.title || `таблица ${item.tableIndex}`,
        index: item.tableIndex,
        massUnit: item.massUnit,
        volumeUnit: item.volumeUnit,
        massFactor: item.layout.massFactor,
        volumeFactor: item.layout.volumeFactor,
        basis: item.layout.basis,
        count: preview.tables.find((table) => table.index === item.tableIndex)?.count ?? 0,
      })),
      count: preview.entries.length,
      withMass,
      withVolume,
      confidence: Number.isFinite(answer.confidence) ? answer.confidence : null,
      reason: String(answer.reason || ''),
    },
  };
}

/** Чем предложение отличается от нынешнего разбора. */
export function compare(current, preview) {
  const before = new Set(current.entries.map((entry) => entry.name));
  const after = new Set(preview.entries.map((entry) => entry.name));
  return {
    added: [...after].filter((name) => !before.has(name)),
    removed: [...before].filter((name) => !after.has(name)),
    countBefore: current.entries.length,
    countAfter: preview.entries.length,
  };
}
