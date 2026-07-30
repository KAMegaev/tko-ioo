// Формирование книги с отчётами: соответствия категорий и аналитика проверки.

import { STATUS_LABELS } from '../lib/match.js';
import { humanize } from '../lib/formula.js';
import { BASIS_LABELS } from '../lib/units.js';
import { round } from '../lib/calc.js';

const MODE_LABELS = {
  single: 'Прямое соответствие',
  formula: 'Формула',
  manual: 'Значения вручную',
  none: 'Не сопоставлено',
  ignored: 'Исключено',
};

const percent = (value) => (Number.isFinite(value) ? `${Math.round(value * 100)} %` : '');

/** Таблица соответствий «шаблон ↔ нормативы». */
export function normMappingTable({ categories, normMapping, normById, results }) {
  const byCategory = new Map(results.rows.map((row) => [row.categoryKey, row]));
  const header = [
    'Категория (Выгрузка общих сведений)',
    'Единица измерения',
    'Способ сопоставления',
    'Категория (Нормативы накопления ТКО)',
    'Расчётная единица норматива',
    'Норматив по массе, кг/год',
    'Норматив по объему, м³/год',
    'Статус',
    'Схожесть наименований',
    'Проверено вручную',
  ];
  const rows = categories.map((category) => {
    const mapping = normMapping.get(category.key) || {};
    const result = byCategory.get(category.key);
    const entry = mapping.entryId ? normById.get(mapping.entryId) : null;
    let normName = '';
    if (mapping.mode === 'formula') {
      normName = humanize(mapping.expression, (id) => normById.get(id)?.name);
    } else if (mapping.mode === 'manual') {
      normName = 'значения заданы вручную';
    } else if (entry) {
      normName = entry.name;
    }
    return [
      category.name,
      category.unit || '',
      MODE_LABELS[mapping.mode] || MODE_LABELS.none,
      normName,
      entry ? BASIS_LABELS[entry.basis] || entry.basis : '',
      result && result.normMass !== null ? result.normMass : '',
      result && result.normVolume !== null ? result.normVolume : '',
      STATUS_LABELS[mapping.status] || '',
      mapping.mode === 'single' && mapping.auto ? percent(mapping.score) : '',
      mapping.auto === false ? 'да' : '',
    ];
  });
  return [header, ...rows];
}

/** Таблица соответствий «реестр ↔ шаблон». */
export function registryMappingTable({ registry, registryMapping, categoryByKey }) {
  const header = [
    'Категория (Выгрузка реестра ИОО)',
    'Строк в реестре',
    'Сумма расчётных единиц',
    'Категория (Выгрузка общих сведений)',
    'Статус',
    'Схожесть наименований',
    'Проверено вручную',
  ];
  const rows = registry.categories.map((category) => {
    const mapping = registryMapping.get(category.key) || {};
    const target = mapping.templateKey ? categoryByKey.get(mapping.templateKey) : null;
    return [
      category.name,
      category.rows,
      round(category.units, 2),
      target ? target.name : '',
      STATUS_LABELS[mapping.status] || STATUS_LABELS.none,
      mapping.auto ? percent(mapping.score) : '',
      mapping.auto === false ? 'да' : '',
    ];
  });
  return [header, ...rows];
}

/** Построчный расчёт — то, что записано в файл. */
export function resultTable(results) {
  const header = [
    'Строка файла',
    'Зона деятельности',
    'Категория потребителя',
    'Единица измерения',
    'Количество источников (F)',
    'Количество расчетных единиц (G)',
    'Расчетная масса, т (H)',
    'Расчетный объем, м³ (I)',
    'Коэффициент плотности, т/м³ (J)',
    'Норматив по массе, кг/год',
    'Норматив по объему, м³/год',
    'Строк реестра в группе',
    'Из них с нулевым количеством',
    'Точная сумма расчётных единиц',
  ];
  const rows = results.rows.map((row) => [
    row.excelRow,
    row.templateRow.zone,
    row.templateRow.category,
    row.templateRow.unit,
    row.sources || 0,
    round(row.units, 0) ?? 0,
    round(row.mass, 2) ?? 0,
    round(row.volume, 2) ?? 0,
    round(row.density, 2) ?? 0,
    row.normMass ?? '',
    row.normVolume ?? '',
    row.registryRows,
    row.zeroSources,
    round(row.units, 4) ?? 0,
  ]);
  return [header, ...rows];
}

