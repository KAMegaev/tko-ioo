// Разбор файла «Нормативы накопления ТКО»: .docx (приказ) или .xlsx.

import { normalize, parseNumber } from '../lib/text.js';
import { unitBasis, massFactor, volumeFactor, isMassHeader, isVolumeHeader } from '../lib/units.js';

const META_ROW = /список изменяющих|действие изменений|в ред\.|утративш/i;

/** Непустые строки таблицы — с ними работают и разметка, и извлечение. */
export function significantRows(grid) {
  return grid.filter((row) => row.some((cell) => String(cell || '').trim()));
}

/** Склеивает многоярусную шапку в один заголовок на столбец. */
export function headerTexts(rows, headerRowCount) {
  const width = Math.max(0, ...rows.map((row) => row.length));
  const headers = [];
  for (let col = 0; col < width; col += 1) {
    const parts = [];
    for (const row of rows.slice(0, headerRowCount)) {
      const text = String(row[col] || '').trim();
      if (text && !parts.includes(text)) parts.push(text);
    }
    headers.push(parts.join(' '));
  }
  return headers;
}

/**
 * Извлекает нормативы по заданной разметке столбцов.
 * Разметку определяет либо эвристика, либо помощник — способ на результат не влияет.
 *
 * @param {string[][]} grid строки таблицы
 * @param {object} layout {headerRowCount, nameColumn, massColumn, volumeColumn, unitColumn,
 *                         massFactor, volumeFactor, basis}
 * @param {{title?: string}} context подпись таблицы
 */
export function extractWithLayout(grid, layout, context = {}) {
  const rows = significantRows(grid);
  const {
    headerRowCount, nameColumn, unitColumn = -1,
    massColumn = -1, volumeColumn = -1,
  } = layout;
  if (!(headerRowCount >= 0) || !(nameColumn >= 0)) return null;
  if (massColumn < 0 && volumeColumn < 0) return null;
  if (rows.length <= headerRowCount) return null;

  const headers = headerTexts(rows, headerRowCount);
  const toMass = massColumn >= 0 ? layout.massFactor ?? massFactor(headers[massColumn]) ?? 1 : null;
  const toVolume =
    volumeColumn >= 0 ? layout.volumeFactor ?? volumeFactor(headers[volumeColumn]) ?? 1 : null;
  const fallbackBasis =
    layout.basis
    || (unitBasis(headers[massColumn] || '') !== 'other' ? unitBasis(headers[massColumn] || '') : null)
    || unitBasis(headers[volumeColumn] || '')
    || unitBasis(context.title || '');

  const nameCol = nameColumn;
  const unitCol = unitColumn;
  const massCol = massColumn;
  const volumeCol = volumeColumn;
  const firstDataRow = headerRowCount;
  const entries = [];
  for (const row of rows.slice(firstDataRow)) {
    const name = String(row[nameCol] || '').trim().replace(/\s+/g, ' ');
    if (!name || META_ROW.test(name)) continue;
    const mass = massCol >= 0 ? parseNumber(row[massCol]) : null;
    const volume = volumeCol >= 0 ? parseNumber(row[volumeCol]) : null;
    if (mass === null && volume === null) continue;
    const unitText = unitCol >= 0 ? String(row[unitCol] || '').trim() : '';
    entries.push({
      name,
      basis: (unitText && unitBasis(unitText)) || fallbackBasis || 'other',
      unitText: unitText || headers[massCol] || headers[volumeCol] || '',
      mass: mass === null ? null : mass * toMass,
      volume: volume === null ? null : volume * toVolume,
      rawMass: mass,
      rawVolume: volume,
      massUnit: massCol >= 0 ? headers[massCol] : '',
      volumeUnit: volumeCol >= 0 ? headers[volumeCol] : '',
      table: context.title || '',
    });
  }
  if (!entries.length) return null;
  return {
    entries,
    headerInfo: {
      title: context.title || '',
      nameHeader: headers[nameCol],
      massHeader: massCol >= 0 ? headers[massCol] : null,
      volumeHeader: volumeCol >= 0 ? headers[volumeCol] : null,
      massFactor: toMass,
      volumeFactor: toVolume,
      layout: {
        headerRowCount: firstDataRow,
        nameColumn: nameCol,
        unitColumn: unitCol,
        massColumn: massCol,
        volumeColumn: volumeCol,
      },
    },
  };
}

