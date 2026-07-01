# AccountAbstraction — ERC-4337 stack for LNET (LACChain)

An [ERC-4337](https://eips.ethereum.org/EIPS/eip-4337) (Account Abstraction) v0.7 stack targeting the
**LNET network on LACChain**, starting on testnet. Built with [Foundry](https://book.getfoundry.sh/).

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
