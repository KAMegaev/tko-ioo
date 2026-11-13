import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const project = resolve('.');
function runSwitch(t, { nginxFails = false, apiStatus = '400' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tko-domain-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const conf = join(dir, 'conf');
  const cert = join(dir, 'cert');
  mkdirSync(conf); mkdirSync(cert);
  const originalEnv = 'OPENAI_API_KEY=keep-test-key\nPUBLIC_ORIGIN=https://tko.megaev.ru\nMAX_DAILY_REQUESTS=50\n';
  writeFileSync(join(dir, 'site.env'), originalEnv, { mode: 0o600 });
  for (const name of ['tko-ioo.conf', 'tko-ioo-https.conf', 'ioo-acme.conf']) {
    writeFileSync(join(conf, name), `original ${name}`);
  }
  writeFileSync(join(cert, 'fullchain.pem'), 'fixture');
  writeFileSync(join(cert, 'privkey.pem'), 'fixture');
  writeFileSync(join(dir, 'nginx-count'), '0');
  const mocks = {
    nginx: `#!/bin/bash
set -eu
count=$(cat "$TEST_DIR/nginx-count")
count=$((count + 1))
printf '%s' "$count" > "$TEST_DIR/nginx-count"
if [[ "$NGINX_FAILS" == yes && "$count" == 1 ]]; then exit 1; fi
`,
    systemctl: '#!/bin/bash\nprintf "%s\\n" "$*" >> "$TEST_DIR/services"\n',
    curl: `#!/bin/bash
case "$*" in
  *api/ai*) printf '%s' "$API_STATUS";;
  *) printf '%s' '{"status":"ok"}';;
esac
`,
  };
  for (const [name, contents] of Object.entries(mocks)) writeFileSync(join(dir, name), contents, { mode: 0o755 });
  const result = spawnSync('bash', ['-c', `
source "$1/server/deploy/switch-to-ioo.sh"
APP_DIR="$1"
NGINX_DIR="$2/conf"
ENV_FILE="$2/site.env"
CERT_DIR="$2/cert"
BACKUP_ROOT="$2"
LOCK_FILE="$2/lock"
NGINX="$2/nginx"
SYSTEMCTL="$2/systemctl"
CURL="$2/curl"
switch_domain
`, 'test', project, dir], { encoding: 'utf8', env: {
    ...process.env, TEST_DIR: dir, NGINX_FAILS: nginxFails ? 'yes' : 'no', API_STATUS: apiStatus,
  } });
  return { dir, conf, originalEnv, result };
}

test('смена домена сохраняет ключ и лимиты, закрывает старый адрес и проверяет новый Origin', (t) => {
  const { dir, conf, result } = runSwitch(t);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(dir, 'site.env'), 'utf8'),
    'OPENAI_API_KEY=keep-test-key\nPUBLIC_ORIGIN=https://ioo.megaev.ru\nMAX_DAILY_REQUESTS=50\n');
  assert.equal(statSync(join(dir, 'site.env')).mode & 0o777, 0o600);
  assert.match(readFileSync(join(conf, 'ioo.conf'), 'utf8'), /server_name ioo\.megaev\.ru/);
  assert.match(readFileSync(join(conf, 'tko-disabled.conf'), 'utf8'), /ssl_reject_handshake on/);
  for (const name of ['tko-ioo.conf', 'tko-ioo-https.conf', 'ioo-acme.conf']) assert.equal(existsSync(join(conf, name)), false);
  assert.equal(readFileSync(join(dir, 'services'), 'utf8'), 'restart tko-ioo.service\nreload nginx\n');
  assert.doesNotMatch(result.stdout + result.stderr, /keep-test-key/);
});

for (const [name, options] of [
  ['ошибке nginx -t', { nginxFails: true }],
  ['отказе API принимать новый Origin', { apiStatus: '403' }],
]) {
  test(`при ${name} прежние конфигурации и настройки восстанавливаются`, (t) => {
    const { dir, conf, originalEnv, result } = runSwitch(t, options);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Восстанавливаю прежние настройки/);
    assert.equal(readFileSync(join(dir, 'site.env'), 'utf8'), originalEnv);
    for (const file of ['tko-ioo.conf', 'tko-ioo-https.conf', 'ioo-acme.conf']) {
      assert.equal(readFileSync(join(conf, file), 'utf8'), `original ${file}`);
    }
    assert.equal(existsSync(join(conf, 'ioo.conf')), false);
    assert.equal(existsSync(join(conf, 'tko-disabled.conf')), false);
    assert.doesNotMatch(result.stdout + result.stderr, /keep-test-key/);
  });
}
