// Восстановление таблиц из отсканированного PDF.
//
// У скана есть текстовый слой, оставленный распознаванием, но устроен он
// иначе, чем у PDF, сделанного из Word: там текст записан ячейками, здесь —
// отдельными словами, каждое со своими координатами. Порядок слов в файле
// произволен, поэтому опереться на него, как в pdf-layout.js, нельзя.
//
// Опора здесь другая — то, как таблица свёрстана на бумаге:
//
//   1. между столбцами по всей высоте таблицы идут пустые просветы;
//   2. ячейки выровнены по вертикальному центру строки, поэтому у всех ячеек
//      одной строки — общий центр;
//   3. в одном из столбцов (обычно с номером или со значением) ровно одна
//      ячейка на строку, и он задаёт разметку строк для остальных столбцов.
//
// Из третьего пункта и вырастает разбор: столбец-скелет даёт центры строк,
// а строки текста каждого столбца распределяются по ним так, чтобы центр
// каждой ячейки оказался как можно ближе к центру своей строки.

/** Медиана; для пустого списка — null. */
function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Группирует близкие значения. Размах группы ограничен: иначе дрожание
 * распознавания сцепляет соседние печатные строки в одну цепочку.
 */
function groupBySpan(values, span) {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  const groups = [];
  for (const value of sorted) {
    const last = groups[groups.length - 1];
    if (last && value - last[0] <= span) last.push(value);
    else groups.push([value]);
  }
  return groups;
}

/**
 * Наклон скана. Лист при сканировании всегда ложится чуть косо, и строка
 * справа оказывается ниже, чем слева. Подбираем наклон, при котором слова
 * собираются в наименьшее число строк, — при верном наклоне строки сходятся.
 */
export function skewSlope(words, textHeight) {
  let fewest = Infinity;
  let best = [];
  for (let step = -20; step <= 20; step += 1) {
    const slope = step / 500; // до ±0,04 — около 2,3 градуса
    const lines = groupBySpan(words.map((w) => w.y - slope * w.x), textHeight * 0.5).length;
    if (lines < fewest) { fewest = lines; best = [slope]; }
    else if (lines === fewest) best.push(slope);
  }
  // Подходит обычно не один наклон, а промежуток: берём его середину.
  return median(best) ?? 0;
}

/** Слова строки, слитые в сплошные куски: между кусками — заметный просвет. */
function runsOfLine(words, gap) {
  const runs = [];
  for (const word of [...words].sort((a, b) => a.x - b.x)) {
    const last = runs[runs.length - 1];
    if (last && word.x - last.x1 <= gap) {
      last.x1 = Math.max(last.x1, word.x + word.width);
      last.words.push(word);
    } else runs.push({ x0: word.x, x1: word.x + word.width, words: [word] });
  }
  return runs;
}

// Куски шире WIDE не участвуют в поиске границ столбцов: они бы перекрыли
// просветы. Кусок шире SPANNING — это уже заголовок раздела во всю таблицу;
// порог заметно выше, иначе под него попадёт длинное наименование, слипшееся
// с номером строки.
const WIDE = 0.35;
const SPANNING = 0.55;

/**
 * Границы столбцов — просветы, свободные почти во всех строках.
 *
 * Считается не по всем кускам текста, а только по узким: заголовок таблицы и
 * строки-разделы («5 Предприятия общественного питания») тянутся во всю
 * ширину и просветы бы перекрыли. Порог «почти во всех» терпит отдельную
 * ошибку распознавания, из-за которой одно число попадает в чужой столбец.
 */
