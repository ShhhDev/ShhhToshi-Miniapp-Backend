# ShhhToshi API (Node) + Bot (Python) — ShhhDev
FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv \
    build-essential python3-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY requirements.txt ./
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt

COPY server.js db.js bot.py start.sh ./
RUN chmod +x start.sh && test -f server.js && test -f db.js

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["bash", "start.sh"]