/** Аналитика проверки: сводка, контрольные суммы и замечания. */
export function verificationTable(verification, meta) {
  const rows = [];
  rows.push(['Аналитические данные проверки']);
  rows.push([]);
  rows.push(['Исходные файлы']);
  rows.push(['Шаблон общих сведений', meta.templateFile]);
  rows.push(['Файл нормативов', meta.normsFile]);
  for (const file of meta.registryFiles) rows.push(['Реестр ИОО', file]);
  rows.push(['Дата формирования', meta.generatedAt]);
  rows.push([]);

  const summary = verification.summary;
  rows.push(['Сводка']);
  rows.push(['Строк в файле общих сведений', summary.templateRows]);
  rows.push(['Из них с данными реестра', summary.rowsWithData]);
  rows.push(['Из них без данных (нули)', summary.rowsEmpty]);
  rows.push(['Категорий без норматива', summary.rowsWithoutNorm]);
  rows.push(['Строк в реестре ИОО', summary.registryRows]);
  rows.push(['Из них с нулевым количеством единиц', summary.registryZeroRows]);
  rows.push(['Уникальных категорий в реестре', summary.registryCategories]);
  rows.push(['Итого источников (столбец F)', summary.totalSources]);
  rows.push(['Итого расчётных единиц (столбец G)', summary.totalUnits]);
  rows.push(['Итого расчётная масса, т', summary.totalMass]);
  rows.push(['Итого расчётный объем, м³', summary.totalVolume]);
  rows.push(['Средний коэффициент плотности, т/м³', summary.averageDensity ?? '']);
  rows.push(['Групп реестра вне файла', summary.unassignedGroups]);
  rows.push(['Ошибок', summary.errors]);
  rows.push(['Предупреждений', summary.warnings]);
  rows.push([]);

  rows.push(['Контрольные сверки', 'Ожидается', 'Фактически', 'Результат']);
  for (const check of verification.checks) {
    rows.push([check.name, check.expected, check.actual, check.ok ? 'сходится' : 'РАСХОЖДЕНИЕ']);
  }
  rows.push([]);

  rows.push(['Замечания', '', '']);
  rows.push(['Уровень', 'Тип', 'Описание']);
  const levels = { error: 'Ошибка', warning: 'Предупреждение', info: 'Информация' };
  if (!verification.issues.length) {
    rows.push(['', '', 'Замечаний нет: файл не противоречит исходным данным.']);
  }
  for (const item of verification.issues) {
    rows.push([levels[item.level] || item.level, item.title, item.detail]);
  }
  return rows;
}

/** Собирает книгу отчётов. */
export function buildReportWorkbook(data, XLSXLib) {
  const workbook = XLSXLib.utils.book_new();
  const sheets = [
    ['Проверка', verificationTable(data.verification, data.meta)],
    ['Соответствие нормативов', normMappingTable(data)],
    ['Категории реестра', registryMappingTable(data)],
    ['Расчёт по строкам', resultTable(data.results)],
    ['Нормативы (распознано)', normsTable(data.norms)],
  ];
  for (const [name, aoa] of sheets) {
    const sheet = XLSXLib.utils.aoa_to_sheet(aoa);
    sheet['!cols'] = widthsFor(aoa);
    XLSXLib.utils.book_append_sheet(workbook, sheet, name);
  }
  return XLSXLib.write(workbook, { bookType: 'xlsx', type: 'array' });
}

function normsTable(norms) {
  const header = [
    'Категория из файла нормативов',
    'Расчётная единица',
    'Норматив по массе, кг/год',
    'Норматив по объему, м³/год',
    'Значение в файле (масса)',
    'Значение в файле (объём)',
    'Файл',
  ];
  const rows = norms.entries.map((entry) => [
    entry.name,
    BASIS_LABELS[entry.basis] || entry.basis || '',
    entry.mass ?? '',
    entry.volume ?? '',
    entry.rawMass ?? '',
    entry.rawVolume ?? '',
    entry.file,
  ]);
  return [header, ...rows];
}

function widthsFor(aoa) {
  const widths = [];
  for (const row of aoa) {
    row.forEach((cell, index) => {
      const length = Math.min(String(cell ?? '').length + 2, 70);
      widths[index] = Math.max(widths[index] || 10, length);
    });
  }
  return widths.map((width) => ({ wch: width }));
}
