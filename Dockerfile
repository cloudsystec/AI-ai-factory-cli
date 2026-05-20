FROM node:20-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*
COPY package.json orchestrator agents scopes ./
COPY src ./src/
ENV NODE_ENV=production
CMD ["node", "src/worker.js"]
