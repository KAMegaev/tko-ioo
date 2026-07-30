// Запись результата в исходный файл «Выгрузка общих сведений».
//
// Строки, их порядок и столбцы A–E остаются нетронутыми: значения пишутся
// только в F–J и в два добавленных столбца с нормативами. Столбец K не
// заполняется по требованиям выгрузки.

import { NUM_FMT } from '../lib/xlsx-doc.js';
import { round } from '../lib/calc.js';

export const NORM_MASS_HEADER = 'Норматив по массе, кг/год';
export const NORM_VOLUME_HEADER = 'Норматив по объему, м³/год';

/**
 * Заполняет шаблон и возвращает готовый файл.
 * @param {object} template результат parseTemplate
 * @param {object} results результат buildResults
 * @returns {Promise<Blob|Buffer>}
 */
export async function fillTemplate(template, results) {
  const document = template.document;
  const sheet = await document.sheetDoc(template.sheetPath);
  const columns = template.columns;

  const occupied = Math.max(
    ...Object.values(columns).filter((value) => Number.isFinite(value)),
    template.lastHeaderColumn || 0,
  );
  const normMassCol = columns.normMass ?? occupied + 1;
  const normVolumeCol = columns.normVolume ?? occupied + 2;

  // Шапка добавленных столбцов повторяет оформление существующего заголовка.
  const headerBase =
    document.cellStyleId(sheet, template.headerRow, columns.category) ??
    document.cellStyleId(sheet, template.headerRow, 1);
  const headerStyle = await document.deriveStyle(headerBase, { center: true });
  document.setCell(sheet, template.headerRow, normMassCol, NORM_MASS_HEADER, headerStyle);
  document.setCell(sheet, template.headerRow, normVolumeCol, NORM_VOLUME_HEADER, headerStyle);
  document.setColumnWidth(sheet, normMassCol, 24);
  document.setColumnWidth(sheet, normVolumeCol, 24);

  let maxRow = template.headerRow;
  for (const row of results.rows) {
    const excelRow = row.excelRow;
    maxRow = Math.max(maxRow, excelRow);
    const base =
      document.cellStyleId(sheet, excelRow, columns.category) ??
      document.cellStyleId(sheet, excelRow, 1);

    const integerStyle = await document.deriveStyle(base, { numFmtId: NUM_FMT.INTEGER, center: true });
    const decimalStyle = await document.deriveStyle(base, { numFmtId: NUM_FMT.TWO_DECIMALS, center: true });
    const plainStyle = await document.deriveStyle(base, { center: true });

    // F–J: пустых значений быть не должно, вместо них ноль.
    if (columns.sources) {
      document.setCell(sheet, excelRow, columns.sources, row.sources || 0, integerStyle);
    }
    if (columns.units) {
      document.setCell(sheet, excelRow, columns.units, round(row.units, 0) ?? 0, integerStyle);
    }
    if (columns.mass) {
      document.setCell(sheet, excelRow, columns.mass, round(row.mass, 2) ?? 0, decimalStyle);
    }
    if (columns.volume) {
      document.setCell(sheet, excelRow, columns.volume, round(row.volume, 2) ?? 0, decimalStyle);
    }
    if (columns.density) {
      document.setCell(sheet, excelRow, columns.density, round(row.density, 2) ?? 0, decimalStyle);
    }

    // Нормативы задаются с точностью до пяти знаков; при вычислении по формуле
    // накапливается шум двоичного представления — его нужно убрать.
    document.setCell(sheet, excelRow, normMassCol, round(row.normMass, 6), plainStyle);
    document.setCell(sheet, excelRow, normVolumeCol, round(row.normVolume, 6), plainStyle);
  }

  document.updateDimension(sheet, maxRow, normVolumeCol);
  document.markDirty(template.sheetPath);
  return document.toBlob();
}