export function columnBands(lines, textHeight) {
  const runs = lines.flatMap((line) => runsOfLine(line.words, textHeight * 1.1));
  if (!runs.length) return [];
  const left = Math.floor(Math.min(...runs.map((run) => run.x0)));
  const right = Math.ceil(Math.max(...runs.map((run) => run.x1)));
  const narrow = runs.filter((run) => run.x1 - run.x0 < (right - left) * WIDE);
  if (!narrow.length) return [{ x0: left, x1: right }];

  const cover = new Array(right - left + 1).fill(0);
  for (const run of narrow) {
    for (let x = Math.floor(run.x0); x <= Math.ceil(run.x1); x += 1) cover[x - left] += 1;
  }
  const limit = Math.max(1, Math.floor(lines.length * 0.06));

  const bands = [];
  let start = null;
  cover.forEach((value, index) => {
    if (value > limit) { if (start === null) start = index; return; }
    if (start !== null) { bands.push({ x0: left + start, x1: left + index }); start = null; }
  });
  if (start !== null) bands.push({ x0: left + start, x1: right });

  // Узкие огрызки — это не столбцы, а просветы между словами внутри ячейки.
  const merged = [];
  for (const band of bands) {
    const last = merged[merged.length - 1];
    if (last && band.x0 - last.x1 < textHeight * 0.6) last.x1 = band.x1;
    else merged.push({ ...band });
  }
  return merged;
}

/** Насколько плотно текст закрывает каждую точку по горизонтали. */
function coverage(lines, textHeight) {
  const runs = lines.flatMap((line) => runsOfLine(line.words, textHeight * 1.1));
  if (!runs.length) return null;
  const left = Math.floor(Math.min(...runs.map((run) => run.x0)));
  const right = Math.ceil(Math.max(...runs.map((run) => run.x1)));
  const narrow = runs.filter((run) => run.x1 - run.x0 < (right - left) * WIDE);
  const cover = new Array(right - left + 1).fill(0);
  for (const run of narrow.length ? narrow : runs) {
    for (let x = Math.floor(run.x0); x <= Math.ceil(run.x1); x += 1) cover[x - left] += 1;
  }
  return { cover, left, right };
}

/**
 * Делит страницу на заданное число столбцов.
 *
 * Нужно, когда просвет между столбцами на этой странице замусорен: сам он не
 * находится, но известно, сколько столбцов в таблице — по страницам, где
 * разметка прочиталась уверенно. Разрезы ставим в самых свободных местах,
 * не давая им сойтись вплотную.
 */
export function bandsForCount(lines, textHeight, count) {
  const profile = coverage(lines, textHeight);
  if (!profile || count < 2) return [];
  const { cover, left, right } = profile;
  const apart = Math.max((right - left) / (count * 4), textHeight * 1.5);
  const busiest = Math.max(...cover);

  // Разрез ставим посреди просвета, а выбираем просветы по ширине: узкая
  // щель внутри ячейки бывает и вовсе пустой, но столбцы делит не она.
  const corridors = [];
  let start = null;
  cover.forEach((value, index) => {
    const free = value <= busiest * 0.15;
    if (free) { if (start === null) start = index; return; }
    if (start !== null) { corridors.push([left + start, left + index]); start = null; }
  });
  if (start !== null) corridors.push([left + start, right]);

  const cuts = [];
  for (const [x0, x1] of corridors.sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]))) {
    if (cuts.length >= count - 1) break;
    const x = (x0 + x1) / 2;
    if (x <= left + textHeight || x >= right - textHeight) continue;
    if (cuts.every((cut) => Math.abs(cut - x) >= apart)) cuts.push(x);
  }
  if (cuts.length < count - 1) return [];

  cuts.sort((a, b) => a - b);
  const edges = [left, ...cuts, right];
  return edges.slice(0, -1).map((x0, index) => ({ x0, x1: edges[index + 1] }));
}

/** Столбец, которому принадлежит слово, — ближайший по середине слова. */
function bandOf(bands, word) {
  const centre = word.x + word.width / 2;
  let best = 0;
  let distance = Infinity;
  bands.forEach((band, index) => {
    const away = centre < band.x0 ? band.x0 - centre : Math.max(0, centre - band.x1);
    if (away < distance) { distance = away; best = index; }
  });
  return best;
}

