// Панель помощника: что уходит из браузера, что он предложил,
// что изменится при применении. Задачи две — нормативы и реестр.

import { el, clear, num } from './dom.js';
import { describeSample } from '../ai/norms-markup.js';
import { describeSample as describeRegistrySample } from '../ai/registry-markup.js';
import { isCustomEndpoint } from '../ai/client.js';

const BASIS_TEXT = {
  person: 'на 1 человека',
  sqm: 'на 1 м²',
  place: 'на 1 место',
  other: 'иная расчётная единица',
};

function factorNote(label, factor, unit) {
  if (factor === null || factor === undefined) return null;
  const note = factor === 1 ? 'пересчёт не нужен' : `значения умножаются на ${num(factor)}`;
  return el('li', {}, `${label}: «${unit || '—'}» — ${note}`);
}

/** Блок «что уходит из браузера» — раскрывается по требованию. */
function sampleBlock(sample, describe) {
  const text = describe(sample);
  return el('details', {}, [
    el('summary', {}, `Что уходит из браузера: ${sample.length} шт., ${new Blob([text]).size} байт`),
    el('pre.sample', {}, text),
  ]);
}

function problemsBlock(problems) {
  return el('div.issue.error', {}, [
    el('div.title', {}, 'Предложение помощника отклонено проверкой'),
    el('ul.detail', {}, problems.map((problem) => el('li', {}, problem))),
    el('div.detail', {}, 'Ответ не сошёлся с содержимым файла, поэтому не применён.'),
  ]);
}

function errorBlock(message) {
  return el('div.issue.error', {}, [
    el('div.title', {}, 'Помощник не справился'),
    el('div.detail', {}, message),
    el('div.detail', {}, 'Разбор остался прежним — тем, что выполнили встроенные правила.'),
  ]);
}

function appliedBlock(title, detail, onReset) {
  return el('div.issue.info', {}, [
    el('div.title', {}, `Разметка задана: ${title}`),
    el('div.detail', {}, [
      `${detail} `,
      el('button.button.small', { type: 'button', onclick: onReset }, 'Вернуть автоматический разбор'),
    ]),
  ]);
}

/** Предложение по нормативам. */
function normsProposal(proposal, actions) {
  const { summary, compare: diff } = proposal;
  const tableLines = summary.tables.map((table) => el('li', {}, [
    `Таблица «${table.title}»: нормативов ${table.count}, ${BASIS_TEXT[table.basis] || 'единица определяется по строкам'}`,
    el('ul', {}, [
      factorNote('масса', table.massFactor, table.massUnit),
      factorNote('объём', table.volumeFactor, table.volumeUnit),
    ].filter(Boolean)),
  ]));

  return el('div.issue.info', {}, [
    el('div.title', {}, 'Предложение помощника: нормативы'),
    el('div.detail', {}, summary.reason),
    el('ul.detail', {}, [
      ...tableLines,
      el('li', {}, `Всего нормативов: ${summary.count} (было ${diff.countBefore})`),
      el('li', {}, `Из них с массой: ${summary.withMass}, с объёмом: ${summary.withVolume}`),
      summary.confidence !== null
        ? el('li', {}, `Уверенность помощника: ${Math.round(summary.confidence * 100)} %`) : null,
      diff.added.length
        ? el('li', {}, `Добавятся категории (${diff.added.length}): ${diff.added.slice(0, 5).join('; ')}${diff.added.length > 5 ? '…' : ''}`)
        : null,
      diff.removed.length
        ? el('li.loss', {}, `Исчезнут категории (${diff.removed.length}): ${diff.removed.slice(0, 5).join('; ')}${diff.removed.length > 5 ? '…' : ''}`)
        : null,
    ]),
    el('div.detail', {}, [
      el('button.button.small', { type: 'button', onclick: () => actions.aiApply() }, 'Применить'),
      ' ',
      el('button.button.small', { type: 'button', onclick: () => actions.aiDismiss('norms') }, 'Отклонить'),
    ]),
  ]);
}

