# LNET direct bundler

This directory contains a small ERC-4337 v0.7 JSON-RPC bundler for LNET testnet.

The bundler follows the same transaction path as `script/directE2E.cjs`:

```text
relayer EOA -> EntryPoint.handleOps([userOp], beneficiary)
```

It does **not** route through `PermissionedMetaTxHub`. The relayer key must therefore have direct
raw-tx writer permission on LNET, and the EntryPoint must be an allowed call target for that relayer.

It is intentionally private and single-operator:

- accepts UserOps through `eth_sendUserOperation`
- keeps an in-memory mempool
- batches pending ops into `EntryPoint.handleOps`
- sends legacy transactions with `gasPrice = 0`
- rejects non-zero packed `gasFees` by default

It does **not** implement P2P mempool, reputation, stake policy, profitability checks, or signature
aggregators. That is acceptable for the current LNET testnet flow, where the network is permissioned
and gas is free.

## Start

```bash
cp .env.example .env
# Fill RELAYER_PK with an LNET relayer that has direct raw-tx writer permission.
npm run bundler
```

The service listens on `http://127.0.0.1:3000` by default.

Useful health/status calls:

```bash
curl -sS http://127.0.0.1:3000/health
curl -sS http://127.0.0.1:3000 \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"lnet_bundlerStatus","params":[]}'
```

## Required environment

```bash
RELAYER_PK=0x...
```

`RELAYER_PK` can fall back to `PRIVATE_KEY`, matching `script/directE2E.cjs`.

Optional settings:

| Var | Default | Meaning |
| --- | --- | --- |
| `LNET_TESTNET_RPC_URL` | config `network` | LNET RPC URL |
| `LNET_TESTNET_CHAIN_ID` | `648540` | LNET chain ID |
| `ENTRYPOINT_ADDRESS` | deployed testnet EntryPoint | Supported EntryPoint |
| `BUNDLER_BENEFICIARY` | relayer address | `handleOps` beneficiary |
| `BUNDLER_BUNDLE_GAS_LIMIT` | `8000000` | Gas limit for the direct `handleOps` transaction |
| `BUNDLER_SIMULATION` | `try` | `try`, `required`, or `disabled` |
| `BUNDLER_ENFORCE_ZERO_GAS_FEES` | true | Reject non-zero packed UserOp fees |
| `KEYCLOAK_URL` | — | Keycloak base URL, e.g. `https://auth.l-net.io`. Enables JWT auth when set with the realm |
| `KEYCLOAK_REALM` | — | Keycloak realm, e.g. `naas-realm` |
| `KEYCLOAK_CLIENT_ID` | — | Expected token `azp` (authorized party); rejects tokens from other clients |
| `BUNDLER_AUTH_ENABLED` | auto | `true`/`false` to force auth on/off (defaults on once URL+realm are set) |
| `BUNDLER_AUTH_AUDIENCE` | — | Optional expected `aud` claim |
| `BUNDLER_REQUIRED_ROLE` | — | Require this realm or client role on write methods, e.g. `bundler-writer` (empty = no role check) |

`BUNDLER_SIMULATION=try` attempts `simulateValidation`. The deployed canonical EntryPoint may not
expose simulation methods directly, so `try` accepts the op if simulation is unavailable. Use
`required` only with an EntryPoint/simulation setup that supports it.

## Authentication (Keycloak JWT)

When `KEYCLOAK_URL` and `KEYCLOAK_REALM` are set, the bundler acts as an OAuth2 **resource server**:
write methods require a valid Keycloak access token sent as `Authorization: Bearer <token>`.

- **Validation is offline.** The token's RS256 signature is verified against the realm JWKS
  (`<issuer>/protocol/openid-connect/certs`, cached), then `iss`, `exp`, optional `aud`, and — when
  `KEYCLOAK_CLIENT_ID` is set — the `azp` claim are enforced. No per-request call to Keycloak.
- **Optional role gate.** Set `BUNDLER_REQUIRED_ROLE` (e.g. `bundler-writer`) to require that role on
  write methods. It is matched against the token's realm roles (`realm_access.roles`) and the
  configured client's roles (`resource_access[KEYCLOAK_CLIENT_ID].roles`); a token without it is
  rejected with `-32001 token missing required role '...'`.
- **Only write methods are protected:** `eth_sendUserOperation` and `lnet_bundleNow`. Read-only
  proxies, status, gas estimation, hash/receipt lookups and `/health` stay open so browser examples
  can keep using the bundler as a CORS-friendly read RPC.
- An unauthenticated write call returns JSON-RPC error `-32001 unauthorized: ...`.
- Set `BUNDLER_AUTH_ENABLED=false` to disable auth entirely (e.g. for local-only runs).

Client apps obtain the token from Keycloak using the **standard (authorization code) flow**. For a
scripted test loop, `bundler/test-service/get-token.sh` fetches a token via the token endpoint:

```bash
TOKEN=$(./bundler/test-service/get-token.sh)          # client_credentials grant (default)
curl -sS http://127.0.0.1:3000 \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_sendUserOperation","params":[<userOp>, "<entryPoint>"]}'
```

The `client_credentials` grant needs *Service accounts roles* enabled on the client; `GRANT=password`
(with `KC_USERNAME`/`KC_PASSWORD`) needs *Direct access grants*. The interactive authorization-code
flow can't be completed with curl.

## JSON-RPC methods

Supported ERC-4337 methods:

- `eth_chainId`
- `eth_supportedEntryPoints`
- `eth_sendUserOperation`
- `eth_estimateUserOperationGas`
- `eth_getUserOperationByHash`
- `eth_getUserOperationReceipt`

Local operator methods:

- `lnet_bundlerStatus`
- `lnet_bundleNow`

Read-only proxy methods:

- `eth_call`
- `eth_getCode`
- `eth_blockNumber`
- `eth_getBalance`
- `eth_getTransactionReceipt`

These are proxied to the configured LNET RPC. They exist so browser examples can use the local
bundler as a CORS-friendly read RPC instead of calling the private LNET RPC directly.

## Client notes

The bundler expects ERC-4337 v0.7 `PackedUserOperation` fields:

```json
{
  "sender": "0x...",
  "nonce": "0x0",
  "initCode": "0x",
  "callData": "0x",
  "accountGasLimits": "0x0000000000000000000000000000000000000000000000000000000000000000",
  "preVerificationGas": "0x0",
  "gasFees": "0x0000000000000000000000000000000000000000000000000000000000000000",
  "paymasterAndData": "0x",
  "signature": "0x..."
}
```

On LNET, `gasFees` must pack `maxPriorityFeePerGas = 0` and `maxFeePerGas = 0`.

If LNET returns `-32007 "Sender account not authorized"`, the relayer does not have the direct
raw-tx permission required by this bundler.

## Test service helpers

The scripts in `bundler/test-service` provide the quickest manual loop:

```bash
cp .env bundler/test-service/.env
./bundler/test-service/start-bundler.sh
./bundler/test-service/test-curl.sh
./bundler/test-service/test-storage-via-bundler.sh
```

The storage test deploys `Storage` with the direct relayer, builds a UserOp that creates an
`LnetAccount`, sends it through `eth_sendUserOperation`, waits for the bundler receipt, and verifies
that `Storage.value()` is `42`.
