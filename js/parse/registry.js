// Разбор файлов «Выгрузка реестра ИОО».

import { normalize, parseNumber } from '../lib/text.js';

const COLUMN_PATTERNS = {
  category: /категор/,
  units: /количеств[а-я]*\s+расчетн|расчетн[а-я]*\s+единиц|кол во расчетн/,
  zone: /зона/,
  unitName: /единиц[а-я]*\s+измерен/,
  municipality: /муниципальн|городско|район/,
  source: /наименование источник|адрес|источник образован/,
};

/** Ищет строку заголовка и сопоставляет колонки по названиям. */
export function detectColumns(grid, maxScan = 25) {
  let best = null;
  const limit = Math.min(grid.length, maxScan);
  for (let rowIndex = 0; rowIndex < limit; rowIndex += 1) {
    const row = grid[rowIndex] || [];
    const map = {};
    let score = 0;
    row.forEach((cell, colIndex) => {
      const text = normalize(cell);
      if (!text) return;
      for (const [key, pattern] of Object.entries(COLUMN_PATTERNS)) {
        if (map[key] === undefined && pattern.test(text)) {
          map[key] = colIndex;
          score += key === 'category' || key === 'units' ? 2 : 1;
        }
      }
    });
    if (map.category !== undefined && map.units !== undefined && (!best || score > best.score)) {
      best = { headerRow: rowIndex, columns: map, score };
    }
  }
  return best;
}

/**
 * Читает один файл реестра.
 * @returns {{fileName, headerRow, columns, rows, sheetName, warnings}}
 */
export function parseRegistryWorkbook(arrayBuffer, fileName, XLSXLib) {
  const workbook = XLSXLib.read(arrayBuffer, { type: 'array', dense: true, cellDates: false });
  const warnings = [];
  let picked = null;

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const grid = XLSXLib.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null });
    const detected = detectColumns(grid);
    if (detected && (!picked || grid.length > picked.grid.length)) {
      picked = { sheetName, grid, ...detected };
    }
  }
  if (!picked) {
    throw new Error(
      `В файле «${fileName}» не найдены колонки «Категория потребителя» и «Количество расчетных единиц»`,
    );
  }

  const { columns, headerRow, grid } = picked;
  const rows = [];
  for (let i = headerRow + 1; i < grid.length; i += 1) {
    const row = grid[i] || [];
    const category = String(row[columns.category] ?? '').trim().replace(/\s+/g, ' ');
    if (!category) continue;
    const units = parseNumber(row[columns.units]);
    if (units === null && row[columns.units] !== null && row[columns.units] !== undefined
        && String(row[columns.units]).trim() !== '') {
      warnings.push(`Строка ${i + 1}: не удалось разобрать количество «${row[columns.units]}»`);
    }
    rows.push({
      excelRow: i + 1,
      category,
      units: units === null ? 0 : units,
      unitsMissing: units === null,
      zone: columns.zone === undefined ? '' : String(row[columns.zone] ?? '').trim(),
      municipality:
        columns.municipality === undefined ? '' : String(row[columns.municipality] ?? '').trim(),
      unitName: columns.unitName === undefined ? '' : String(row[columns.unitName] ?? '').trim(),
    });
  }

  return {
    fileName,
    sheetName: picked.sheetName,
    headerRow: headerRow + 1,
    columns,
    rows,
    warnings: warnings.slice(0, 50),
    warningsTotal: warnings.length,
  };
}

/** Сводит строки нескольких файлов реестра в группы «зона + категория». */
export function aggregateRegistry(files) {
  const groups = new Map();
  const categories = new Map();
  const zones = new Map();
  let totalRows = 0;
  let zeroRows = 0;

  for (const file of files) {
    for (const row of file.rows) {
      totalRows += 1;
      const zoneKey = normalize(row.zone);
      const categoryKey = normalize(row.category);
      const key = `${zoneKey}||${categoryKey}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          key,
          zone: row.zone,
          category: row.category,
          zoneKey,
          categoryKey,
          sources: 0,
          sourcesWithZero: 0,
          units: 0,
          rows: 0,
          files: new Set(),
        };
        groups.set(key, group);
      }
      group.rows += 1;
      group.units += row.units;
      group.files.add(file.fileName);
      if (row.units === 0) {
        group.sourcesWithZero += 1;
        zeroRows += 1;
      } else {
        group.sources += 1;
      }

      if (!categories.has(categoryKey)) {
        categories.set(categoryKey, { name: row.category, key: categoryKey, rows: 0, units: 0, zones: new Set() });
      }
      const category = categories.get(categoryKey);
      category.rows += 1;
      category.units += row.units;
      category.zones.add(row.zone);

      if (!zones.has(zoneKey)) zones.set(zoneKey, { name: row.zone, key: zoneKey, rows: 0 });
      zones.get(zoneKey).rows += 1;
    }
  }

  return {
    groups,
    categories: [...categories.values()].sort((a, b) => b.rows - a.rows),
    zones: [...zones.values()].sort((a, b) => b.rows - a.rows),
    totalRows,
    zeroRows,
    files: files.map((f) => ({
      fileName: f.fileName,
      sheetName: f.sheetName,
      rows: f.rows.length,
      warningsTotal: f.warningsTotal,
    })),
  };
}
