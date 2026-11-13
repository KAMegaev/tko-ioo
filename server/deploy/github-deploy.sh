#!/bin/bash
# Установить root:root 755 в /usr/local/sbin/tko-ioo-deploy.
# SSH-ключ запускает только этот скрипт. stdin: одна строка с SHA коммита main.
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
export GIT_TERMINAL_PROMPT=0
export GIT_CONFIG_GLOBAL=/dev/null

APP_DIR=/opt/tko-ioo
REPOSITORY_URL=https://github.com/KAMegaev/tko-ioo.git
LOCK_FILE=/home/tko-deploy/deploy.lock
HEALTH_URL=http://127.0.0.1:8787/healthz
HEALTH_ATTEMPTS=15
SUDO=/usr/bin/sudo
SYSTEMCTL=/usr/bin/systemctl
CURL=/usr/bin/curl

restart_and_check() {
  "$SUDO" -n "$SYSTEMCTL" restart tko-ioo.service || return 1
  local attempt body
  for ((attempt = 0; attempt < HEALTH_ATTEMPTS; attempt++)); do
    if body=$("$CURL" --fail --silent --max-time 3 "$HEALTH_URL") && [[ "$body" == '{"status":"ok"}' ]]; then
      return 0
    fi
    if ((attempt + 1 < HEALTH_ATTEMPTS)); then sleep 1; fi
  done
  return 1
}

deploy_main() {
  local revision previous fetched
  if ! IFS= read -r -t 20 revision || [[ ! "$revision" =~ ^[0-9a-f]{40}$ ]]; then
    echo 'Ожидается SHA коммита: 40 символов 0–9, a–f.' >&2
    return 1
  fi
  exec 9>"$LOCK_FILE"
  flock -n 9 || { echo 'Другой деплой уже выполняется.' >&2; return 1; }
  cd "$APP_DIR"
  umask 022
  if ! git diff --quiet || ! git diff --cached --quiet; then
    echo 'В рабочей копии есть локальные изменения. Деплой остановлен.' >&2
    return 1
  fi
  previous=$(git rev-parse --verify HEAD)
  # Только фиксированный репозиторий и main; произвольный URL/ветка не принимаются.
  timeout 120 git -c core.hooksPath=/dev/null -c http.lowSpeedLimit=100 -c http.lowSpeedTime=30 \
    fetch --no-tags --depth=1 "$REPOSITORY_URL" +refs/heads/main:refs/remotes/origin/main
  fetched=$(git rev-parse --verify refs/remotes/origin/main)
  if [[ "$revision" != "$fetched" ]]; then
    echo 'main уже изменился или SHA не соответствует main. Запустите workflow для актуальной main.' >&2
    return 1
  fi
  git -c core.hooksPath=/dev/null reset --hard "$revision"
  if ! restart_and_check; then
    echo "Новая версия не запустилась. Возврат к $previous." >&2
    git -c core.hooksPath=/dev/null reset --hard "$previous"
    if restart_and_check; then
      echo 'Предыдущая версия восстановлена.' >&2
    else
      echo 'Не удалось запустить и предыдущую версию. Проверьте journalctl -u tko-ioo.' >&2
    fi
    return 1
  fi
  echo "Деплой завершён: $revision"
}

# Проверки могут подключить функции и испытать их на временном Git-репозитории.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  if (($#)); then echo 'Аргументы не принимаются; SHA передаётся через stdin.' >&2; exit 1; fi
  deploy_main
fi
