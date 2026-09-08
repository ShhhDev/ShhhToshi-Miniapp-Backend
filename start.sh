#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

export PORT="${PORT:-8080}"

# Resolve node binary
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  for p in /usr/local/bin/node /usr/bin/node; do
    [ -x "$p" ] && NODE_BIN="$p" && break
  done
fi
if [ -z "$NODE_BIN" ]; then
  echo "[start] FATAL: node not found. Use the Dockerfile deploy."
  exit 1
fi

echo "[start] ShhhToshi API + Bot · PORT=$PORT · node=$NODE_BIN"

if command -v python3 >/dev/null 2>&1 && [ -n "${BOT_TOKEN:-}" ] && [ -f bot.py ]; then
  echo "[start] bot starting..."
  python3 -u bot.py >> /tmp/shhht-bot.log 2>&1 &
  echo "[start] bot pid=$!"
else
  echo "[start] bot skipped (need BOT_TOKEN + python3 + bot.py)"
fi

echo "[start] API listening on 0.0.0.0:$PORT"
exec "$NODE_BIN" server.js
