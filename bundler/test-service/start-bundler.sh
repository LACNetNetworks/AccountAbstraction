#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE"
  echo "Copy the project root .env into this folder before starting the bundler."
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

export BUNDLER_MODE="${BUNDLER_MODE:-direct}"
export BUNDLER_HOST="${BUNDLER_HOST:-127.0.0.1}"
export BUNDLER_PORT="${BUNDLER_PORT:-3000}"
export BUNDLER_BUNDLE_GAS_LIMIT="${BUNDLER_BUNDLE_GAS_LIMIT:-8000000}"

cd "$REPO_ROOT"
exec npm run bundler
