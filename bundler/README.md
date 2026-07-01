# Bundler on LNET (LACChain)

The bundler is an **off-chain** service. This repo does not implement one; it deploys the on-chain
stack (EntryPoint, factory, paymaster) and provides configuration to point an existing ERC-4337 v0.7
bundler at LNET.

## Recommended bundler

Use [eth-infinitism/bundler](https://github.com/eth-infinitism/bundler) (v0.7 branch) or
[Pimlico Alto](https://github.com/pimlicolabs/alto) — both support EntryPoint v0.7.

## LNET specifics

- **Zero gas.** LNET runs with `gasPrice = 0`. Configure the bundler with `maxFeePerGas = 0` and
  `maxPriorityFeePerGas = 0`, and disable any minimum-priority-fee / profitability checks (the
  bundler must not require the UserOp to pay it, since fees are zero).
- **Permissioned RPC.** The bundler's signer account must be an authorized LNET *writer* account.
- **Chain id `648540`**, RPC `http://34.69.184.205:4545` (see `.env`).
- **No mempool P2P** needed for a single-operator testnet; run the bundler in private/`--unsafe`
  mode initially, then tighten.

## Example config (eth-infinitism bundler)

See `bundler.config.json` in this directory. Start with:

```bash
# in a checkout of eth-infinitism/bundler
yarn bundler --config /path/to/AccountAbstraction/bundler/bundler.config.json --unsafe
```

Fill `entryPoint` with the address printed by `script/DeployEntryPoint.s.sol` and `mnemonic`/`beneficiary`
with your LNET writer account.
