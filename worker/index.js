// Прокси к Anthropic API для разметки таблиц нормативов.
//
// Ключ хранится в секретах Cloudflare и в браузер не попадает.
// Клиент присылает только образец таблиц; текст запроса и схема ответа
// заданы здесь, поэтому через прокси нельзя обратиться к модели произвольно.

const ALLOWED_ORIGINS = [
  'https://kamegaev.github.io',
  'http://localhost:8000',
  'http://127.0.0.1:8000',
];

const LIMITS = {
  body: 64 * 1024, // байт
  tables: 12,
  rows: 6,
  columns: 12,
  cell: 200,
};

const MODEL = 'claude-haiku-4-5-20251001';

const NORMS_SYSTEM = `Ты размечаешь таблицы из региональных приказов об утверждении нормативов
накопления твёрдых коммунальных отходов (ТКО).

Тебе дают несколько таблиц из одного документа: подпись, первые строки и номера столбцов.
Нужно указать, в какой таблице лежат нормативы и где именно находятся значения.

Правила:
- Таблиц с нормативами может быть несколько: в приказах жильё («на 1 человека») и
  прочие категории («на 1 кв. метр») обычно разнесены по разным приложениям. Перечисли
  ВСЕ таблицы с нормативами, а не только самую большую.
- Таблица нормативов содержит наименования категорий потребителей и числовые значения
  накопления. Служебные таблицы («Список изменяющих документов», примечания) не подходят.
- Шапка бывает многоярусной: верхний ярус — общий заголовок, нижний — единицы измерения.
  headerRowCount — сколько первых строк занимает шапка, данные начинаются сразу после них.
- Нумерация строк и столбцов начинается с нуля и совпадает с присланной.
- Норматив по массе и норматив по объёму — разные столбцы. Если какого-то в таблице нет,
  укажи -1.
- unitColumn — столбец с расчётной единицей («на 1 человека», «на 1 кв. метр»), если он есть
  отдельным столбцом; иначе -1.
- massUnit и volumeUnit — единицы измерения именно так, как они указаны в шапке.
- basis — на что установлен норматив: person (человек), sqm (квадратный метр),
  place (место), other.
- Если подходящих таблиц нет, верни пустой список tables и объясни причину в reason.
- confidence — насколько ты уверен: 1 — шапка однозначна, 0.5 — есть сомнения.
- reason — одно-два предложения по-русски о том, как ты определил разметку.

Отвечай только вызовом инструмента.`;

const NORMS_TOOL = {
  name: 'razmetka_normativov',
  description: 'Разметка таблицы нормативов накопления ТКО',
  input_schema: {
    type: 'object',
    properties: {
      tables: {
        type: 'array',
        description: 'Все таблицы с нормативами, найденные в документе',
        items: {
          type: 'object',
          properties: {
            tableIndex: { type: 'integer', description: 'Номер таблицы' },
            headerRowCount: { type: 'integer', description: 'Сколько первых строк занимает шапка' },
            nameColumn: { type: 'integer', description: 'Столбец с наименованием категории' },
            massColumn: { type: 'integer', description: 'Столбец норматива по массе, -1 если отсутствует' },
            volumeColumn: { type: 'integer', description: 'Столбец норматива по объёму, -1 если отсутствует' },
            unitColumn: { type: 'integer', description: 'Столбец расчётной единицы, -1 если отсутствует' },
            massUnit: { type: 'string', description: 'Единица массы из шапки, например «кг» или «т»' },
            volumeUnit: { type: 'string', description: 'Единица объёма из шапки, например «куб.м»' },
            basis: { type: 'string', enum: ['person', 'sqm', 'place', 'other'] },
          },
          required: ['tableIndex', 'headerRowCount', 'nameColumn', 'massColumn',
            'volumeColumn', 'unitColumn', 'massUnit', 'volumeUnit', 'basis'],
        },
      },
      confidence: { type: 'number' },
      reason: { type: 'string' },
    },
    required: ['tables', 'confidence', 'reason'],
  },
};

const REGISTRY_SYSTEM = `Ты размечаешь выгрузку реестра источников образования отходов (ИОО) —
таблицу Excel, где каждая строка описывает один источник образования ТКО.

Тебе дают листы книги: название листа и первые строки каждого.
Нужно указать лист с данными, строку заголовка и роли столбцов.

Роли столбцов:
- category — наименование категории потребителя («Индивидуальные жилые дома», «Гостиницы»);
- units — количество расчётных единиц источника: число проживающих, квадратные метры,
  места. Столбца может не быть: тогда укажи -1, не подставляй вместо него другой
  числовой столбец;
- zone — зона деятельности регионального оператора;
- municipality — муниципальное образование, городской или муниципальный округ, район;
- unitName — единица измерения расчётных единиц, если она вынесена отдельным столбцом.

Правила:
- Нумерация строк и столбцов начинается с нуля и совпадает с присланной.
- headerRow — номер строки с названиями столбцов, данные идут после неё.
- Роль, которой в таблице нет, отмечай -1. Обязателен только category.
- Не путай количество расчётных единиц с порядковым номером строки или с кодом объекта.
- Если подходящего листа нет, укажи sheet -1 и объясни причину в reason.
- confidence — насколько ты уверен; reason — одно-два предложения по-русски.

Отвечай только вызовом инструмента.`;

