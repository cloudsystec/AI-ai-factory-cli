# ai-factory-cli

Worker Docker por tenant: orquestrador + volume `data/tenants/<id>/`.

## Build

```bash
docker build -t ai-factory-cli .
```

## Worker

```bash
# .env em data/tenants/<uuid>/.env (BACK_URL, WORKER_SECRET, TENANT_ID, CURSOR_API_KEY)
./scripts/start-tenant-worker.sh <tenant-id>
```

Scripts locais: `npm run scope|develop|task`.
