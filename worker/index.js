// Прокси к Anthropic API: извлечение нормативов и разметка реестра.
//
// Ключ хранится в секретах Cloudflare и в браузер не попадает.
// Текст задачи и схема ответа заданы на сервере.

import { EXTRACTION_LIMITS } from '../js/ai/norms-contract.js';
import { EXTRACTION_SYSTEM, EXTRACTION_TOOL, extractionContent } from './norms-extract.js';
import { REGISTRY_SYSTEM, REGISTRY_TOOL } from '../js/ai/registry-prompt.js';

const ALLOWED_ORIGINS = [
  'https://kamegaev.github.io',
  'http://localhost:8000',
  'http://127.0.0.1:8000',
];

// Приказ о нормативах уходит целиком, поэтому пределы рассчитаны на документ
// в сотни строк. Выгрузка реестра по-прежнему присылается образцом в
// несколько строк — её ограничивает уже сам клиент.
const LIMITS = {
  body: 1024 * 1024, // байт
  tables: 12,
  rows: 400,
  columns: 16,
  cell: 300,
  cells: 24000, // всего ячеек во всех таблицах
};

const MODEL = 'claude-haiku-4-5-20251001';

const NORMS_SYSTEM = `Ты размечаешь таблицы из региональных приказов об утверждении нормативов
накопления твёрдых коммунальных отходов (ТКО).

Тебе дают таблицы одного документа целиком: подпись, все строки и номера столбцов.
Нужно указать, в какой таблице лежат нормативы и где именно находятся значения.
Значения из таблиц не переписывай и ничего не вычисляй: их прочитает программа —
твоё дело сказать, где они лежат. Строки даны полностью как раз для того, чтобы
разметку можно было проверить по всей таблице, а не по одной шапке.

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

const TASKS = {
  'norms-extract': { system: EXTRACTION_SYSTEM, tool: EXTRACTION_TOOL },
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

async function readPayload(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Пустой запрос');
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > EXTRACTION_LIMITS.bodyBytes) {
        await reader.cancel();
        throw new Error('Слишком большой запрос');
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } finally {
    reader.releaseLock();
  }
}

/** Обрезает присланный образец до безопасных размеров. */
function trimSample(tables) {
  if (!Array.isArray(tables)) throw new Error('Ожидался список таблиц');
  let cells = LIMITS.cells;
  return tables.slice(0, LIMITS.tables).map((table, order) => {
    const rows = Array.isArray(table.rows) ? table.rows : [];
    const trimmed = [];
    for (const row of rows.slice(0, LIMITS.rows)) {
      const line = (Array.isArray(row) ? row : []).slice(0, LIMITS.columns)
        .map((cell) => String(cell ?? '').slice(0, LIMITS.cell));
      if (cells - line.length < 0) break;
      cells -= line.length;
      trimmed.push(line);
    }
    return {
      index: Number.isInteger(table.index) ? table.index : order,
      title: String(table.title || '').slice(0, LIMITS.cell),
      rows: trimmed,
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
    if (length > EXTRACTION_LIMITS.bodyBytes) {
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
      payload = await readPayload(request);
    } catch (error) {
      if (error.message === 'Слишком большой запрос') return json({ error: error.message }, 413, allowed);
      return json({ error: 'Не удалось разобрать запрос' }, 400, allowed);
    }
    if (typeof payload?.task !== 'string' || !Object.hasOwn(TASKS, payload.task)) {
      return json({ error: 'Неизвестная задача' }, 400, allowed);
    }
    const task = TASKS[payload.task];

    let content;
    try {
      if (payload.task === 'norms-extract') {
        content = extractionContent(payload.document);
      } else {
        if (length > LIMITS.body || new TextEncoder().encode(JSON.stringify(payload)).length > LIMITS.body) {
          return json({ error: 'Слишком большой образец' }, 413, allowed);
        }
        const tables = trimSample(payload.tables);
        if (!tables.length) return json({ error: 'Пустой образец' }, 400, allowed);
        content = task.describe(tables);
      }
    } catch (error) {
      return json({ error: error.message }, 400, allowed);
    }

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: payload.task === 'norms-extract' ? 32000 : 1024,
          system: task.system,
          tools: [task.tool],
          tool_choice: { type: 'tool', name: task.tool.name },
          messages: [{ role: 'user', content }],
        }),
      });

      if (!response.ok) {
        const detail = await response.text();
        return json({ error: `Модель недоступна (${response.status})`, detail: detail.slice(0, 300) },
          502, allowed);
      }

      const data = await response.json();
      if (data.stop_reason === 'max_tokens') {
        return json({ error: 'Ответ ИИ не поместился целиком. Разделите документ на части; неполный результат не применён.' }, 502, allowed);
      }
      const block = (data.content || []).find((item) => item.type === 'tool_use' && item.name === task.tool.name);
      if (!block) return json({ error: 'Модель не вернула структурированный результат' }, 502, allowed);

      return json({ ok: true, result: block.input, usage: data.usage, model: data.model }, 200, allowed);
    } catch {
      return json({ error: 'Не удалось получить ответ ИИ. Повторите обработку.' }, 502, allowed);
    }
  },
};
