#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
export PORT="${PORT:-8080}"

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "[start] FATAL: node not found"
  exit 1
fi

echo "[start] ShhhToshi · PORT=$PORT · node=$($NODE_BIN -v)"

if command -v python3 >/dev/null 2>&1 && [ -n "${BOT_TOKEN:-}" ] && [ -f bot.py ]; then
  echo "[start] bot starting..."
  python3 -u bot.py >> /tmp/shhht-bot.log 2>&1 &
  echo "[start] bot pid=$!"
else
  echo "[start] bot skipped"
fi

echo "[start] API on 0.0.0.0:$PORT"
exec "$NODE_BIN" server.js
