// Таблица соответствий «категория формы ↔ норматив» с ручной правкой.

import { el, clear, num, percent, headRow } from './dom.js';
import { STATUS_LABELS } from '../lib/match.js';
import { BASIS_LABELS } from '../lib/units.js';
import { humanize, validate } from '../lib/formula.js';

const MODES = [
  ['single', 'Норматив из справочника'],
  ['formula', 'Формула'],
  ['manual', 'Значения вручную'],
  ['none', 'Не сопоставлять'],
];

const ATTENTION = new Set(['weak', 'none']);

function statusBadge(mapping) {
  const status = mapping.status || 'none';
  return el(`span.badge.${status}`, {}, STATUS_LABELS[status] || status);
}

function normSelect(mapping, norms, onChange) {
  const select = el('select.wide', { onchange: (event) => onChange(event.target.value || null) });
  select.append(el('option', { value: '' }, '— не выбрано —'));

  const candidates = mapping.candidates || [];
  const suggestedIds = new Set(candidates.map((item) => item.id));
  if (candidates.length) {
    const group = el('optgroup', { label: 'Похожие наименования' });
    for (const candidate of candidates) {
      group.append(el('option', {
        value: candidate.id,
        selected: candidate.id === mapping.entryId,
      }, `${candidate.name} — ${percent(candidate.score)}`));
    }
    select.append(group);
  }
  const group = el('optgroup', { label: 'Все нормативы' });
  for (const entry of norms) {
    if (suggestedIds.has(entry.id)) continue;
    group.append(el('option', {
      value: entry.id,
      selected: entry.id === mapping.entryId,
    }, `${entry.name} (${BASIS_LABELS[entry.basis] || entry.basis || '—'})`));
  }
  select.append(group);
  return select;
}

function formulaEditor(mapping, norms, normById, onChange) {
  const box = el('div.formula-row');
  const input = el('input.formula', {
    type: 'text',
    value: mapping.expression || '',
    placeholder: 'например: [n5] + [n7] или 0,5*[n5]',
    size: 28,
  });
  const preview = el('div.preview');
  const error = el('div.error-text');

  const refresh = () => {
    const message = mapping.expression ? validate(mapping.expression, new Set(normById.keys())) : 'Формула не задана';
    error.textContent = message || '';
    preview.textContent = mapping.expression
      ? humanize(mapping.expression, (id) => normById.get(id)?.name)
      : '';
  };

  input.addEventListener('change', () => onChange(input.value));
  input.addEventListener('blur', () => onChange(input.value));

  const insert = el('select', {
    onchange: (event) => {
      if (!event.target.value) return;
      const token = `[${event.target.value}]`;
      input.value = input.value.trim() ? `${input.value.trim()} + ${token}` : token;
      event.target.value = '';
      onChange(input.value);
    },
  });
  insert.append(el('option', { value: '' }, '+ добавить норматив…'));
  for (const entry of norms) {
    insert.append(el('option', { value: entry.id }, entry.name));
  }

  refresh();
  box.append(input, insert, preview, error);
  return box;
}

function manualEditor(mapping, onChange) {
  const box = el('div.manual-inputs');
  const mass = el('input', {
    type: 'number', step: 'any', placeholder: 'масса, кг/год',
    value: Number.isFinite(mapping.manualMass) ? mapping.manualMass : '',
  });
  const volume = el('input', {
    type: 'number', step: 'any', placeholder: 'объём, м³/год',
    value: Number.isFinite(mapping.manualVolume) ? mapping.manualVolume : '',
  });
  const commit = () => onChange(
    mass.value === '' ? null : Number(mass.value),
    volume.value === '' ? null : Number(volume.value),
  );
  mass.addEventListener('change', commit);
  volume.addEventListener('change', commit);
  box.append(mass, volume);
  return box;
}

