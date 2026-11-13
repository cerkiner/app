# Build only this trusted Dockerfile, with an empty build context. No repository
# package scripts run on the host or while credentials are present in a container.
FROM node:24.15.0-bookworm@sha256:f22d6a1f082c02f292e86929b5b0442ac2e5eaf438a5dea9b1566601c3e05940
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium git ripgrep python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ENV HOME=/tmp/codex-home CHROME_BIN=/usr/bin/chromium PUPPETEER_SKIP_DOWNLOAD=true CI=true
WORKDIR /workspace
CMD ["sleep", "infinity"]
