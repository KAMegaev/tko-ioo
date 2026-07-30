// Автоматическое сопоставление категорий: шаблон ↔ нормативы и реестр ↔ шаблон.

import { normalize, similarity } from './text.js';
import { unitBasis } from './units.js';

export const STATUS = {
  EXACT: 'exact',
  AUTO: 'auto',
  WEAK: 'weak',
  NONE: 'none',
  MANUAL: 'manual',
  FORMULA: 'formula',
  IGNORED: 'ignored',
};

export const STATUS_LABELS = {
  exact: 'Точное совпадение',
  auto: 'Сопоставлено автоматически',
  weak: 'Похоже, требует проверки',
  none: 'Не найдено',
  manual: 'Задано вручную',
  formula: 'Формула',
  ignored: 'Исключено вручную',
};

export const THRESHOLDS = { auto: 0.85, weak: 0.45 };

const BASIS_PENALTY = 0.6;

function statusFor(score) {
  if (score >= 0.999) return STATUS.EXACT;
  if (score >= THRESHOLDS.auto) return STATUS.AUTO;
  if (score >= THRESHOLDS.weak) return STATUS.WEAK;
  return STATUS.NONE;
}

/**
 * Ранжирует кандидатов из списка по похожести наименования.
 * @param {string} name искомое наименование
 * @param {Array<{id: string, name: string, basis?: string}>} candidates
 * @param {string|null} basis требуемый тип расчётной единицы
 */
export function rankCandidates(name, candidates, basis = null, limit = 5) {
  const scored = candidates.map((candidate) => {
    const base = similarity(name, candidate.name);
    const compatible =
      !basis || !candidate.basis || candidate.basis === 'other' || candidate.basis === basis;
    return {
      id: candidate.id,
      name: candidate.name,
      basis: candidate.basis || null,
      score: compatible ? base : base * BASIS_PENALTY,
      rawScore: base,
      basisMismatch: !compatible,
    };
  });
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'ru'));
  return scored.slice(0, limit);
}

/** Уникальные категории шаблона (несколько строк шаблона могут делить категорию). */
export function templateCategories(templateRows) {
  const map = new Map();
  for (const row of templateRows) {
    const key = normalize(row.category);
    if (!map.has(key)) {
      map.set(key, {
        key,
        name: row.category,
        unit: row.unit,
        basis: unitBasis(row.unit),
        rows: [],
        zones: new Set(),
      });
    }
    const category = map.get(key);
    category.rows.push(row.index);
    category.zones.add(row.zone);
    if (!category.unit && row.unit) {
      category.unit = row.unit;
      category.basis = unitBasis(row.unit);
    }
  }
  return [...map.values()];
}

/** Автосопоставление категорий шаблона с нормативами. */
export function matchNorms(categories, normEntries) {
  const pool = normEntries.map((entry) => ({ id: entry.id, name: entry.name, basis: entry.basis }));
  const result = new Map();
  for (const category of categories) {
    const candidates = rankCandidates(category.name, pool, category.basis);
    const best = candidates[0];
    result.set(category.key, {
      mode: 'single',
      entryId: best && best.score >= THRESHOLDS.weak ? best.id : null,
      score: best ? best.score : 0,
      status: best ? statusFor(best.score) : STATUS.NONE,
      auto: true,
      expression: '',
      manualMass: null,
      manualVolume: null,
      candidates,
    });
  }
  return result;
}

/** Автосопоставление категорий реестра со строками шаблона. */
export function matchRegistryCategories(registryCategories, categories) {
  const pool = categories.map((category) => ({
    id: category.key,
    name: category.name,
    basis: category.basis,
  }));
  const result = new Map();
  for (const registryCategory of registryCategories) {
    const candidates = rankCandidates(registryCategory.name, pool);
    const best = candidates[0];
    result.set(registryCategory.key, {
      templateKey: best && best.score >= THRESHOLDS.weak ? best.id : null,
      score: best ? best.score : 0,
      status: best ? statusFor(best.score) : STATUS.NONE,
      auto: true,
      candidates,
    });
  }
  return result;
}

/** Сопоставление зон деятельности реестра с зонами шаблона. */
export function matchZones(registryZones, templateRows) {
  const templateZones = new Map();
  for (const row of templateRows) {
    const key = normalize(row.zone);
    if (!templateZones.has(key)) templateZones.set(key, { id: key, name: row.zone });
  }
  const pool = [...templateZones.values()];
  const result = new Map();
  for (const zone of registryZones) {
    const candidates = rankCandidates(zone.name, pool);
    const best = candidates[0];
    result.set(zone.key, {
      templateKey: best && best.score >= THRESHOLDS.weak ? best.id : null,
      score: best ? best.score : 0,
      status: best ? statusFor(best.score) : STATUS.NONE,
      auto: true,
      candidates,
    });
  }
  return { zoneMapping: result, templateZones: pool };
}

export { statusFor };
