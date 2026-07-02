# LNET private bundler

This directory contains a small ERC-4337 v0.7 JSON-RPC bundler for LNET testnet.

It is intentionally private and single-operator:

- accepts UserOps through `eth_sendUserOperation`
- keeps an in-memory mempool
- batches pending ops into `EntryPoint.handleOps`
- routes the bundle through `PermissionedMetaTxHub.execute` by default
- uses legacy transactions with `gasPrice = 0`
- rejects non-zero packed `gasFees` by default

It does **not** implement P2P mempool, reputation, stake policy, profitability checks, or signature
aggregators. That is acceptable for the current LNET testnet flow, where the network itself is
permissioned and gas is free.

## Start

```bash
cp .env.example .env
# Fill RELAYER_PK and SENDER_PK for Hub mode.
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

Hub mode is the default and matches the normal LNET path:

```bash
BUNDLER_MODE=hub
RELAYER_PK=0x... # forward.caller, allowlisted Hub caller
SENDER_PK=0x...  # forward.from, Hub-permissioned signer/deployer
```

Direct mode skips the Hub and sends `handleOps` straight to the EntryPoint. Use it only if LNET
support granted direct raw-tx writer permission to the relayer:

```bash
BUNDLER_MODE=direct
RELAYER_PK=0x...
```

Optional settings:

| Var | Default | Meaning |
| --- | --- | --- |
| `LNET_TESTNET_RPC_URL` | config `network` | LNET RPC URL |
| `LNET_TESTNET_CHAIN_ID` | `648540` | LNET chain ID |
| `ENTRYPOINT_ADDRESS` | deployed testnet EntryPoint | Supported EntryPoint |
| `LNET_HUB_ADDRESS` | testnet Hub | PermissionedMetaTxHub |
| `BUNDLER_BENEFICIARY` | relayer address | `handleOps` beneficiary |
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