/**
 * Подбирает разметку таблицы по её шапке.
 * @returns {object|null} разметка либо null, если таблица не похожа на нормативы
 */
export function detectLayout(grid) {
  const rows = significantRows(grid);
  if (rows.length < 2) return null;

  // Шапка кончается там, где встретилась первая строка с числом.
  const firstDataRow = rows.findIndex(
    (row, index) => index > 0 && row.some((cell) => parseNumber(cell) !== null),
  );
  if (firstDataRow < 1) return null;

  const headers = headerTexts(rows, firstDataRow);
  const nameColumn = headers.findIndex((h) => /наименование|категор/i.test(h));
  const unitColumn = headers.findIndex(
    (h) => /расчетн[а-я]*\s+единиц|единиц[а-я]*\s+измерени/i.test(normalize(h)),
  );
  const massColumn = headers.findIndex((h, i) => i !== nameColumn && isMassHeader(h));
  const volumeColumn = headers.findIndex((h, i) => i !== nameColumn && isVolumeHeader(h));
  if (nameColumn < 0 || (massColumn < 0 && volumeColumn < 0)) return null;

  return { headerRowCount: firstDataRow, nameColumn, unitColumn, massColumn, volumeColumn };
}

/**
 * Извлекает нормативы из таблицы, определяя разметку самостоятельно.
 * @returns {{entries: Array, headerInfo: object}|null}
 */
export function extractFromGrid(grid, context = {}) {
  const layout = detectLayout(grid);
  if (!layout) return null;
  return extractWithLayout(grid, layout, context);
}

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

/** Дочерние элементы узла (без текстовых узлов), совместимо с любым DOM. */
function childElements(node, localName) {
  const result = [];
  const children = node.childNodes || [];
  for (let i = 0; i < children.length; i += 1) {
    const child = children[i];
    if (child.nodeType === 1 && (!localName || child.localName === localName)) result.push(child);
  }
  return result;
}

function wordText(node) {
  const nodes = node.getElementsByTagNameNS(W_NS, 't');
  const parts = [];
  for (let i = 0; i < nodes.length; i += 1) parts.push(nodes[i].textContent);
  return parts.join('').replace(/\s+/g, ' ').trim();
}

function attr(node, name) {
  return node ? node.getAttributeNS(W_NS, name) || node.getAttribute(`w:${name}`) : null;
}

/** Превращает <w:tbl> в прямоугольную сетку с учётом объединённых ячеек. */
function tableToGrid(table) {
  const grid = [];
  for (const tr of childElements(table, 'tr')) {
    const cells = [];
    for (const tc of childElements(tr, 'tc')) {
      const [props] = childElements(tc, 'tcPr');
      let span = 1;
      if (props) {
        const [gridSpan] = childElements(props, 'gridSpan');
        if (gridSpan) span = Number(attr(gridSpan, 'val')) || 1;
      }
      const text = wordText(tc);
      for (let i = 0; i < span; i += 1) cells.push(text);
    }
    grid.push(cells);
  }
  // Вертикально объединённые ячейки приходят пустыми — подставляем значение сверху.
  for (let r = 1; r < grid.length; r += 1) {
    for (let c = 0; c < grid[r].length; c += 1) {
      if (!grid[r][c] && grid[r - 1][c] && r < 3) grid[r][c] = grid[r - 1][c];
    }
  }
  return grid;
}

/** Разбирает .docx с приказом об утверждении нормативов. */
export async function parseNormsDocx(arrayBuffer, fileName, JSZipLib) {
  const zip = await JSZipLib.loadAsync(arrayBuffer);
  const file = zip.file('word/document.xml');
  if (!file) throw new Error('Не найден word/document.xml — файл не является .docx');
  const xml = await file.async('string');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const body = doc.getElementsByTagNameNS(W_NS, 'body')[0];
  if (!body) throw new Error('Повреждённая структура .docx');

  const tables = [];
  let caption = '';
  const captionParts = [];
  for (const child of childElements(body)) {
    if (child.localName === 'p') {
      const text = wordText(child);
      if (text) {
        captionParts.push(text);
        if (captionParts.length > 4) captionParts.shift();
        caption = captionParts.join(' ');
      }
    } else if (child.localName === 'tbl') {
      tables.push({ grid: tableToGrid(child), title: caption });
      captionParts.length = 0;
      caption = '';
    }
  }
  return collect(tables, fileName);
}