/** Слова одного столбца, собранные в строки текста. */
function linesOfWords(words, textHeight) {
  const groups = groupBySpan(words.map((word) => word.y), textHeight * 0.5);
  const index = new Map();
  groups.forEach((group, order) => group.forEach((y) => index.set(y, order)));
  const lines = groups.map(() => []);
  for (const word of words) lines[index.get(word.y)].push(word);
  return lines
    .map((items) => ({
      y: median(items.map((word) => word.y)),
      text: joinWords([...items].sort((a, b) => a.x - b.x).map((word) => word.text)),
    }))
    .sort((a, b) => a.y - b.y);
}

/** Распознавание отбивает знаки препинания пробелами — возвращаем на место. */
export function joinWords(parts) {
  return parts.join(' ')
    .replace(/\s+([,.;:!?)»%])/g, '$1')
    .replace(/([(«])\s+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Границы между строками таблицы.
 *
 * Ячейки выровнены по вертикальному центру, поэтому расстояние между центрами
 * соседних строк — это полусумма их высот. Отсюда нижняя граница строки
 * получается из её центра и границы предыдущей: `граница = 2·центр − предыдущая`.
 * Так высокая строка с длинным наименованием и соседняя однострочная получают
 * каждая свою настоящую высоту, а не делят расстояние пополам.
 *
 * @param {number[]} centres центры строк сверху вниз
 * @param {number} top верхний край таблицы
 * @returns {number[]} нижняя граница каждой строки
 */
export function rowBounds(centres, top) {
  const bounds = [];
  let previous = top;
  centres.forEach((centre, index) => {
    const next = centres[index + 1];
    let bound = 2 * centre - previous;
    // Границу держим строго между своим центром и следующим: это гасит
    // ошибку, накопленную от неточно взятого верхнего края.
    if (next === undefined) bound = Infinity;
    else if (!(bound > centre) || bound >= next) bound = (centre + next) / 2;
    bounds.push(bound);
    previous = bound;
  });
  return bounds;
}

/**
 * Убирает систематический сдвиг столбца по вертикали.
 *
 * Распознавание ставит базовую линию по-разному для разных начертаний: числа
 * в столбце значений оказываются на несколько пунктов ниже номера строки.
 * У границы строки этого хватает, чтобы значение ушло к соседям, поэтому
 * каждый столбец подтягиваем на его же средний сдвиг.
 *
 * @returns {Array<Array<{y: number, text: string}>>} строки с исправленным y
 */
export function alignColumns(columnLines, centres) {
  const nearest = (y) => centres.reduce((best, centre) => (Math.abs(centre - y) < Math.abs(best - y) ? centre : best), centres[0]);
  return columnLines.map((lines) => {
    const offsets = lines.map((line) => line.y - nearest(line.y));
    const shift = median(offsets.filter((value) => Math.abs(value) < 8)) ?? 0;
    return lines.map((line) => ({ ...line, y: line.y - shift }));
  });
}

/**
 * Подбирает верхний край таблицы.
 *
 * В расчёте границ он остаётся единственной свободной величиной, и ошибка в
 * нём гуляет по всем строкам, попеременно завышая и занижая их высоту.
 * Перебираем его и берём тот, при котором содержимое строк ложится на их
 * центры ровнее всего — ведь ячейки выровнены по центру.
 */
export function chooseTop(columnLines, centres, textHeight) {
  let best = { top: centres[0] - textHeight, cost: Infinity };
  for (let step = -16; step <= 16; step += 1) {
    const top = centres[0] - textHeight * (1 + step / 8);
    const bounds = rowBounds(centres, top);
    if (bounds.some((bound, index) => bound <= centres[index])) continue;

    let cost = 0;
    for (const lines of columnLines) {
      const rows = new Map();
      for (const line of lines) {
        let row = bounds.findIndex((bound) => line.y < bound);
        if (row < 0) row = bounds.length - 1;
        const seen = rows.get(row) || [];
        seen.push(line.y);
        rows.set(row, seen);
      }
      for (const [row, ys] of rows) {
        cost += Math.abs((Math.min(...ys) + Math.max(...ys)) / 2 - centres[row]);
      }
    }
    if (cost < best.cost) best = { top, cost };
  }
  return best.top;
}

/**
 * Раскладывает строки текста столбца по строкам таблицы: каждая попадает в ту,
 * в чьи границы укладывается.
 *
 * @param {Array<{y: number, text: string}>} lines строки текста столбца
 * @param {number[]} bounds нижние границы строк таблицы
 * @returns {string[]} по ячейке на строку таблицы
 */
export function fitLinesToRows(lines, bounds) {
  const cells = new Array(bounds.length).fill('');
  for (const line of lines) {
    let row = bounds.findIndex((bound) => line.y < bound);
    if (row < 0) row = bounds.length - 1;
    cells[row] = cells[row] ? `${cells[row]} ${line.text}` : line.text;
  }
  return cells;
}

// «4», «4.1», «2.10.» — номер по порядку. Значение норматива под это не
// подходит: в нём десятичная запятая, а не точка.
const ORDINAL = /^\d{1,3}(\.\d{1,3})*\.?$/;

/**
 * Выбирает столбец, который задаст разметку строк.
 *
 * Лучший кандидат — столбец с номером по порядку: он заполнен во всех строках,
 * включая заголовки разделов, где значений нет. Если номеров в таблице нет,
 * берётся столбец с наименьшим числом строк: скорее всего, в нём по одной
 * строке текста на строку таблицы.
 */
export function chooseSkeleton(columnLines) {
  const numbered = columnLines.findIndex((lines) => lines.length >= 3
    && lines.filter((line) => ORDINAL.test(line.text)).length >= lines.length * 0.7);
  if (numbered >= 0) return numbered;

  let best = -1;
  columnLines.forEach((lines, index) => {
    if (lines.length < 3) return;
    if (best < 0 || lines.length < columnLines[best].length) best = index;
  });
  return best;
}

/** Выправляет наклон страницы и собирает её слова в строки. */
function straighten(words) {
  const clean = words.filter((word) => String(word.text || '').trim());
  if (clean.length < 20) return null;
  const textHeight = median(clean.map((word) => word.height).filter((h) => h > 0)) || 10;
  const slope = skewSlope(clean, textHeight);
  const straight = clean.map((word) => ({ ...word, y: word.y - slope * word.x }));
  const pageLines = groupBySpan(straight.map((word) => word.y), textHeight * 0.5)
    .map((group) => ({ words: straight.filter((word) => group.includes(word.y)) }));
  return { straight, pageLines, textHeight };
}

/**
 * Восстанавливает таблицы скана постранично.
 *
 * Столбцы ищутся сразу по всем страницам: разграфка приказа по всему документу
 * одна, а на отдельной странице просвет между столбцами способна перекрыть
 * пара ошибок распознавания. Вместе страницы дают ту разметку, которую по
 * одной не увидеть.
 *
 * @param {Array<Array>} pages слова по страницам
 * @returns {Array<{title: string, grid: string[][]}>}
 */
export function tablesFromScanPages(pages) {
  const prepared = pages.map(straighten);
  if (!prepared.some(Boolean)) return [];

  // Сколько в таблице столбцов, видно по страницам, где просветы читаются
  // уверенно. Столбцы приказ не меняет от страницы к странице, поэтому
  // наибольшее найденное число и есть настоящее.
  const own = prepared.map((page) => (page ? columnBands(page.pageLines, page.textHeight) : []));
  const counts = own.map((bands) => bands.length).filter((count) => count >= 2);
  const target = counts.length ? Math.max(...counts) : 0;

  const tables = [];
  prepared.forEach((page, index) => {
    if (!page) return;
    const bands = own[index].length === target
      ? own[index]
      : bandsForCount(page.pageLines, page.textHeight, target) || own[index];
    const table = tableFromWords(pages[index], bands.length >= 2 ? bands : null);
    if (!table) return;
    const title = table.title || '';
    // Страницы с одинаковым числом столбцов — это одна таблица, разорванная
    // разрывом страницы: шапка с единицами измерения стоит только на первой.
    const previous = tables[tables.length - 1];
    if (previous && previous.grid[0].length === table.grid[0].length) {
      previous.grid.push(...table.grid);
    } else {
      tables.push({ title, grid: table.grid });
    }
  });
  return tables;
}

/**
 * Восстанавливает таблицу одной страницы скана.
 *
 * @param {Array<{text: string, x: number, y: number, width: number, height: number}>} words
 * @param {Array<{x0: number, x1: number}>} [known] полосы столбцов, найденные
 *   по всему документу; без них считаются по одной этой странице
 * @returns {{grid: string[][], bands: Array, rows: number[]} | null}
 */
export function tableFromWords(words, known = null) {
  const page = straighten(words);
  if (!page) return null;
  const { straight, pageLines, textHeight } = page;

  const bands = known && known.length >= 2 ? known : columnBands(pageLines, textHeight);
  if (bands.length < 2 || pageLines.length < 3) return null;

  // Заголовок раздела («5 Предприятия общественного питания») идёт через все
  // столбцы. Его слова отделяем: иначе они и полосы столбцов размывают, и
  // сбивают выравнивание, считаясь то значением, то наименованием.
  const width = bands[bands.length - 1].x1 - bands[0].x0;
  const spanning = [];
  const rest = [];
  for (const line of pageLines) {
    for (const run of runsOfLine(line.words, textHeight * 1.1)) {
      if (run.x1 - run.x0 >= width * SPANNING && run.words.length > 2) spanning.push(run);
      else rest.push(...run.words);
    }
  }

  const columns = bands.map(() => []);
  for (const word of rest) columns[bandOf(bands, word)].push(word);
  const columnLines = columns.map((items) => linesOfWords(items, textHeight));

  const skeleton = chooseSkeleton(columnLines);
  if (skeleton < 0) return null;

  // Шапка таблицы стоит выше первой размеченной строки. Ей нужна своя строка:
  // иначе она войдёт в первую строку данных и собьёт разметку всей страницы.
  const first = columnLines[skeleton][0].y;
  const above = columnLines.flatMap((lines) => lines.filter((line) => line.y < first - textHeight * 0.8));
  const centres = columnLines[skeleton].map((line) => line.y);
  if (above.length) centres.unshift(median(above.map((line) => line.y)));

  const aligned = alignColumns(columnLines, centres);
  const bounds = rowBounds(centres, chooseTop(aligned, centres, textHeight));
  const cells = aligned.map((lines) => fitLinesToRows(lines, bounds));

  const grid = centres.map((_, row) => cells.map((column) => column[row] || ''));

  // Заголовок раздела повторяем во всех столбцах его строки — в таком виде
  // разбор нормативов узнаёт объединённую строку и пропускает её. А то, что
  // стоит над шапкой, — название приказа и приложения: это подпись к таблице,
  // и в сетке ему не место, иначе шапка тонет в нём и единицы измерения из
  // неё не прочитать.
  const caption = [];
  for (const run of spanning) {
    // Заголовок раздела набран своим начертанием, поэтому его базовая линия
    // не совпадает с базовой линией номера: берём ближайшую строку по центру,
    // а не по границам.
    const y = median(run.words.map((word) => word.y));
    let row = 0;
    centres.forEach((centre, index) => {
      if (Math.abs(centre - y) < Math.abs(centres[row] - y)) row = index;
    });
    const text = joinWords(run.words.map((word) => word.text));
    if (row === 0) { caption.push(text); continue; }
    grid[row] = grid[row].map((cell) => (cell && !ORDINAL.test(cell) ? `${cell} ${text}` : text));
  }
  return { grid, bands, rows: centres, title: joinWords(caption) };
}
