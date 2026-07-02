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

`BUNDLER_SIMULATION=try` attempts `simulateValidation`. The deployed canonical EntryPoint may not
expose simulation methods directly, so `try` accepts the op if simulation is unavailable. Use
`required` only with an EntryPoint/simulation setup that supports it.

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
