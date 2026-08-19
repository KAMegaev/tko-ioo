// Разбор файла «Нормативы накопления ТКО»: .docx (приказ), .xlsx или .pdf.

import { normalize, parseNumber } from '../lib/text.js';
import { readPdfTables } from './pdf.js';
import {
  unitBasis, massFactor, volumeFactor, isMassHeader, isVolumeHeader, parseMeasure,
} from '../lib/units.js';

// Строки-примечания и отсылки к изменяющим документам данными не являются.
const META_ROW = /список изменяющих|действие изменений|в ред\.|введен|введена|введено|утратил|исключен|дополнен|примечани|^\s*<?\*/i;

/** Строка, объединённая на всю ширину, — это заголовок раздела, а не данные. */
function isSpanningRow(row) {
  const cells = row.map((cell) => String(cell ?? '').trim()).filter(Boolean);
  return cells.length > 1 && new Set(cells).size === 1;
}

/** Строка вида «1 | 2 | 3 | 4» — нумерация столбцов, часть шапки. */
function isColumnNumberingRow(row) {
  const cells = row.map((cell) => String(cell ?? '').trim()).filter(Boolean);
  if (cells.length < 2) return false;
  return cells.every((cell, index) => /^\d{1,2}\.?$/.test(cell) && Number(cell.replace('.', '')) === index + 1);
}

