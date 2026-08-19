// Восстановление таблиц из PDF.
//
// В PDF нет ни таблиц, ни строк, ни столбцов — только обрывки текста с
// координатами. Таблицу приходится собирать заново.
//
// Опора — порядок, в котором текст записан в файле. Программы, из которых
// приказы и выходят (Word, LibreOffice, КонсультантПлюс, печать из браузера),
// пишут таблицу по ячейкам: слева направо внутри строки, потом следующая
// строка. Отсюда два надёжных признака:
//
//   1. сменился левый край — началась следующая ячейка;
//   2. левый край вернулся назад, к уже занятому в этой строке столбцу, —
//      началась следующая строка таблицы.
//
// Расстояния между строками при этом второстепенны: они всего лишь страхуют
// случай, когда в двух строках подряд заполнен один и тот же единственный
// столбец. Признак «строка из одной ячейки — это абзац, а не строка таблицы»
// отделяет таблицы друг от друга и даёт подпись к следующей таблице.
//
// Восстановление может и ошибиться — например, склеить две таблицы, стоящие
// вплотную без текста между ними. Поэтому сетка сохраняется целиком: разметку
// можно задать заново вручную или с помощью помощника, как и для .docx.

/** Медиана; для пустого списка — null. */
function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Разбивает числа на группы: соседние значения в одной группе,
 * если расстояние между ними не больше допуска.
 * @returns {number[]} левая граница каждой группы
 */
export function clusterValues(values, tolerance) {
  const sorted = [...values].sort((a, b) => a - b);
  const groups = [];
  for (const value of sorted) {
    const last = groups[groups.length - 1];
    if (last && value - last[last.length - 1] <= tolerance) last.push(value);
    else groups.push([value]);
  }
  return groups.map((group) => group[0]);
}

/** Индекс ближайшей границы. */
function nearestIndex(edges, value) {
  let best = 0;
  for (let index = 1; index < edges.length; index += 1) {
    if (Math.abs(edges[index] - value) < Math.abs(edges[best] - value)) best = index;
  }
  return best;
}

/**
 * Межстрочный шаг внутри ячейки: расстояние между обрывками с одинаковым
 * левым краем. Такие обрывки почти всегда строки одной ячейки, поэтому
 * оценка получается устойчивой и не зависит от высоты строк таблицы.
 */
function linePitch(items, textHeight) {
  const gaps = [];
  for (let index = 1; index < items.length; index += 1) {
    const previous = items[index - 1];
    const item = items[index];
    const gap = item.y - previous.y;
    if (Math.abs(item.x - previous.x) < 0.5 && gap > textHeight * 0.2 && gap < textHeight * 3) {
      gaps.push(gap);
    }
  }
  return median(gaps) ?? textHeight * 1.25;
}

/**
 * Склеивает строки одной ячейки. Слово, разорванное по дефису
 * («торгово-» + «развлекательные»), собирается обратно без пробела: дефис в
 * таких словах свой, его надо сохранить, а лишний пробел помешал бы
 * сопоставлению наименований.
 */
