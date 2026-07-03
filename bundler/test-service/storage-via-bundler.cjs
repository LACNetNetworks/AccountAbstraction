#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const SCRIPT_DIR = __dirname;
const REPO_ROOT = path.join(SCRIPT_DIR, "..", "..");
const ENV_FILE = path.join(SCRIPT_DIR, ".env");

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const key = match[1];
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] == null) process.env[key] = value;
  }
}

loadEnv(ENV_FILE);

const RPC = process.env.LNET_TESTNET_RPC_URL || "http://34.69.184.205:4545";
const CHAIN_ID = Number(process.env.LNET_TESTNET_CHAIN_ID || 648540);
const BUNDLER_URL =
  process.env.BUNDLER_URL ||
  `http://${process.env.BUNDLER_HOST || "127.0.0.1"}:${process.env.BUNDLER_PORT || "3000"}`;
const ENTRYPOINT = process.env.ENTRYPOINT_ADDRESS || "0x9fD181236dA8c890bD5007b44B80E395E130c57D";
const FACTORY = process.env.FACTORY_ADDRESS || "0x5589A0E344688976e473FD56BAe94411d9d56f67";
const PAYMASTER = process.env.PAYMASTER_ADDRESS || "0xafed236702eF6F90B31560Fab884433057764B99";

const UO =
  "(address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)";
const EP_ABI = [`function getUserOpHash(${UO} userOp) view returns (bytes32)`];
const FACTORY_ABI = [
  "function getAddress(address owner, uint256 salt) view returns (address)",
  "function createAccount(address owner, uint256 salt) returns (address)",
];
const ACCOUNT_ABI = ["function execute(address dest, uint256 value, bytes func)", "function owner() view returns (address)"];
const PM_ABI = [`function getHash(${UO} userOp, uint48 validUntil, uint48 validAfter) view returns (bytes32)`];
const STORAGE_ABI = ["function set(uint256 v)", "function value() view returns (uint256)"];

const pack = (hi, lo) => ethers.zeroPadValue(ethers.toBeHex((BigInt(hi) << 128n) | BigInt(lo)), 32);
const rndNonce = () => (BigInt(Date.now()) << 160n) | ethers.toBigInt(ethers.randomBytes(20));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function toQuantity(value) {
  return ethers.toQuantity(value);
}

function serializeUserOp(op) {
  return {
    sender: op.sender,
    nonce: toQuantity(op.nonce),
    initCode: op.initCode,
    callData: op.callData,
    accountGasLimits: op.accountGasLimits,
    preVerificationGas: toQuantity(op.preVerificationGas),
    gasFees: op.gasFees,
    paymasterAndData: op.paymasterAndData,
    signature: op.signature,
  };
}

async function rpc(method, params = []) {
  const response = await fetch(BUNDLER_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });
  const payload = await response.json();
  if (payload.error) {
    const err = new Error(payload.error.message);
    err.data = payload.error.data;
    throw err;
  }
  return payload.result;
}

async function waitForUserOpReceipt(userOpHash) {
  const attempts = Number(process.env.BUNDLER_TEST_RECEIPT_ATTEMPTS || 60);
  const delayMs = Number(process.env.BUNDLER_TEST_RECEIPT_DELAY_MS || 2000);

  for (let i = 0; i < attempts; i++) {
    const receipt = await rpc("eth_getUserOperationReceipt", [userOpHash]);
    if (receipt) return receipt;
    process.stdout.write(".");
    await sleep(delayMs);
  }
  throw new Error(`Timed out waiting for UserOp receipt ${userOpHash}`);
}

function loadKeys() {
  const relayerPk = process.env.RELAYER_PK || process.env.PRIVATE_KEY;
  const pmKey = process.env.PAYMASTER_SIGNER_KEY;

  if (!relayerPk) {
    throw new Error("Missing RELAYER_PK or PRIVATE_KEY in bundler/test-service/.env");
  }

  if (pmKey) {
    const pmSigner = new ethers.Wallet(pmKey);
    const expectedPm = process.env.PAYMASTER_SIGNER;
    if (expectedPm && pmSigner.address.toLowerCase() !== expectedPm.toLowerCase()) {
      throw new Error(`PAYMASTER_SIGNER_KEY address ${pmSigner.address} does not match PAYMASTER_SIGNER ${expectedPm}`);
    }
  }

  return { relayerPk, pmKey, usePaymaster: !!pmKey };
}

function explain(e) {
  const code = e?.code ?? e?.info?.error?.code ?? e?.error?.code;
  const msg = e?.message || e?.info?.error?.message || e?.error?.message || String(e);
  if (code === -32007 || /not authorized/i.test(msg)) {
    return (
      "LNET rejected the direct tx: the relayer is NOT authorized to send raw transactions.\n" +
      "This test requires RELAYER_PK to have direct raw-tx writer permission."
    );
  }
  return e?.data ? `${msg}\n${e.data}` : msg;
}

