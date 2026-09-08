#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

echo "[start] API + Bot (ShhhDev)"

# Bot in background — failures must not kill the API container
if command -v python3 >/dev/null 2>&1 && [ -n "${BOT_TOKEN:-}" ] && [ -f bot/bot.py ]; then
  echo "[start] launching Telegram bot..."
  (cd bot && python3 -u bot.py) >> /tmp/bot.log 2>&1 &
  echo "[start] bot pid=$!"
elif command -v python >/dev/null 2>&1 && [ -n "${BOT_TOKEN:-}" ] && [ -f bot/bot.py ]; then
  echo "[start] launching Telegram bot..."
  (cd bot && python -u bot.py) >> /tmp/bot.log 2>&1 &
  echo "[start] bot pid=$!"
else
  echo "[start] bot skipped (need python3 + BOT_TOKEN + bot/bot.py)"
fi

echo "[start] launching API on PORT=${PORT:-3000}..."
exec node server.js
