// Сведение данных реестра по строкам шаблона и расчёт массы, объёма и плотности.

import { normalize } from './text.js';
import { evaluate } from './formula.js';

export const KG_PER_TONNE = 1000;

/**
 * Округление «половина вверх» до заданного числа знаков.
 * Масштабирование через экспоненциальную запись убирает ошибку двоичного
 * представления: 1.005 * 100 даёт 100.49999999999999 и округлилось бы вниз.
 */
export function round(value, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const sign = value < 0 ? -1 : 1;
  const scaled = Math.round(Number(`${Math.abs(value)}e${digits}`));
  const result = Number(`${scaled}e-${digits}`);
  return Number.isFinite(result) ? sign * result : null;
}

/**
 * Возвращает норматив (масса кг/год, объём м³/год) для категории шаблона.
 * @param {object} mapping правило сопоставления
 * @param {Map<string, object>} normById нормативы по идентификатору
 */
export function resolveNorm(mapping, normById) {
  if (!mapping) return { mass: null, volume: null, error: null };
  if (mapping.mode === 'none' || mapping.mode === 'ignored') {
    return { mass: null, volume: null, error: null };
  }
  if (mapping.mode === 'manual') {
    return {
      mass: Number.isFinite(mapping.manualMass) ? mapping.manualMass : null,
      volume: Number.isFinite(mapping.manualVolume) ? mapping.manualVolume : null,
      error: null,
    };
  }
  if (mapping.mode === 'formula') {
    try {
      const mass = evaluate(mapping.expression, (id) => normById.get(id)?.mass ?? null);
      const volume = evaluate(mapping.expression, (id) => normById.get(id)?.volume ?? null);
      return { mass, volume, error: null };
    } catch (error) {
      return { mass: null, volume: null, error: error.message };
    }
  }
  const entry = mapping.entryId ? normById.get(mapping.entryId) : null;
  if (!entry) return { mass: null, volume: null, error: null };
  return { mass: entry.mass, volume: entry.volume, error: null };
}

/**
 * Собирает итоговую таблицу по строкам шаблона.
 *
 * @param {object} input
 * @param {Array} input.templateRows строки шаблона
 * @param {Map} input.registryGroups группы реестра «зона||категория»
 * @param {Map} input.registryMapping категория реестра → категория шаблона
 * @param {Map} input.zoneMapping зона реестра → зона шаблона
 * @param {Map} input.normMapping категория шаблона → правило норматива
 * @param {Map} input.normById нормативы по идентификатору
 */
export function buildResults({
  templateRows,
  registryGroups,
  registryMapping,
  zoneMapping,
  normMapping,
  normById,
}) {
  // Каждая группа реестра адресуется в строку шаблона: зона → зона, категория → категория.
  const targets = new Map(); // «зонаШаблона||категорияШаблона» → агрегат
  const unassigned = [];

  for (const group of registryGroups.values()) {
    const zoneRule = zoneMapping.get(group.zoneKey);
    const categoryRule = registryMapping.get(group.categoryKey);
    const zoneKey = zoneRule && zoneRule.templateKey;
    const categoryKey = categoryRule && categoryRule.templateKey;
    if (!zoneKey || !categoryKey) {
      unassigned.push({
        zone: group.zone,
        category: group.category,
        sources: group.sources,
        units: group.units,
        rows: group.rows,
        reason: !zoneKey ? 'зона не сопоставлена' : 'категория не сопоставлена',
      });
      continue;
    }
    const key = `${zoneKey}||${categoryKey}`;
    let target = targets.get(key);
    if (!target) {
      target = { sources: 0, units: 0, rows: 0, zeroSources: 0, parts: [] };
      targets.set(key, target);
    }
    target.sources += group.sources;
    target.units += group.units;
    target.rows += group.rows;
    target.zeroSources += group.sourcesWithZero;
    target.parts.push({
      zone: group.zone,
      category: group.category,
      sources: group.sources,
      units: group.units,
    });
  }

  const seen = new Set();
  const duplicates = [];
  const rows = templateRows.map((templateRow) => {
    const categoryKey = normalize(templateRow.category);
    const zoneKey = normalize(templateRow.zone);
    const key = `${zoneKey}||${categoryKey}`;
    const duplicate = seen.has(key);
    if (duplicate) duplicates.push({ excelRow: templateRow.excelRow, zone: templateRow.zone, category: templateRow.category });
    seen.add(key);

    const aggregate = duplicate ? null : targets.get(key);
    const mapping = normMapping.get(categoryKey);
    const norm = resolveNorm(mapping, normById);

    const units = aggregate ? aggregate.units : 0;
    const sources = aggregate ? aggregate.sources : 0;
    const massKg = norm.mass === null ? null : norm.mass * units;
    const mass = massKg === null ? null : massKg / KG_PER_TONNE;
    const volume = norm.volume === null ? null : norm.volume * units;
    const density = mass !== null && volume ? mass / volume : null;

    return {
      templateRow,
      excelRow: templateRow.excelRow,
      categoryKey,
      zoneKey,
      duplicate,
      sources,
      units,
      registryRows: aggregate ? aggregate.rows : 0,
      zeroSources: aggregate ? aggregate.zeroSources : 0,
      parts: aggregate ? aggregate.parts : [],
      normMass: norm.mass,
      normVolume: norm.volume,
      normError: norm.error,
      normMode: mapping ? mapping.mode : 'none',
      mass,
      volume,
      density,
    };
  });

  const usedKeys = new Set(rows.filter((row) => !row.duplicate).map((row) => `${row.zoneKey}||${row.categoryKey}`));
  for (const [key, target] of targets) {
    if (!usedKeys.has(key)) {
      for (const part of target.parts) {
        unassigned.push({ ...part, rows: target.rows, reason: 'нет такой строки в шаблоне' });
      }
    }
  }

  return { rows, unassigned, duplicates };
}

/** Значения, которые попадут в файл (с учётом округления и замены пустых на 0). */
export function formatRow(row) {
  return {
    sources: row.sources || 0,
    units: round(row.units, 0) ?? 0,
    mass: round(row.mass, 2) ?? 0,
    volume: round(row.volume, 2) ?? 0,
    density: round(row.density, 2) ?? 0,
    normMass: row.normMass === null ? null : row.normMass,
    normVolume: row.normVolume === null ? null : row.normVolume,
  };
}
