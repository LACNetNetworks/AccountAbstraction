/**
 * Live E2E of the ERC-4337 stack on LNET, routed through the LACChain PermissionedMetaTxHub.
 *
 * On LNET only allowlisted relayers may send raw txs, and only to the Hub. So the ERC-4337
 * `handleOps` call is wrapped as a Hub meta-tx:
 *
 *   relayer -> Hub.execute(forward{to: EntryPoint, dataHash: keccak(handleOpsCalldata)}, handleOpsCalldata, sig)
 *           -> EntryPoint.handleOps([userOp], beneficiary)
 *
 * Flow: (1) deploy a Storage via Hub, (2) send a sponsored UserOp via Hub that creates a smart
 * account (initCode) and calls Storage.set(42) through it, (3) verify account code + stored value.
 *
 * Env (secrets never printed):
 *   RELAYER_PK           allowlisted Hub caller (also our AA bundler identity)
 *   PAYMASTER_SIGNER_KEY matches the paymaster verifyingSigner
 */
const { ethers } = require("ethers");
const fs = require("fs");

const RPC = "http://34.69.184.205:4545";
const CHAIN_ID = 648540;
const HUB = "0x4053cA6bcdEc6638d9Ad83a5c74d0246C7670ACd";
const ENTRYPOINT = "0x9fD181236dA8c890bD5007b44B80E395E130c57D";
const FACTORY = "0x5589A0E344688976e473FD56BAe94411d9d56f67";
const PAYMASTER = "0xafed236702eF6F90B31560Fab884433057764B99";

const HUB_ABI = [
  "function execute((address from,address to,uint256 value,uint32 space,uint256 nonce,uint256 deadline,bytes32 dataHash,address caller) forward, bytes callData, bytes signature) payable",
  "event ContractDeployed(address indexed signer, address deployed, bytes32 dataHash)",
];
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

const FORWARD_TYPES = {
  Forward: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "space", type: "uint32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "dataHash", type: "bytes32" },
    { name: "caller", type: "address" },
  ],
};

const pack = (hi, lo) => ethers.zeroPadValue(ethers.toBeHex((BigInt(hi) << 128n) | BigInt(lo)), 32);
const rndNonce = () => (BigInt(Date.now()) << 160n) | ethers.toBigInt(ethers.randomBytes(20));

async function hubSend({ provider, relayer, from, to, callData, gasLimit }) {
  const domain = { name: "PermissionedMetaTxHub", version: "1", chainId: CHAIN_ID, verifyingContract: HUB };
  const forward = {
    from: from.address, to, value: 0n, space: 0, nonce: rndNonce(),
    deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
    dataHash: ethers.keccak256(callData), caller: relayer.address,
  };
  const signature = await from.signTypedData(domain, FORWARD_TYPES, forward);
  const hub = new ethers.Contract(HUB, HUB_ABI, relayer);
  const tx = await hub.execute(forward, callData, signature, { gasLimit, gasPrice: 0n });
  const receipt = await tx.wait();
  return { tx, receipt, hub };
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID);
  const relayer = new ethers.Wallet(process.env.RELAYER_PK, provider);
  const paymasterSigner = new ethers.Wallet(process.env.PAYMASTER_SIGNER_KEY, provider);
  const owner = ethers.Wallet.createRandom();          // AA account owner (signs UserOp; never sends a tx)
  const forwardSigner = new ethers.Wallet(process.env.SENDER_PK); // Hub Forward `from` — MUST be an LNet-permissioned deployer

  console.log("relayer:       ", relayer.address);
  console.log("paymasterSigner:", paymasterSigner.address);
  console.log("account owner: ", owner.address);

  const factory = new ethers.Contract(FACTORY, FACTORY_ABI, provider);
  const entryPoint = new ethers.Contract(ENTRYPOINT, EP_ABI, provider);
  const paymaster = new ethers.Contract(PAYMASTER, PM_ABI, provider);
  const accountIface = new ethers.Interface(ACCOUNT_ABI);
  const storageIface = new ethers.Interface(STORAGE_ABI);

  // --- 1) Deploy Storage via Hub -----------------------------------------
  const artifact = JSON.parse(fs.readFileSync("/Users/neri/AccountAbstraction/out/Storage.sol/Storage.json", "utf8"));
  const storageBytecode = artifact.bytecode.object;
  console.log("\n[1] Deploying Storage via Hub...");
  const dep = await hubSend({ provider, relayer, from: forwardSigner, to: ethers.ZeroAddress, callData: storageBytecode, gasLimit: 3_000_000n });
  let storageAddr = null;
  for (const log of dep.receipt.logs) {
    try { const p = dep.hub.interface.parseLog(log); if (p && p.name === "ContractDeployed") { storageAddr = p.args.deployed; break; } } catch {}
  }
  if (!storageAddr) throw new Error("no ContractDeployed event");
  console.log("    Storage deployed:", storageAddr, "| tx", dep.tx.hash);

  // --- 2) Build sponsored UserOp -----------------------------------------
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

  // Paymaster sponsorship signature
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

  // Owner signature over the EntryPoint userOpHash
  const userOpHash = await entryPoint.getUserOpHash(op);
  op.signature = await owner.signMessage(ethers.getBytes(userOpHash));

  // --- 3) Send handleOps via Hub -----------------------------------------
  const handleOpsData = entryPoint.interface.encodeFunctionData("handleOps", [[op], relayer.address]);
  console.log("\n[3] Sending sponsored handleOps via Hub...");
  const run = await hubSend({ provider, relayer, from: forwardSigner, to: ENTRYPOINT, callData: handleOpsData, gasLimit: 8_000_000n });
  console.log("    handleOps tx:", run.tx.hash, "| status", run.receipt.status);

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
    console.log("\n✅ E2E OK: account created + sponsored UserOp executed Storage.set(42) via Hub");
  } else {
    throw new Error("verification failed");
  }
}

main().catch((e) => { console.error("❌", e.message || e); process.exit(1); });
