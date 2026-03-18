FROM mcr.microsoft.com/devcontainers/base:bullseye

# Install Node early so npx is available for Playwright deps
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Playwright system deps — let Playwright manage its own library list
RUN npx playwright install-deps chromium

WORKDIR /workspaces/inbox-angel-worker
