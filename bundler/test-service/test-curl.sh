#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

HOST="${BUNDLER_HOST:-127.0.0.1}"
PORT="${BUNDLER_PORT:-3000}"
URL="http://$HOST:$PORT"

rpc() {
  local id="$1"
  local method="$2"
  local params="${3:-[]}"

  curl -sS "$URL" \
    -H "content-type: application/json" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":$id,\"method\":\"$method\",\"params\":$params}"
  printf "\n"
}

echo "== Health =="
curl -sS "$URL/health"
printf "\n\n"

echo "== lnet_bundlerStatus =="
rpc 1 "lnet_bundlerStatus"
printf "\n"

echo "== eth_chainId =="
rpc 2 "eth_chainId"
printf "\n"

echo "== eth_supportedEntryPoints =="
rpc 3 "eth_supportedEntryPoints"
