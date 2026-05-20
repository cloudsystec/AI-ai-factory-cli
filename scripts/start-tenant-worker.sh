#!/usr/bin/env bash
# Uso: ./scripts/start-tenant-worker.sh <tenant-id>
set -euo pipefail
TENANT_ID="${1:-}"
if [[ -z "$TENANT_ID" ]]; then
  echo "Uso: $0 <tenant-id>" >&2
  exit 1
fi
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/data/tenants/$TENANT_ID/.env"
IMAGE="${AIFACTORY_CLI_IMAGE:-ai-factory-cli:latest}"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Ficheiro $ENV_FILE não encontrado. Gere com pull-tenant-env no repo back." >&2
  exit 1
fi
NAME="aifactory-cli-${TENANT_ID}"
docker rm -f "$NAME" 2>/dev/null || true
docker run -d --name "$NAME" \
  --env-file "$ENV_FILE" \
  -v "$ROOT/data/tenants/$TENANT_ID:/app/data/tenants/$TENANT_ID" \
  --add-host=host.docker.internal:host-gateway \
  "$IMAGE"
echo "Worker $NAME iniciado."
