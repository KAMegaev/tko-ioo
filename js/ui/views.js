// Представления: файлы, сопоставление реестра, расчёт и проверка.

import { el, clear, num, percent, headRow } from './dom.js';
import { STATUS_LABELS } from '../lib/match.js';
import { round } from '../lib/calc.js';

const KIND_LABELS = {
  template: 'Выгрузка общих сведений (шаблон)',
  norms: 'Нормативы накопления ТКО',
  registry: 'Выгрузка реестра ИОО',
  unknown: 'Вид не определён',
};

/** Список загруженных файлов с возможностью сменить их вид. */
export function renderFiles(state, actions) {
  const list = document.getElementById('file-list');
  clear(list);

  for (const file of state.files) {
    const fileCard = el(`div.file-card${file.error ? '.error' : ''}`);
    const kindSelect = el('select', {
      onchange: (event) => actions.changeKind(file.id, event.target.value),
    }, Object.entries(KIND_LABELS)
      .filter(([value]) => value !== 'unknown' || file.kind === 'unknown')
      .map(([value, label]) => el('option', { value, selected: file.kind === value }, label)));

    fileCard.append(
      el('div.grow', {}, [
        el('div.name', {}, file.name),
        el('div.meta', {}, file.error ? `Ошибка: ${file.error}` : file.info || 'Обработка…'),
      ]),
      el('div', {}, kindSelect),
      el('button.button.small', { type: 'button', onclick: () => actions.removeFile(file.id) }, 'Убрать'),
    );
    list.append(fileCard);
  }

  const summary = document.getElementById('file-summary');
  clear(summary);
  if (!state.files.length) return;

  const cards = el('div.cards');
  if (state.template) {
    cards.append(card('Строк в форме', state.template.rows.length,
      `лист «${state.template.sheetName}», заголовок в строке ${state.template.headerRow}`));
  }
  if (state.norms) {
    cards.append(card('Нормативов распознано', state.norms.entries.length,
      `таблиц: ${state.norms.tables.length}`));
  }
  if (state.registry) {
    cards.append(card('Строк реестра', state.registry.totalRows,
      `категорий: ${state.registry.categories.length}, зон: ${state.registry.zones.length}`));
    cards.append(card('С нулевым количеством', state.registry.zeroRows,
      'не учитываются в количестве источников'));
  }
  summary.append(cards);

  if (!state.template || !state.norms || !state.registry) {
    const missing = [
      !state.template && 'форму общих сведений',
      !state.norms && 'файл нормативов',
      !state.registry && 'выгрузку реестра ИОО',
    ].filter(Boolean);
    summary.append(el('p.hint', {}, `Осталось загрузить: ${missing.join(', ')}.`));
  }
}

function card(label, value, hint) {
  return el('div.card', {}, [
    el('div.value', {}, typeof value === 'string' ? value : num(value)),
    el('div.label', {}, label),
    hint ? el('div.label', {}, hint) : null,
  ]);
}

/** Сопоставление зон деятельности. */
export function renderZones(state, actions) {
  const table = document.getElementById('zones-table');
  clear(table);
  table.append(el('thead', {}, headRow([
    'Зона деятельности (реестр ИОО)', ['Строк', true], 'Зона в форме общих сведений', 'Статус',
  ])));
  const body = el('tbody');
  for (const zone of state.registry.zones) {
    const mapping = state.zoneMapping.get(zone.key);
    const select = el('select.wide', {
      onchange: (event) => actions.setZoneRule(zone.key, event.target.value || null),
    }, [
      el('option', { value: '' }, '— не сопоставлено —'),
      ...state.templateZones.map((item) =>
        el('option', { value: item.id, selected: mapping.templateKey === item.id }, item.name)),
    ]);
    const rowClass = mapping.templateKey ? (mapping.auto === false ? 'row-manual' : '') : 'row-none';
    body.append(el(`tr${rowClass ? `.${rowClass}` : ''}`, {}, [
      el('td', {}, zone.name),
      el('td.num', {}, num(zone.rows)),
      el('td', {}, select),
      el('td', {}, el(`span.badge.${mapping.status}`, {}, STATUS_LABELS[mapping.status])),
    ]));
  }
  table.append(body);
}

