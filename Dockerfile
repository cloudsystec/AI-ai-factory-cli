FROM node:20-bookworm-slim
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    bash \
  && curl -fsSL https://cursor.com/install | bash \
  && /root/.local/bin/agent --version \
  && rm -rf /var/lib/apt/lists/* \
  && git config --global user.email "agent@factory.local" \
  && git config --global user.name "Factory Agent"

ENV PATH="/root/.local/bin:${PATH}"
ENV CURSOR_AGENT=agent
ENV CURSOR_AGENT_TRUST=1
ENV AI_FACTORY_CLI_ROOT=/app
ENV NODE_ENV=production
ENV AI_FACTORY_LOG_COLOR=1
ENV AI_FACTORY_LOG_LEVEL=debug

COPY package.json ./
RUN npm install --omit=dev

COPY orchestrator/ ./orchestrator/
COPY agents/ ./agents/
COPY scopes/ ./scopes/
COPY src/ ./src/

RUN test -f /app/orchestrator/run-task.js

CMD ["node", "src/worker.js"]
