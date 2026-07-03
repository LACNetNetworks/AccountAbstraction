# Google Login AA Example for LNET

This example is a browser client for the LNET Account Abstraction stack. It uses Privy only for
Google login and embedded EOA signing; it does not use Privy's smart wallet product.

The full path is:

```text
Google login -> Privy embedded EOA -> sign EntryPoint.getUserOpHash -> local LNET bundler -> EntryPoint.handleOps
```

The Google-created embedded wallet becomes the `owner` of the `LnetAccount` created by
`LnetAccountFactory.createAccount`. The browser never sends a raw LNET transaction and never sees the
relayer private key.

## What This App Does

When you submit a `Storage` contract address, the app:

1. Reads the Privy embedded EVM wallet created by Google login.
2. Computes a counterfactual `LnetAccount` address with `LnetAccountFactory.getAddress(owner, salt)`.
3. Builds a v0.7 `PackedUserOperation` with `initCode` that creates the account.
4. Encodes `LnetAccount.execute(storage, 0, Storage.set(value))`.
5. Calls `EntryPoint.getUserOpHash(userOp)`.
6. Signs that hash with the Privy embedded wallet.
7. Sends `eth_sendUserOperation` to the local bundler.
8. Polls `eth_getUserOperationReceipt` until the bundler reports the `handleOps` tx.

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

### 2. Local direct bundler

Start the direct LNET bundler from the repo root:

```bash
./bundler/test-service/start-bundler.sh
```

The bundler needs `bundler/test-service/.env`. Create it from the repo root `.env`:

```bash
cp .env bundler/test-service/.env
```

That `.env` must contain a relayer key with direct raw-tx writer permission on LNET. The frontend
does not need that key.

### 3. Storage contract

Deploy a `Storage` contract to LNET. You can use the direct E2E script:

```bash
node script/directE2E.cjs
```

Copy the printed `Storage:` address into the frontend input.

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
VITE_BUNDLER_URL=http://127.0.0.1:3000
VITE_READ_RPC_URL=http://127.0.0.1:3000
VITE_ENTRYPOINT_ADDRESS=0x9fD181236dA8c890bD5007b44B80E395E130c57D
VITE_FACTORY_ADDRESS=0x5589A0E344688976e473FD56BAe94411d9d56f67
```

`VITE_BUNDLER_URL` is where the app sends ERC-4337 bundler RPC calls.

`VITE_READ_RPC_URL` should stay pointed at the local bundler for browser testing. The bundler proxies
read-only JSON-RPC methods like `eth_call`, `eth_getCode`, `eth_blockNumber`, `eth_getBalance`, and
`eth_getTransactionReceipt` to LNET. This avoids browser CORS failures against the private LNET RPC.

`VITE_LNET_RPC_URL` is kept for reference and local tooling, but the browser path should not call it
directly unless that RPC explicitly allows your browser origin.

## Run

From the example folder:

```bash
npm install
npm run dev
```

Open:

```text
http://127.0.0.1:5173
```

Click **Continue with Google**, paste a deployed `Storage` address, choose the value to write, and
submit.

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

Use the local bundler as the browser read RPC:

```bash
VITE_READ_RPC_URL=http://127.0.0.1:3000
```

Then restart both services:

```bash
./bundler/test-service/start-bundler.sh
cd examples/privy-google-aa && npm run dev
```

Confirm the bundler is reachable:

```bash
curl -sS http://127.0.0.1:3000/health
curl -sS http://127.0.0.1:3000 \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
```

If you open the browser at `http://localhost:5173`, make sure Privy allows that origin too. For the
least friction, use `http://127.0.0.1:5173` consistently.
