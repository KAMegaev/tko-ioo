// Разбор шаблона «Выгрузка общих сведений».
// Книга открывается как OOXML-документ и сохраняется целиком: выгрузка
// выполняется поверх исходного файла, без пересборки его структуры.

import { normalize } from '../lib/text.js';
import { XlsxDocument, makeRef } from '../lib/xlsx-doc.js';

const META_VALUES = new Set([
  'список', 'число', 'текст', 'дата', 'да нет', 'логическое',
  'обязательное поле', 'необязательное поле', 'опциональное поле',
]);

const COLUMN_MATCHERS = [
  ['subject', (h) => /субъект/.test(h)],
  ['zone', (h) => /зона/.test(h)],
  ['municipality', (h) => /муниципальн/.test(h)],
  ['category', (h) => /категори[а-я]* потребител|^категори/.test(h)],
  ['unit', (h) => /единиц[а-я]*\s+измерен/.test(h)],
  ['sources', (h) => /количеств[а-я]*\s+источник/.test(h)],
  ['registryUnits', (h) => /количеств[а-я]*\s+расчетн/.test(h) && /реестр/.test(h)],
  ['units', (h) => /количеств[а-я]*\s+расчетн/.test(h) && !/реестр/.test(h)],
  ['mass', (h) => /расчетн[а-я]*\s+масс/.test(h)],
  ['volume', (h) => /расчетн[а-я]*\s+объем/.test(h)],
  ['density', (h) => /плотност/.test(h)],
  // Столбцы, добавленные самой программой при предыдущей обработке файла.
  ['normMass', (h) => /норматив/.test(h) && /масс/.test(h)],
  ['normVolume', (h) => /норматив/.test(h) && /объем/.test(h)],
];

function isMetaRow(values) {
  let hits = 0;
  for (const value of values) {
    const text = normalize(value);
    if (!text) continue;
    if (META_VALUES.has(text) || /^заполняется|^справочное|^формат/.test(text)) hits += 1;
  }
  return hits >= 2;
}

function cellText(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim().replace(/\s+/g, ' ');
}

/** Загружает шаблон и определяет структуру листа. */
export async function parseTemplate(arrayBuffer, fileName, JSZipLib) {
  const document = await XlsxDocument.load(arrayBuffer, JSZipLib);
  const sheet =
    document.sheets.find((item) => /общие сведени/i.test(item.name || '')) || document.sheets[0];
  const data = await document.readSheet(sheet.path);

  const width = Math.max(data.maxCol, 13);
  const valueAt = (row, col) => data.values.get(makeRef(col, row));
  const rowTexts = (row) => {
    const texts = [];
    for (let col = 1; col <= width; col += 1) texts.push(cellText(valueAt(row, col)));
    return texts;
  };

  let headerRow = 0;
  for (let r = 1; r <= Math.min(data.maxRow, 20); r += 1) {
    const texts = rowTexts(r);
    if (texts.some((v) => /категори/i.test(v)) && texts.some((v) => /единиц/i.test(v))) {
      headerRow = r;
      break;
    }
  }
  if (!headerRow) {
    throw new Error('В шаблоне не найдена строка заголовка со столбцом «Категория потребителя»');
  }

  const headers = rowTexts(headerRow);
  // Последний столбец с осмысленным заголовком: правее могут стоять пустые
  // оформленные ячейки, и новые столбцы должны примыкать к таблице, а не к ним.
  let lastHeaderColumn = 0;
  headers.forEach((header, index) => {
    if (header) lastHeaderColumn = index + 1;
  });
  const columns = {};
  headers.forEach((header, index) => {
    const text = normalize(header);
    if (!text) return;
    for (const [key, matcher] of COLUMN_MATCHERS) {
      if (columns[key] === undefined && matcher(text)) {
        columns[key] = index + 1;
        break;
      }
    }
  });
  if (columns.category === undefined) {
    throw new Error('В шаблоне не найден столбец «Категория потребителя»');
  }
  if (columns.zone === undefined) {
    throw new Error('В шаблоне не найден столбец «Зона деятельности регионального оператора»');
  }

  const rows = [];
  const metaRows = [];
  for (let r = headerRow + 1; r <= data.maxRow; r += 1) {
    const texts = rowTexts(r);
    if (texts.every((v) => !v)) continue;
    if (isMetaRow(texts)) {
      metaRows.push(r);
      continue;
    }
    const category = texts[columns.category - 1];
    if (!category) continue;
    rows.push({
      excelRow: r,
      index: rows.length,
      subject: columns.subject ? texts[columns.subject - 1] : '',
      zone: texts[columns.zone - 1],
      municipality: columns.municipality ? texts[columns.municipality - 1] : '',
      category,
      unit: columns.unit ? texts[columns.unit - 1] : '',
    });
  }
  if (!rows.length) throw new Error('В шаблоне не найдено ни одной строки с данными');

  return {
    fileName,
    document,
    sheetPath: sheet.path,
    sheetName: sheet.name,
    headerRow,
    metaRows,
    columns,
    headers,
    lastHeaderColumn,
    width,
    maxRow: data.maxRow,
    rows,
  };
}
