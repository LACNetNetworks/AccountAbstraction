# AccountAbstraction — ERC-4337 stack for LNET

An [ERC-4337](https://eips.ethereum.org/EIPS/eip-4337) (Account Abstraction) v0.7 stack targeting the
**LNET network**, starting on testnet. Built with [Foundry](https://book.getfoundry.sh/).

LNET is a permissioned EVM network that runs with **`gasPrice = 0`**. The stack therefore uses gas
sponsorship (paymaster) primarily as a policy/allow-list gate rather than for economic subsidy.

## Components

| Contract | File | Role |
| --- | --- | --- |
| `LnetAccount` | `src/LnetAccount.sol` | Single-owner ECDSA smart account (UUPS-upgradeable, behind an ERC1967 proxy). |
| `LnetAccountFactory` | `src/LnetAccountFactory.sol` | CREATE2 factory producing counterfactual account addresses. |
| `LnetVerifyingPaymaster` | `src/LnetVerifyingPaymaster.sol` | Sponsors UserOps signed by an off-chain verifying signer. |
| EntryPoint (canonical v0.7) | `lib/account-abstraction` | Reference EntryPoint; deploy via `script/DeployEntryPoint.s.sol`. |

The **bundler** is an off-chain service — see [`bundler/README.md`](bundler/README.md).

## Quick start

```bash
cp .env.example .env    # fill in PRIVATE_KEY, ENTRYPOINT_ADDRESS, PAYMASTER_SIGNER
forge build
forge test
```

## End-to-end tests

There are **three** ways to exercise the stack end-to-end, from fully local to fully live on LNET:

| # | What | Where it runs | Needs the network? |
| --- | --- | --- | --- |
| 1 | Foundry tests (`forge test`) | local EVM, real `EntryPoint.handleOps` | no |
| 2 | Live via the Hub (`script/hubE2E.cjs`) | LNET testnet, routed through the PermissionedMetaTxHub | yes + permissioned relayer & Hub deployer |
| 3 | Live direct (`script/directE2E.cjs`) | LNET testnet, `handleOps` straight to the EntryPoint | yes + relayer with **direct raw-tx** permission |

### 1. Foundry tests (local, no network)

The fastest loop. `test/LnetStack.t.sol` drives the real v0.7 `EntryPoint.handleOps` on a local EVM,
with all gas fields packed to 0 to match LNET.

```bash
forge test --match-contract LnetStackTest -vv
```

```
Ran 6 tests for test/LnetStack.t.sol:LnetStackTest
[PASS] test_createAccount_isIdempotent() (gas: 163539)
[PASS] test_getAddress_matchesDeployedAccount() (gas: 164746)
[PASS] test_handleOps_deploysAndExecutes() (gas: 342652)
[PASS] test_paymaster_rejectsWrongSigner() (gas: 328832)
[PASS] test_paymaster_sponsorsDeployAndExecute() (gas: 369549)
[PASS] test_paymaster_sponsorsUserOp() (gas: 361331)
Suite result: ok. 6 passed; 0 failed; 0 skipped
```

Run a single test with `forge test --match-test test_paymaster_sponsorsUserOp -vvv`.

### Prerequisites for the live scripts (2 & 3)

Both live scripts are Node/ethers and read `.env` from the repo root. Keys are never printed.

```bash
forge build          # produces out/Storage.sol/Storage.json used by the scripts
npm install          # ethers (already vendored if node_modules exists)
```

`.env` keys (see `.env.example`):

| Var | Used by | Meaning |
| --- | --- | --- |
| `RELAYER_PK` / `PRIVATE_KEY` | 2 & 3 | relayer/bundler EOA that sends the tx |
| `SENDER_PK` | 2 (Hub) | the Hub-permissioned deployer = `forward.from` |
| `PAYMASTER_SIGNER_KEY` | 2 & 3 (optional) | paymaster `verifyingSigner`; blank ⇒ paymaster-less |

> The LNET RPC (`http://34.69.184.205:4545`) is usually reachable only from inside the network
> (VPN / IP allowlist). A connection timeout is an access issue, not a bug.

Each script runs the same shape: deploy a `Storage`, send a UserOp that **creates a smart account via
`initCode` and calls `Storage.set(42)` through it**, then verify `account.owner()` and
`storage.value() == 42`.

### 2. Live via the Hub (`hubE2E.cjs`)

Wraps `handleOps` as a `Hub.execute` meta-tx — the path that works today for any LNET relayer that is
allowlisted in the Hub. Requires two permissioned accounts (`RELAYER_PK` + `SENDER_PK`).

```bash
node script/hubE2E.cjs
```

```
relayer:        0x248906Bf539e8f16FbD14c001f7Bd3D712f95D3E
deployer(from): 0x5fB09D06843f407982adCBe99453792769b6dD38
paymaster:      NONE (paymaster-less; prefund=0 on LNET)
account owner:  0x4DE9Aff516A236999A9C94556C910348D680469a

[1] Deploying Storage via Hub...
    Storage deployed: 0x9F87419cba22C1dC93D191f0A91C26ec1DD0B065 | tx 0xb93a87b4...
[2] Smart account (counterfactual): 0x3B74455e20BADFaCFED9D66F53e7e71626F50530
[3] Sending sponsored handleOps via Hub...
    handleOps tx: 0xc5c2de39... | status 1
[4] Verification:
    account deployed: true
    account.owner(): ... -> true
    storage.value(): 42 (expected 42)

✅ E2E OK: account created + sponsored UserOp executed Storage.set(42) via Hub
```

### 3. Live direct — no Hub (`directE2E.cjs`)

Sends `handleOps` straight to the EntryPoint as a plain legacy tx (`gasPrice = 0`). Only needs the
relayer key, but that relayer must hold **direct raw-tx (writer)** permission on LNET — otherwise the
node returns `-32007 "Sender account not authorized"` and the script points you back to `hubE2E.cjs`.

Paymaster-less:

```bash
node script/directE2E.cjs
```

```
relayer (tx sender): 0x248906Bf539e8f16FbD14c001f7Bd3D712f95D3E
paymaster:           NONE (paymaster-less; prefund=0 on LNET)
account owner:       0x16547979C8f919E3a226F9433de62Dc7b73a9921

[1] Deploying Storage (direct tx)...
    Storage deployed: 0x73C984a3a96430709d6501efAf2a900e0250bFb5 | tx 0xc607ec20...
[2] Smart account (counterfactual): 0xF54F522252b7De1018B3EE38c9CB63850fD4Ad3F
[3] Sending handleOps (direct tx to EntryPoint)...
    handleOps tx: 0x5bea5978... | status 1
[4] Verification:
    account deployed: true
    account.owner(): ... -> true
    storage.value(): 42 (expected 42)

✅ E2E OK: account created + UserOp executed Storage.set(42) directly (no Hub)
```

Sponsored by the paymaster (set `PAYMASTER_SIGNER_KEY` to the `verifyingSigner` key):

```bash
PAYMASTER_SIGNER_KEY=$(grep '^SENDER_PK=' .env | cut -d= -f2-) node script/directE2E.cjs
```

```
paymaster:           sponsored via 0x5fB09D06843f407982adCBe99453792769b6dD38
...
[3] Sending handleOps (direct tx to EntryPoint)...
    handleOps tx: 0xceecdc35... | status 1
✅ E2E OK: account created + UserOp executed Storage.set(42) directly (no Hub)
```

Contract addresses default to the deployed testnet instances and can be overridden via
`ENTRYPOINT_ADDRESS` / `FACTORY_ADDRESS` / `PAYMASTER_ADDRESS`.

## Deploy to LNET testnet

```bash
# 1. (once, if LNET has no canonical EntryPoint) deploy it
forge script script/DeployEntryPoint.s.sol --rpc-url lnet_testnet --broadcast --legacy --with-gas-price 0
# set ENTRYPOINT_ADDRESS in .env to the printed address

# 2. deploy factory + paymaster
forge script script/DeployStack.s.sol --rpc-url lnet_testnet --broadcast --legacy --with-gas-price 0
```

`--legacy --with-gas-price 0` are required because LNET has no EIP-1559 fee market and gasPrice is 0.

## Network

| | |
| --- | --- |
| RPC URL | `http://34.69.184.205:4545` |
| Chain ID | `648540` |
| Gas | `gasPrice = 0` (permissioned; deployer must be an authorized writer account) |

## Docs

- [`docs/architecture.md`](docs/architecture.md) — how the pieces fit together and the UserOp lifecycle.
