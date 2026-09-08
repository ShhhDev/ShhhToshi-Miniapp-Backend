# ShhhToshi Backend (API + Bot)

Developer: **ShhhDev**

One service: **Express API** (`server.js`) + **Telegram bot** (`bot/bot.py`).

## Files
| File | Purpose |
|------|---------|
| `server.js` | REST API (auth, game, admin, withdrawals) |
| `db.js` | Postgres (Supabase) or SQLite adapter |
| `bot/bot.py` | Telegram bot (welcome, broadcast) |
| `start.sh` | Starts **bot + API together** (Railway entry) |
| `supabase-schema.sql` | Run once in Supabase SQL editor |
| `.env.example` | Environment variables template |

## Database (Supabase Postgres)
1. Run `supabase-schema.sql` in Supabase SQL editor (already done if you finished this).
2. Supabase → **Settings → Database** → copy **URI** connection string.
3. Put it in Railway as `DATABASE_URL`.

## Railway env
```
BOT_TOKEN=
ADMIN_TELEGRAM_IDS=
WEBAPP_URL=https://shhhtoshi-app.netlify.app
CORS_ORIGIN=https://shhhtoshi-app.netlify.app
JWT_SECRET=long_random_secret
DATABASE_URL=postgresql://postgres:...@db.xxxx.supabase.co:5432/postgres
```

Optional: `ADMIN_PANEL_PASSWORD`, `JWT_EXPIRES`, `PORT`

## Deploy check
`GET /api/health` → `{ "ok": true, "db": "postgres", "jwt": true }`

## Local
```bash
cp .env.example .env
npm install
npm start          # start.sh → bot + API
# or
npm run start:api  # API only
npm run start:bot  # bot only
```

## Auth
Telegram `initData` → JWT. Frontend stores `shhht_jwt` and sends `Authorization: Bearer …`.
