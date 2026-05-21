#!/usr/bin/env bash
# Uso: ./scripts/start-tenant-worker.sh <tenant-id> [--build]
set -euo pipefail
TENANT_ID="${1:-}"
BUILD=false
if [[ "${2:-}" == "--build" ]]; then
  BUILD=true
fi
if [[ -z "$TENANT_ID" ]]; then
  echo "Uso: $0 <tenant-id> [--build]" >&2
  exit 1
fi
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ "$BUILD" == true ]]; then
  echo "A construir imagem ai-factory-cli:latest..."
  docker build -t ai-factory-cli:latest "$ROOT"
fi
ENV_FILE="$ROOT/data/tenants/$TENANT_ID/.env"
IMAGE="${AIFACTORY_CLI_IMAGE:-ai-factory-cli:latest}"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Ficheiro $ENV_FILE não encontrado. Gere com pull-tenant-env no repo back." >&2
  exit 1
fi
NAME="aifactory-cli-${TENANT_ID}"
docker rm -f "$NAME" 2>/dev/null || true
NETWORK_ARGS=()
if [[ -n "${AIFACTORY_DOCKER_NETWORK:-}" ]]; then
  NETWORK_ARGS=(--network "$AIFACTORY_DOCKER_NETWORK")
fi
docker run -d --name "$NAME" \
  --env-file "$ENV_FILE" \
  -v "$ROOT/data/tenants/$TENANT_ID:/app/data/tenants/$TENANT_ID" \
  --add-host=host.docker.internal:host-gateway \
  "${NETWORK_ARGS[@]}" \
  "$IMAGE"
echo "Worker $NAME iniciado."
echo "Redis no .env do tenant: use host.docker.internal no Docker (nao 127.0.0.1)."
