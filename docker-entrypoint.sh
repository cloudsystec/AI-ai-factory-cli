#!/bin/sh
set -e

TENANT_ROOT="/app/data/tenants/${TENANT_ID}"
if [ -n "$TENANT_ID" ]; then
  mkdir -p "${TENANT_ROOT}/workspaces"
  mkdir -p "${TENANT_ROOT}/scopes/macro"
  mkdir -p "${TENANT_ROOT}/agents"
fi

exec node src/worker.js
