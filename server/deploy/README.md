# Автоматический деплой GitHub → VPS

Рабочий сайт: **https://tko.megaev.ru**. Репозиторий:
`KAMegaev/tko-ioo`, ветка `main`, VPS `185.200.179.49`.

При каждом push в `main` workflow **«Тесты и деплой на VPS»**:

1. Выполняет `npm install` и все тесты на GitHub Actions.
2. Подключается по SSH как `tko-deploy`, передаёт SHA проверенного коммита.
3. VPS получает `main` из фиксированного публичного репозитория и сравнивает SHA.
4. Обновляет `/opt/tko-ioo` и перезапускает только `tko-ioo.service`.
5. Проверяет локальный `/healthz`; при ошибке запуска возвращает предыдущий
   коммит и повторно запускает службу. Workflow в этом случае завершается ошибкой.
6. Проверяет HTTPS и серверный режим сайта с GitHub Actions.

Push в другие ветки и pull request запускают только тесты. Ручной запуск
workflow тоже доступен; для деплоя выбрать `main`. Пока SSH Secrets не добавлены,
job деплоя пропускается с пояснением в Summary — это не успешная публикация.

## 1. Однократно подготовить VPS

Эти команды выполнить **в root SSH-сессии на VPS**, где сайт уже работает:

```bash
(
set -e
git -C /opt/tko-ioo pull --ff-only origin main
bash /opt/tko-ioo/server/deploy/setup-github.sh
)
```

Скрипт создаст отдельного пользователя `tko-deploy`, установит фиксированный
скрипт `/usr/local/sbin/tko-ioo-deploy` и выдаст право перезапуска только службы
`tko-ioo.service`. SSH-ключ ограничен этим скриптом: без интерактивной консоли,
PTY, перенаправления портов и запуска произвольных SSH-команд. Домашний каталог,
`authorized_keys`, скрипт и sudoers принадлежат root. Пользователь деплоя владеет
только копией приложения и файлом блокировки обновления.

Создаётся отдельный SSH-ключ `/root/.ssh/tko-github-actions`. Повторный запуск
использует тот же ключ. Никакие ключи не печатаются автоматически. Скрипт выведет
команду для просмотра приватной части и публичную строку идентификации сервера.

## 2. Добавить два секрета в GitHub

Открыть:

https://github.com/KAMegaev/tko-ioo/settings/secrets/actions

Нажать **New repository secret** и добавить:

| Name | Secret |
| --- | --- |
| `VPS_SSH_KEY` | Полный вывод `cat /root/.ssh/tko-github-actions`, включая строки `BEGIN OPENSSH PRIVATE KEY` и `END OPENSSH PRIVATE KEY` |
| `VPS_KNOWN_HOSTS` | Полная строка `185.200.179.49 ssh-ed25519 …`, которую напечатал скрипт настройки |

Секреты сохранять как **Repository secrets**, не Environment secrets:
job готовности проверяет их до входа в окружение `production`.
Ключи в чат, коммиты или Issues не отправлять.

`VPS_SSH_KEY` — SSH-ключ для доставки кода, **не OpenAI API key**.
Ключ OpenAI остаётся в `/etc/tko-ioo.env` и в GitHub не передаётся.
Строка `VPS_KNOWN_HOSTS` сверяется строго; `StrictHostKeyChecking=no`
и получение ключа сервера непроверенным `ssh-keyscan` не используются.

## 3. Запустить первый деплой

Открыть:

https://github.com/KAMegaev/tko-ioo/actions/workflows/tests.yml

Выбрать **Run workflow → Branch: main → Run workflow**. Дождаться зелёного
job **«Деплой на tko.megaev.ru»**. Если job пропущен, сначала проверить оба
Repository secrets. После этого новые изменения в `main` доставляются автоматически.

Обновление выполняется без `npm install` на VPS: backend не имеет production
npm-зависимостей. При перезапуске возможен перерыв в доступности. Текущий запрос
ИИ может задержать остановку службы до её `TimeoutStopSec`.

## Что сохраняется при обновлении

`/etc/tko-ioo.env`, `/var/lib/tko-ioo/usage.json`, отдельный Node.js, Nginx,
сертификаты и контейнеры `training-bot` не обновляются скриптом деплоя.
Из репозитория меняется только копия приложения. Изменения шаблонов systemd,
Nginx или самого скрипта деплоя требуют отдельного применения администратором.
Локальные изменения отслеживаемых Git-файлов останавливают деплой, чтобы
оператор мог разобраться. `git clean` не запускается, но файлы приложения
заменяются содержимым коммита; рабочие данные хранить вне `/opt/tko-ioo`.

Деплои сериализованы workflow и файловой блокировкой на сервере. Если пока шли
тесты `main` получила другой коммит, старый SHA не публикуется: нужно дождаться
workflow актуальной `main` или запустить его повторно.

## GitHub Pages

Workflow публикации Pages удалён. Job **«Отключить GitHub Pages»** после тестов
на `main` вызывает официальный API удаления сайта Pages. Повторный запуск
без уже опубликованного сайта считается успешным. Деплой VPS независим от этого job.

Если GitHub отклоняет отключение из-за прав токена или политики организации,
открыть https://github.com/KAMegaev/tko-ioo/settings/pages и нажать
**Unpublish site**. Удалять репозиторий не нужно.

## Диагностика

На VPS от root:

```bash
systemctl status tko-ioo --no-pager
journalctl -u tko-ioo -n 40 --no-pager
sudo -u tko-deploy git -C /opt/tko-ioo log -1 --oneline
sudo -u tko-deploy git -C /opt/tko-ioo status --short
```

После настройки владельцем репозитория является `tko-deploy`, поэтому Git-команды
в этой копии выполнять через `sudo -u tko-deploy`. Не добавлять глобальный
`safe.directory=*`. Для повторного деплоя использовать workflow: он запускает тесты и передаёт
именно проверенный SHA. При изменении SSH host key после переустановки VPS
обновить `VPS_KNOWN_HOSTS` из `/etc/ssh/ssh_host_ed25519_key.pub` через доверенную
консоль FirstVDS или ранее проверенную SSH-сессию.
