// Панель помощника разметки: что уходит из браузера, что он предложил,
// что изменится при применении.

import { el, clear, num } from './dom.js';
import { describeSample } from '../ai/norms-markup.js';
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

/** Отрисовывает блок помощника. */
export function renderAi(state, actions) {
  const block = document.getElementById('ai-block');
  const result = document.getElementById('ai-result');
  const runButton = document.getElementById('ai-run');
  clear(result);

  block.hidden = !state.norms;
  runButton.disabled = !state.norms || !state.ai.endpoint || state.ai.status === 'running';

  if (!state.norms) return;

  if (isCustomEndpoint(state.ai.endpoint)) {
    result.append(el('p.hint', {}, `Используется свой прокси: ${state.ai.endpoint}`));
  }

  if (state.norms.source && state.norms.source !== 'эвристика') {
    result.append(el('div.issue.info', {}, [
      el('div.title', {}, `Разметка нормативов задана: ${state.norms.source}`),
      el('div.detail', {}, [
        `Распознано нормативов: ${state.norms.entries.length}. `,
        el('button.button.small', { type: 'button', onclick: () => actions.aiReset() },
          'Вернуть автоматический разбор'),
      ]),
    ]));
  } else if (!state.norms.entries.length) {
    result.append(el('div.issue.error', {}, [
      el('div.title', {}, 'Нормативы не распознаны'),
      el('div.detail', {}, 'Ни одна таблица в файле не похожа на таблицу нормативов. '
        + 'Помощник может определить разметку, если задан адрес прокси.'),
    ]));
  }

  if (state.ai.status === 'running') {
    result.append(el('p.hint', {}, 'Помощник разбирает таблицы…'));
    return;
  }

  if (state.ai.error) {
    result.append(el('div.issue.error', {}, [
      el('div.title', {}, 'Помощник не справился'),
      el('div.detail', {}, state.ai.error),
      el('div.detail', {}, 'Разбор остался прежним — тем, что выполнили встроенные правила.'),
    ]));
  }

  if (state.ai.sample) {
    result.append(el('details', {}, [
      el('summary', {}, `Что уходит из браузера: ${state.ai.sample.length} таблиц, `
        + `${new Blob([describeSample(state.ai.sample)]).size} байт`),
      el('pre.sample', {}, describeSample(state.ai.sample)),
    ]));
  }

  const proposal = state.ai.proposal;
  if (!proposal) return;

  if (!proposal.ok) {
    result.append(el('div.issue.error', {}, [
      el('div.title', {}, 'Предложение помощника отклонено проверкой'),
      el('ul.detail', {}, proposal.problems.map((problem) => el('li', {}, problem))),
      el('div.detail', {}, 'Ответ не сошёлся с содержимым файла, поэтому не применён.'),
    ]));
    return;
  }

  const { summary, compare: diff } = proposal;
  const tableLines = summary.tables.map((table) => el('li', {}, [
    `Таблица «${table.title}»: нормативов ${table.count}, ${BASIS_TEXT[table.basis] || 'единица определяется по строкам'}`,
    el('ul', {}, [
      factorNote('масса', table.massFactor, table.massUnit),
      factorNote('объём', table.volumeFactor, table.volumeUnit),
    ].filter(Boolean)),
  ]));

  result.append(el('div.issue.info', {}, [
    el('div.title', {}, 'Предложение помощника'),
    el('div.detail', {}, summary.reason),
    el('ul.detail', {}, [
      ...tableLines,
      el('li', {}, `Всего нормативов: ${summary.count} (было ${diff.countBefore})`),
      el('li', {}, `Из них с массой: ${summary.withMass}, с объёмом: ${summary.withVolume}`),
      summary.confidence !== null
        ? el('li', {}, `Уверенность помощника: ${Math.round(summary.confidence * 100)} %`)
        : null,
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
      el('button.button.small', { type: 'button', onclick: () => actions.aiDismiss() }, 'Отклонить'),
    ]),
  ]));

  result.append(el('details', {}, [
    el('summary', {}, 'Первые строки по предложенной разметке'),
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
