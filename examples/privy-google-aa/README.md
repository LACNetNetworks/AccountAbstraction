# Google Login AA Example for LNET

This example is a browser client for the LNET Account Abstraction stack. It uses Privy only for
Google login and embedded EOA signing; it does not use Privy's smart wallet product.

The full path is:

```text
Google login -> Privy embedded EOA -> sign EntryPoint.getUserOpHash -+
                                                                     |
                     /api/bundler (session backend, adds Bearer) <---+
                                  |
                                  v
                          LNET bundler -> EntryPoint.handleOps
                          (bundler.l-net.io)
```

The Google-created embedded wallet becomes the `owner` of the `LnetAccount` created by
`LnetAccountFactory.createAccount`. The browser never sends a raw LNET transaction and never sees the
relayer private key.

The bundler is protected with Keycloak JWT auth, so write calls (`eth_sendUserOperation`) need a
Bearer token. A small **session backend** (`server/token-server.mjs`) logs into Keycloak server-side
with the NAAS client secret and user credentials from `.env` — and the access token never reaches the
frontend either: it is stored in an **HttpOnly cookie**, and the backend proxies write calls to the
bundler, attaching `Authorization: Bearer` itself.

### Why the cookie implies a proxy

An HttpOnly cookie is unreadable to page JS — that is the point (an XSS cannot exfiltrate the token).
But it also means the frontend cannot build the `Authorization` header for the bundler, which lives on
another origin. So the authenticated path becomes:

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/api/session` | `POST` | verifies the caller's **Privy** access token, logs into Keycloak, `Set-Cookie: naas_session=…; HttpOnly; SameSite=Strict; Path=/api` |
| `/api/session` | `GET` | `{ authenticated, expires_at, user }` — no token in the body |
| `/api/session` | `DELETE` | clears the cookie (the Logout button calls it) |
| `/api/bundler` | `POST` | checks the UserOperation against the write policy, then forwards it with the Bearer header taken from the cookie |

Read-only RPC (`eth_call`, `eth_getUserOperationReceipt`, …) still goes straight to the bundler: it
needs no token, so it needs no proxy.

The cookie is a first-party cookie of the app's own origin because Vite proxies `/api` to the backend,
and `SameSite=Strict` keeps it off cross-site requests. It carries the Keycloak token plus the Privy
subject, HMAC-signed so that pairing cannot be forged, and it has **no `Max-Age`** — a session cookie,
kept in browser memory instead of written to the cookie database on disk. `/api/token` — the old
endpoint that handed the token to the browser — is gone and answers `410`.

### What the cookie does *not* fix

Worth being explicit, because it shapes the rest of the design: an HttpOnly cookie stops a token from
being **stolen**, not from being **used**. Injected script on the page can still call
`fetch('/api/bundler', {credentials:'same-origin', …})`, and it can ask the Privy embedded wallet to
sign a UserOperation — embedded wallets sign programmatically, with no user prompt (see
`src/userOp.ts`). So two more gates carry the actual authorization:

1. **Identity** — `POST /api/session` requires a valid Privy access token, verified offline against
   Privy's JWKS (ES256 signature, `iss`, `aud` = this app id, `exp`). No Privy app secret is needed. A
   session therefore belongs to a logged-in Google user, and every forwarded call is logged with that
   user's Privy subject. Without a login there is no route to the bundler at all.
2. **Policy** — `POST /api/bundler` validates before forwarding (`server/userop-policy.mjs`): only
   `eth_sendUserOperation`, no batches, the configured EntryPoint, zero gas fees, gas ceilings, no
   paymaster, `initCode` only through the configured factory, and the inner call restricted to an
   allow-list of targets and function signatures (default: `set(uint256)` on `VITE_STORAGE_ADDRESS`).

Same framing as `LnetVerifyingPaymaster` in this repo: the policy is off-chain and is an allow-list,
not an economic control. With both gates, the worst an XSS can do through this backend is write a
number to an allow-listed `Storage` contract as the user's own account.

Still open, and deliberately out of scope here: the backend logs into Keycloak with a **shared service
account** (`grant_type=password`), so the bundler authorizes that service, not the end user. Token
exchange (RFC 8693) against the verified Privy token would fix that. There is also no rate limit yet —
gas is free on LNET, so spam is the cheap attack.

## Quick Start

The bundler is hosted at <https://bundler.l-net.io>, so nothing has to run locally for it. The
example only needs **two local services**: the session backend (`:8787`) and the Vite dev server
(`:5173`). One command starts both:

```bash
cd examples/privy-google-aa
npm install
npm run dev:all      # session backend (:8787) + Vite (:5173)
```

Then open <http://127.0.0.1:5173>.

This assumes `.env` is filled in (see [Configure](#configure)).

## What This App Does

When you submit a `Storage` contract address, the app:

1. Reads the Privy embedded EVM wallet created by Google login.
2. Computes a counterfactual `LnetAccount` address with `LnetAccountFactory.getAddress(owner, salt)`.
3. Builds a v0.7 `PackedUserOperation` with `initCode` that creates the account.
4. Encodes `LnetAccount.execute(storage, 0, Storage.set(value))`.
5. Calls `EntryPoint.getUserOpHash(userOp)`.
6. Signs that hash with the Privy embedded wallet.
7. Ensures a session cookie exists (`POST /api/session`, authenticated with the Privy access token) —
   the Keycloak token stays in the HttpOnly cookie.
8. Sends `eth_sendUserOperation` to `/api/bundler`, which checks it against the write policy and
   forwards it with `Authorization: Bearer <token>` read from that cookie.
9. Polls `eth_getUserOperationReceipt` until the bundler reports the `handleOps` tx.

The bundler then sends the actual LNET tx:

```text
permissioned relayer EOA -> EntryPoint.handleOps([userOp], beneficiary)
```

## Prerequisites

### 1. Privy dashboard

Create a Privy app and enable:

- Google login
- Embedded EVM wallets

Allow this local origin:

```text
http://127.0.0.1:5173
```

Also allow `http://localhost:5173` if you open the app through `localhost` instead of `127.0.0.1`.

