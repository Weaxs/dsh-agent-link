FROM node:24-bookworm
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY dist ./dist
COPY .github/e2e/acp/start.mjs /opt/acp-e2e/start.mjs
ENTRYPOINT ["node", "/opt/acp-e2e/start.mjs"]