/** Предложение по реестру. */
function registryProposal(proposal, actions) {
  const { summary } = proposal;
  return el('div.issue.info', {}, [
    el('div.title', {}, 'Предложение помощника: реестр'),
    el('div.detail', {}, summary.reason),
    el('ul.detail', {}, [
      el('li', {}, `Лист «${summary.sheet}», строк с данными: ${num(summary.rows)}`),
      el('li', {}, `Столбцы: ${Object.entries(summary.roles)
        .map(([role, column]) => `${role} — № ${column}`).join(', ')}`),
      el('li', {}, `Категорий: ${summary.categories}, зон: ${summary.zones}`
        + (summary.municipalities ? `, муниципальных образований: ${summary.municipalities}` : '')),
      summary.hasUnits
        ? null
        : el('li.loss', {}, 'Столбца с количеством расчётных единиц нет — столбец G останется нулевым'),
      summary.confidence !== null
        ? el('li', {}, `Уверенность помощника: ${Math.round(summary.confidence * 100)} %`) : null,
    ]),
    el('div.detail', {}, [
      el('button.button.small', { type: 'button', onclick: () => actions.aiApplyRegistry() }, 'Применить'),
      ' ',
      el('button.button.small', { type: 'button', onclick: () => actions.aiDismiss('registry') }, 'Отклонить'),
    ]),
  ]);
}

/** Отрисовывает блок помощника. */
export function renderAi(state, actions) {
  const block = document.getElementById('ai-block');
  const result = document.getElementById('ai-result');
  const normsButton = document.getElementById('ai-run');
  const registryButton = document.getElementById('ai-run-registry');
  clear(result);

  const registryEntry = state.files.find((item) => item.kind === 'registry' && item.buffer);
  block.hidden = !state.norms && !registryEntry;
  normsButton.disabled = !state.norms || !state.ai.endpoint || state.ai.norms.status === 'running';
  registryButton.disabled = !registryEntry || !state.ai.endpoint || state.ai.registry.status === 'running';
  if (block.hidden) return;

  if (isCustomEndpoint(state.ai.endpoint)) {
    result.append(el('p.hint', {}, `Используется свой прокси: ${state.ai.endpoint}`));
  }

  if (state.norms && state.norms.source && state.norms.source !== 'эвристика') {
    result.append(appliedBlock(`нормативы — ${state.norms.source}`,
      `Распознано нормативов: ${state.norms.entries.length}.`,
      () => actions.aiReset('norms')));
  } else if (state.norms && !state.norms.entries.length) {
    result.append(el('div.issue.error', {}, [
      el('div.title', {}, 'Нормативы не распознаны'),
      el('div.detail', {}, 'Ни одна таблица в файле не похожа на таблицу нормативов — '
        + 'нажмите «Разобрать нормативы».'),
    ]));
  }

  const registry = registryEntry && registryEntry.parsed;
  if (registry && registry.source && registry.source !== 'эвристика') {
    result.append(appliedBlock(`реестр — ${registry.source}`,
      `Лист «${registry.sheetName}», строк: ${registry.rows.length}.`,
      () => actions.aiReset('registry')));
  } else if (registryEntry && registryEntry.error) {
    result.append(el('div.issue.error', {}, [
      el('div.title', {}, 'Реестр не разобран'),
      el('div.detail', {}, registryEntry.error),
      el('div.detail', {}, 'Нажмите «Разобрать реестр», чтобы помощник определил столбцы.'),
    ]));
  } else if (registry && !registry.hasUnits) {
    result.append(el('div.issue.warning', {}, [
      el('div.title', {}, 'В реестре не найдено количество расчётных единиц'),
      el('div.detail', {}, 'Столбец G останется нулевым, масса и объём не рассчитаются. '
        + 'Если столбец в файле всё же есть, нажмите «Разобрать реестр».'),
    ]));
  }

  for (const [which, describe, render] of [
    ['norms', describeSample, normsProposal],
    ['registry', describeRegistrySample, registryProposal],
  ]) {
    const task = state.ai[which];
    if (task.status === 'running') {
      result.append(el('p.hint', {}, which === 'norms'
        ? 'Помощник разбирает таблицы нормативов…' : 'Помощник разбирает выгрузку реестра…'));
      continue;
    }
    if (task.error) result.append(errorBlock(task.error));
    if (task.sample) result.append(sampleBlock(task.sample, describe));
    if (!task.proposal) continue;
    result.append(task.proposal.ok ? render(task.proposal, actions) : problemsBlock(task.proposal.problems));
  }

  const proposal = state.ai.norms.proposal;
  if (proposal && proposal.ok) {
    result.append(el('details', {}, [
      el('summary', {}, 'Первые строки по предложенной разметке нормативов'),
      el('div.table-scroll', {}, el('table.grid.compact', {}, [
        el('thead', {}, el('tr', {}, [
          el('th', {}, 'Категория'),
          el('th.num', {}, 'Масса, кг/год'),
          el('th.num', {}, 'Объём, м³/год'),
        ])),
        el('tbody', {}, proposal.preview.entries.slice(0, 8).map((entry) => el('tr', {}, [
          el('td', {}, entry.name),
          el('td.num', {}, num(entry.mass, true)),
          el('td.num', {}, num(entry.volume, true)),
        ]))),
      ])),
    ]));
  }
}