/** Разбирает нормативы, оформленные таблицей Excel. */
export function parseNormsXlsx(arrayBuffer, fileName, XLSXLib) {
  const workbook = XLSXLib.read(arrayBuffer, { type: 'array', cellDates: false });
  const tables = [];
  for (const sheetName of workbook.SheetNames) {
    const grid = XLSXLib.utils.sheet_to_json(workbook.Sheets[sheetName], {
      header: 1,
      raw: true,
      defval: '',
      blankrows: false,
    });
    tables.push({ grid: grid.map((row) => row.map((cell) => (cell === null ? '' : String(cell)))), title: sheetName });
  }
  return collect(tables, fileName);
}

function collect(tables, fileName) {
  const entries = [];
  const parsedTables = [];
  const skipped = [];
  tables.forEach((table, index) => {
    const result = extractFromGrid(table.grid, { title: table.title });
    if (!result) {
      if (table.grid.length > 1) skipped.push({ index, title: table.title, rows: table.grid.length });
      return;
    }
    parsedTables.push({ index, ...result.headerInfo, count: result.entries.length });
    for (const entry of result.entries) {
      entries.push({ ...entry, id: `n${entries.length}`, file: fileName });
    }
  });
  // Таблицы сохраняются целиком: если разметка не удалась, её можно задать
  // заново — вручную или с помощью помощника — не перечитывая файл.
  const rawTables = tables.map((table, index) => ({
    index, title: table.title, grid: table.grid,
  }));
  return { fileName, entries, tables: parsedTables, skipped, rawTables, source: 'эвристика' };
}

/**
 * Пересобирает нормативы по явно заданной разметке.
 *
 * Таблиц может быть несколько: в приказах жильё («на 1 человека») и прочие
 * категории («на 1 кв. м») обычно разнесены по разным приложениям.
 *
 * @param {object} norms результат parseNorms
 * @param {{tables: Array<{tableIndex: number, layout: object}>, source?: string}} markup
 * @returns {object} новый результат разбора (исходный не изменяется)
 */
export function applyLayouts(norms, markup) {
  const list = markup && Array.isArray(markup.tables) ? markup.tables : [];
  if (!list.length) throw new Error('Разметка не содержит ни одной таблицы');

  const entries = [];
  const parsedTables = [];
  const used = new Set();
  for (const item of list) {
    const table = norms.rawTables.find((raw) => raw.index === item.tableIndex);
    if (!table) throw new Error(`В файле нет таблицы № ${item.tableIndex}`);
    const result = extractWithLayout(table.grid, item.layout, { title: table.title });
    if (!result) throw new Error(`По разметке таблицы № ${item.tableIndex} не прочитан ни один норматив`);
    used.add(table.index);
    parsedTables.push({ index: table.index, ...result.headerInfo, count: result.entries.length });
    for (const entry of result.entries) {
      entries.push({ ...entry, id: `n${entries.length}`, file: norms.fileName });
    }
  }

  return {
    ...norms,
    entries,
    tables: parsedTables,
    skipped: norms.rawTables.filter((item) => !used.has(item.index))
      .map((item) => ({ index: item.index, title: item.title, rows: item.grid.length })),
    source: markup.source || 'разметка',
  };
}

/** Точка входа: определяет формат по расширению. */
export async function parseNorms(file, arrayBuffer, libs) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.docx')) return parseNormsDocx(arrayBuffer, file.name, libs.JSZip);
  if (/\.(xlsx|xlsm|xls|ods)$/.test(name)) return parseNormsXlsx(arrayBuffer, file.name, libs.XLSX);
  throw new Error(`Неподдерживаемый формат файла нормативов: ${file.name}`);
}