/** Сопоставление категорий реестра со строками формы. */
export function renderRegistryMapping(state, actions) {
  const table = document.getElementById('registry-table');
  clear(table);
  const filter = document.getElementById('registry-filter').value;
  const search = document.getElementById('registry-search').value.trim().toLowerCase();

  table.append(el('thead', {}, headRow([
    'Категория (реестр ИОО)',
    ['Строк', true],
    ['Источников', true],
    ['Расчётных единиц', true],
    'Категория в форме общих сведений',
    'Статус',
    '',
  ])));

  const body = el('tbody');
  let shown = 0;
  let unmapped = 0;

  for (const category of state.registry.categories) {
    const mapping = state.registryMapping.get(category.key);
    if (!mapping.templateKey) unmapped += 1;
    if (search && !category.name.toLowerCase().includes(search)) continue;
    if (filter === 'attention' && (mapping.status === 'exact' || mapping.status === 'auto') && mapping.auto !== false) continue;
    if (filter === 'none' && mapping.templateKey) continue;
    if (filter === 'manual' && mapping.auto !== false) continue;
    shown += 1;

    const candidateIds = new Set((mapping.candidates || []).map((item) => item.id));
    const select = el('select.wide', {
      onchange: (event) => actions.setRegistryRule(category.key, event.target.value || null),
    });
    select.append(el('option', { value: '' }, '— не переносить в форму —'));
    if (mapping.candidates && mapping.candidates.length) {
      const group = el('optgroup', { label: 'Похожие наименования' });
      for (const candidate of mapping.candidates) {
        group.append(el('option', {
          value: candidate.id, selected: candidate.id === mapping.templateKey,
        }, `${candidate.name} — ${percent(candidate.score)}`));
      }
      select.append(group);
    }
    const group = el('optgroup', { label: 'Все категории формы' });
    for (const item of state.categories) {
      if (candidateIds.has(item.key)) continue;
      group.append(el('option', { value: item.key, selected: item.key === mapping.templateKey }, item.name));
    }
    select.append(group);

    const rowClass = mapping.auto === false
      ? 'row-manual'
      : !mapping.templateKey ? 'row-none' : mapping.status === 'weak' ? 'row-attention' : '';

    body.append(el(`tr${rowClass ? `.${rowClass}` : ''}`, {}, [
      el('td', {}, category.name),
      el('td.num', {}, num(category.rows)),
      el('td.num', {}, num([...state.registry.groups.values()]
        .filter((group_) => group_.categoryKey === category.key)
        .reduce((sum, group_) => sum + group_.sources, 0))),
      el('td.num', {}, num(category.units)),
      el('td', {}, select),
      el('td', {}, el(`span.badge.${mapping.auto === false ? 'manual' : mapping.status}`, {},
        mapping.auto === false ? 'Задано вручную' : STATUS_LABELS[mapping.status])),
      el('td', {}, mapping.auto === false
        ? el('button.button.small', { type: 'button', onclick: () => actions.resetRegistryRule(category.key) }, 'Сброс')
        : null),
    ]));
  }
  table.append(body);

  document.getElementById('registry-stats').textContent =
    `показано ${shown} из ${state.registry.categories.length} · не переносится в форму: ${unmapped}`;
}

