FROM node:22-bookworm-slim
ARG XRAY_VERSION=26.9.9
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl nginx openssl && rm -rf /var/lib/apt/lists/* \
 && arch="amd64" \
 && curl -fsSL "https://github.com/XTLS/Xray-core/releases/download/v${XRAY_VERSION}/Xray-linux-${arch}.zip" -o /tmp/xray.zip \
 && mkdir -p /opt/xray \
 && apt-get update && apt-get install -y --no-install-recommends unzip \
 && unzip -q /tmp/xray.zip xray geoip.dat geosite.dat -d /opt/xray \
 && chmod +x /opt/xray/xray \
 && rm -f /tmp/xray.zip \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
RUN mkdir -p /app/data /app/runtime /etc/nginx/templates
ENV NODE_ENV=production PORT=1400 PANEL_PORT=1323 DATA_DIR=/app/data XRAY_BIN=/opt/xray/xray XRAY_CONFIG=/app/runtime/config.json
EXPOSE 1400 1323
CMD ["node","src/server.js"]
