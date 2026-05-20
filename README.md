# ai-factory-cli

**Cliente** AI Factory instalado na máquina do **tenant**: um **container Docker por tenant**.

Dentro do container:

- **Worker** (`src/worker.js`) — claim de jobs na API, execução local, logs no Redis
- **Orquestrador** (`orchestrator/`) — scope, develop, pipeline de tasks
- **Cursor Agent** (`agent` no PATH) — execução dos prompts com `CURSOR_API_KEY`
- **Volume** `data/tenants/<tenantId>/` — workspaces, `agents/`, `scopes/`

**Não é** backend nem frontend. Não expõe portal; liga-se ao back publicado e ao Redis de logs.

## Guia operacional

Ver **[docs/CLIENT.md](docs/CLIENT.md)** — instalação, variáveis, Redis, rede N8N, smoke.

Regras dos agentes no volume: [AGENTS.md](AGENTS.md).

## Build da imagem

```bash
docker build -t ai-factory-cli .
```

A imagem inclui o **Cursor CLI** (`agent`). Override: `CURSOR_AGENT`.

## Arranque do worker

```bash
# No repo back (gera data/tenants/<uuid>/.env):
npm run pull-tenant-env -- <tenant-uuid>

# Neste repo:
./scripts/start-tenant-worker.sh <tenant-uuid>
# Windows: .\scripts\start-tenant-worker.ps1 <tenant-uuid>
```

`.env` do tenant (obrigatório): `TENANT_ID`, `BACK_URL`, `WORKER_SECRET`, `REDIS_URL`, `CURSOR_API_KEY`.

## Logs (Redis)

Gravação direta no Redis (`RPUSH` + `PUBLISH`), não por HTTP. `DEL` da lista no início de cada job. Ver `src/job-log-redis.js`.

## Scripts locais (fora do worker)

```bash
npm run scope|develop|task
```

Requer `CURSOR_API_KEY` e `agent` no PATH (ou ambiente de dev com Cursor instalado).

## Relacionados

- Backend: [../ai-factory-back/README.md](../ai-factory-back/README.md)
- Frontend: [../ai-factory-front/README.md](../ai-factory-front/README.md)
