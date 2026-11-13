#!/bin/bash
# Однократная настройка из root SSH-сессии на уже работающем VPS.
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin

if [[ "$EUID" != 0 ]]; then echo 'Запустите от root на VPS.' >&2; exit 1; fi
APP_DIR=/opt/tko-ioo
DEPLOY_HOME=/home/tko-deploy
KEY=/root/.ssh/tko-github-actions
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
for command in git sudo visudo ssh-keygen flock timeout curl systemctl; do
  command -v "$command" >/dev/null || { echo "Не найдена команда: $command" >&2; exit 1; }
done
test -d "$APP_DIR/.git" || { echo 'Нужна Git-копия проекта в /opt/tko-ioo.' >&2; exit 1; }
test -f /etc/ssh/ssh_host_ed25519_key.pub
test -f "$SCRIPT_DIR/github-deploy.sh"
test -f /etc/tko-ioo.env
test -x /opt/tko-node/bin/node
systemctl is-active --quiet tko-ioo.service

if ! id tko-deploy >/dev/null 2>&1; then
  useradd --create-home --user-group --home-dir "$DEPLOY_HOME" --shell /bin/bash tko-deploy
elif [[ "$(getent passwd tko-deploy | cut -d: -f6)" != "$DEPLOY_HOME" ]]; then
  echo 'Пользователь tko-deploy уже существует с другим домашним каталогом.' >&2
  exit 1
fi
install -d -m 700 /root/.ssh
if [[ ! -e "$KEY" ]]; then
  ssh-keygen -q -t ed25519 -N '' -C 'tko-github-actions' -f "$KEY"
fi
test -f "$KEY.pub"
chmod 600 "$KEY"
install -o root -g root -m 755 "$SCRIPT_DIR/github-deploy.sh" /usr/local/sbin/tko-ioo-deploy
install -d -o tko-deploy -g tko-deploy -m 700 "$DEPLOY_HOME/.ssh"
authorized=$(mktemp)
sudoers=$(mktemp)
trap 'rm -f -- "$authorized" "$sudoers"' EXIT
printf 'restrict,command="/usr/local/sbin/tko-ioo-deploy" %s\n' "$(cat "$KEY.pub")" > "$authorized"
install -o root -g root -m 600 "$authorized" "$DEPLOY_HOME/.ssh/authorized_keys"
# Каталог root не даёт пользователю подменить ограничение command=.
chown root:root "$DEPLOY_HOME/.ssh"
chmod 755 "$DEPLOY_HOME/.ssh"
chmod 644 "$DEPLOY_HOME/.ssh/authorized_keys"
printf '%s\n' 'tko-deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart tko-ioo.service' > "$sudoers"
visudo -cf "$sudoers"
install -o root -g root -m 440 "$sudoers" /etc/sudoers.d/tko-ioo-deploy
chown -R tko-deploy:tko-deploy "$APP_DIR"
chmod 755 "$APP_DIR" "$DEPLOY_HOME"
chown root:root "$DEPLOY_HOME"
for profile in .bashrc .profile .bash_logout; do
  if [[ -f "$DEPLOY_HOME/$profile" ]]; then chown root:root "$DEPLOY_HOME/$profile"; fi
done
touch "$DEPLOY_HOME/deploy.lock"
chown tko-deploy:tko-deploy "$DEPLOY_HOME/deploy.lock"
chmod 600 "$DEPLOY_HOME/deploy.lock"
sudo -u tko-deploy git -C "$APP_DIR" config core.hooksPath /dev/null

printf '\nНастройка завершена. В GitHub → Settings → Secrets and variables → Actions добавьте:\n'
printf '\nVPS_SSH_KEY — полный вывод команды (не отправлять в чат):\ncat %s\n' "$KEY"
printf '\nVPS_KNOWN_HOSTS — следующая публичная строка:\n'
printf '185.200.179.49 %s\n' "$(cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub)"