Only the public app id goes in this frontend. Do not put the Privy app secret in `.env`; browser
builds expose `VITE_*` values.

### 2. Bundler

The example points at the hosted LNET bundler:

```text
https://bundler.l-net.io
```

It runs the same direct-mode service as `bundler/` (same EntryPoint
`0x9fD181236dA8c890bD5007b44B80E395E130c57D`, Keycloak JWT auth on writes, CORS open for browsers),
so no local bundler is required. Check it before running the app:

```bash
curl -sS https://bundler.l-net.io/health
curl -sS https://bundler.l-net.io \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"lnet_bundlerStatus","params":[]}'
```

To run against a local bundler instead, start it from the repo root and point `VITE_BUNDLER_URL` /
`VITE_READ_RPC_URL` at `http://127.0.0.1:3000`:

```bash
cp .env bundler/test-service/.env     # needs a relayer key with direct raw-tx writer permission
./bundler/test-service/start-bundler.sh
```

The frontend never needs that relayer key in either case.

### 3. Storage contract

The **Storage contract** input is prefilled with an already-deployed testnet `Storage`
(`0xDcEA70eDDFA7EAB3590A1Ac7c00B48D36b4a13c6`), so you can skip this step.

To use your own, deploy one with the direct E2E script:

```bash
node script/directE2E.cjs
```

Copy the printed `Storage:` address into the frontend input, or set `VITE_STORAGE_ADDRESS` in `.env`
to change the default.

## Configure

```bash
cd examples/privy-google-aa
cp .env.example .env
```

Fill:

```bash
VITE_PRIVY_APP_ID=<your Privy app id>
```

Default network values:

```bash
VITE_LNET_RPC_URL=http://34.69.184.205:4545
VITE_LNET_CHAIN_ID=648540
VITE_BUNDLER_URL=https://bundler.l-net.io
VITE_READ_RPC_URL=https://bundler.l-net.io
VITE_ENTRYPOINT_ADDRESS=0x9fD181236dA8c890bD5007b44B80E395E130c57D
VITE_FACTORY_ADDRESS=0x5589A0E344688976e473FD56BAe94411d9d56f67
```

`VITE_BUNDLER_URL` is where the app sends ERC-4337 bundler RPC calls. Set both it and
`VITE_READ_RPC_URL` to `http://127.0.0.1:3000` to use a locally running bundler instead.

### Session backend (Keycloak)

The session backend needs these `.env` values (no `VITE_` prefix, so Vite never ships them to the
browser):

```bash
KEYCLOAK_URL=https://auth.l-net.io
KEYCLOAK_REALM=naas-realm
KEYCLOAK_CLIENT_ID=naas-client
KEYCLOAK_CLIENT_SECRET=<naas client secret>
NAAS_USERNAME=<naas user>
NAAS_PASSWORD=<naas password>
TOKEN_SERVER_HOST=127.0.0.1
TOKEN_SERVER_PORT=8787
BUNDLER_URL=https://bundler.l-net.io   # where /api/bundler forwards writes
```

