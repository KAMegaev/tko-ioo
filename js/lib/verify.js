// Проверка результата на непротиворечивость исходным данным реестра.

import { round, KG_PER_TONNE } from './calc.js';
import { BASIS_LABELS, unitBasis } from './units.js';

const TOLERANCE = 0.011; // допуск сверки округлённых до сотых значений

const issue = (level, code, title, detail, extra = {}) => ({ level, code, title, detail, ...extra });

/** Число в привычном виде: 315 970,22. */
const fmt = (value) => (Number.isFinite(value)
  ? value.toLocaleString('ru-RU', { maximumFractionDigits: 2 })
  : String(value));

/**
 * Сверяет расчёт с реестром и правилами заполнения.
 * @returns {{summary: object, issues: Array, checks: Array}}
 */
export function verify({ results, registry, normById, normMapping, templateRows }) {
  const issues = [];
  const checks = [];

  const totalUnitsRegistry = [...registry.groups.values()].reduce((sum, g) => sum + g.units, 0);
  const totalSourcesRegistry = [...registry.groups.values()].reduce((sum, g) => sum + g.sources, 0);
  const totalUnitsResult = results.rows.reduce((sum, row) => sum + row.units, 0);
  const totalSourcesResult = results.rows.reduce((sum, row) => sum + row.sources, 0);
  const unassignedUnits = results.unassigned.reduce((sum, row) => sum + row.units, 0);
  const unassignedSources = results.unassigned.reduce((sum, row) => sum + row.sources, 0);

  // 1. Баланс: всё, что есть в реестре, либо попало в файл, либо явно не сопоставлено.
  const unitsDelta = round(totalUnitsRegistry - totalUnitsResult - unassignedUnits, 6);
  const sourcesDelta = totalSourcesRegistry - totalSourcesResult - unassignedSources;
  checks.push({
    name: 'Баланс расчётных единиц',
    expected: round(totalUnitsRegistry, 2),
    actual: round(totalUnitsResult + unassignedUnits, 2),
    ok: Math.abs(unitsDelta) < 1e-6,
  });
  checks.push({
    name: 'Баланс количества источников',
    expected: totalSourcesRegistry,
    actual: totalSourcesResult + unassignedSources,
    ok: sourcesDelta === 0,
  });
  if (Math.abs(unitsDelta) >= 1e-6 || sourcesDelta !== 0) {
    issues.push(
      issue('error', 'balance', 'Расхождение с реестром',
        `Сумма по реестру ${fmt(totalUnitsRegistry)} ед. / ${fmt(totalSourcesRegistry)} источников, ` +
        `в файле и нераспределённых — ${fmt(totalUnitsResult + unassignedUnits)} ед. / ${fmt(totalSourcesResult + unassignedSources)} источников.`),
    );
  }

  // 2. Данные реестра, не попавшие в файл.
  for (const item of results.unassigned) {
    issues.push(
      issue('error', 'unassigned', 'Данные реестра не попали в файл',
        `«${item.category}» (зона «${item.zone}»): ${fmt(item.rows)} строк, ${fmt(item.units)} ед., ` +
        `${fmt(item.sources)} источников — ${item.reason}.`,
        { category: item.category, zone: item.zone }),
    );
  }

  // 3. Дубли строк шаблона: одна и та же пара «зона + категория».
  for (const duplicate of results.duplicates) {
    issues.push(
      issue('warning', 'duplicate', 'Повторяющаяся строка шаблона',
        `Строка ${duplicate.excelRow}: пара «${duplicate.zone}» + «${duplicate.category}» уже встречалась выше. ` +
        'Данные реестра отнесены к первой такой строке, здесь проставлены нули.'),
    );
  }

  // 4. Построчные проверки.
  let rowsWithData = 0;
  let rowsWithoutNorm = 0;
  let rowsEmpty = 0;
  for (const row of results.rows) {
    const hasData = row.units > 0 || row.sources > 0;
    if (hasData) rowsWithData += 1;
    else rowsEmpty += 1;

    if (row.normError) {
      issues.push(
        issue('error', 'formula', 'Ошибка в формуле норматива',
          `Строка ${row.excelRow}, «${row.templateRow.category}»: ${row.normError}`),
      );
    }

    const noNorm = row.normMass === null && row.normVolume === null;
    if (noNorm) {
      rowsWithoutNorm += 1;
      if (hasData) {
        issues.push(
          issue('error', 'no-norm', 'Нет норматива при наличии данных',
            `Строка ${row.excelRow}, «${row.templateRow.category}»: ${fmt(row.units)} расчётных единиц, ` +
            'но норматив не сопоставлен — масса и объём останутся нулевыми.'),
        );
      }
    } else if (row.normMass === null || row.normVolume === null) {
      issues.push(
        issue('warning', 'half-norm', 'Норматив задан частично',
          `Строка ${row.excelRow}, «${row.templateRow.category}»: известен только ` +
          `${row.normMass === null ? 'объём' : 'масса'}.`),
      );
    }

    // 5. Автосопоставления с невысокой схожестью должны быть подтверждены вручную.
    const mapping = normMapping.get(row.categoryKey);
    if (mapping && mapping.auto && mapping.status === 'weak' && mapping.entryId) {
      const entry = normById.get(mapping.entryId);
      issues.push(
        issue('warning', 'unconfirmed', 'Сопоставление не подтверждено',
          `Строка ${row.excelRow}, «${row.templateRow.category}»: норматив подобран автоматически ` +
          `по неполному совпадению наименований (${Math.round(mapping.score * 100)} %) — ` +
          `«${entry ? entry.name : mapping.entryId}». Требуется ручная проверка.`),
      );
    }

    // 6. Совпадение расчётной единицы шаблона и базы норматива.
    if (mapping && mapping.mode === 'single' && mapping.entryId) {
      const entry = normById.get(mapping.entryId);
      const templateBasis = unitBasis(row.templateRow.unit);
      if (entry && templateBasis && entry.basis && entry.basis !== 'other' && entry.basis !== templateBasis) {
        issues.push(
          issue('warning', 'basis', 'Разные расчётные единицы',
            `Строка ${row.excelRow}, «${row.templateRow.category}»: в шаблоне «${row.templateRow.unit}», ` +
            `норматив «${entry.name}» установлен ${BASIS_LABELS[entry.basis] || entry.basis}.`),
        );
      }
    }

    // 7. Арифметика по записанным в файл значениям.
    if (!noNorm && row.units > 0) {
      const writtenMass = round(row.mass, 2) ?? 0;
      const writtenVolume = round(row.volume, 2) ?? 0;
      const expectedMass = round((row.normMass * row.units) / KG_PER_TONNE, 2) ?? 0;
      const expectedVolume = round(row.normVolume * row.units, 2) ?? 0;
      if (Math.abs(writtenMass - expectedMass) > TOLERANCE || Math.abs(writtenVolume - expectedVolume) > TOLERANCE) {
        issues.push(
          issue('error', 'arithmetic', 'Ошибка расчёта',
            `Строка ${row.excelRow}: масса ${fmt(writtenMass)} т при ожидаемых ${fmt(expectedMass)} т, ` +
            `объём ${fmt(writtenVolume)} м³ при ожидаемых ${fmt(expectedVolume)} м³.`),
        );
      }
      const writtenDensity = round(row.density, 2) ?? 0;
      if (writtenVolume > 0) {
        const expectedDensity = round(writtenMass / writtenVolume, 2) ?? 0;
        if (Math.abs(writtenDensity - expectedDensity) > 0.02) {
          issues.push(
            issue('warning', 'density', 'Плотность не сходится с массой и объёмом',
              `Строка ${row.excelRow}: записано ${writtenDensity} т/м³, ` +
              `отношение округлённых массы и объёма даёт ${expectedDensity} т/м³.`),
          );
        }
      }
    }
  }

  // 8. В выгрузке нет количества расчётных единиц.
  if (registry.hasUnits === false) {
    issues.push(
      issue('error', 'no-units', 'В реестре нет количества расчётных единиц',
        `В выгрузке отсутствует столбец с количеством расчётных единиц, поэтому столбец G `
        + `заполнен нулями, а масса и объём не рассчитаны. Заполнено только количество `
        + `источников (${fmt(registry.totalRows)} строк). Нужна выгрузка реестра со столбцом `
        + '«Количество расчетных единиц».'),
    );
  }

  // 9. Нулевые источники.
  if (registry.zeroRows > 0) {
    issues.push(
      issue('info', 'zero-sources', 'Источники с нулевым количеством единиц',
        `В реестре ${fmt(registry.zeroRows)} строк с нулевым количеством расчётных единиц — ` +
        'они не учтены в столбце «Количество источников», но учтены в сумме единиц (вклад нулевой).'),
    );
  }

  const totalMass = results.rows.reduce((sum, row) => sum + (round(row.mass, 2) ?? 0), 0);
  const totalVolume = results.rows.reduce((sum, row) => sum + (round(row.volume, 2) ?? 0), 0);

  const summary = {
    templateRows: templateRows.length,
    rowsWithData,
    rowsEmpty,
    rowsWithoutNorm,
    registryRows: registry.totalRows,
    registryZeroRows: registry.zeroRows,
    registryCategories: registry.categories.length,
    totalSources: totalSourcesResult,
    totalUnits: round(totalUnitsResult, 2),
    totalMass: round(totalMass, 2),
    totalVolume: round(totalVolume, 2),
    averageDensity: totalVolume ? round(totalMass / totalVolume, 3) : null,
    unassignedGroups: results.unassigned.length,
    errors: 0,
    warnings: 0,
  };
  summary.errors = issues.filter((item) => item.level === 'error').length;
  summary.warnings = issues.filter((item) => item.level === 'warning').length;

  return { summary, issues, checks };
}
