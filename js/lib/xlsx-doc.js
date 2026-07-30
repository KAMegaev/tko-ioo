// Минимальная работа с книгой XLSX на уровне OOXML.
//
// Готовые библиотеки здесь не подходят: шаблон ФГИС записан с префиксом
// пространства имён (<x:worksheet>), а его <dimension> указывает лишь первые
// строки листа. Прямая правка XML сохраняет исходный файл без изменений
// во всём, что программа не трогает.

const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';

/** «AB12» → {col: 28, row: 12} (нумерация с единицы). */
export function parseRef(ref) {
  const match = /^([A-Z]+)(\d+)$/.exec(String(ref).toUpperCase());
  if (!match) return null;
  let col = 0;
  for (const char of match[1]) col = col * 26 + (char.charCodeAt(0) - 64);
  return { col, row: Number(match[2]) };
}

/** 28 → «AB». */
export function columnLetter(index) {
  let letter = '';
  let value = index;
  while (value > 0) {
    const rest = (value - 1) % 26;
    letter = String.fromCharCode(65 + rest) + letter;
    value = Math.floor((value - 1) / 26);
  }
  return letter;
}

export function makeRef(col, row) {
  return `${columnLetter(col)}${row}`;
}

function children(node, localName) {
  const result = [];
  const list = node ? node.childNodes || [] : [];
  for (let i = 0; i < list.length; i += 1) {
    const child = list[i];
    if (child.nodeType === 1 && (!localName || child.localName === localName)) result.push(child);
  }
  return result;
}

function firstChild(node, localName) {
  return children(node, localName)[0] || null;
}

function textOf(node) {
  return node ? node.textContent : '';
}

/** Создаёт элемент в том же пространстве имён и с тем же префиксом, что у соседа. */
function createLike(sibling, localName) {
  const doc = sibling.ownerDocument;
  const prefix = sibling.prefix;
  const ns = sibling.namespaceURI || MAIN_NS;
  return doc.createElementNS(ns, prefix ? `${prefix}:${localName}` : localName);
}

function dirname(path) {
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index);
}

function resolvePath(base, target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = `${base}/${target}`.split('/');
  const stack = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return stack.join('/');
}

export class XlsxDocument {
  constructor(zip, JSZipLib) {
    this.zip = zip;
    this.JSZip = JSZipLib;
    this.docs = new Map(); // путь → XML Document
    this.dirty = new Set();
    this.sheets = [];
    this.sharedStrings = [];
    this.styleCache = new Map();
  }

  static async load(arrayBuffer, JSZipLib) {
    const zip = await JSZipLib.loadAsync(arrayBuffer);
    const doc = new XlsxDocument(zip, JSZipLib);
    await doc.init();
    return doc;
  }

  async xml(path) {
    if (this.docs.has(path)) return this.docs.get(path);
    const file = this.zip.file(path);
    if (!file) return null;
    // Файлы ФГИС начинаются с BOM, который ломает разбор XML.
    const text = (await file.async('string')).replace(/^﻿/, '').trimStart();
    const parsed = new DOMParser().parseFromString(text, 'application/xml');
    const error = parsed.getElementsByTagName('parsererror')[0];
    if (error) throw new Error(`Не удалось разобрать ${path}: ${error.textContent.slice(0, 200)}`);
    this.docs.set(path, parsed);
    return parsed;
  }

  async init() {
    const rootRels = await this.xml('_rels/.rels');
    let workbookPath = 'xl/workbook.xml';
    if (rootRels) {
      for (const rel of children(rootRels.documentElement, 'Relationship')) {
        if ((rel.getAttribute('Type') || '').endsWith('/officeDocument')) {
          workbookPath = resolvePath('', rel.getAttribute('Target'));
        }
      }
    }
    this.workbookPath = workbookPath;
    const workbook = await this.xml(workbookPath);
    if (!workbook) throw new Error('Не найден xl/workbook.xml — файл не является книгой XLSX');

    const relsPath = `${dirname(workbookPath)}/_rels/${workbookPath.split('/').pop()}.rels`;
    const relsDoc = await this.xml(relsPath);
    const rels = new Map();
    if (relsDoc) {
      for (const rel of children(relsDoc.documentElement, 'Relationship')) {
        rels.set(rel.getAttribute('Id'), rel.getAttribute('Target'));
      }
    }

    const sheetsNode = firstChild(workbook.documentElement, 'sheets');
    for (const sheet of children(sheetsNode, 'sheet')) {
      const id = sheet.getAttributeNS(REL_NS, 'id') || sheet.getAttribute('r:id');
      const target = rels.get(id);
      if (!target) continue;
      this.sheets.push({
        name: sheet.getAttribute('name'),
        path: resolvePath(dirname(workbookPath), target),
      });
    }
    if (!this.sheets.length) throw new Error('В книге не найдено ни одного листа');

    const sharedPath = `${dirname(workbookPath)}/sharedStrings.xml`;
    const shared = await this.xml(sharedPath);
    this.sharedPath = sharedPath;
    if (shared) {
      for (const si of children(shared.documentElement, 'si')) {
        const parts = [];
        for (const t of children(si, 't')) parts.push(textOf(t));
        for (const r of children(si, 'r')) {
          for (const t of children(r, 't')) parts.push(textOf(t));
        }
        this.sharedStrings.push(parts.join(''));
      }
    }
    this.stylesPath = `${dirname(workbookPath)}/styles.xml`;
  }

