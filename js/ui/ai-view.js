// Панель помощника: что уходит из браузера, что он предложил,
// что изменится при применении. Задачи две — нормативы и реестр.

import { el, clear, num } from './dom.js';
import { describeNormsDocument } from '../ai/norms-extract.js';
import { describeSample as describeRegistrySample } from '../ai/registry-markup.js';
import { isCustomEndpoint } from '../ai/client.js';

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
    el('div.detail', {}, 'Неполный или некорректный ответ не применяется. Предыдущий результат сохранён.'),
  ]);
}

function errorBlock(message) {
  return el('div.issue.error', {}, [
    el('div.title', {}, 'Помощник не справился'),
    el('div.detail', {}, message),
    el('div.detail', {}, 'Предыдущий результат сохранён. Если ИИ ещё не извлекал данные, доступны только результаты встроенного разбора.'),
  ]);
}

function appliedBlock(title, detail, onReset) {
  return el('div.issue.info', {}, [
    el('div.title', {}, `Применено: ${title}`),
    el('div.detail', {}, [
      `${detail} `,
      el('button.button.small', { type: 'button', onclick: onReset }, 'Вернуть встроенный разбор'),
    ]),
  ]);
}

/** Предложение по нормативам. */
function normsProposal(proposal, actions) {
  const { summary } = proposal;
  return el('div.issue.info', {}, [
    el('div.title', {}, 'Нормативы извлечены из полного документа'),
    el('div.detail', {}, summary.reason),
    el('ul.detail', {}, [
      el('li', {}, `Всего записей: ${summary.count}`),
      el('li', {}, `Из них с массой: ${summary.withMass}, с объёмом: ${summary.withVolume}`),
      ...summary.warnings.map((warning) => el('li.loss', {}, warning)),
    ]),
    el('div.detail', {}, 'Значения приведены к кг/год и м³/год на одну расчётную единицу. Проверьте распознавание по исходному документу, особенно для сканов.'),
    el('button.button.small', { type: 'button', onclick: () => actions.downloadNorms() }, 'Скачать извлечённые нормативы (.xlsx)'),
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
  const normsEntry = state.files.find((item) => item.kind === 'norms' && item.buffer);
  block.hidden = !normsEntry && !registryEntry;
  normsButton.disabled = !normsEntry || !state.ai.endpoint || state.ai.norms.status === 'running';
  registryButton.disabled = !registryEntry || !state.ai.endpoint || state.ai.registry.status === 'running';
  if (block.hidden) return;

  if (isCustomEndpoint(state.ai.endpoint)) {
    result.append(el('p.hint', {}, `Используется свой прокси: ${state.ai.endpoint}`));
  }

  if (state.norms && state.norms.source && state.norms.source !== 'эвристика') {
    result.append(appliedBlock(`нормативы — ${state.norms.source}`,
      `Распознано нормативов: ${state.norms.entries.length}.`,
      () => actions.aiReset('norms')));
  } else if (state.norms && !state.norms.entries.length && state.ai.norms.status !== 'running') {
    result.append(el('div.issue.error', {}, [
      el('div.title', {}, 'Нормативы не распознаны'),
      el('div.detail', {}, 'Нажмите «Извлечь нормативы с ИИ», чтобы обработать исходный документ целиком, включая сканы.'),
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
      el('div.detail', {}, 'Нажмите «Проверить реестр», чтобы помощник определил столбцы заново.'),
    ]));
  } else if (registry && !registry.hasUnits) {
    result.append(el('div.issue.warning', {}, [
      el('div.title', {}, 'В реестре не найдено количество расчётных единиц'),
      el('div.detail', {}, 'Столбец G останется нулевым, масса и объём не рассчитаются. '
        + 'Если столбец в файле всё же есть, нажмите «Проверить реестр».'),
    ]));
  }

  for (const [which, describe, render] of [
    ['norms', describeNormsDocument, normsProposal],
    ['registry', describeRegistrySample, registryProposal],
  ]) {
    const task = state.ai[which];
    if (task.status === 'running') {
      result.append(el('p.hint', {}, which === 'norms'
        ? 'ИИ читает весь документ и извлекает нормативы. Это может занять несколько минут…' : 'Помощник проверяет разбор выгрузки реестра…'));
      continue;
    }
    if (task.error) result.append(errorBlock(task.error));
    if (task.sample) result.append(which === 'norms'
      ? el('details', {}, [el('summary', {}, `Что отправлено ИИ: ${task.sample.name} целиком`),
        el('pre.sample', {}, describe(task.sample))])
      : sampleBlock(task.sample, describe));
    if (which === 'norms' && task.applied) result.append(normsProposal(task.applied, actions));
    if (!task.proposal) continue;
    result.append(task.proposal.ok ? render(task.proposal, actions) : problemsBlock(task.proposal.problems));
  }

  const proposal = state.ai.norms.applied;
  if (proposal && proposal.ok) {
    result.append(el('details', {}, [
      el('summary', {}, `Все извлечённые нормативы (${proposal.preview.entries.length})`),
      el('div.table-scroll', {}, el('table.grid.compact', {}, [
        el('thead', {}, el('tr', {}, [
          el('th', {}, 'Категория'),
          el('th', {}, 'Расчётная единица'),
          el('th.num', {}, 'Масса, кг/год'),
          el('th.num', {}, 'Объём, м³/год'),
          el('th', {}, 'Статус значений'),
          el('th', {}, 'Источник в документе'),
        ])),
        el('tbody', {}, proposal.preview.entries.map((entry) => el(
          entry.mass === null && entry.volume === null ? 'tr.row-attention' : 'tr', {}, [
          el('td', {}, entry.name),
          el('td', {}, entry.unitText),
          el('td.num', {}, num(entry.mass, true)),
          el('td.num', {}, num(entry.volume, true)),
          el('td', {}, entry.mass === null && entry.volume === null ? 'Не указаны в документе' : 'Указаны'),
          el('td', { title: entry.sourceQuote }, entry.sourceLocation),
        ]))),
      ])),
    ]));
  }
}
