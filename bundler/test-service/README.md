# Bundler Test Service

This folder contains local helper scripts for running and testing the direct LNET bundler with the
same environment as the project root.

## Setup

From the repo root:

```bash
cp .env bundler/test-service/.env
```

The copied `.env` is intentionally ignored by git. It must contain an LNET relayer key:

```bash
RELAYER_PK=0x...
```

`RELAYER_PK` can fall back to `PRIVATE_KEY`, matching the direct E2E scripts. The relayer must have
direct raw-tx writer permission on LNET because this bundler does not route through the Hub.

## Start The Bundler

```bash
./bundler/test-service/start-bundler.sh
```

Defaults:

```text
BUNDLER_HOST=127.0.0.1
BUNDLER_PORT=3000
BUNDLER_BUNDLE_GAS_LIMIT=8000000
```

The service listens at `http://127.0.0.1:3000`.

## Basic Curl Test

In another terminal:

```bash
./bundler/test-service/test-curl.sh
```

This checks:

- `/health`
- `lnet_bundlerStatus`
- `eth_chainId`
- `eth_supportedEntryPoints`

## Storage UserOp Test

Run:

```bash
./bundler/test-service/test-storage-via-bundler.sh
```

This test:

1. Deploys `Storage` to LNET with the direct relayer.
2. Builds a v0.7 `PackedUserOperation`.
3. Creates a new `LnetAccount` through `initCode`.
4. Calls `Storage.set(42)` through `LnetAccount.execute`.
5. Sends the UserOp through `eth_sendUserOperation`.
6. Polls `eth_getUserOperationReceipt`.
7. Verifies that `Storage.value()` is `42`.

## Browser CORS Check

The bundler also responds to browser preflight requests:

```bash
curl -i -X OPTIONS http://127.0.0.1:3000 \
  -H 'origin: http://127.0.0.1:5173' \
  -H 'access-control-request-method: POST'
```

Expected result: `204 No Content` with `access-control-allow-origin: *`.