const REGISTRY_TOOL = {
  name: 'razmetka_reestra',
  description: 'Разметка выгрузки реестра ИОО',
  input_schema: {
    type: 'object',
    properties: {
      sheet: { type: 'integer', description: 'Номер листа с данными, -1 если подходящего нет' },
      headerRow: { type: 'integer', description: 'Номер строки с названиями столбцов' },
      category: { type: 'integer', description: 'Столбец категории потребителя' },
      units: { type: 'integer', description: 'Столбец количества расчётных единиц, -1 если отсутствует' },
      zone: { type: 'integer', description: 'Столбец зоны деятельности, -1 если отсутствует' },
      municipality: { type: 'integer', description: 'Столбец муниципального образования, -1 если отсутствует' },
      unitName: { type: 'integer', description: 'Столбец единицы измерения, -1 если отсутствует' },
      confidence: { type: 'number' },
      reason: { type: 'string' },
    },
    required: ['sheet', 'headerRow', 'category', 'units', 'zone', 'municipality', 'unitName',
      'confidence', 'reason'],
  },
};

const TASKS = {
  'norms-markup': { system: NORMS_SYSTEM, tool: NORMS_TOOL, describe: describeTables },
  'registry-markup': { system: REGISTRY_SYSTEM, tool: REGISTRY_TOOL, describe: describeSheets },
};

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(origin) },
  });
}

/** Обрезает присланный образец до безопасных размеров. */
function trimSample(tables) {
  if (!Array.isArray(tables)) throw new Error('Ожидался список таблиц');
  return tables.slice(0, LIMITS.tables).map((table, order) => {
    const rows = Array.isArray(table.rows) ? table.rows : [];
    return {
      index: Number.isInteger(table.index) ? table.index : order,
      title: String(table.title || '').slice(0, LIMITS.cell),
      rows: rows.slice(0, LIMITS.rows).map((row) => (Array.isArray(row) ? row : [])
        .slice(0, LIMITS.columns)
        .map((cell) => String(cell ?? '').slice(0, LIMITS.cell))),
    };
  });
}

function describeTables(tables) {
  return tables.map((table) => {
    const lines = [`Таблица ${table.index}${table.title ? ` — подпись: «${table.title}»` : ''}`];
    table.rows.forEach((row, rowIndex) => {
      const cells = row.map((cell, colIndex) => `[${colIndex}] ${cell || '—'}`).join(' | ');
      lines.push(`  строка ${rowIndex}: ${cells}`);
    });
    return lines.join('\n');
  }).join('\n\n');
}

function describeSheets(sheets) {
  return sheets.map((sheet) => {
    const lines = [`Лист ${sheet.index}${sheet.title ? ` — название: «${sheet.title}»` : ''}`];
    sheet.rows.forEach((row, rowIndex) => {
      const cells = row.map((cell, colIndex) => `[${colIndex}] ${cell || '—'}`).join(' | ');
      lines.push(`  строка ${rowIndex}: ${cells}`);
    });
    return lines.join('\n');
  }).join('\n\n');
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(allowed) });
    }
    if (request.method !== 'POST') {
      return json({ error: 'Поддерживается только POST' }, 405, allowed);
    }
    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
      return json({ error: 'Обращение с этого адреса не разрешено' }, 403, allowed);
    }

    const length = Number(request.headers.get('Content-Length') || 0);
    if (length > LIMITS.body) {
      return json({ error: 'Слишком большой запрос' }, 413, allowed);
    }

    if (env.RATE_LIMITER) {
      const key = request.headers.get('CF-Connecting-IP') || 'anonymous';
      const { success } = await env.RATE_LIMITER.limit({ key });
      if (!success) {
        return json({ error: 'Слишком часто. Подождите минуту и повторите.' }, 429, allowed);
      }
    }

    let payload;
    try {
      const text = await request.text();
      if (text.length > LIMITS.body) throw new Error('Слишком большой запрос');
      payload = JSON.parse(text);
    } catch {
      return json({ error: 'Не удалось разобрать запрос' }, 400, allowed);
    }
    const task = TASKS[payload.task];
    if (!task) return json({ error: 'Неизвестная задача' }, 400, allowed);

    let tables;
    try {
      tables = trimSample(payload.tables);
    } catch (error) {
      return json({ error: error.message }, 400, allowed);
    }
    if (!tables.length) return json({ error: 'Пустой образец' }, 400, allowed);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        system: task.system,
        tools: [task.tool],
        tool_choice: { type: 'tool', name: task.tool.name },
        messages: [{ role: 'user', content: task.describe(tables) }],
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      return json({ error: `Модель недоступна (${response.status})`, detail: detail.slice(0, 300) },
        502, allowed);
    }

    const data = await response.json();
    const block = (data.content || []).find((item) => item.type === 'tool_use');
    if (!block) return json({ error: 'Модель не вернула разметку' }, 502, allowed);

    return json({ ok: true, result: block.input, usage: data.usage, model: data.model }, 200, allowed);
  },
};
