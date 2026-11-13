import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';

const script = resolve('server/deploy/github-deploy.sh');
function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: {
    ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.test',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.test',
    GIT_CONFIG_GLOBAL: '/dev/null',
  } });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function fixture(t, { restartFails = false, healthFails = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tko-deploy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, 'source');
  const app = join(dir, 'app');
  mkdirSync(source);
  git(source, 'init', '--initial-branch=main');
  writeFileSync(join(source, 'version.txt'), 'old');
  git(source, 'add', '.');
  git(source, 'commit', '-m', 'old');
  const old = git(source, 'rev-parse', 'HEAD');
  git(dir, 'clone', source, app);
  writeFileSync(join(source, 'version.txt'), 'new');
  git(source, 'commit', '-am', 'new');
  const current = git(source, 'rev-parse', 'HEAD');
  writeFileSync(join(dir, 'restarts'), '0');
  writeFileSync(join(dir, 'server.env'), 'OPENAI_API_KEY=keep-test-key');
  writeFileSync(join(app, 'operator-note.txt'), 'keep untracked note');
  const sudo = join(dir, 'sudo-mock');
  writeFileSync(sudo, `#!/bin/bash
set -eu
test "$1" = -n
test "$3" = restart
test "$4" = tko-ioo.service
count=$(cat "$MOCK_STATE/restarts")
count=$((count + 1))
printf '%s' "$count" > "$MOCK_STATE/restarts"
if [[ "$MOCK_RESTART_FAILS" == yes && "$count" == 1 ]]; then exit 1; fi
`, { mode: 0o755 });
  const server = createServer((req, res) => {
    const count = Number(readFileSync(join(dir, 'restarts'), 'utf8'));
    if (healthFails && count === 1) { res.writeHead(503).end('unhealthy'); return; }
    res.setHeader('Content-Type', 'application/json');
    res.end('{"status":"ok"}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((done) => server.close(done)));
  const health = `http://127.0.0.1:${server.address().port}/healthz`;
  function deploy(revision) {
    return new Promise((done, reject) => {
      const child = spawn('bash', ['-c', `
source "$1"
APP_DIR="$2"
REPOSITORY_URL="$3"
LOCK_FILE="$4/deploy.lock"
SUDO="$4/sudo-mock"
HEALTH_URL="$5"
HEALTH_ATTEMPTS=1
deploy_main
`, 'test', script, app, source, dir, health], { env: {
        ...process.env, MOCK_STATE: dir, MOCK_RESTART_FAILS: restartFails ? 'yes' : 'no',
      } });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', (data) => { stdout += data; });
      child.stderr.on('data', (data) => { stderr += data; });
      child.on('error', reject);
      child.on('close', (code) => done({ code, stdout, stderr }));
      child.stdin.end(`${revision}\n`);
    });
  }
  return { dir, app, source, old, current, deploy,
    restarts: () => Number(readFileSync(join(dir, 'restarts'), 'utf8')) };
}

test('деплой получает точный main, сохраняет настройки и перезапускает только службу сайта', async (t) => {
  const f = await fixture(t);
  const result = await f.deploy(f.current);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(git(f.app, 'rev-parse', 'HEAD'), f.current);
  assert.equal(readFileSync(join(f.app, 'version.txt'), 'utf8'), 'new');
  assert.equal(readFileSync(join(f.dir, 'server.env'), 'utf8'), 'OPENAI_API_KEY=keep-test-key');
  assert.equal(readFileSync(join(f.app, 'operator-note.txt'), 'utf8'), 'keep untracked note');
  assert.equal(f.restarts(), 1);
  assert.match(result.stdout, /Деплой завершён/);
});

test('SHA из stdin проверяется до любых изменений и не выполняется как команда', async (t) => {
  const f = await fixture(t);
  const result = await f.deploy('main; touch should-not-exist');
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Ожидается SHA/);
  assert.equal(git(f.app, 'rev-parse', 'HEAD'), f.old);
  assert.equal(f.restarts(), 0);
});

test('коммит, который не совпадает с текущей main, не публикуется', async (t) => {
  const f = await fixture(t);
  const result = await f.deploy(f.old);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /не соответствует main/);
  assert.equal(git(f.app, 'rev-parse', 'HEAD'), f.old);
  assert.equal(f.restarts(), 0);
});

test('локальные изменения на VPS останавливают обновление до reset', async (t) => {
  const f = await fixture(t);
  writeFileSync(join(f.app, 'version.txt'), 'operator change');
  const result = await f.deploy(f.current);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /локальные изменения/);
  assert.equal(readFileSync(join(f.app, 'version.txt'), 'utf8'), 'operator change');
  assert.equal(f.restarts(), 0);
});

for (const [name, options] of [
  ['ошибке перезапуска', { restartFails: true }],
  ['неработающем healthz новой версии', { healthFails: true }],
]) {
  test(`при ${name} возвращается предыдущий коммит и проверяется его запуск`, async (t) => {
    const f = await fixture(t, options);
    const result = await f.deploy(f.current);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Предыдущая версия восстановлена/);
    assert.equal(git(f.app, 'rev-parse', 'HEAD'), f.old);
    assert.equal(readFileSync(join(f.app, 'version.txt'), 'utf8'), 'old');
    assert.equal(f.restarts(), 2);
    assert.equal(readFileSync(join(f.dir, 'server.env'), 'utf8'), 'OPENAI_API_KEY=keep-test-key');
  });
}