The backend does a Keycloak password-grant login, sets the access token as an HttpOnly cookie, and
proxies bundler writes; the Vite dev server proxies `/api` -> `http://127.0.0.1:8787`. Keep
`BUNDLER_URL` in sync with `VITE_BUNDLER_URL` so reads and writes hit the same bundler.

It also needs the Privy **app id** to verify user tokens. It falls back to `VITE_PRIVY_APP_ID`, so
normally there is nothing extra to set; the Privy *app secret* is not used anywhere.

The frontend calls `POST /api/session` before a write and retries once — re-establishing the session —
if the proxy answers `401` or the bundler answers `-32001`. The NAAS user must have the bundler's
required role (e.g. `bundler-writer`); otherwise the bundler rejects writes with
`-32001 token missing required role`.

Write policy (defaults derived from the `VITE_*` values, so usually nothing to set):

```bash
ENTRYPOINT_ADDRESS=0x9fD181236dA8c890bD5007b44B80E395E130c57D
FACTORY_ADDRESS=0x5589A0E344688976e473FD56BAe94411d9d56f67
ALLOWED_CALL_TARGETS=0xDcEA70eDDFA7EAB3590A1Ac7c00B48D36b4a13c6   # `*` to allow any target
ALLOWED_INNER_CALLS=set(uint256)                                  # `*` to allow any inner call
```

`ALLOWED_CALL_TARGETS` defaults to `VITE_STORAGE_ADDRESS`, so with a `.env` copied from
`.env.example` the target check is default-deny: pasting a *different* `Storage` deployment into the UI
is rejected with `rejected by policy: target 0x… is not allowed` until you add it (comma separated) or
set `ALLOWED_CALL_TARGETS=*`. If **neither** variable is set, any target is accepted and the backend
warns about it at startup — the inner-call allowlist still applies in that case.

Optional cookie knobs (defaults are right for local dev):

```bash
SESSION_COOKIE_NAME=naas_session
SESSION_COOKIE_PATH=/api
SESSION_COOKIE_SAMESITE=Strict   # None (+ Secure + HTTPS) only for a cross-origin frontend
SESSION_COOKIE_SECURE=true       # implied when SameSite=None
SESSION_SECRET=                  # fixes cookie signing across restarts
```

If the frontend does not go through the Vite proxy — `VITE_API_BASE` set to an absolute URL — the
requests become cross-origin, so you also need `TOKEN_ALLOWED_ORIGINS`, `SESSION_COOKIE_SAMESITE=None`
and HTTPS on both sides. Staying on the proxy avoids all of that.

`VITE_READ_RPC_URL` should stay pointed at the bundler for browser testing. The bundler proxies
read-only JSON-RPC methods like `eth_call`, `eth_getCode`, `eth_blockNumber`, `eth_getBalance`, and
`eth_getTransactionReceipt` to LNET. This avoids browser CORS failures against the private LNET RPC.

`VITE_LNET_RPC_URL` is kept for reference and local tooling, but the browser path should not call it
directly unless that RPC explicitly allows your browser origin.

## Run

From the example folder, start both the session backend and the Vite dev server:

```bash
npm install
npm run dev:all      # session backend (:8787) + Vite (:5173) together
```

Or run them in two terminals:

```bash
npm run server       # terminal 1: session backend on :8787
npm run dev          # terminal 2: Vite on :5173
```

`dev:all` traps `EXIT INT TERM` and kills the backgrounded session backend, so `Ctrl+C` — or Vite
exiting on its own — takes both services down instead of leaving `:8787` orphaned. If port `8787`
ever stays busy anyway, kill the leftover process:

```bash
lsof -ti :8787 | xargs kill
```

Sanity-check the backend:

```bash
# Reports the Keycloak issuer, the bundler, the Privy app id and the active policy
curl -sS http://127.0.0.1:8787/api/health

# Creating a session needs a real Privy login, so curl gets a 401 here — that is
# the identity gate working, not a misconfiguration:
curl -sS -X POST http://127.0.0.1:8787/api/session
# -> {"error":"missing Privy access token — log in with Google first"}

# Same for the proxy without a cookie:
curl -sS -X POST http://127.0.0.1:8787/api/bundler \
  -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
# -> {"error":"no session — POST /api/session first"}
```

The full authenticated path is exercised from the browser, or by `npm test`, which unit-tests the
Privy verifier, the cookie codec and the write policy against a locally generated ES256 key (no
network, no Keycloak):

