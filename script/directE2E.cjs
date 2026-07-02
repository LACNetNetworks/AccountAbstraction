/**
 * Live E2E of the ERC-4337 stack on LNET, WITHOUT the LNET PermissionedMetaTxHub.
 *
 * This is the Hub-less variant of script/hubE2E.cjs. It assumes the bundler/relayer account has
 * been granted DIRECT raw-tx (writer) permission on LNET so it can send transactions straight to
 * the EntryPoint. If that grant is missing, LNET rejects the tx with:
 *
 *   -32007 "Sender account not authorized"
 *
 * ...in which case you must use hubE2E.cjs instead (route via the Hub) or ask LNet support to
 * permission the relayer address printed below. See docs/lnet-integration.md.
 *
 *   relayer -> EntryPoint.handleOps([userOp], beneficiary)     (plain legacy tx, gasPrice = 0)
 *
 * Flow: (1) deploy a Storage via a direct contract-creation tx, (2) send a UserOp that creates a
 * smart account (initCode) and calls Storage.set(42) through it, (3) verify account code + value.
 *
 * Env (secrets never printed):
 *   RELAYER_PK / PRIVATE_KEY   relayer with DIRECT raw-tx permission (also our AA bundler identity)
 *   PAYMASTER_SIGNER_KEY       (optional) matches the paymaster verifyingSigner; blank = paymaster-less
 */
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
// Load .env from the repo root (script/ lives one level down) so the flow works
// regardless of the CWD `node` was invoked from.
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const RPC = process.env.LNET_TESTNET_RPC_URL || "http://34.69.184.205:4545";
const CHAIN_ID = Number(process.env.LNET_TESTNET_CHAIN_ID || 648540);
const ENTRYPOINT = process.env.ENTRYPOINT_ADDRESS || "0x9fD181236dA8c890bD5007b44B80E395E130c57D";
const FACTORY = process.env.FACTORY_ADDRESS || "0x5589A0E344688976e473FD56BAe94411d9d56f67";
const PAYMASTER = process.env.PAYMASTER_ADDRESS || "0xafed236702eF6F90B31560Fab884433057764B99";

const UO = "(address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)";
const EP_ABI = [
  `function getUserOpHash(${UO} userOp) view returns (bytes32)`,
  `function handleOps(${UO}[] ops, address beneficiary)`,
];
const FACTORY_ABI = [
  "function getAddress(address owner, uint256 salt) view returns (address)",
  "function createAccount(address owner, uint256 salt) returns (address)",
];
const ACCOUNT_ABI = ["function execute(address dest, uint256 value, bytes func)", "function owner() view returns (address)"];
const PM_ABI = [`function getHash(${UO} userOp, uint48 validUntil, uint48 validAfter) view returns (bytes32)`];
const STORAGE_ABI = ["function set(uint256 v)", "function value() view returns (uint256)"];

const pack = (hi, lo) => ethers.zeroPadValue(ethers.toBeHex((BigInt(hi) << 128n) | BigInt(lo)), 32);
const rndNonce = () => (BigInt(Date.now()) << 160n) | ethers.toBigInt(ethers.randomBytes(20));

// Resolve the keys the flow needs. Only the relayer is truly required; the paymaster is OPTIONAL:
// on LNET gasPrice=0 so required prefund=0 — a UserOp validates without any paymaster.
function loadKeys() {
  const relayerPk = process.env.RELAYER_PK || process.env.PRIVATE_KEY;
  const pmKey = process.env.PAYMASTER_SIGNER_KEY;

  if (!relayerPk) {
    throw new Error(
      "Missing required key in .env:\n  - RELAYER_PK (or PRIVATE_KEY) — the relayer with DIRECT raw-tx permission\n" +
      "Add it to .env and re-run. See docs/lnet-integration.md for which account is which."
    );
  }

  const usePaymaster = !!pmKey;
  if (usePaymaster) {
    const pmSigner = new ethers.Wallet(pmKey);
    // Guardrail: paymaster signature only verifies on-chain if this key matches PAYMASTER_SIGNER.
    const expectedPm = process.env.PAYMASTER_SIGNER;
    if (expectedPm && pmSigner.address.toLowerCase() !== expectedPm.toLowerCase()) {
      throw new Error(
        `PAYMASTER_SIGNER_KEY address ${pmSigner.address} does not match PAYMASTER_SIGNER ${expectedPm}.\n` +
        "handleOps would revert on the paymaster signature. Use the private key for " + expectedPm + "."
      );
    }
  }
  return { relayerPk, pmKey, usePaymaster };
}

