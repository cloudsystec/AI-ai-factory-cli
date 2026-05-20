# Cliente AI Factory — instalação por tenant

Este repositório é o **cliente** que corre na infraestrutura do tenant (ou do operador), **um container Docker por tenant**.

## O que corre no container

| Componente | Função |
|------------|--------|
| `src/worker.js` | Poll da fila no backend, executa jobs, reporta dashboard |
| `orchestrator/*` | Pipelines scope / develop / task |
| `agent` (Cursor CLI) | Invoca prompts dos ficheiros em `data/tenants/<id>/agents/` |
| Volume montado | `data/tenants/<tenantId>/` — workspaces, scopes, agentes |

## Dependências externas

| Serviço | Variável | Notas |
|---------|----------|--------|
| **Backend** (API) | `BACK_URL` | URL publicada (ex. `http://host.docker.internal:4000` em dev Docker) |
| **Redis** (logs) | `REDIS_URL` | **Docker (worker):** `redis://host.docker.internal:6379` se Redis no PC; **N8N:** `redis://redis-stack:6379`. Não uses `127.0.0.1` dentro do container. |
| **Cursor** | `CURSOR_API_KEY` | Chave do tenant (gravada no back, exportada por `pull-tenant-env`) |
| **Cursor CLI** | `CURSOR_AGENT` (opcional) | Default na imagem: `agent` |

Sem `REDIS_URL` o worker não arranca. Sem `CURSOR_API_KEY` os jobs que usam agentes falham.

### Reset de projeto (painel)

`POST /api/projects/:slug/reset` — antes de apagar, grava ZIP em:

`data/tenants/<tenant-id>/BACKUP/YYYY-MM-DD/<slug>_HH-MM-SS.zip`

Conteúdo: `workspace/<slug>/` (código, micros, backlog, relatórios, etc.), `scopes/macro/<slug>.md`, `manifest.json`. Depois remove o workspace e restaura o macro a partir do escopo na BD.

## Instalação

### 1. Gerar `.env` do tenant (no repo back)

```bash
cd ../ai-factory-back
npm run pull-tenant-env -- <tenant-uuid>
```

Cria `ai-factory-cli/data/tenants/<uuid>/.env` com `TENANT_ID`, `BACK_URL`, `WORKER_SECRET`, `REDIS_URL` (via `TENANT_REDIS_URL` no `.env` do back), `CURSOR_API_KEY` (se existir na BD).

### 2. Build da imagem

```bash
cd ../ai-factory-cli
docker build -t ai-factory-cli .
docker run --rm ai-factory-cli agent --version   # validar Cursor CLI
```

### 3. Subir o worker

```bash
./scripts/start-tenant-worker.sh <tenant-uuid>
```

Windows:

```powershell
$env:AIFACTORY_DOCKER_NETWORK = "n8n-network"   # se usar redis-stack no N8N
.\scripts\start-tenant-worker.ps1 <tenant-uuid>
```

Ou `docker-compose.cli.yml` (perfil) com rede `n8n-network` externa.

## Redis e logs

- Lista: `aifactory:job:{jobId}:log` — reset (`DEL`) no início de cada execução
- Pub/Sub: `aifactory:job:{jobId}:live` — linhas em tempo real para o SSE do front (via back)
- TTL aplicado pelo back ao concluir o job

## Compose N8N (opcional)

Exemplos copiáveis no repo **meta** (backup): `ai-factory-meta/deploy/n8n-docker-compose.ai-factory.yml` e `.env.ai-factory.example`.

Copie para a pasta do N8N e ajuste `AIFACTORY_CLI_BUILD_CONTEXT` para o caminho do repo `ai-factory-cli`.

## Smoke

1. Back e Redis acessíveis a partir do container (`BACK_URL`, `REDIS_URL`).
2. Worker registado: logs do container sem erro de claim.
3. Job no portal → linhas no painel (snapshot + live).
4. `agent --version` dentro do container responde.

## O que este cliente não faz

- Não serve HTTP ao utilizador final (isso é o **front**).
- Não guarda tenants/jobs na BD (isso é o **back** + Postgres).
- Não substitui o Redis — precisa de instância acessível (host ou `redis-stack`).
