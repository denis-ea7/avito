#!/bin/bash
set -e

SERVER_HOST="${SERVER_HOST:-121.127.37.208}"
SERVER_USER="${SERVER_USER:-root}"
REMOTE_DIR="${REMOTE_DIR:-/root/realty-parser/avito}"
SSH_KEY="${SSH_KEY:-${HOME}/.ssh/id_ed25519}"

FILES_TO_COPY=(
  "avito-cian.js"
  "package.json"
  "package-lock.json"
  "ecosystem.config.js"
)

echo "🚀 Начало полного развертывания в $REMOTE_DIR..."

if [[ ! -f "${SSH_KEY}" ]]; then
  echo "❌ SSH ключ не найден: ${SSH_KEY}"
  exit 1
fi

SSH_BASE_OPTS=(-o "StrictHostKeyChecking=no" -o "PasswordAuthentication=no")
SSH_CMD=(ssh -i "${SSH_KEY}" "${SSH_BASE_OPTS[@]}")
SCP_CMD=(scp -i "${SSH_KEY}" "${SSH_BASE_OPTS[@]}")

echo "🔐 Проверяю доступ по SSH..."
if ! "${SSH_CMD[@]}" "${SERVER_USER}@${SERVER_HOST}" "echo ok" >/dev/null 2>&1; then
  echo "❌ Не получилось подключиться по SSH: ${SERVER_USER}@${SERVER_HOST}"
  exit 1
fi

echo "📁 Создание директории $REMOTE_DIR на сервере..."
"${SSH_CMD[@]}" "${SERVER_USER}@${SERVER_HOST}" "mkdir -p $REMOTE_DIR"

echo "📤 Копирование файлов на сервер..."
for file in "${FILES_TO_COPY[@]}"; do
  if [ -f "$file" ]; then
    "${SCP_CMD[@]}" "$file" "${SERVER_USER}@${SERVER_HOST}:${REMOTE_DIR}/"
    echo "  - $file скопирован."
  else
    echo "  - ⚠️  Файл $file не найден в папке avito/, пропуск."
  fi
done

echo "⚙️  Настройка сервера и запуск приложения..."
"${SSH_CMD[@]}" "${SERVER_USER}@${SERVER_HOST}" << EOF
  set -e
  echo "  - Переход в директорию $REMOTE_DIR"
  cd $REMOTE_DIR

  echo "  - Установка зависимостей проекта..."
  npm install

  echo "  - (Пропущено) Установка браузера (уже должен быть)"

  echo "  - Запуск/перезагрузка приложения через pm2..."
  pm2 reload ecosystem.config.js --name realty-parser || pm2 start ecosystem.config.js

  echo "  - Сохранение списка процессов pm2..."
  pm2 save
EOF

echo "✅ Развертывание завершено!"
echo "🎉 Ваш бот должен работать из папки $REMOTE_DIR."
echo "👀 Чтобы посмотреть логи, используйте: pm2 logs realty-parser"
