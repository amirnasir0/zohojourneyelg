#!/usr/bin/env bash
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Usage: ./deploy.sh <path-to-tenant-config.json>" >&2
  exit 1
fi

CONFIG_PATH="$1"

npx tsx src/scripts/validate-config.ts "$CONFIG_PATH"
