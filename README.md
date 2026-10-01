# ShhhToshi Backend — deploy ALL these files

## Required on GitHub / Railway (root of repo)
- Dockerfile
- railway.toml
- server.js
- db.js
- bot.py
- start.sh
- package.json
- requirements.txt

## Railway settings
1. Settings → Build → Builder: **Dockerfile**
2. Start command: `bash start.sh` (or leave empty — Dockerfile CMD)
3. Variables:
   BOT_TOKEN=
   ADMIN_TELEGRAM_IDS=
   WEBAPP_URL=https://shhhtoshi-app.netlify.app
   CORS_ORIGIN=https://shhhtoshi-app.netlify.app
   DATABASE_URL=
   ADMIN_PANEL_PASSWORD=
   PORT=8080

## Do NOT
- Delete server.js
- Use only Python start command
- Leave builder as Nixpacks/Python
