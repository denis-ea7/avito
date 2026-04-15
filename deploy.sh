#!/usr/bin/env bash
set -euo pipefail

SERVER_HOST="${SERVER_HOST:-121.127.37.208}"
SERVER_USER="${SERVER_USER:-root}"
REMOTE_DIR="${REMOTE_DIR:-/root/avito}"
SSH_KEY="${SSH_KEY:-}"
PORT="${PORT:-4076}"

SSH_OPTS=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null)

if [[ -n "$SSH_KEY" ]]; then
  SSH_CMD=(ssh -i "$SSH_KEY" "${SSH_OPTS[@]}")
  SCP_CMD=(scp -O -i "$SSH_KEY" "${SSH_OPTS[@]}")
else
  SSH_CMD=(ssh "${SSH_OPTS[@]}")
  SCP_CMD=(scp -O "${SSH_OPTS[@]}")
fi

if [[ -n "${SSHPASS:-}" ]]; then
  SSH_CMD=(sshpass -e "${SSH_CMD[@]}")
  SCP_CMD=(sshpass -e "${SCP_CMD[@]}")
fi

TMP_ARCHIVE="$(mktemp -t avito-deploy.XXXXXX.tar.gz)"
trap 'rm -f "$TMP_ARCHIVE"' EXIT

COPYFILE_DISABLE=1 git ls-files -z | COPYFILE_DISABLE=1 tar \
  --null \
  --exclude='chrome-profile/*' \
  --exclude='sent-ids.txt' \
  --exclude='.DS_Store' \
  -czf "$TMP_ARCHIVE" \
  --files-from -

"${SSH_CMD[@]}" "${SERVER_USER}@${SERVER_HOST}" "mkdir -p '$REMOTE_DIR'"
"${SCP_CMD[@]}" "$TMP_ARCHIVE" "${SERVER_USER}@${SERVER_HOST}:/tmp/avito-deploy.tar.gz"

"${SSH_CMD[@]}" "${SERVER_USER}@${SERVER_HOST}" "
set -euo pipefail
cd '$REMOTE_DIR'
if [[ -f filters.json ]]; then
  cp filters.json /tmp/avito-filters.json
fi
tar -xzf /tmp/avito-deploy.tar.gz -C '$REMOTE_DIR'
if [[ -f /tmp/avito-filters.json ]]; then
  mv /tmp/avito-filters.json filters.json
fi
rm -f /tmp/avito-deploy.tar.gz
PUPPETEER_SKIP_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install
npm run build
if ! command -v pm2 >/dev/null 2>&1; then
  npm install -g pm2
fi
if screen -ls | grep -q '[.]avito'; then
  screen -S avito -X quit || true
fi
pm2 delete avito-web >/dev/null 2>&1 || true
PORT='$PORT' pm2 start ecosystem.config.js
pm2 save
"

echo "http://${SERVER_HOST}:${PORT}"
