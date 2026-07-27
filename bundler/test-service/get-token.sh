#!/usr/bin/env bash
# Fetch a Keycloak access token for testing the bundler's JWT auth.
#
# The bundler client (naas-client) is configured for the standard (authorization
# code) flow, which needs a browser redirect and cannot be scripted with curl.
# For a headless test loop this helper uses a token endpoint grant instead:
#
#   GRANT=client_credentials  (default) -> needs "Service accounts roles" enabled on the client
#   GRANT=password            -> needs "Direct access grants" enabled; set KC_USERNAME / KC_PASSWORD
#
# Prints the raw access_token to stdout so it can be captured:
#
#   TOKEN=$(./bundler/test-service/get-token.sh)
#   curl -H "authorization: Bearer $TOKEN" ...
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

KEYCLOAK_URL="${KEYCLOAK_URL:?set KEYCLOAK_URL, e.g. https://auth.l-net.io}"
KEYCLOAK_REALM="${KEYCLOAK_REALM:?set KEYCLOAK_REALM, e.g. naas-realm}"
KEYCLOAK_CLIENT_ID="${KEYCLOAK_CLIENT_ID:?set KEYCLOAK_CLIENT_ID, e.g. naas-client}"
KEYCLOAK_CLIENT_SECRET="${KEYCLOAK_CLIENT_SECRET:?set KEYCLOAK_CLIENT_SECRET}"
GRANT="${GRANT:-client_credentials}"

TOKEN_URL="${KEYCLOAK_URL%/}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/token"

args=(
  --silent --show-error --fail-with-body
  -X POST "$TOKEN_URL"
  -H "content-type: application/x-www-form-urlencoded"
  --data-urlencode "client_id=${KEYCLOAK_CLIENT_ID}"
  --data-urlencode "client_secret=${KEYCLOAK_CLIENT_SECRET}"
  --data-urlencode "grant_type=${GRANT}"
)

if [[ "$GRANT" == "password" ]]; then
  args+=(
    --data-urlencode "username=${KC_USERNAME:?set KC_USERNAME for password grant}"
    --data-urlencode "password=${KC_PASSWORD:?set KC_PASSWORD for password grant}"
    --data-urlencode "scope=openid"
  )
fi

response="$(curl "${args[@]}")"

token="$(printf '%s' "$response" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);if(j.access_token){process.stdout.write(j.access_token);}else{console.error("no access_token in response:\n"+s);process.exit(1);}}catch(e){console.error("bad token response:\n"+s);process.exit(1);}})')"

printf '%s' "$token"
