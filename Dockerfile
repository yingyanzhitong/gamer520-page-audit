FROM mcr.microsoft.com/playwright:v1.62.0-noble

ENV NODE_ENV=production \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --include=dev

COPY --chown=pwuser:pwuser . .
RUN npm run build \
    && npm prune --omit=dev \
    && mkdir -p /app/data \
    && chown -R pwuser:pwuser /app/data

USER pwuser

EXPOSE 3000

CMD ["npm", "run", "scheduler"]
