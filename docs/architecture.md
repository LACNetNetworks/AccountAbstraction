# Architecture

## Overview

This is a standard ERC-4337 v0.7 deployment. Users control **smart contract accounts** rather than
EOAs. Intents are expressed as **UserOperations** (UserOps), collected off-chain by a **bundler**,
and executed on-chain by a singleton **EntryPoint** that calls each account's `validateUserOp` then
its `callData`. An optional **paymaster** can sponsor a UserOp.

```
User ──sign──▶ UserOp ──▶ Bundler (off-chain) ──handleOps──▶ EntryPoint ──▶ LnetAccount.validateUserOp
                                                                     │              └─▶ execute(dest, value, func)
                                                                     └─▶ LnetVerifyingPaymaster.validatePaymasterUserOp
```

## On-chain contracts (this repo)

- **`LnetAccount`** — single-owner account. `_validateSignature` recovers the ECDSA signer from the
  EntryPoint-provided `userOpHash` and checks it equals `owner`. Execution entrypoints are
  `execute` / `executeBatch`, callable only by the EntryPoint or the owner. UUPS-upgradeable, owner-gated.
- **`LnetAccountFactory`** — deploys one `LnetAccount` implementation in its constructor, then mints
  per-user **ERC1967 proxies** via CREATE2. `getAddress(owner, salt)` returns the counterfactual
  address so the account can be funded/referenced before it exists; `createAccount` is idempotent and
  is invoked through the UserOp `initCode` on first use.
- **`LnetVerifyingPaymaster`** — trusts an off-chain `verifyingSigner`. The signer approves a UserOp
  by signing `getHash(userOp, validUntil, validAfter)`; the contract re-derives that hash on-chain and
  checks the signature in `_validatePaymasterUserOp`. All sponsorship *policy* lives off-chain.

The **EntryPoint** is the canonical eth-infinitism v0.7 contract from `lib/account-abstraction`; we
deploy an instance rather than fork it.

## LNET specifics

- **`gasPrice = 0`.** UserOps set `maxFeePerGas = maxPriorityFeePerGas = 0`. The required prefund is
  therefore 0, so neither the account nor the paymaster needs an EntryPoint deposit to transact. The
  paymaster's role collapses to an **allow-list / policy gate**, not economic gas subsidy.
- **Permissioned.** Only authorized *writer* accounts may submit transactions. Both the deployer key
  and the bundler's signer must be authorized on LNET.
- **No EIP-1559.** Use `--legacy --with-gas-price 0` for all broadcasts.
- **No block explorer API.** Contract verification is manual; there is no Etherscan-compatible endpoint.

## UserOp lifecycle (paymaster-sponsored, first-time account)

1. Off-chain: compute account address with `factory.getAddress(owner, salt)`.
2. Build the UserOp with `initCode = factory ++ createAccount(owner, salt)` and
   `callData = execute(target, value, data)`.
3. Paymaster service signs `getHash(...)`; the signature is appended to `paymasterAndData`.
4. Owner signs the EntryPoint `userOpHash`; the signature goes in `signature`.
5. Bundler calls `entryPoint.handleOps([op], beneficiary)`.
6. EntryPoint: validates account signature + paymaster signature, deploys the account via initCode,
   then calls `execute`, which fans out to the target contract.

The full flow (including the `paymasterAndData` byte layout) is exercised in
`test/LnetStack.t.sol::test_paymaster_sponsorsUserOp`.
