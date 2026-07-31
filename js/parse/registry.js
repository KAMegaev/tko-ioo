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
    // Столбец с количеством расчётных единиц есть не в каждой выгрузке:
    // достаточно категории и ещё одного опознанного столбца.
    const recognized = Object.keys(map).filter((key) => key !== 'category').length;
    if (map.category !== undefined && recognized > 0 && (!best || score > best.score)) {
      best = { headerRow: rowIndex, columns: map, score };
    }
  }
  return best;
}

/**
 * Образец книги для разметки: названия листов и первые строки каждого.
 * Уходит помощнику вместо самих данных — их в выгрузке сотни тысяч строк.
 */
export function buildRegistrySample(arrayBuffer, XLSXLib, { rows = 6, columns = 14, cell = 120 } = {}) {
  const workbook = XLSXLib.read(arrayBuffer, { type: 'array', sheetRows: rows + 2, cellDates: false });
  return workbook.SheetNames.map((title, index) => {
    const grid = XLSXLib.utils.sheet_to_json(workbook.Sheets[title], {
      header: 1, raw: true, defval: '', blankrows: false,
    });
    return {
      index,
      title,
      rows: grid.slice(0, rows).map((row) => row.slice(0, columns)
        .map((value) => String(value ?? '').slice(0, cell))),
    };
  });
}

/**
 * Читает один файл реестра.
 * @param {object} [markup] явная разметка {sheet, headerRow, columns} — от помощника
 *                          или заданная вручную; без неё разметка подбирается сама.
 */
export function parseRegistryWorkbook(arrayBuffer, fileName, XLSXLib, markup = null) {
  const workbook = XLSXLib.read(arrayBuffer, { type: 'array', dense: true, cellDates: false });
  const warnings = [];
  let picked = null;

  if (markup) {
    const sheetName = workbook.SheetNames[markup.sheet];
    if (!sheetName) throw new Error(`В книге нет листа № ${markup.sheet}`);
    const grid = XLSXLib.utils.sheet_to_json(workbook.Sheets[sheetName], {
      header: 1, raw: true, defval: null,
    });
    picked = { sheetName, grid, headerRow: markup.headerRow, columns: markup.columns, source: markup.source || 'разметка' };
  } else {
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const grid = XLSXLib.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null });
      const detected = detectColumns(grid);
      if (detected && (!picked || grid.length > picked.grid.length)) {
        picked = { sheetName, grid, ...detected, source: 'эвристика' };
      }
    }
  }
  if (!picked) {
    throw new Error(
      `В файле «${fileName}» не найден столбец «Категория потребителя». `
      + 'Укажите разметку вручную или воспользуйтесь помощником.',
    );
  }

  const { columns, headerRow, grid } = picked;
  const hasUnits = columns.units !== undefined;
  const rows = [];
  for (let i = headerRow + 1; i < grid.length; i += 1) {
    const row = grid[i] || [];
    const category = String(row[columns.category] ?? '').trim().replace(/\s+/g, ' ');
    if (!category) continue;
    const raw = hasUnits ? row[columns.units] : null;
    const units = hasUnits ? parseNumber(raw) : null;
    if (hasUnits && units === null && raw !== null && raw !== undefined && String(raw).trim() !== '') {
      warnings.push(`Строка ${i + 1}: не удалось разобрать количество «${raw}»`);
    }
    rows.push({
      excelRow: i + 1,
      category,
      units: hasUnits ? (units ?? 0) : null,
      unitsMissing: hasUnits && units === null,
      zone: columns.zone === undefined ? '' : String(row[columns.zone] ?? '').trim(),
      municipality:
        columns.municipality === undefined ? '' : String(row[columns.municipality] ?? '').trim(),
      unitName: columns.unitName === undefined ? '' : String(row[columns.unitName] ?? '').trim(),
    });
  }

  return {
    fileName,
    sheetName: picked.sheetName,
    sheetIndex: workbook.SheetNames.indexOf(picked.sheetName),
    headerRow: headerRow + 1,
    columns,
    hasUnits,
    source: picked.source,
    rows,
    warnings: warnings.slice(0, 50),
    warningsTotal: warnings.length,
  };
}

/**
 * Сводит строки нескольких файлов реестра в группы.
 *
 * Группировка ведётся по зоне, муниципальному образованию и категории.
 * Учитывать ли МО, решает форма общих сведений: если в ней столбец МО пуст,
 * группы схлопываются по зоне и категории на этапе расчёта.
 */
export function aggregateRegistry(files) {
  const groups = new Map();
  const categories = new Map();
  const zones = new Map();
  const municipalities = new Map();
  let totalRows = 0;
  let zeroRows = 0;
  let rowsWithoutUnits = 0;

  for (const file of files) {
    for (const row of file.rows) {
      totalRows += 1;
      const zoneKey = normalize(row.zone);
      const categoryKey = normalize(row.category);
      const municipalityKey = normalize(row.municipality);
      const key = `${zoneKey}||${municipalityKey}||${categoryKey}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          key,
          zone: row.zone,
          category: row.category,
          municipality: row.municipality,
          zoneKey,
          categoryKey,
          municipalityKey,
          sources: 0,
          sourcesWithZero: 0,
          units: 0,
          unitsKnown: true,
          rows: 0,
          files: new Set(),
        };
        groups.set(key, group);
      }
      group.rows += 1;
      group.files.add(file.fileName);

      if (row.units === null) {
        // Количество расчётных единиц в выгрузке отсутствует: строка считается
        // источником, но вклад в сумму единиц неизвестен.
        rowsWithoutUnits += 1;
        group.unitsKnown = false;
        group.sources += 1;
      } else {
        group.units += row.units;
        if (row.units === 0) {
          group.sourcesWithZero += 1;
          zeroRows += 1;
        } else {
          group.sources += 1;
        }
      }

      if (!categories.has(categoryKey)) {
        categories.set(categoryKey, {
          name: row.category, key: categoryKey, rows: 0, units: 0, unitsKnown: true, zones: new Set(),
        });
      }
      const category = categories.get(categoryKey);
      category.rows += 1;
      if (row.units === null) category.unitsKnown = false;
      else category.units += row.units;
      category.zones.add(row.zone);

      if (!zones.has(zoneKey)) zones.set(zoneKey, { name: row.zone, key: zoneKey, rows: 0 });
      zones.get(zoneKey).rows += 1;

      if (municipalityKey) {
        if (!municipalities.has(municipalityKey)) {
          municipalities.set(municipalityKey, { name: row.municipality, key: municipalityKey, rows: 0 });
        }
        municipalities.get(municipalityKey).rows += 1;
      }
    }
  }

  return {
    groups,
    categories: [...categories.values()].sort((a, b) => b.rows - a.rows),
    zones: [...zones.values()].sort((a, b) => b.rows - a.rows),
    municipalities: [...municipalities.values()].sort((a, b) => b.rows - a.rows),
    totalRows,
    zeroRows,
    rowsWithoutUnits,
    hasUnits: files.every((file) => file.hasUnits !== false),
    files: files.map((f) => ({
      fileName: f.fileName,
      sheetName: f.sheetName,
      rows: f.rows.length,
      hasUnits: f.hasUnits !== false,
      warningsTotal: f.warningsTotal,
    })),
  };
}