/** Данные это или служебная строка таблицы. */
function isServiceRow(row, nameColumn = -1) {
  if (isSpanningRow(row) || isColumnNumberingRow(row)) return true;
  const name = nameColumn >= 0 ? String(row[nameColumn] ?? '').trim() : '';
  return Boolean(name) && META_ROW.test(name);
}

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
    if (isServiceRow(row, nameCol)) continue;
    const name = String(row[nameCol] || '').trim().replace(/\s+/g, ' ');
    if (!name) continue;

    // Размерность может стоять в самой ячейке («2,073 м3/1 человека в год»)
    // либо только в шапке — тогда берётся множитель столбца.
    const massCell = massCol >= 0 ? parseMeasure(row[massCol]) : null;
    const volumeCell = volumeCol >= 0 ? parseMeasure(row[volumeCol]) : null;
    if (!massCell && !volumeCell) continue;
    if (massCell && massCell.kind === 'volume') continue;
    if (volumeCell && volumeCell.kind === 'mass') continue;

    const mass = massCell ? massCell.value * (massCell.factor ?? toMass ?? 1) : null;
    const volume = volumeCell ? volumeCell.value * (volumeCell.factor ?? toVolume ?? 1) : null;

    const unitText = unitCol >= 0 ? String(row[unitCol] || '').trim() : '';
    const rowBasis =
      (unitText && unitBasis(unitText) !== 'other' ? unitBasis(unitText) : null)
      || (massCell && massCell.basis)
      || (volumeCell && volumeCell.basis)
      || fallbackBasis
      || 'other';

    entries.push({
      name,
      basis: rowBasis,
      unitText: unitText || (volumeCell && volumeCell.unitText) || (massCell && massCell.unitText)
        || headers[massCol] || headers[volumeCol] || '',
      mass,
      volume,
      rawMass: massCell ? massCell.value : null,
      rawVolume: volumeCell ? volumeCell.value : null,
      massUnit: (massCell && massCell.unitText) || (massCol >= 0 ? headers[massCol] : ''),
      volumeUnit: (volumeCell && volumeCell.unitText) || (volumeCol >= 0 ? headers[volumeCol] : ''),
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

/** Первая строка с данными: не служебная, с наименованием и хотя бы одним значением. */
function findFirstDataRow(rows) {
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (isSpanningRow(row) || isColumnNumberingRow(row)) continue;
    const cells = row.map((cell) => String(cell ?? '').trim());
    const hasMeasure = cells.some((cell) => parseMeasure(cell) !== null);
    const hasName = cells.some((cell) => /[а-яa-z]{4}/i.test(cell) && !META_ROW.test(cell));
    if (hasMeasure && hasName) return index;
  }
  return -1;
}

/**
 * Считает по каждому столбцу, что в нём лежит: значения (и каких размерностей)
 * или текст. Шапка бывает бесполезной — «показатели объема» без слова «куб.м», —
 * поэтому столбцы опознаются прежде всего по содержимому.
 */
function profileColumns(rows, firstDataRow) {
  const width = Math.max(0, ...rows.map((row) => row.length));
  const stats = Array.from({ length: width }, () => ({ mass: 0, volume: 0, plain: 0, text: 0 }));
  for (const row of rows.slice(firstDataRow)) {
    if (isSpanningRow(row) || isColumnNumberingRow(row)) continue;
    for (let col = 0; col < width; col += 1) {
      const cell = String(row[col] ?? '').trim();
      if (!cell) continue;
      const measure = parseMeasure(cell);
      if (measure) {
        if (measure.kind === 'mass') stats[col].mass += 1;
        else if (measure.kind === 'volume') stats[col].volume += 1;
        else stats[col].plain += 1;
      } else if (/[а-яa-z]{4}/i.test(cell)) {
        stats[col].text += 1;
      }
    }
  }
  return stats;
}

const NUMBERING_HEADER = /^\s*(n|№)\s*(п\/п)?\s*$/i;

/**
 * Подбирает разметку таблицы: сколько строк занимает шапка, где наименования,
 * где значения по массе и по объёму.
 * @returns {object|null} разметка либо null, если таблица не похожа на нормативы
 */
export function detectLayout(grid) {
  const rows = significantRows(grid);
  if (rows.length < 2) return null;

  const firstDataRow = findFirstDataRow(rows);
  if (firstDataRow < 1) return null;

  const headers = headerTexts(rows, firstDataRow);
  const stats = profileColumns(rows, firstDataRow);
  const width = stats.length;

  // Наименование: по заголовку, иначе — столбец с наибольшим числом текстовых ячеек.
  let nameColumn = headers.findIndex(
    (header) => !NUMBERING_HEADER.test(header) && /наименование|категор/i.test(header),
  );
  if (nameColumn < 0) {
    let best = -1;
    for (let col = 0; col < width; col += 1) {
      if (stats[col].text > 0 && (best < 0 || stats[col].text > stats[best].text)) best = col;
    }
    nameColumn = best;
  }
  if (nameColumn < 0) return null;

  const unitColumn = headers.findIndex(
    (header) => /расчетн[а-я]*\s+единиц|единиц[а-я]*\s+измерени/i.test(normalize(header)),
  );

  // 1. Размерность указана в самих ячейках.
  const pick = (kind) => {
    let best = -1;
    for (let col = 0; col < width; col += 1) {
      if (col === nameColumn || col === unitColumn) continue;
      if (stats[col][kind] > 0 && (best < 0 || stats[col][kind] > stats[best][kind])) best = col;
    }
    return best;
  };
  let massColumn = pick('mass');
  let volumeColumn = pick('volume');

  // 2. Иначе — размерность из шапки столбца.
  if (massColumn < 0) {
    massColumn = headers.findIndex(
      (header, col) => col !== nameColumn && col !== volumeColumn && stats[col].plain > 0 && isMassHeader(header),
    );
  }
  if (volumeColumn < 0) {
    volumeColumn = headers.findIndex(
      (header, col) => col !== nameColumn && col !== massColumn && stats[col].plain > 0 && isVolumeHeader(header),
    );
  }

  // 3. Иначе — по словам «масса» и «объём» в шапке.
  if (massColumn < 0) {
    massColumn = headers.findIndex(
      (header, col) => col !== nameColumn && col !== volumeColumn && stats[col].plain > 0 && /масс/i.test(header),
    );
  }
  if (volumeColumn < 0) {
    volumeColumn = headers.findIndex(
      (header, col) => col !== nameColumn && col !== massColumn && stats[col].plain > 0 && /объем|объём/i.test(header),
    );
  }

  if (massColumn < 0 && volumeColumn < 0) return null;
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

const hasNumbers = (row) => row.some((cell) => parseNumber(cell) !== null);
const isUnitHeaderRow = (row) => row
  .filter((cell) => isMassHeader(cell) || isVolumeHeader(cell)).length >= 2;

/**
 * Делит восстановленную из PDF таблицу там, где начинается следующая.
 *
 * В PDF две таблицы, стоящие вплотную и одинаково разграфлённые, неотличимы
 * от одной. Признак — повторная шапка с единицами измерения: приказы обычно
 * разносят жильё («кг в год») и прочие категории («кг на 1 кв. метр в год»)
 * по разным приложениям. Не разделив их, множитель массы из первой шапки
 * применился бы ко всем строкам — а это разница в тысячу раз.
 */
export function splitOnRepeatedHeader(grid) {
  const parts = [];
  let start = 0;
  for (let index = 1; index < grid.length; index += 1) {
    if (!isUnitHeaderRow(grid[index])) continue;
    // Шапка бывает многоярусной: захватываем идущие перед ней строки без чисел.
    let from = index;
    while (from > start + 1 && !hasNumbers(grid[from - 1])
      && grid[from - 1].some((cell) => String(cell).trim())) from -= 1;
    if (from <= start || !grid.slice(start, from).some(hasNumbers)) continue;
    parts.push(grid.slice(start, from));
    start = from;
  }
  parts.push(grid.slice(start));
  return parts.filter((part) => part.length > 1);
}

/**
 * Разбирает приказ, присланный в PDF.
 *
 * Таблицы в PDF нет: она восстанавливается по расположению текста на странице
 * (см. pdf-layout.js). Дальше всё как у остальных форматов.
 */
export async function parseNormsPdf(arrayBuffer, fileName, pdfjsLib = null) {
  const restored = await readPdfTables(arrayBuffer, pdfjsLib);
  const tables = restored.flatMap((table) => splitOnRepeatedHeader(table.grid)
    .map((grid, part) => ({ grid, title: part === 0 ? table.title : '' })));
  if (!tables.length) {
    throw new Error('В PDF не нашлось ни одной таблицы: текст есть, но он не разложен '
      + 'по столбцам. Возьмите приказ в .docx или .xlsx.');
  }
  return collect(tables, fileName);
}

/** Точка входа: определяет формат по расширению. */
export async function parseNorms(file, arrayBuffer, libs = {}) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.docx')) return parseNormsDocx(arrayBuffer, file.name, libs.JSZip);
  if (name.endsWith('.pdf')) return parseNormsPdf(arrayBuffer, file.name, libs.pdfjs);
  if (/\.(xlsx|xlsm|xls|ods)$/.test(name)) return parseNormsXlsx(arrayBuffer, file.name, libs.XLSX);
  throw new Error(`Неподдерживаемый формат файла нормативов: ${file.name}`);
}
