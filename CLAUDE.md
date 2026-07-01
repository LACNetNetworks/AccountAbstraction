# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An ERC-4337 **v0.7** Account Abstraction stack (Foundry/Solidity) targeting the **LNET network on
LACChain**, testnet first. LNET is a **permissioned EVM with `gasPrice = 0`** — this single fact
drives most of the non-obvious decisions below.

## Commands

```bash
forge build                 # compile
forge test                  # run all tests
forge test -vvv             # with traces (use -vvvv for full call traces)
forge test --match-test test_paymaster_sponsorsUserOp   # single test
forge test --match-contract LnetStackTest               # single test contract
forge fmt                   # format
forge snapshot              # gas snapshots
```

Deploy (see `.env.example` for required vars; copy to `.env` first):

```bash
# EntryPoint — only if LNET has no canonical one deployed
forge script script/DeployEntryPoint.s.sol --rpc-url lnet_testnet --broadcast --legacy --with-gas-price 0
# factory + paymaster
forge script script/DeployStack.s.sol --rpc-url lnet_testnet --broadcast --legacy --with-gas-price 0
```

## LNET gotchas (do not forget these)

- **`--legacy --with-gas-price 0` on every broadcast.** LNET has no EIP-1559 fee market and gas is
  free. UserOps must set `maxFeePerGas = maxPriorityFeePerGas = 0` (see the `gasFees` packing in
  tests). Anything assuming a non-zero fee market will break here.
- **Required prefund is 0.** Because gas is free, neither accounts nor the paymaster need an EntryPoint
  deposit to transact. The paymaster is effectively an **allow-list / policy gate**, not an economic
  subsidy — keep that framing when reasoning about it.
- **Permissioned network.** The deployer key and the bundler signer must be authorized *writer*
  accounts on LNET. The RPC (`http://34.69.184.205:4545`, chainId `648540`) is generally **not
  reachable** from a normal dev machine (VPN / IP allowlist) — do not treat a connection timeout as a
  bug in this code.
- **No Etherscan-compatible API** → contract verification is manual.

## Architecture

Standard ERC-4337 v0.7 topology. The three owned contracts in `src/` are deliberately close to the
eth-infinitism reference samples so they stay bundler-compatible:

- **`LnetAccount`** — single-owner ECDSA account. UUPS-upgradeable, deployed behind an ERC1967 proxy.
  Signature check lives in `_validateSignature`; execution via `execute` / `executeBatch` (EntryPoint
  or owner only).
- **`LnetAccountFactory`** — deploys ONE account implementation in its constructor, then mints per-user
  **CREATE2 ERC1967 proxies**. `getAddress(owner, salt)` = counterfactual address; `createAccount` is
  idempotent and runs via the UserOp `initCode`.
- **`LnetVerifyingPaymaster`** — sponsorship gated by an off-chain `verifyingSigner`. It only verifies
  a signature over `getHash(userOp, validUntil, validAfter)`; all policy is off-chain.

The **EntryPoint** is the canonical v0.7 contract imported from `lib/account-abstraction` (not forked).
The **bundler** is off-chain and not implemented here — see `bundler/`. Deeper detail, including the
`paymasterAndData` byte layout and the UserOp lifecycle, is in `docs/architecture.md`.

### Dependencies & remappings

Installed as git submodules under `lib/` (pinned): `account-abstraction@v0.7.0`,
`openzeppelin-contracts@v5.0.2`, `forge-std`. Remappings live in `foundry.toml`:
`@account-abstraction/`, `@openzeppelin/contracts/`, `forge-std/`. Solc is pinned to `0.8.23`,
`evm_version = "paris"`.

## Conventions

- New stack contracts use the `Lnet` prefix. When extending account/paymaster behavior, mirror the
  eth-infinitism v0.7 patterns (same function shapes, `PackedUserOperation`, `_packValidationData`)
  rather than inventing new interfaces — bundler compatibility depends on it.
- Tests drive the real `EntryPoint.handleOps` path (not mocks). New account/paymaster features should
  add a UserOp-level test in `test/LnetStack.t.sol`, packing gas fields to 0 to match LNET.