async function main() {
  const keys = loadKeys();
  const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID);
  const relayer = new ethers.Wallet(keys.relayerPk, provider);
  const owner = ethers.Wallet.createRandom();
  const paymasterSigner = keys.usePaymaster ? new ethers.Wallet(keys.pmKey, provider) : null;

  console.log("bundler:          ", BUNDLER_URL);
  console.log("relayer:          ", relayer.address);
  console.log("account owner:    ", owner.address);
  console.log("paymaster:        ", keys.usePaymaster ? `sponsored via ${paymasterSigner.address}` : "NONE");

  const status = await rpc("lnet_bundlerStatus");
  if (status.entryPoint.toLowerCase() !== ENTRYPOINT.toLowerCase()) {
    throw new Error(`Bundler EntryPoint ${status.entryPoint} does not match script EntryPoint ${ENTRYPOINT}`);
  }
  console.log("bundler status:   ", status.mode, "pending", status.pending);

  const artifactPath = path.join(REPO_ROOT, "out", "Storage.sol", "Storage.json");
  if (!fs.existsSync(artifactPath)) {
    throw new Error(`Missing ${artifactPath}. Run 'forge build' first.`);
  }

  const factory = new ethers.Contract(FACTORY, FACTORY_ABI, provider);
  const entryPoint = new ethers.Contract(ENTRYPOINT, EP_ABI, provider);
  const paymaster = new ethers.Contract(PAYMASTER, PM_ABI, provider);
  const accountIface = new ethers.Interface(ACCOUNT_ABI);
  const storageIface = new ethers.Interface(STORAGE_ABI);

  console.log("\n[1] Deploying Storage with the direct relayer...");
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const storageFactory = new ethers.ContractFactory(STORAGE_ABI, artifact.bytecode.object, relayer);
  const storage = await storageFactory.deploy({ gasPrice: 0n, gasLimit: 3_000_000n });
  await storage.waitForDeployment();
  const storageAddr = await storage.getAddress();
  console.log("    Storage:", storageAddr, "| tx", storage.deploymentTransaction().hash);

  console.log("\n[2] Building and signing UserOp...");
  const salt = rndNonce();
  const sender = await factory.getFunction("getAddress(address,uint256)")(owner.address, salt);
  const initCode = ethers.concat([FACTORY, factory.interface.encodeFunctionData("createAccount", [owner.address, salt])]);
  const callData = accountIface.encodeFunctionData("execute", [
    storageAddr,
    0,
    storageIface.encodeFunctionData("set", [42]),
  ]);

  const op = {
    sender,
    nonce: 0n,
    initCode,
    callData,
    accountGasLimits: pack(3_000_000, 1_000_000),
    preVerificationGas: 100_000n,
    gasFees: pack(0, 0),
    paymasterAndData: "0x",
    signature: "0x",
  };

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

  const expectedUserOpHash = await entryPoint.getUserOpHash(op);
  op.signature = await owner.signMessage(ethers.getBytes(expectedUserOpHash));
  console.log("    smart account:", sender);
  console.log("    UserOp hash:  ", expectedUserOpHash);

  console.log("\n[3] Sending UserOp through the bundler...");
  const userOpHash = await rpc("eth_sendUserOperation", [serializeUserOp(op), ENTRYPOINT]);
  if (userOpHash.toLowerCase() !== expectedUserOpHash.toLowerCase()) {
    throw new Error(`Bundler returned ${userOpHash}, expected ${expectedUserOpHash}`);
  }
  process.stdout.write("    waiting for receipt ");
  const userOpReceipt = await waitForUserOpReceipt(userOpHash);
  console.log("\n    bundle tx:", userOpReceipt.receipt.transactionHash, "| success", userOpReceipt.success);

  console.log("\n[4] Verifying account and Storage value...");
  const code = await provider.getCode(sender);
  const account = new ethers.Contract(sender, ACCOUNT_ABI, provider);
  const storedOwner = await account.owner();
  const storedValue = await new ethers.Contract(storageAddr, STORAGE_ABI, provider).value();

  console.log("    account deployed:", code !== "0x");
  console.log("    owner matches:    ", storedOwner.toLowerCase() === owner.address.toLowerCase());
  console.log("    storage.value():  ", storedValue.toString());

  if (code === "0x" || storedOwner.toLowerCase() !== owner.address.toLowerCase() || storedValue !== 42n) {
    throw new Error("verification failed");
  }

  console.log("\nE2E OK: Storage deployed, UserOp sent via bundler, Storage.set(42) executed.");
}

main().catch((e) => {
  console.error("FAILED:", explain(e));
  process.exit(1);
});
