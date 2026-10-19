# Chrome + virtueller Bildschirm + noVNC, damit man sich per Browser bei REWE anmelden kann
FROM mcr.microsoft.com/playwright:v1.64.0-noble

RUN apt-get update \
 && apt-get install -y --no-install-recommends xvfb x11vnc novnc websockify fluxbox fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev \
 && npx playwright install --with-deps chrome \
 && mkdir -p /data && chown pwuser:pwuser /data

COPY lib.js shop.js browser.js oauth.js http-server.js start.sh ./
RUN chmod +x start.sh

USER pwuser
ENV DISPLAY=:99 REWE_PROFILE_DIR=/data/profile
EXPOSE 47823 6080
CMD ["./start.sh"]
