# Stage 1: Build
FROM node:22-bookworm AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
COPY scripts/ scripts/
RUN npm run build

# Stage 2: Runtime
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libgbm1 \
    libpango-1.0-0 libcairo2 libasound2 libatspi2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /app/dist dist/
COPY --from=builder /app/node_modules node_modules/
COPY package.json ./

# Install Chromium for Playwright
RUN npx playwright install chromium

ENV ONEAGENT_NETWORK=true
ENV ONEAGENT_HTTP_TRANSPORT=true
ENV ONEAGENT_DATA_DIR=/data

VOLUME /data
EXPOSE 3000 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://localhost:3000/api/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

ENTRYPOINT ["node", "dist/index.js", "serve", "--http", "--port", "3000"]
