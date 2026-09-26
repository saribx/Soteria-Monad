# Relayer for Railway (or any container host). Build context: the repository root,
# because the relayer reads data/ (scenarios, contracts, demo terms) and the
# recorded Soteria decisions from soteria-frontend/src/data/soteria.json.
FROM node:22-slim
WORKDIR /app

COPY relayer/package.json relayer/package-lock.json ./relayer/
RUN cd relayer && npm ci

COPY data ./data
COPY soteria-frontend/src/data/soteria.json ./soteria-frontend/src/data/soteria.json
COPY relayer ./relayer

WORKDIR /app/relayer
# Railway sets PORT; secrets (RELAYER_KEYS, CONTROL_TOKEN) come from its variables
CMD ["npx", "tsx", "src/server.ts"]