async function main() {
  const keys = loadKeys();
  const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID);
  const relayer = new ethers.Wallet(keys.relayerPk, provider);
  const paymasterSigner = keys.usePaymaster ? new ethers.Wallet(keys.pmKey, provider) : null;
  const owner = ethers.Wallet.createRandom();          // AA account owner (signs UserOp; never sends a tx)

  console.log("relayer (tx sender):", relayer.address);
  console.log("paymaster:          ", keys.usePaymaster ? `sponsored via ${paymasterSigner.address}` : "NONE (paymaster-less; prefund=0 on LNET)");
  console.log("account owner:      ", owner.address);

  const factory = new ethers.Contract(FACTORY, FACTORY_ABI, provider);
  const entryPoint = new ethers.Contract(ENTRYPOINT, EP_ABI, relayer);
  const paymaster = new ethers.Contract(PAYMASTER, PM_ABI, provider);
  const accountIface = new ethers.Interface(ACCOUNT_ABI);
  const storageIface = new ethers.Interface(STORAGE_ABI);

  // --- 1) Deploy Storage via a direct contract-creation tx ----------------
  const artifact = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "out", "Storage.sol", "Storage.json"), "utf8"));
  const storageFactory = new ethers.ContractFactory(STORAGE_ABI, artifact.bytecode.object, relayer);
  console.log("\n[1] Deploying Storage (direct tx)...");
  const storage = await storageFactory.deploy({ gasPrice: 0n, gasLimit: 3_000_000n });
  await storage.waitForDeployment();
  const storageAddr = await storage.getAddress();
  console.log("    Storage deployed:", storageAddr, "| tx", storage.deploymentTransaction().hash);

  // --- 2) Build UserOp ----------------------------------------------------
  const salt = rndNonce();
  // NB: ethers v6 reserves Contract.getAddress(); call the explicit fragment for our getAddress(address,uint256).
  const sender = await factory.getFunction("getAddress(address,uint256)")(owner.address, salt);
  console.log("\n[2] Smart account (counterfactual):", sender);

  const initCode = ethers.concat([FACTORY, factory.interface.encodeFunctionData("createAccount", [owner.address, salt])]);
  const innerCall = accountIface.encodeFunctionData("execute", [storageAddr, 0, storageIface.encodeFunctionData("set", [42])]);

  const op = {
    sender, nonce: 0n, initCode, callData: innerCall,
    accountGasLimits: pack(3_000_000, 1_000_000), preVerificationGas: 100_000n,
    gasFees: pack(0, 0), paymasterAndData: "0x", signature: "0x",
  };

  // Paymaster sponsorship signature — only when a paymaster signer key is available. On LNET
  // (gasPrice=0, required prefund=0) the account can validate without any paymaster, so we leave
  // paymasterAndData = "0x" when running paymaster-less.
  if (keys.usePaymaster) {
    const validUntil = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const validAfter = 0n;
    const pmHeader = ethers.concat([
      PAYMASTER,
      ethers.zeroPadValue(ethers.toBeHex(500_000n), 16),
      ethers.zeroPadValue(ethers.toBeHex(100_000n), 16),
      ethers.AbiCoder.defaultAbiCoder().encode(["uint48", "uint48"], [validUntil, validAfter]),
    ]);
    op.paymasterAndData = pmHeader;
    const pmHash = await paymaster.getHash(op, validUntil, validAfter);
    const pmSig = await paymasterSigner.signMessage(ethers.getBytes(pmHash));
    op.paymasterAndData = ethers.concat([pmHeader, pmSig]);
  }

  // Owner signature over the EntryPoint userOpHash
  const userOpHash = await entryPoint.getUserOpHash(op);
  op.signature = await owner.signMessage(ethers.getBytes(userOpHash));

  // --- 3) Send handleOps DIRECTLY to the EntryPoint -----------------------
  console.log("\n[3] Sending handleOps (direct tx to EntryPoint)...");
  const tx = await entryPoint.handleOps([op], relayer.address, { gasPrice: 0n, gasLimit: 8_000_000n });
  const receipt = await tx.wait();
  console.log("    handleOps tx:", tx.hash, "| status", receipt.status);

  // --- 4) Verify ----------------------------------------------------------
  const code = await provider.getCode(sender);
  const acct = new ethers.Contract(sender, ACCOUNT_ABI, provider);
  const storedOwner = await acct.owner();
  const storedValue = await new ethers.Contract(storageAddr, STORAGE_ABI, provider).value();
  console.log("\n[4] Verification:");
  console.log("    account deployed:", code !== "0x");
  console.log("    account.owner():", storedOwner, "==", owner.address, "->", storedOwner.toLowerCase() === owner.address.toLowerCase());
  console.log("    storage.value():", storedValue.toString(), "(expected 42)");
  if (code !== "0x" && storedOwner.toLowerCase() === owner.address.toLowerCase() && storedValue === 42n) {
    console.log("\n✅ E2E OK: account created + UserOp executed Storage.set(42) directly (no Hub)");
  } else {
    throw new Error("verification failed");
  }
}

// LNET rejects txs from non-permissioned senders with JSON-RPC code -32007. Surface it clearly:
// without the Hub, the relayer itself must hold direct raw-tx permission.
function explain(e) {
  const code = e?.code ?? e?.info?.error?.code ?? e?.error?.code;
  const msg = e?.message || e?.info?.error?.message || e?.error?.message || String(e);
  if (code === -32007 || /not authorized/i.test(msg)) {
    return (
      "LNET rejected the tx: the relayer is NOT authorized to send raw transactions.\n" +
      "   This Hub-less flow requires the relayer to hold DIRECT raw-tx (writer) permission.\n" +
      "   Fix: ask LNet support to permission the relayer address, or use hubE2E.cjs (route via the Hub)."
    );
  }
  return msg;
}
main().catch((e) => { console.error("❌", explain(e)); process.exit(1); });
