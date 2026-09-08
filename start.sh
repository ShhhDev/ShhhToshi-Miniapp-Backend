#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

# Load .env if present (Railway injects env directly)
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

echo "[start] API + Bot together (ShhhDev)"

# Start bot in background if python available and BOT_TOKEN set
if command -v python3 >/dev/null 2>&1 && [ -n "$BOT_TOKEN" ]; then
  if [ -f bot/bot.py ]; then
    echo "[start] launching Telegram bot..."
    (cd bot && python3 bot.py) &
    BOT_PID=$!
    echo "[start] bot pid=$BOT_PID"
  fi
elif command -v python >/dev/null 2>&1 && [ -n "$BOT_TOKEN" ]; then
  if [ -f bot/bot.py ]; then
    echo "[start] launching Telegram bot..."
    (cd bot && python bot.py) &
    BOT_PID=$!
    echo "[start] bot pid=$BOT_PID"
  fi
else
  echo "[start] bot skipped (python or BOT_TOKEN missing)"
fi

# Foreground API (keeps container alive)
echo "[start] launching API on PORT=${PORT:-3000}..."
exec node server.js
