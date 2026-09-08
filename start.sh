#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

# Railway always sets PORT — default 3000 for local
export PORT="${PORT:-3000}"

echo "[start] ShhhToshi API + Bot · PORT=$PORT"

if command -v python3 >/dev/null 2>&1 && [ -n "${BOT_TOKEN:-}" ] && [ -f bot.py ]; then
  echo "[start] bot starting..."
  python3 -u bot.py >> /tmp/shhht-bot.log 2>&1 &
  echo "[start] bot pid=$!"
elif command -v python >/dev/null 2>&1 && [ -n "${BOT_TOKEN:-}" ] && [ -f bot.py ]; then
  python -u bot.py >> /tmp/shhht-bot.log 2>&1 &
  echo "[start] bot pid=$!"
else
  echo "[start] bot skipped (need BOT_TOKEN + python + bot.py)"
fi

echo "[start] API listening on 0.0.0.0:$PORT"
exec node server.js
