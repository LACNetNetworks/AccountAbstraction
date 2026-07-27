#!/usr/bin/env bash
# Assertion-based checks for the bundler's Keycloak JWT auth.
#
# Verifies that:
#   1. read-only methods work WITHOUT a token
#   2. write methods are REJECTED without a token         (-32001)
#   3. write methods are REJECTED with a bogus token      (-32001)
#   4. write methods PASS auth with a valid Keycloak token
#
# Requires the bundler running with auth enabled (KEYCLOAK_URL + KEYCLOAK_REALM).
# Exits non-zero if any check fails.
set -uo pipefail

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

PASS=0
FAIL=0

# Extract a dotted field (e.g. error.code) from a JSON string on stdin.
json_get() {
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{let v=JSON.parse(s);for(const k of process.argv[1].split(".")){v=v==null?undefined:v[k];}process.stdout.write(v===undefined||v===null?"":String(v));}catch{process.stdout.write("");}})' "$1"
}

# POST a JSON-RPC call. $1=method $2=params $3=token(optional)
post() {
  local method="$1" params="${2:-[]}" token="${3:-}"
  local args=(-sS "$URL" -H "content-type: application/json")
  [[ -n "$token" ]] && args+=(-H "authorization: Bearer $token")
  args+=(-d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$method\",\"params\":$params}")
  curl "${args[@]}"
}

ok()   { PASS=$((PASS + 1)); echo "  PASS: $1"; }
bad()  { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }

echo "== bundler auth checks against $URL =="

# Preflight: is auth actually on? A protected call without a token must error.
gate="$(post "lnet_bundleNow")"
if [[ "$(printf '%s' "$gate" | json_get error.code)" != "-32001" ]]; then
  echo "auth does not appear to be enabled (protected call without token did not return -32001)."
  echo "response: $gate"
  echo "Start the bundler with KEYCLOAK_URL + KEYCLOAK_REALM set, then re-run."
  exit 2
fi

echo
echo "[1] read-only method without token (eth_chainId)"
resp="$(post "eth_chainId")"
if [[ -n "$(printf '%s' "$resp" | json_get result)" ]]; then
  ok "read allowed without token -> $(printf '%s' "$resp" | json_get result)"
else
  bad "read should succeed without a token: $resp"
fi

echo
echo "[2] write method without token (lnet_bundleNow) -> expect -32001"
resp="$(post "lnet_bundleNow")"
if [[ "$(printf '%s' "$resp" | json_get error.code)" == "-32001" ]]; then
  ok "write rejected without token -> $(printf '%s' "$resp" | json_get error.message)"
else
  bad "write should be rejected without a token: $resp"
fi

echo
echo "[3] write method with bogus token -> expect -32001"
resp="$(post "lnet_bundleNow" "[]" "not.a.jwt")"
if [[ "$(printf '%s' "$resp" | json_get error.code)" == "-32001" ]]; then
  ok "write rejected with bogus token -> $(printf '%s' "$resp" | json_get error.message)"
else
  bad "write should be rejected with a bogus token: $resp"
fi

echo
echo "[4] write method with a valid Keycloak token"
TOKEN="${BUNDLER_TOKEN:-$("$SCRIPT_DIR/get-token.sh" 2>/tmp/test-auth-token.err)}"
if [[ -z "$TOKEN" ]]; then
  bad "could not obtain a token from Keycloak: $(cat /tmp/test-auth-token.err 2>/dev/null)"
else
  # Decode the token's roles (realm + naas-client) to reason about the expected result.
  has_role=""
  if [[ -n "${BUNDLER_REQUIRED_ROLE:-}" ]]; then
    has_role="$(printf '%s' "$TOKEN" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const p=JSON.parse(Buffer.from(s.trim().split(".")[1],"base64url"));const r=new Set([...(p.realm_access?.roles||[]),...(p.resource_access?.[process.argv[2]]?.roles||[])]);process.stdout.write(r.has(process.argv[1])?"yes":"no");}catch{process.stdout.write("no");}})' "$BUNDLER_REQUIRED_ROLE" "${KEYCLOAK_CLIENT_ID:-}")"
  fi

  resp="$(post "lnet_bundleNow" "[]" "$TOKEN")"
  code="$(printf '%s' "$resp" | json_get error.code)"

  if [[ -n "${BUNDLER_REQUIRED_ROLE:-}" && "$has_role" != "yes" ]]; then
    # Role enforcement is on and this token lacks it -> must be rejected for the role.
    msg="$(printf '%s' "$resp" | json_get error.message)"
    if [[ "$code" == "-32001" && "$msg" == *"required role '$BUNDLER_REQUIRED_ROLE'"* ]]; then
      ok "token without '$BUNDLER_REQUIRED_ROLE' rejected for missing role -> $msg"
    else
      bad "expected rejection for missing role '$BUNDLER_REQUIRED_ROLE': $resp"
    fi
  elif [[ "$code" != "-32001" ]]; then
    ok "authorized token accepted (no auth error) -> $resp"
  else
    bad "authorized token was rejected: $resp"
  fi
fi

echo
[[ -n "${BUNDLER_REQUIRED_ROLE:-}" ]] && echo "(required role: $BUNDLER_REQUIRED_ROLE)"
echo "== $PASS passed, $FAIL failed =="
[[ "$FAIL" -eq 0 ]]