  /** Значение ячейки с учётом типа. */
  cellValue(cell) {
    const type = cell.getAttribute('t') || 'n';
    if (type === 'inlineStr') {
      const is = firstChild(cell, 'is');
      const parts = [];
      for (const t of children(is, 't')) parts.push(textOf(t));
      for (const r of children(is, 'r')) for (const t of children(r, 't')) parts.push(textOf(t));
      return parts.join('');
    }
    const value = firstChild(cell, 'v');
    if (!value) return null;
    const raw = textOf(value);
    if (type === 's') {
      const index = Number(raw);
      return this.sharedStrings[index] ?? null;
    }
    if (type === 'b') return raw === '1';
    if (type === 'str' || type === 'e') return raw;
    if (raw === '') return null;
    const number = Number(raw);
    return Number.isFinite(number) ? number : raw;
  }

  /**
   * Читает лист как разреженную сетку.
   * @returns {{maxRow: number, maxCol: number, values: Map<string, any>}}
   */
  async readSheet(sheetPath) {
    const doc = await this.xml(sheetPath);
    if (!doc) throw new Error(`Лист ${sheetPath} не найден в книге`);
    const sheetData = firstChild(doc.documentElement, 'sheetData');
    const values = new Map();
    let maxRow = 0;
    let maxCol = 0;
    for (const row of children(sheetData, 'row')) {
      const rowNumber = Number(row.getAttribute('r')) || maxRow + 1;
      maxRow = Math.max(maxRow, rowNumber);
      for (const cell of children(row, 'c')) {
        const ref = cell.getAttribute('r') || '';
        const parsed = parseRef(ref);
        if (!parsed) continue;
        maxCol = Math.max(maxCol, parsed.col);
        const value = this.cellValue(cell);
        if (value !== null && value !== '') values.set(ref, value);
      }
    }
    return { maxRow, maxCol, values };
  }

  async sheetDoc(sheetPath) {
    const doc = await this.xml(sheetPath);
    if (!doc) throw new Error(`Лист ${sheetPath} не найден в книге`);
    return doc;
  }

  markDirty(path) {
    this.dirty.add(path);
  }

  /** Возвращает (создавая при необходимости) элемент строки, сохраняя порядок. */
  ensureRow(sheetDoc, rowNumber) {
    const sheetData = firstChild(sheetDoc.documentElement, 'sheetData');
    const rows = children(sheetData, 'row');
    let insertBefore = null;
    for (const row of rows) {
      const current = Number(row.getAttribute('r'));
      if (current === rowNumber) return row;
      if (current > rowNumber) {
        insertBefore = row;
        break;
      }
    }
    const created = createLike(sheetData, 'row');
    created.setAttribute('r', String(rowNumber));
    sheetData.insertBefore(created, insertBefore);
    return created;
  }

  /** Возвращает (создавая при необходимости) элемент ячейки, сохраняя порядок столбцов. */
  ensureCell(sheetDoc, rowNumber, colNumber) {
    const row = this.ensureRow(sheetDoc, rowNumber);
    const ref = makeRef(colNumber, rowNumber);
    let insertBefore = null;
    for (const cell of children(row, 'c')) {
      const parsed = parseRef(cell.getAttribute('r') || '');
      if (!parsed) continue;
      if (parsed.col === colNumber) return cell;
      if (parsed.col > colNumber) {
        insertBefore = cell;
        break;
      }
    }
    const created = createLike(row, 'c');
    created.setAttribute('r', ref);
    row.insertBefore(created, insertBefore);
    return created;
  }

