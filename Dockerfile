# ShhhToshi — Node API + Python bot (ShhhDev)
FROM node:20-bookworm-slim

# Python for Telegram bot
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Node deps
COPY package.json ./
RUN npm install --omit=dev

# Python deps
COPY requirements.txt ./
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt

# App code
COPY server.js db.js bot.py start.sh ./
RUN chmod +x start.sh

# Railway injects PORT (often 8080)
ENV PORT=8080
EXPOSE 8080

CMD ["bash", "start.sh"]
