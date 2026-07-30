// Мелкие помощники для работы с DOM и форматирования значений.

/** Создаёт элемент: el('td.num', {colSpan: 2}, 'текст'). */
export function el(spec, props = {}, ...children) {
  const [tag, ...classes] = String(spec).split('.');
  const node = document.createElement(tag || 'div');
  if (classes.length) node.className = classes.join(' ');
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = `${node.className} ${value}`.trim();
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key in node && key !== 'list') node[key] = value;
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function $(selector) {
  return document.querySelector(selector);
}

const numberFormat = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
const preciseFormat = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 5 });

/** Число в русском формате; пустое значение — прочерк. */
export function num(value, precise = false) {
  if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))) return '—';
  return (precise ? preciseFormat : numberFormat).format(Number(value));
}

export function percent(value) {
  return Number.isFinite(value) ? `${Math.round(value * 100)} %` : '';
}

/** Строка таблицы из заголовков. */
export function headRow(cells) {
  return el('tr', {}, cells.map((cell) => {
    const [label, isNum] = Array.isArray(cell) ? cell : [cell, false];
    return el(isNum ? 'th.num' : 'th', {}, label);
  }));
}

const toasts = () => document.getElementById('toasts');

export function toast(message, kind = '') {
  const node = el(`div.toast${kind ? `.${kind}` : ''}`, {}, message);
  toasts().append(node);
  setTimeout(() => {
    node.style.transition = 'opacity .4s';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 400);
  }, kind === 'error' ? 9000 : 4500);
}

const overlay = () => document.getElementById('overlay');

/** Показывает индикатор и даёт браузеру перерисоваться до тяжёлой работы. */
export async function withOverlay(message, work) {
  const box = overlay();
  document.getElementById('overlay-text').textContent = message;
  box.hidden = false;
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0))));
  try {
    return await work();
  } finally {
    box.hidden = true;
  }
}

/** Сохраняет данные в файл на компьютере пользователя. */
export function download(data, fileName, mime = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = el('a', { href: url, download: fileName, hidden: true });
  link.setAttribute('download', fileName);
  document.body.append(link);
  link.click();
  // Ссылку нельзя убирать сразу: часть браузеров читает атрибуты уже после клика.
  setTimeout(() => {
    link.remove();
    URL.revokeObjectURL(url);
  }, 2000);
}
