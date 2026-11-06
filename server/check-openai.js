// Запустить на VPS. Ключ вводится скрыто и не записывается в историю команд.
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { OPENAI_URL, OPENAI_MODEL } from '../js/ai/openai.js';

async function hiddenKey() {
  let muted = false;
  const output = new Writable({ write(chunk, encoding, next) {
    if (!muted) process.stdout.write(chunk, encoding);
    next();
  } });
  const input = createInterface({ input: process.stdin, output, terminal: process.stdin.isTTY });
  return new Promise((resolve) => {
    input.question('OpenAI API-ключ (ввод скрыт): ', (answer) => {
      muted = false;
      input.close();
      process.stdout.write('\n');
      resolve(answer.trim());
    });
    muted = true;
  });
}

try {
  const key = process.env.OPENAI_API_KEY || await hiddenKey();
  if (!key) throw new Error('Ключ не введён');
  const response = await fetch(OPENAI_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: process.env.OPENAI_MODEL || OPENAI_MODEL,
      input: 'Ответь одним словом: ОК', max_output_tokens: 32, store: false }),
    signal: AbortSignal.timeout(30000),
  });
  const data = await response.json();
  const message = response.ok ? 'VPS успешно получил ответ OpenAI'
    : String(data.error?.message || 'Запрос отклонён').replaceAll(key, '[скрыто]');
  console.log(`HTTP ${response.status}: ${message}`);
  if (!response.ok) process.exitCode = 1;
} catch (error) {
  console.error(error.name === 'TimeoutError' ? 'OpenAI не ответил за 30 секунд'
    : 'Проверка не завершена: проверьте сеть, ключ и наличие Node.js 22+.');
  process.exitCode = 1;
}
