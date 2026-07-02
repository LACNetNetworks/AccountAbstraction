# Running the ERC-4337 stack on LNET

LNET is a permissioned Hyperledger Besu network with `gasPrice = 0`. The critical constraint that
shapes everything:

> **No account can send a raw transaction directly.** Only allowlisted **relayer** accounts may send
> transactions, and only **to the LNET `PermissionedMetaTxHub`**. Everything else is rejected at
> the node with JSON-RPC error `-32007 "Sender account not authorized to send transactions"`.

This means the ERC-4337 `handleOps` call cannot be sent straight to the EntryPoint by an ordinary
bundler EOA — it must be wrapped as a Hub meta-transaction.

## The two relay layers

LNET ends up with **two stacked relay hubs**, at different layers:

```
relayer EOA ──▶ PermissionedMetaTxHub.execute(forward, callData, sig)   ← LNet network-access layer
                    └──▶ EntryPoint.handleOps([userOp], beneficiary)     ← ERC-4337 application layer
                              └──▶ account.validateUserOp / execute ──▶ target
```

- **PermissionedMetaTxHub** — LNet's gateway. Gatekeeps *who may write to the chain*. Verifies an
  EIP-712 `Forward` signed by `forward.from`, requires `msg.sender == forward.caller` and that the
  caller is allowlisted, then performs the CREATE / CALL to `forward.to`.
- **EntryPoint** — ERC-4337. Provides smart accounts, paymaster sponsorship, batching. Called *by the
  Hub* (so `msg.sender` at the EntryPoint is the Hub — fine, `handleOps` accepts any caller).

Internal calls (EntryPoint → factory → account → target) are **message calls, not transactions**, so
they are not subject to Besu transaction permissioning. Only the outer tx (relayer → Hub) is.

## Two accounts must be permissioned by LNet support

| Role | In this stack | Requirement |
| --- | --- | --- |
| **relayer** = `forward.caller` | our AA bundler identity | allowlisted in the Hub (`isCallerAllowed`), gas limit per block |
| **deployer/signer** = `forward.from` | signs the Hub `Forward` | permissioned deployer, gas bucket allocation |

Both are configured by the LNet support team. A non-permissioned `forward.from` makes the Hub revert
with custom error `0xfc336c41`.

The ERC-4337 account **owner** (who signs the UserOp) does **not** need permissioning — it never sends
a transaction; the account contract validates its signature on-chain.

## Hub `execute` API

```solidity
function execute(
  Forward forward,   // {from, to, value, space, nonce, deadline, dataHash, caller}
  bytes callData,    // for CALL: the target calldata; for CREATE (to == 0): the init bytecode
  bytes signature    // EIP-712 signature by `forward.from`
) payable;
```

- `forward.to = 0x0` → CREATE (deploy); the Hub emits `ContractDeployed(signer, deployed, dataHash)`.
- `forward.to = <contract>` → CALL.
- `forward.dataHash = keccak256(callData)`.
- EIP-712 domain: `{name: "PermissionedMetaTxHub", version: "1", chainId, verifyingContract: hub}`.
- Nonce is `(space, nonce)`; use a fresh random `nonce` per meta-tx (`isNonceUsed` to check).

Testnet Hub: `0x4053cA6bcdEc6638d9Ad83a5c74d0246C7670ACd` (mainnet: `0x1B5c82C4093D2422699255f59f3B8A33c4a37773`).

## End-to-end reference

`script/hubE2E.cjs` runs the full flow live: deploys a `Storage` via the Hub, then sends a
paymaster-sponsored UserOp (that creates a smart account via `initCode` and calls `Storage.set(42)`
through it) wrapped in `Hub.execute`, and verifies the result.

```bash
# RELAYER_PK / SENDER_PK come from an LNet-permissioned pair (kept out of this repo)
RELAYER_PK=0x... SENDER_PK=0x... \
PAYMASTER_SIGNER_KEY=0x... \
NODE_PATH=<path-to-ethers-node_modules> \
node script/hubE2E.cjs
```

