# Google Login AA Example for LNET

This example is a browser client for the LNET Account Abstraction stack. It uses Privy only for
Google login and embedded EOA signing; it does not use Privy's smart wallet product.

The full path is:

```text
Google login -> Privy embedded EOA -> sign EntryPoint.getUserOpHash -> LNET bundler -> EntryPoint.handleOps
                                                                       (bundler.l-net.io)
                                                                          ^
                          token backend -> Keycloak access token (Bearer) -+
```

The Google-created embedded wallet becomes the `owner` of the `LnetAccount` created by
`LnetAccountFactory.createAccount`. The browser never sends a raw LNET transaction and never sees the
relayer private key.

The bundler is protected with Keycloak JWT auth, so write calls (`eth_sendUserOperation`) need a
Bearer token. A small **token backend** (`server/token-server.mjs`) logs into Keycloak server-side
with the NAAS client secret and user credentials from `.env`, and returns only a short-lived access
token to the browser — the secret and password never reach the frontend.

## Quick Start

The bundler is hosted at <https://bundler.l-net.io>, so nothing has to run locally for it. The
example only needs **two local services**: the token backend (`:8787`) and the Vite dev server
(`:5173`). One command starts both:

```bash
cd examples/privy-google-aa
npm install
npm run dev:all      # token backend (:8787) + Vite (:5173)
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
7. Fetches a Keycloak access token from the token backend (`/api/token`).
8. Sends `eth_sendUserOperation` to the bundler with `Authorization: Bearer <token>`.
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

### Token backend (Keycloak)

The token backend needs these `.env` values (no `VITE_` prefix, so Vite never ships them to the
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
```

The backend does a Keycloak password-grant login and exposes `POST /api/token`, which the Vite dev
server proxies (`/api` -> `http://127.0.0.1:8787`). The frontend fetches the token from there and
attaches it as `Authorization: Bearer` on write calls, refreshing it once on a `-32001` from the
bundler. The NAAS user must have the bundler's required role (e.g. `bundler-writer`); otherwise the
bundler rejects writes with `-32001 token missing required role`.

`VITE_READ_RPC_URL` should stay pointed at the bundler for browser testing. The bundler proxies
read-only JSON-RPC methods like `eth_call`, `eth_getCode`, `eth_blockNumber`, `eth_getBalance`, and
`eth_getTransactionReceipt` to LNET. This avoids browser CORS failures against the private LNET RPC.

`VITE_LNET_RPC_URL` is kept for reference and local tooling, but the browser path should not call it
directly unless that RPC explicitly allows your browser origin.

## Run

From the example folder, start both the token backend and the Vite dev server:

```bash
npm install
npm run dev:all      # token backend (:8787) + Vite (:5173) together
```

Or run them in two terminals:

```bash
npm run server       # terminal 1: token backend on :8787
npm run dev          # terminal 2: Vite on :5173
```

`dev:all` traps `EXIT INT TERM` and kills the backgrounded token backend, so `Ctrl+C` — or Vite
exiting on its own — takes both services down instead of leaving `:8787` orphaned. If port `8787`
ever stays busy anyway, kill the leftover process:

```bash
lsof -ti :8787 | xargs kill
```

Sanity-check the backend:

```bash
curl -sS http://127.0.0.1:8787/api/health
curl -sS -X POST http://127.0.0.1:8787/api/token   # -> { access_token, ... }
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
