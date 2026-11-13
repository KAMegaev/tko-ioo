#!/bin/bash
# Запускать от root после выпуска сертификата ioo.megaev.ru.
set -Eeuo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin

APP_DIR=/opt/tko-ioo
NGINX_DIR=/etc/nginx/conf.d
ENV_FILE=/etc/tko-ioo.env
CERT_DIR=/etc/letsencrypt/live/ioo.megaev.ru
BACKUP_ROOT=/root
LOCK_FILE=/home/tko-deploy/deploy.lock
NGINX=/usr/sbin/nginx
SYSTEMCTL=/usr/bin/systemctl
CURL=/usr/bin/curl
WAIT_ATTEMPTS=30
WAIT_DELAY=1
BACKUP=
FILES=()

rollback_domain() {
  local status=$? file name
  # ERR наследуется подстановками команд. Восстановление выполняет только основной процесс.
  if ((BASH_SUBSHELL)); then return "$status"; fi
  trap - ERR
  echo 'Переключение не прошло проверку. Восстанавливаю прежние настройки.' >&2
  for file in "${FILES[@]}"; do
    name=$(basename -- "$file")
    if [[ -e "$BACKUP/$name" ]]; then
      cp -a -- "$BACKUP/$name" "$file"
    else
      rm -f -- "$file"
    fi
  done
  "$SYSTEMCTL" restart tko-ioo.service || echo 'Проверьте запуск tko-ioo.service.' >&2
  if "$NGINX" -t; then "$SYSTEMCTL" reload nginx || true; fi
  echo "Резервная копия: $BACKUP" >&2
  exit "$status"
}

wait_for_domain() {
  local attempt body code=unknown
  for ((attempt = 0; attempt < WAIT_ATTEMPTS; attempt++)); do
    # reload посылает сигнал master; новые worker и сертификат готовы не сразу.
    # Повторяем запрос с обычной проверкой TLS, включая временный curl 60.
    if body=$("$CURL" --fail --silent --show-error --connect-timeout 3 --max-time 5 \
      https://ioo.megaev.ru/healthz 2>"$BACKUP/domain-check.log") && [[ "$body" == '{"status":"ok"}' ]]; then
      # Некорректная задача даёт 400, отказ Origin — 403. К ИИ запрос не отправляется.
      if code=$("$CURL" --silent --show-error --connect-timeout 3 --max-time 5 --output /dev/null --write-out '%{http_code}' \
        -H 'Origin: https://ioo.megaev.ru' -H 'Content-Type: application/json' \
        --data '{"task":"domain-check"}' https://ioo.megaev.ru/api/ai 2>"$BACKUP/domain-check.log") && [[ "$code" == 400 ]]; then
        return 0
      fi
    fi
    if ((attempt + 1 < WAIT_ATTEMPTS)); then sleep "$WAIT_DELAY"; fi
  done
  echo "Новый домен не стал доступен после $WAIT_ATTEMPTS проверок. Код API: $code." >&2
  cat "$BACKUP/domain-check.log" >&2
  return 1
}

switch_domain() {
  test -s "$CERT_DIR/fullchain.pem"
  test -s "$CERT_DIR/privkey.pem"
  grep -q '^PUBLIC_ORIGIN=' "$ENV_FILE"
  exec 9>"$LOCK_FILE"
  flock -n 9 || { echo 'Сейчас выполняется деплой. Повторите после его завершения.' >&2; return 1; }
  umask 077
  BACKUP=$(mktemp -d "$BACKUP_ROOT/ioo-switch.XXXXXX")
  FILES=("$ENV_FILE" "$NGINX_DIR/tko-ioo.conf" "$NGINX_DIR/tko-ioo-https.conf"
    "$NGINX_DIR/ioo-acme.conf" "$NGINX_DIR/ioo.conf" "$NGINX_DIR/tko-disabled.conf")
  for file in "${FILES[@]}"; do
    if [[ -e "$file" ]]; then cp -a -- "$file" "$BACKUP/$(basename -- "$file")"; fi
  done
  trap rollback_domain ERR
  cat "$APP_DIR/server/deploy/nginx-http.conf" "$APP_DIR/server/deploy/nginx-https.conf" > "$BACKUP/new-ioo.conf"
  install -m 644 "$BACKUP/new-ioo.conf" "$NGINX_DIR/ioo.conf"
  install -m 644 "$APP_DIR/server/deploy/tko-disabled.conf" "$NGINX_DIR/tko-disabled.conf"
  rm -f -- "$NGINX_DIR/tko-ioo.conf" "$NGINX_DIR/tko-ioo-https.conf" "$NGINX_DIR/ioo-acme.conf"
  "$NGINX" -t
  sed -i 's|^PUBLIC_ORIGIN=.*|PUBLIC_ORIGIN=https://ioo.megaev.ru|' "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  "$SYSTEMCTL" restart tko-ioo.service
  "$SYSTEMCTL" reload nginx
  wait_for_domain
  trap - ERR
  echo 'Готово: https://ioo.megaev.ru. Старый адрес отключён без перенаправления.'
  echo "Резервная копия настроек (доступна только root): $BACKUP"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  if [[ "$EUID" != 0 ]]; then echo 'Запустите от root на VPS.' >&2; exit 1; fi
  if (($#)); then echo 'Аргументы не требуются.' >&2; exit 1; fi
  switch_domain
fi