```bash
npm test
```

Open:

```text
http://127.0.0.1:5173
```

Click **Continue with Google**, keep the prefilled `Storage` address (or paste another deployment),
choose the value to write, and submit.

Expected result:

- The UI shows the embedded wallet owner.
- The UI shows the counterfactual smart account.
- The UI shows the UserOp hash.
- The bundler returns a receipt with the `handleOps` transaction hash.

## Notes

- The browser never sends a raw LNET transaction.
- The bundler access token is never in JS reach: no `localStorage`, no `sessionStorage`, no in-memory
  copy — only the HttpOnly cookie, which `document.cookie` cannot see.
- The bundler relayer still needs direct raw-tx permission on LNET.
- Gas fields are packed as zero to match LNET.
- This example does not use Privy's smart wallet product. It only uses Privy for Google auth plus an
  embedded EOA signer, then uses this repo's `LnetAccount`.
- The example creates a new smart account on each submission because it uses a fresh random salt. That
  keeps testing simple and avoids nonce reuse while iterating.

## Troubleshooting

### `Login with Google not allowed`

This is a Privy dashboard configuration issue. The frontend reached Privy, but Privy returned `403`
from `https://auth.privy.io/api/v1/oauth/init`.

Check:

- `VITE_PRIVY_APP_ID` matches the app where you enabled Google.
- Google is enabled in the app's login methods.
- `http://127.0.0.1:5173` is allowed for the app/client.
- If you opened `http://localhost:5173`, add that origin too.

The Privy app secret is not needed in this frontend and must not be exposed to the browser.

### `Buffer is not defined`

The app imports `src/polyfills.ts`, which installs the `buffer` package on `globalThis.Buffer` before
Privy loads. If this error appears again, check that:

- `buffer` is installed.
- `src/main.tsx` imports `./polyfills` before `@privy-io/react-auth`.
- You restarted Vite after installing dependencies.

### MetaMask global provider warning

This warning means multiple wallet extensions are trying to set `window.ethereum`. It is noisy but
does not cause the Privy `403`. Disable extra wallet extensions only if they interfere with the UI.

### `rejected by policy: …`

The write policy in `server/userop-policy.mjs` refused to forward the UserOperation. The message names
the rule. The common ones:

- `target 0x… is not allowed` — a `Storage` address that is not in `ALLOWED_CALL_TARGETS`.
- `inner call 0x… is not allowed` — the inner call is not `set(uint256)`.
- `entryPoint must be 0x…` — `VITE_ENTRYPOINT_ADDRESS` and the backend's `ENTRYPOINT_ADDRESS` disagree.
- `gasFees must be zero on LNET` — something set a non-zero fee.

### `missing Privy access token` on every write

The backend only mints a session for a verified Privy user. Check that you are logged in (the Logout
button is visible), and that `VITE_PRIVY_APP_ID` matches the app whose tokens the browser presents — the
`aud` claim must equal that app id. `curl` will always get this error; that is the gate working.

### `no session — POST /api/session first` on every write

The session cookie is not reaching the backend. Check, in order:

- You are calling the app through the Vite dev server (`http://127.0.0.1:5173`), not the backend port
  directly — otherwise the request is cross-origin and `SameSite=Strict` drops the cookie.
- `VITE_API_BASE` is unset (or `/api`). An absolute URL needs `TOKEN_ALLOWED_ORIGINS` +
  `SESSION_COOKIE_SAMESITE=None` + HTTPS.
- You did not switch between `127.0.0.1` and `localhost` mid-session: they are different cookie hosts.
- The backend log has no `access token is N bytes — close to the 4KB cookie limit` warning; past ~4KB
  the browser silently drops the cookie.

### `Failed to fetch`

This usually means the browser could not reach a JSON-RPC endpoint or the endpoint blocked the
browser with CORS.

Use the bundler as the browser read RPC — never the raw LNET RPC, which does not allow browser
origins:

```bash
VITE_READ_RPC_URL=https://bundler.l-net.io
```

Then restart Vite (`VITE_*` values are baked in at startup):

```bash
cd examples/privy-google-aa && npm run dev
```

Confirm the bundler is reachable:

```bash
curl -sS https://bundler.l-net.io/health
curl -sS https://bundler.l-net.io \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'   # -> 0x9e55c (648540)
```

If you open the browser at `http://localhost:5173`, make sure Privy allows that origin too. For the
least friction, use `http://127.0.0.1:5173` consistently.