Verified run (block ~59,049,713):
- Storage: `0xDcEA70eDDFA7EAB3590A1Ac7c00B48D36b4a13c6`
- Smart account: `0x4818C1b33327978d69722D165A2603eE8C77b3F2`
- `handleOps` via Hub: `0xf8227d3a88559dd0e9ebcfab2ca9ac20f2714881ddebaa4398b339f7b8be95b8` (status 1)

## Hub-less variant (direct raw-tx)

The Hub is a **network-access** requirement, not part of the ERC-4337 contracts — none of `src/`,
the tests, nor the EntryPoint reference the Hub. So if LNet support grants the bundler/relayer
account **direct raw-tx (writer) permission**, `handleOps` can be sent straight to the EntryPoint and
the Hub is skipped entirely:

```
relayer EOA ──▶ EntryPoint.handleOps([userOp], beneficiary)   ← plain legacy tx, gasPrice = 0
                     └──▶ account.validateUserOp / execute ──▶ target
```

What changes versus the Hub path:

| | Hub path (`hubE2E.cjs`) | Hub-less (`directE2E.cjs`) |
| --- | --- | --- |
| Storage deploy | `Hub.execute` (CREATE), `ContractDeployed` event | direct contract-creation tx |
| `handleOps` | wrapped in `Hub.execute` meta-tx | direct `EntryPoint.handleOps` tx |
| Permissioned accounts | **two**: `forward.caller` + `forward.from` | **one**: the relayer/bundler EOA |
| Env keys | `RELAYER_PK` + `SENDER_PK` | `RELAYER_PK` (or `PRIVATE_KEY`) only |

### What to permission (testnet)

Because the only transaction target in ERC-4337 is the EntryPoint (factory, paymaster and account
are internal message calls inside `handleOps`), the grant collapses to a single account and a single
target:

| Item | Testnet address | Permission |
| --- | --- | --- |
| **relayer / bundler EOA** (`PRIVATE_KEY`) | *your key* | **direct raw-tx (writer)** — required |
| **EntryPoint** | `0x9fD181236dA8c890bD5007b44B80E395E130c57D` | allowed call target for the relayer |
| LnetAccountFactory | `0x5589A0E344688976e473FD56BAe94411d9d56f67` | none (called by EntryPoint via `initCode`) |
| LnetVerifyingPaymaster | `0xafed236702eF6F90B31560Fab884433057764B99` | none (internal to EntryPoint) |

The deployer account additionally needs raw-tx permission only if you intend to **re-deploy**
contracts (EntryPoint/factory/paymaster/Storage) without the Hub; it can be the same account as the
relayer. As with the Hub path, the AA account **owner** never needs permissioning.

### Running it

```bash
forge build   # produces out/Storage.sol/Storage.json used by the script
# .env: RELAYER_PK (or PRIVATE_KEY) with direct raw-tx permission; PAYMASTER_SIGNER_KEY optional
node script/directE2E.cjs
```

If the relayer lacks direct permission, the node rejects the tx with `-32007 "Sender account not
authorized"` and the script prints an actionable message pointing back to `hubE2E.cjs`. Addresses are
overridable via `ENTRYPOINT_ADDRESS` / `FACTORY_ADDRESS` / `PAYMASTER_ADDRESS` env vars.

## Implications for AA on LNET

- The **bundler must be an LNet-permissioned relayer** (or route through one). A public/permissionless
  bundler is not possible on this network.
- Smart accounts are still counterfactual and created on-demand via `initCode` — they do **not** need
  individual permissioning, because they never originate a transaction.
- `gasPrice = 0`, so paymaster sponsorship is a policy/allow-list gate, not economic subsidy.
- Direct `forge`/`cast` broadcasts (raw txs) fail with `-32007` **unless the sending account holds
  direct raw-tx permission**; without that grant, use the Hub path. See *Hub-less variant* above.
