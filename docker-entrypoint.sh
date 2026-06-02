#!/bin/sh
set -e

if ! command -v agent >/dev/null 2>&1; then
  echo "ERRO: Cursor CLI (agent) não encontrado no PATH" >&2
  exit 1
fi
agent --version

TENANT_ROOT="/app/data/tenants/${TENANT_ID}"
if [ -n "$TENANT_ID" ]; then
  mkdir -p "${TENANT_ROOT}/workspaces"
  mkdir -p "${TENANT_ROOT}/scopes/macro"
  mkdir -p "${TENANT_ROOT}/agents"
fi

exec node src/worker.js