/** Предпросмотр того, что будет записано в файл. */
export function renderResults(state) {
  const table = document.getElementById('result-table');
  clear(table);
  if (!state.results) return;
  const onlyData = document.getElementById('result-only-data').checked;

  table.append(el('thead', {}, headRow([
    ['Строка', true],
    'Категория потребителя',
    'Ед. изм.',
    ['F: источников', true],
    ['G: расчётных единиц', true],
    ['H: масса, т', true],
    ['I: объём, м³', true],
    ['J: плотность, т/м³', true],
    ['Норматив, кг/год', true],
    ['Норматив, м³/год', true],
  ])));

  const body = el('tbody');
  let shown = 0;
  for (const row of state.results.rows) {
    const hasData = row.units > 0 || row.sources > 0;
    if (onlyData && !hasData) continue;
    shown += 1;
    const noNorm = row.normMass === null && row.normVolume === null;
    const rowClass = row.normError || (noNorm && hasData) ? 'row-none' : row.duplicate ? 'row-attention' : '';
    body.append(el(`tr${rowClass ? `.${rowClass}` : ''}`, {}, [
      el('td.num', {}, row.excelRow),
      el('td', {}, row.templateRow.category),
      el('td', {}, row.templateRow.unit),
      el('td.num', {}, num(row.sources || 0)),
      el('td.num', {}, num(round(row.units, 0) ?? 0)),
      el('td.num', {}, num(round(row.mass, 2) ?? 0)),
      el('td.num', {}, num(round(row.volume, 2) ?? 0)),
      el('td.num', {}, num(round(row.density, 2) ?? 0)),
      el('td.num', {}, num(row.normMass, true)),
      el('td.num', {}, num(row.normVolume, true)),
    ]));
  }
  table.append(body);

  const summary = state.verification ? state.verification.summary : null;
  document.getElementById('result-stats').textContent = summary
    ? `строк ${shown} из ${state.results.rows.length} · итого ${num(summary.totalUnits)} расчётных единиц, ` +
      `${num(summary.totalMass)} т, ${num(summary.totalVolume)} м³`
    : '';
}

/** Число с существительным в правильном падеже: 1 ошибка, 2 ошибки, 5 ошибок. */
function plural(count, one, few, many) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  let word = many;
  if (mod10 === 1 && mod100 !== 11) word = one;
  else if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) word = few;
  return `${count} ${word}`;
}

/** Сводка проверки, контрольные сверки и замечания. */
export function renderCheck(state) {
  const summaryBox = document.getElementById('check-summary');
  const table = document.getElementById('check-table');
  const issuesBox = document.getElementById('check-issues');
  clear(summaryBox);
  clear(table);
  clear(issuesBox);
  if (!state.verification) return;

  const { summary, checks, issues } = state.verification;
  const status = summary.errors ? 'error' : summary.warnings ? 'warn' : 'ok';
  const headline = summary.errors
    ? plural(summary.errors, 'ошибка', 'ошибки', 'ошибок')
    : summary.warnings ? plural(summary.warnings, 'предупреждение', 'предупреждения', 'предупреждений')
      : 'Без замечаний';
  summaryBox.append(
    el(`div.card.${status}`, {}, [
      el('div.value', {}, headline),
      el('div.label', {}, summary.errors ? 'требуется исправление' : summary.warnings ? 'стоит проверить' : 'файл не противоречит реестру'),
    ]),
    card('Строк с данными', `${summary.rowsWithData} из ${summary.templateRows}`, ''),
    card('Итого источников (F)', summary.totalSources, ''),
    card('Итого расчётных единиц (G)', summary.totalUnits, ''),
    card('Итого масса, т (H)', summary.totalMass, ''),
    card('Итого объём, м³ (I)', summary.totalVolume, ''),
    card('Категорий без норматива', summary.rowsWithoutNorm, ''),
    card('Групп реестра вне формы', summary.unassignedGroups, ''),
  );

  table.append(el('thead', {}, headRow(['Проверка', ['По реестру', true], ['В расчёте', true], 'Результат'])));
  table.append(el('tbody', {}, checks.map((check) => el('tr', {}, [
    el('td', {}, check.name),
    el('td.num', {}, num(check.expected)),
    el('td.num', {}, num(check.actual)),
    el('td', {}, el(`span.badge.${check.ok ? 'exact' : 'none'}`, {}, check.ok ? 'сходится' : 'расхождение')),
  ]))));

  if (!issues.length) {
    issuesBox.append(el('div.issue.info', {}, [
      el('div.title', {}, 'Замечаний нет'),
      el('div.detail', {}, 'Расчёт полностью соответствует исходным данным реестра.'),
    ]));
    return;
  }
  const order = { error: 0, warning: 1, info: 2 };
  for (const item of [...issues].sort((a, b) => order[a.level] - order[b.level])) {
    issuesBox.append(el(`div.issue.${item.level}`, {}, [
      el('div.title', {}, item.title),
      el('div.detail', {}, item.detail),
    ]));
  }
}