  /** Записывает значение в ячейку: число, строку или пусто (null). */
  setCell(sheetDoc, rowNumber, colNumber, value, styleId) {
    const cell = this.ensureCell(sheetDoc, rowNumber, colNumber);
    for (const child of children(cell)) cell.removeChild(child);
    cell.removeAttribute('t');
    if (styleId !== undefined && styleId !== null) cell.setAttribute('s', String(styleId));

    if (value === null || value === undefined || value === '') return cell;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return cell;
      const v = createLike(cell, 'v');
      v.appendChild(cell.ownerDocument.createTextNode(String(value)));
      cell.appendChild(v);
      return cell;
    }
    cell.setAttribute('t', 'inlineStr');
    const is = createLike(cell, 'is');
    const t = createLike(cell, 't');
    t.appendChild(cell.ownerDocument.createTextNode(String(value)));
    is.appendChild(t);
    cell.appendChild(is);
    return cell;
  }

  /** Текущий индекс стиля ячейки (или стиля столбца/строки). */
  cellStyleId(sheetDoc, rowNumber, colNumber) {
    const sheetData = firstChild(sheetDoc.documentElement, 'sheetData');
    for (const row of children(sheetData, 'row')) {
      if (Number(row.getAttribute('r')) !== rowNumber) continue;
      for (const cell of children(row, 'c')) {
        const parsed = parseRef(cell.getAttribute('r') || '');
        if (parsed && parsed.col === colNumber) {
          const style = cell.getAttribute('s');
          return style === null ? null : Number(style);
        }
      }
    }
    return null;
  }

  /**
   * Создаёт стиль на основе существующего: числовой формат и выравнивание по центру.
   * @returns {Promise<number>} индекс в cellXfs
   */
  async deriveStyle(baseStyleId, { numFmtId = null, center = false } = {}) {
    const key = `${baseStyleId ?? 'none'}|${numFmtId ?? ''}|${center ? 'c' : ''}`;
    if (this.styleCache.has(key)) return this.styleCache.get(key);

    const styles = await this.xml(this.stylesPath);
    if (!styles) return baseStyleId ?? 0;
    const cellXfs = firstChild(styles.documentElement, 'cellXfs');
    if (!cellXfs) return baseStyleId ?? 0;
    const xfs = children(cellXfs, 'xf');
    const base = xfs[baseStyleId ?? 0] || xfs[0];
    if (!base) return 0;

    const xf = base.cloneNode(true);
    if (numFmtId !== null) {
      xf.setAttribute('numFmtId', String(numFmtId));
      xf.setAttribute('applyNumberFormat', '1');
    }
    if (center) {
      for (const child of children(xf, 'alignment')) xf.removeChild(child);
      const alignment = createLike(xf, 'alignment');
      alignment.setAttribute('horizontal', 'center');
      alignment.setAttribute('vertical', 'center');
      xf.appendChild(alignment);
      xf.setAttribute('applyAlignment', '1');
    }

    const serialized = new XMLSerializer().serializeToString(xf);
    for (let i = 0; i < xfs.length; i += 1) {
      if (new XMLSerializer().serializeToString(xfs[i]) === serialized) {
        this.styleCache.set(key, i);
        return i;
      }
    }
    cellXfs.appendChild(xf);
    cellXfs.setAttribute('count', String(xfs.length + 1));
    this.markDirty(this.stylesPath);
    this.styleCache.set(key, xfs.length);
    return xfs.length;
  }

  /** Обновляет <dimension>, чтобы охватить указанные строку и столбец. */
  updateDimension(sheetDoc, maxRow, maxCol) {
    const dimension = firstChild(sheetDoc.documentElement, 'dimension');
    if (!dimension) return;
    const ref = dimension.getAttribute('ref') || 'A1';
    const [, end = ref] = ref.split(':');
    const parsed = parseRef(end) || { col: 1, row: 1 };
    dimension.setAttribute(
      'ref',
      `A1:${makeRef(Math.max(parsed.col, maxCol), Math.max(parsed.row, maxRow))}`,
    );
  }

  /** Задаёт ширину столбца (если ширина ещё не задана). */
  setColumnWidth(sheetDoc, colNumber, width) {
    const root = sheetDoc.documentElement;
    let cols = firstChild(root, 'cols');
    if (!cols) {
      cols = createLike(root, 'cols');
      const sheetData = firstChild(root, 'sheetData');
      root.insertBefore(cols, sheetData);
    }
    for (const col of children(cols, 'col')) {
      const min = Number(col.getAttribute('min'));
      const max = Number(col.getAttribute('max'));
      if (colNumber >= min && colNumber <= max) return;
    }
    const col = createLike(cols, 'col');
    col.setAttribute('min', String(colNumber));
    col.setAttribute('max', String(colNumber));
    col.setAttribute('width', String(width));
    col.setAttribute('customWidth', '1');
    cols.appendChild(col);
  }

  /** Сериализует изменённые части и отдаёт новую книгу. */
  async toBlob() {
    for (const path of this.dirty) {
      const doc = this.docs.get(path);
      if (!doc) continue;
      const xml = new XMLSerializer().serializeToString(doc);
      this.zip.file(path, xml.startsWith('<?xml') ? xml : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${xml}`);
    }
    return this.zip.generateAsync({
      type: typeof window === 'undefined' ? 'nodebuffer' : 'blob',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      compression: 'DEFLATE',
    });
  }
}

/** Встроенные числовые форматы Excel. */
export const NUM_FMT = { INTEGER: 1, TWO_DECIMALS: 2, GENERAL: 0 };
