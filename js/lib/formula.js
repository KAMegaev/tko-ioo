// Разбор и вычисление формул нормативов вида «[n1] + [n2]» или «0.5*[n3]».
// Собственный разборщик вместо eval: выражение приходит из интерфейса,
// но исполнять произвольный код недопустимо.

const TOKEN_RE = /\s*(\[[^\]]+\]|\d+(?:[.,]\d+)?|[()+\-*/])/y;

/** Разбивает выражение на токены. */
export function tokenize(expression) {
  const tokens = [];
  let position = 0;
  const text = String(expression || '');
  while (position < text.length) {
    TOKEN_RE.lastIndex = position;
    const match = TOKEN_RE.exec(text);
    if (!match) {
      if (!text.slice(position).trim()) break;
      throw new Error(`Непонятный символ в позиции ${position + 1}: «${text[position]}»`);
    }
    tokens.push(match[1]);
    position = TOKEN_RE.lastIndex;
  }
  return tokens;
}

/**
 * Вычисляет выражение.
 * @param {string} expression формула
 * @param {(id: string) => number|null} resolve значение норматива по идентификатору
 */
export function evaluate(expression, resolve) {
  const tokens = tokenize(expression);
  if (!tokens.length) throw new Error('Формула пуста');
  let index = 0;
  let unresolved = false;

  const peek = () => tokens[index];
  const next = () => tokens[index++];

  function parsePrimary() {
    const token = next();
    if (token === undefined) throw new Error('Формула обрывается — не хватает значения');
    if (token === '(') {
      const value = parseSum();
      if (next() !== ')') throw new Error('Не хватает закрывающей скобки');
      return value;
    }
    if (token === '-') return -parsePrimary();
    if (token === '+') return parsePrimary();
    if (token.startsWith('[')) {
      const id = token.slice(1, -1).trim();
      const value = resolve(id);
      if (value === null || value === undefined || !Number.isFinite(value)) {
        unresolved = true;
        return 0;
      }
      return value;
    }
    const number = Number(token.replace(',', '.'));
    if (!Number.isFinite(number)) throw new Error(`Не число: «${token}»`);
    return number;
  }

  function parseProduct() {
    let value = parsePrimary();
    while (peek() === '*' || peek() === '/') {
      const operator = next();
      const right = parsePrimary();
      if (operator === '/') {
        if (right === 0) throw new Error('Деление на ноль');
        value /= right;
      } else {
        value *= right;
      }
    }
    return value;
  }

  function parseSum() {
    let value = parseProduct();
    while (peek() === '+' || peek() === '-') {
      const operator = next();
      const right = parseProduct();
      value = operator === '+' ? value + right : value - right;
    }
    return value;
  }

  const result = parseSum();
  if (index < tokens.length) throw new Error(`Лишний фрагмент: «${tokens.slice(index).join(' ')}»`);
  return unresolved ? null : result;
}

/** Идентификаторы нормативов, участвующих в формуле. */
export function referencedIds(expression) {
  return tokenize(expression)
    .filter((token) => token.startsWith('['))
    .map((token) => token.slice(1, -1).trim());
}

/** Проверяет формулу и возвращает текст ошибки либо null. */
export function validate(expression, knownIds) {
  try {
    const ids = referencedIds(expression);
    const unknown = ids.filter((id) => !knownIds.has(id));
    if (unknown.length) return `Неизвестные нормативы: ${unknown.join(', ')}`;
    evaluate(expression, () => 1);
    return null;
  } catch (error) {
    return error.message;
  }
}

/** Заменяет идентификаторы на наименования — для показа в отчётах. */
export function humanize(expression, nameOf) {
  return String(expression || '').replace(/\[([^\]]+)\]/g, (match, id) => {
    const name = nameOf(id.trim());
    return name ? `«${name}»` : match;
  });
}
