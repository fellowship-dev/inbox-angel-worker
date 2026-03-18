FROM mcr.microsoft.com/devcontainers/base:bullseye

# Playwright system deps for headless Chromium screenshots
RUN apt-get update && export DEBIAN_FRONTEND=noninteractive \
    && apt-get install -y \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libgdk-pixbuf2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xdg-utils \
    && apt-get clean -y && rm -rf /var/lib/apt/lists/*

WORKDIR /workspaces/inbox-angel-worker