function matches(category, mapping, filter, search) {
  if (search && !category.name.toLowerCase().includes(search)) return false;
  if (filter === 'attention') return ATTENTION.has(mapping.status) || mapping.mode === 'none';
  if (filter === 'none') return mapping.mode === 'none' || (!mapping.entryId && mapping.mode === 'single');
  if (filter === 'manual') return mapping.auto === false;
  return true;
}

/** Отрисовывает таблицу сопоставления нормативов. */
export function renderNormsMapping(state, actions) {
  const table = document.getElementById('norms-table');
  clear(table);
  const filter = document.getElementById('norms-filter').value;
  const search = document.getElementById('norms-search').value.trim().toLowerCase();

  table.append(el('thead', {}, headRow([
    'Категория (форма общих сведений)',
    'Статус',
    'Способ сопоставления',
    'Норматив',
    ['Масса, кг/год', true],
    ['Объём, м³/год', true],
    '',
  ])));

  const resultByKey = new Map(state.results ? state.results.rows.map((row) => [row.categoryKey, row]) : []);
  const body = el('tbody');
  let shown = 0;

  for (const category of state.categories) {
    const mapping = state.normMapping.get(category.key);
    if (!matches(category, mapping, filter, search)) continue;
    shown += 1;
    const result = resultByKey.get(category.key);

    let control;
    if (mapping.mode === 'formula') {
      control = formulaEditor(mapping, state.norms.entries, state.normById,
        (expression) => actions.setNormRule(category.key, { expression }));
    } else if (mapping.mode === 'manual') {
      control = manualEditor(mapping, (manualMass, manualVolume) =>
        actions.setNormRule(category.key, { manualMass, manualVolume }));
    } else if (mapping.mode === 'single') {
      control = normSelect(mapping, state.norms.entries, (entryId) =>
        actions.setNormRule(category.key, { entryId }));
    } else {
      control = el('span.hint', {}, 'норматив не применяется');
    }

    const modeSelect = el('select', {
      onchange: (event) => actions.setNormRule(category.key, { mode: event.target.value }),
    }, MODES.map(([value, label]) => el('option', { value, selected: mapping.mode === value }, label)));

    const rowClass = mapping.auto === false
      ? 'row-manual'
      : mapping.status === 'none' ? 'row-none' : ATTENTION.has(mapping.status) ? 'row-attention' : '';

    body.append(el(`tr${rowClass ? `.${rowClass}` : ''}`, {}, [
      el('td', {}, [
        el('div', {}, category.name),
        el('div.hint', {}, `${category.unit || 'единица не указана'} · строк формы: ${category.rows.length}`),
      ]),
      el('td', {}, [
        statusBadge(mapping),
        mapping.auto && mapping.mode === 'single' && mapping.entryId
          ? el('div.hint', {}, `схожесть ${percent(mapping.score)}`)
          : null,
      ]),
      el('td', {}, modeSelect),
      el('td', {}, control),
      el('td.num', {}, result ? num(result.normMass, true) : '—'),
      el('td.num', {}, result ? num(result.normVolume, true) : '—'),
      el('td', {}, mapping.auto === false
        ? el('button.button.small', {
          type: 'button',
          onclick: () => actions.resetNormRule(category.key),
          title: 'Вернуть автоматически подобранное соответствие',
        }, 'Сброс')
        : null),
    ]));
  }

  table.append(body);

  const counts = { exact: 0, auto: 0, weak: 0, none: 0, manual: 0 };
  for (const category of state.categories) {
    const mapping = state.normMapping.get(category.key);
    if (mapping.auto === false) counts.manual += 1;
    else counts[mapping.status] = (counts[mapping.status] || 0) + 1;
  }
  document.getElementById('norms-stats').textContent =
    `показано ${shown} из ${state.categories.length} · точных ${counts.exact}, ` +
    `автоматических ${counts.auto}, требуют проверки ${counts.weak}, ` +
    `не найдено ${counts.none}, вручную ${counts.manual}`;
}