export function joinLines(parts) {
  let text = '';
  for (const part of parts) {
    if (!text) text = part;
    else if (/[^\s][-‑–]$/.test(text) && /^[a-zа-яё]/.test(part)) text += part;
    else text += ` ${part}`;
  }
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Собирает строки таблиц одной страницы.
 *
 * @param {Array<{text: string, x: number, y: number, height: number}>} items
 *   обрывки текста в том порядке, в каком они записаны в файле;
 *   y отсчитывается от верха страницы вниз
 * @returns {{rows: Array, textHeight: number, pitch: number}}
 */
export function rowsFromItems(items) {
  const clean = items.filter((item) => String(item.text || '').trim());
  if (!clean.length) return { rows: [], textHeight: 0, pitch: 0 };

  const textHeight = median(clean.map((item) => item.height).filter((height) => height > 0)) || 10;
  const columns = clusterValues(clean.map((item) => item.x), textHeight * 0.5);
  const pitch = linePitch(clean, textHeight);
  const sameColumn = textHeight * 0.5;
  const cellLimit = pitch * 1.25;

  const rows = [];
  let row = null;
  let cell = null;

  for (const item of clean) {
    const column = nearestIndex(columns, item.x);
    const continues = cell
      && cell.column === column
      && Math.abs(item.x - cell.x) <= sameColumn
      && item.y - cell.lastY >= -textHeight * 0.3
      && item.y - cell.lastY <= cellLimit;

    if (continues) {
      cell.parts.push(item.text);
      cell.lastY = item.y;
      continue;
    }

    // Левый край вернулся к уже занятому столбцу — пошла следующая строка.
    if (!row || column <= row.maxColumn) {
      row = { top: item.y, maxColumn: -1, cells: [] };
      rows.push(row);
    }
    cell = { column, x: item.x, top: item.y, lastY: item.y, parts: [item.text] };
    row.cells.push(cell);
    row.maxColumn = column;
  }

  for (const item of rows) {
    for (const one of item.cells) one.text = joinLines(one.parts);
  }
  return { rows, textHeight, pitch };
}

/** Есть ли среди границ подходящая под значение. */
const fits = (edges, x, tolerance) => edges.some((edge) => Math.abs(edge - x) <= tolerance);

/**
 * Делит строки страницы на блоки — заготовки таблиц.
 *
 * Блок обрывается в двух случаях: строка состоит из одной ячейки (это абзац,
 * а не строка таблицы) или её ячейки стоят совсем не там, где столбцы текущей
 * таблицы, — значит, началась другая таблица. Второй признак и отделяет
 * приказ от штампов вроде «Список изменяющих документов», которые в PDF стоят
 * вплотную к таблице.
 *
 * Блоки возвращаются все, включая однострочные: строка, оставшаяся на новой
 * странице от разорванной таблицы, — тоже блок, и отбрасывать её рано.
 *
 * @returns {Array<{caption: Array, rows: Array, edges: number[]}>}
 */
export function blocksFromRows(rows, textHeight) {
  const tolerance = Math.max(textHeight * 0.5, 1);
  const blocks = [];
  let caption = [];
  let block = null;

  const close = () => { block = null; };

  for (const row of rows) {
    if (row.cells.length < 2) {
      close();
      caption.push(row);
      if (caption.length > 4) caption.shift();
      continue;
    }

    if (block) {
      const matched = row.cells.filter((cell) => fits(block.edges, cell.x, tolerance)).length;
      // Меньше половины ячеек попали в известные столбцы — это другая таблица.
      if (matched * 2 < row.cells.length) close();
    }
    if (!block) {
      block = { caption, rows: [], edges: [] };
      blocks.push(block);
      caption = [];
    }
    block.rows.push(row);
    for (const cell of row.cells) {
      if (!fits(block.edges, cell.x, tolerance)) block.edges.push(cell.x);
    }
    block.edges.sort((a, b) => a - b);
  }

  return blocks;
}

/** Блок из одной строки таблицей не считается: это абзац в две колонки. */
const isTable = (block) => block.rows.length >= 2;

/** Сетка строк: ячейки раскладываются по границам столбцов таблицы. */
function gridFromRows(rows, edges) {
  return rows.map((row) => {
    const line = new Array(edges.length).fill('');
    for (const cell of row.cells) {
      const index = nearestIndex(edges, cell.x);
      line[index] = line[index] ? `${line[index]} ${cell.text}` : cell.text;
    }
    return line;
  });
}

const captionText = (rows) => rows
  .map((row) => row.cells.map((cell) => cell.text).join(' ')).join(' ').replace(/\s+/g, ' ').trim();

/** Строки страницы → готовые таблицы. */
export function tablesFromRows(rows, textHeight) {
  return blocksFromRows(rows, textHeight).filter(isTable).map((block) => {
    const edges = clusterValues(
      block.rows.flatMap((row) => row.cells.map((cell) => cell.x)),
      Math.max(textHeight * 0.5, 1),
    );
    return { title: captionText(block.caption), grid: gridFromRows(block.rows, edges) };
  });
}

/**
 * Продолжает ли блок предыдущий: столбцы того же вида. Точного совпадения не
 * требуется — на новой странице какой-то столбец может оказаться пустым.
 */
function continues(previous, block, tolerance) {
  const [fewer, more] = previous.edges.length <= block.edges.length
    ? [previous.edges, block.edges] : [block.edges, previous.edges];
  if (fewer.length < 2) return false;
  return fewer.every((edge) => fits(more, edge, tolerance));
}

/**
 * Дописывает в последнюю строку таблицы текст, перенесённый на новую страницу.
 * Разрыв страницы может разрезать ячейку — например, длинное наименование
 * категории; без этого хвост наименования потерялся бы.
 */
function absorb(block, rows, tolerance) {
  const last = block.rows[block.rows.length - 1];
  if (!last) return;
  for (const row of rows) {
    for (const cell of row.cells) {
      const target = last.cells.find((one) => Math.abs(one.x - cell.x) <= tolerance);
      if (target) target.text = `${target.text} ${cell.text}`.trim();
    }
  }
}

/**
 * Восстанавливает таблицы всего документа.
 *
 * Таблица, разорванная разрывом страницы, склеивается обратно: если блок
 * открывает страницу и столбцы у него того же вида, что у последней таблицы
 * предыдущей страницы, — это одна таблица.
 *
 * @param {Array<Array>} pages обрывки текста по страницам
 * @returns {Array<{title: string, grid: string[][]}>}
 */
export function tablesFromPages(pages) {
  const collected = [];
  let tolerance = 1;
  for (const items of pages) {
    const { rows, textHeight } = rowsFromItems(items);
    if (!rows.length) continue;
    tolerance = Math.max(textHeight * 0.5, 1);
    blocksFromRows(rows, textHeight).forEach((block, index) => {
      const previous = collected[collected.length - 1];
      if (index === 0 && previous && continues(previous, block, tolerance)) {
        absorb(previous, block.caption, tolerance);
        previous.rows.push(...block.rows);
        for (const edge of block.edges) {
          if (!fits(previous.edges, edge, tolerance)) previous.edges.push(edge);
        }
      } else {
        collected.push(block);
      }
    });
  }

  return collected.filter(isTable).map((block) => {
    const edges = clusterValues(
      block.rows.flatMap((row) => row.cells.map((cell) => cell.x)), tolerance,
    );
    return { title: captionText(block.caption), grid: gridFromRows(block.rows, edges) };
  });
}
