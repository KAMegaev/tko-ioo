// Сборка тестовых книг, в том числе в «сложном» виде выгрузки ФГИС:
// с префиксом пространства имён и заниженным <dimension>.

import JSZip from 'jszip';
import * as XLSX from 'xlsx';

export const TEMPLATE_HEADER = [
  'Субъект РФ',
  'Зона деятельности регионального оператора',
  'Муниципальное образование / ГО, входящее в зону',
  'Категория потребителя',
  'Единица измерения расчетных единиц',
  'Количество источников образования ТКО',
  'Количество расчетных единиц',
  'Расчетная масса, т',
  'Расчетный объем, м3',
  'Расчетный коэффициент плотности отходов,  т/м³',
  'Количество расчетных единиц (Данные из реестра ИОО)',
];

const META_ROWS = [
  ['список', 'список', 'список', 'список', 'список', 'число', 'число', 'число', 'число', 'число', 'число'],
  ['обязательное поле', 'обязательное поле', 'заполняется по усмотрению', 'обязательное поле',
    'обязательное поле', 'обязательное поле', 'обязательное поле', 'обязательное поле',
    'обязательное поле', 'обязательное поле', 'справочное поле, данные из него не загружаются'],
];

/** Книга «Общие сведения» с указанными строками категорий. */
export function templateWorkbook(rows) {
  const aoa = [TEMPLATE_HEADER, ...META_ROWS, ...rows.map((row) => [
    row.subject || 'Омская область',
    row.zone,
    row.municipality || null,
    row.category,
    row.unit,
  ])];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(aoa), 'Общие сведения');
  return XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
}

/** Книга реестра ИОО. */
export function registryWorkbook(rows, header = ['Категория потребителя', 'Количество расчетных единиц', 'Зона деятельности']) {
  // Порядок столбцов задаётся шапкой: выгрузки разных регионов отличаются
  // и составом, и порядком колонок.
  const hasUnits = header.some((title) => /количеств/i.test(title));
  const hasMunicipality = header.some((title) => /муниципальн/i.test(title));
  const aoa = [header, ...rows.map((row) => (hasUnits
    ? [row.category, row.units, row.zone]
    : [row.municipality ?? 'Кемеровский городской округ', row.category, row.zone]))];
  if (!hasUnits && !hasMunicipality) throw new Error('Шапка без количества единиц должна содержать МО');
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(aoa), 'Реестр ИОО');
  return XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
}

/**
 * Приводит книгу к виду выгрузки ФГИС: элементы получают префикс x:,
 * а <dimension> охватывает лишь первые строки листа.
 */
export async function toFgisStyle(arrayBuffer, dimensionRef = 'A1:S4') {
  const zip = await JSZip.loadAsync(arrayBuffer);
  for (const path of Object.keys(zip.files)) {
    if (!/^xl\/(workbook\.xml|worksheets\/sheet\d+\.xml|styles\.xml|sharedStrings\.xml)$/.test(path)) continue;
    let xml = await zip.file(path).async('string');
    xml = xml
      .replace(/xmlns="http:\/\/schemas\.openxmlformats\.org\/spreadsheetml\/2006\/main"/g,
        'xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"')
      .replace(/<(\/?)([a-zA-Z][\w]*)(\s|\/|>)/g, (match, slash, name, tail) =>
        (name.includes(':') ? match : `<${slash}x:${name}${tail}`));
    if (path.includes('worksheets/')) {
      xml = xml.replace(/<x:dimension ref="[^"]*"\s*\/>/, `<x:dimension ref="${dimensionRef}"/>`);
      if (!xml.includes('<x:dimension')) {
        xml = xml.replace(/(<x:worksheet[^>]*>)/, `$1<x:dimension ref="${dimensionRef}"/>`);
      }
    }
    // Выгрузки ФГИС начинаются с BOM.
    zip.file(path, `﻿${xml}`);
  }
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

/** Сетка таблицы нормативов «как в приказе»: две строки шапки. */
export function normsGrid(rows, { massHeader = 'кг в год', volumeHeader = 'куб.м в год', withUnitColumn = false } = {}) {
  const title = 'Наименование категории потребителей услуги по обращению с твердыми коммунальными отходами';
  const norm = 'Норматив накопления твердых коммунальных отходов';
  if (withUnitColumn) {
    return [
      [title, 'Расчетная единица, в отношении которой установлен норматив', norm, norm],
      [title, 'Расчетная единица, в отношении которой установлен норматив', volumeHeader, massHeader],
      ...rows.map((row) => [row.name, row.unit, row.volume, row.mass]),
    ];
  }
  return [
    [title, norm, norm],
    [title, volumeHeader, massHeader],
    ...rows.map((row) => [row.name, row.volume, row.mass]),
  ];
}
