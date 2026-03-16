# ── Build stage ───────────────────────────────────────────
FROM node:20-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# ── Runtime stage ─────────────────────────────────────────
FROM node:20-slim
WORKDIR /app

# Install Google Chrome stable + ffmpeg + Xvfb (virtual display for headful Chrome)
RUN apt-get update && apt-get install -y --no-install-recommends \
      wget gnupg ca-certificates xvfb ffmpeg \
    && wget -q -O - https://dl.google.com/linux/linux_signing_key.pub \
       | gpg --dearmor > /etc/apt/trusted.gpg.d/google.gpg \
    && echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" \
       > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update && apt-get install -y --no-install-recommends \
       google-chrome-stable \
    && apt-get purge -y wget gnupg \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp (universal video downloader)
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip curl \
    && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod +x /usr/local/bin/yt-dlp \
    && rm -rf /var/lib/apt/lists/*

# Copy deps and source
COPY --from=deps /app/node_modules ./node_modules
COPY server/   ./server/
COPY public/   ./public/
COPY scripts/  ./scripts/
COPY package.json ./

# Browser profile directory — mount a named volume here in production
RUN mkdir -p .browser-data/profile

EXPOSE 3000
ENV NODE_ENV=production \
    DISPLAY=:99

# Entrypoint starts Xvfb then the app
COPY scripts/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
CMD ["/entrypoint.sh"]
