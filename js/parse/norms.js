// Разбор файла «Нормативы накопления ТКО»: .docx (приказ) или .xlsx.

import { normalize, parseNumber } from '../lib/text.js';
import { unitBasis, massFactor, volumeFactor, isMassHeader, isVolumeHeader } from '../lib/units.js';

const META_ROW = /список изменяющих|действие изменений|в ред\.|утративш/i;

/**
 * Извлекает нормативы из прямоугольной сетки текстовых ячеек.
 * @param {string[][]} grid строки таблицы
 * @param {{title?: string, source?: string}} context подпись таблицы
 * @returns {{entries: Array, headerInfo: object}|null}
 */
export function extractFromGrid(grid, context = {}) {
  const rows = grid.filter((row) => row.some((cell) => String(cell || '').trim()));
  if (rows.length < 2) return null;

  const firstDataRow = rows.findIndex(
    (row, index) => index > 0 && row.some((cell) => parseNumber(cell) !== null),
  );
  if (firstDataRow < 1) return null;

  const width = Math.max(...rows.map((row) => row.length));
  const headerRows = rows.slice(0, firstDataRow);
  const headers = [];
  for (let col = 0; col < width; col += 1) {
    const parts = [];
    for (const row of headerRows) {
      const text = String(row[col] || '').trim();
      if (text && !parts.includes(text)) parts.push(text);
    }
    headers.push(parts.join(' '));
  }

  const nameCol = headers.findIndex((h) => /наименование|категор/i.test(h));
  const unitCol = headers.findIndex((h) => /расчетн[а-я]*\s+единиц|единиц[а-я]*\s+измерени/i.test(normalize(h)));
  const massCol = headers.findIndex((h, i) => i !== nameCol && isMassHeader(h));
  const volumeCol = headers.findIndex((h, i) => i !== nameCol && isVolumeHeader(h));
  if (nameCol < 0 || (massCol < 0 && volumeCol < 0)) return null;

  const toMass = massCol >= 0 ? massFactor(headers[massCol]) ?? 1 : null;
  const toVolume = volumeCol >= 0 ? volumeFactor(headers[volumeCol]) ?? 1 : null;
  const headerBasis =
    unitBasis(headers[massCol] || '') !== 'other' ? unitBasis(headers[massCol] || '') : null;
  const fallbackBasis =
    headerBasis || unitBasis(headers[volumeCol] || '') || unitBasis(context.title || '');

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
    },
  };
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
  if (!entries.length) {
    throw new Error('В файле нормативов не найдено ни одной таблицы с категориями и значениями');
  }
  return { fileName, entries, tables: parsedTables, skipped };
}

/** Точка входа: определяет формат по расширению. */
export async function parseNorms(file, arrayBuffer, libs) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.docx')) return parseNormsDocx(arrayBuffer, file.name, libs.JSZip);
  if (/\.(xlsx|xlsm|xls|ods)$/.test(name)) return parseNormsXlsx(arrayBuffer, file.name, libs.XLSX);
  throw new Error(`Неподдерживаемый формат файла нормативов: ${file.name}`);
}
