#!/usr/bin/env node

const http = require("http");
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const REPO_ROOT = path.join(__dirname, "..", "..");
const DEFAULT_DEPLOYMENTS = path.join(REPO_ROOT, "deployments", "lnet-testnet.json");
const DEFAULT_CONFIG = path.join(REPO_ROOT, "bundler", "bundler.config.json");

const UO =
  "(address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)";

const ENTRYPOINT_ABI = [
  `function getUserOpHash(${UO} userOp) view returns (bytes32)`,
  `function simulateValidation(${UO} userOp) returns (((uint256 preOpGas,uint256 prefund,uint256 accountValidationData,uint256 paymasterValidationData,bytes paymasterContext) returnInfo,(uint112 stake,uint32 unstakeDelaySec) senderInfo,(uint112 stake,uint32 unstakeDelaySec) factoryInfo,(uint112 stake,uint32 unstakeDelaySec) paymasterInfo,(address aggregator,(uint112 stake,uint32 unstakeDelaySec) stakeInfo) aggregatorInfo))`,
  `function handleOps(${UO}[] ops, address beneficiary)`,
  "event UserOperationEvent(bytes32 indexed userOpHash,address indexed sender,address indexed paymaster,uint256 nonce,bool success,uint256 actualGasCost,uint256 actualGasUsed)",
];

const HUB_ABI = [
  "function execute((address from,address to,uint256 value,uint32 space,uint256 nonce,uint256 deadline,bytes32 dataHash,address caller) forward, bytes callData, bytes signature) payable",
];

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

const ZERO_BYTES32 = ethers.ZeroHash;
const ZERO_ADDRESS = ethers.ZeroAddress;
const DEFAULT_HUB = "0x4053cA6bcdEc6638d9Ad83a5c74d0246C7670ACd";

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function usableAddress(value) {
  return ethers.isAddress(value) && value !== ZERO_ADDRESS ? value : null;
}

function txHashOf(receipt) {
  return receipt.hash || receipt.transactionHash;
}

function loadConfig() {
  const args = parseArgs(process.argv);
  const configPath = path.resolve(args.config || process.env.BUNDLER_CONFIG || DEFAULT_CONFIG);
  const fileConfig = fs.existsSync(configPath) ? readJson(configPath) : {};
  const deployments = fs.existsSync(DEFAULT_DEPLOYMENTS) ? readJson(DEFAULT_DEPLOYMENTS) : {};
  const deployedEntryPoint = deployments.contracts?.EntryPoint;

  const entryPoint = usableAddress(process.env.ENTRYPOINT_ADDRESS) || usableAddress(fileConfig.entryPoint) || usableAddress(deployedEntryPoint) || ZERO_ADDRESS;

  const beneficiary =
    usableAddress(process.env.BUNDLER_BENEFICIARY) ||
    usableAddress(fileConfig.beneficiary) ||
    usableAddress(process.env.RELAYER_ADDRESS) ||
    ZERO_ADDRESS;

  return {
    configPath,
    host: process.env.BUNDLER_HOST || fileConfig.host || "127.0.0.1",
    port: Number(process.env.BUNDLER_PORT || fileConfig.port || 3000),
    rpcUrl: process.env.LNET_TESTNET_RPC_URL || fileConfig.rpcUrl || fileConfig.network || deployments.rpcUrl,
    chainId: Number(process.env.LNET_TESTNET_CHAIN_ID || fileConfig.chainId || deployments.chainId || 648540),
    entryPoint,
    beneficiary,
    hub: process.env.LNET_HUB_ADDRESS || fileConfig.hub || DEFAULT_HUB,
    mode: process.env.BUNDLER_MODE || fileConfig.mode || "hub",
    simulationMode: process.env.BUNDLER_SIMULATION || fileConfig.simulation || "try",
    maxBundleSize: Number(process.env.BUNDLER_MAX_BUNDLE_SIZE || fileConfig.maxBundleSize || fileConfig.autoBundleMempoolSize || 10),
    autoBundleIntervalMs: Number(process.env.BUNDLER_AUTO_BUNDLE_MS || fileConfig.autoBundleIntervalMs || ((fileConfig.autoBundleInterval || 3) * 1000)),
    hubGasLimit: BigInt(process.env.BUNDLER_HUB_GAS_LIMIT || fileConfig.hubGasLimit || 8_000_000),
    directGasLimit: BigInt(process.env.BUNDLER_DIRECT_GAS_LIMIT || fileConfig.directGasLimit || 8_000_000),
    enforceZeroGasFees: process.env.BUNDLER_ENFORCE_ZERO_GAS_FEES !== "false" && fileConfig.enforceZeroGasFees !== false,
    logLevel: process.env.BUNDLER_LOG_LEVEL || fileConfig.logLevel || "info",
  };
}

function assertConfig(config) {
  if (!config.rpcUrl) throw new Error("Missing LNET_TESTNET_RPC_URL or bundler.config.json network/rpcUrl");
  if (!ethers.isAddress(config.entryPoint) || config.entryPoint === ZERO_ADDRESS) {
    throw new Error("Missing ENTRYPOINT_ADDRESS or bundler.config.json entryPoint");
  }
  if (!ethers.isAddress(config.beneficiary)) throw new Error("BUNDLER_BENEFICIARY must be an address");
  if (!["hub", "direct"].includes(config.mode)) throw new Error("BUNDLER_MODE must be 'hub' or 'direct'");
  if (!["try", "required", "disabled"].includes(config.simulationMode)) {
    throw new Error("BUNDLER_SIMULATION must be 'try', 'required', or 'disabled'");
  }
  if (config.mode === "hub" && (!ethers.isAddress(config.hub) || config.hub === ZERO_ADDRESS)) {
    throw new Error("Missing LNET_HUB_ADDRESS or bundler.config.json hub");
  }
}

function loadWallets(provider, mode) {
  const relayerPk = process.env.RELAYER_PK || process.env.PRIVATE_KEY;
  if (!relayerPk) throw new Error("Missing RELAYER_PK or PRIVATE_KEY for the bundler relayer");
  const relayer = new ethers.Wallet(relayerPk, provider);

  if (mode === "direct") return { relayer, forwardSigner: null };

  const senderPk = process.env.SENDER_PK || process.env.DEPLOYER_PK;
  if (!senderPk) {
    throw new Error("Missing SENDER_PK or DEPLOYER_PK for Hub forward.from in hub mode");
  }
  return { relayer, forwardSigner: new ethers.Wallet(senderPk) };
}

function toHex(value) {
  return ethers.toQuantity(value);
}

function normalizeHex(value, field, empty = "0x") {
  if (value == null) return empty;
  if (typeof value !== "string" || !ethers.isHexString(value)) {
    throw rpcError(-32602, `${field} must be a 0x-prefixed hex string`);
  }
  return value;
}

function normalizeAddress(value, field) {
  if (!ethers.isAddress(value)) throw rpcError(-32602, `${field} must be an address`);
  return ethers.getAddress(value);
}

function normalizeBytes32(value, field) {
  if (!ethers.isHexString(value, 32)) throw rpcError(-32602, `${field} must be bytes32`);
  return value;
}

function normalizeBigInt(value, field) {
  try {
    if (typeof value === "bigint") return value;
    if (typeof value === "number") return BigInt(value);
    if (typeof value === "string") return BigInt(value);
  } catch {
    throw rpcError(-32602, `${field} must be a uint256 quantity`);
  }
  throw rpcError(-32602, `${field} must be a uint256 quantity`);
}

function normalizeUserOp(input) {
  if (!input || typeof input !== "object") throw rpcError(-32602, "UserOperation must be an object");
  return {
    sender: normalizeAddress(input.sender, "sender"),
    nonce: normalizeBigInt(input.nonce ?? 0, "nonce"),
    initCode: normalizeHex(input.initCode, "initCode"),
    callData: normalizeHex(input.callData, "callData"),
    accountGasLimits: normalizeBytes32(input.accountGasLimits ?? ZERO_BYTES32, "accountGasLimits"),
    preVerificationGas: normalizeBigInt(input.preVerificationGas ?? 0, "preVerificationGas"),
    gasFees: normalizeBytes32(input.gasFees ?? ZERO_BYTES32, "gasFees"),
    paymasterAndData: normalizeHex(input.paymasterAndData, "paymasterAndData"),
    signature: normalizeHex(input.signature, "signature"),
  };
}

function serializeUserOp(op) {
  return {
    sender: op.sender,
    nonce: toHex(op.nonce),
    initCode: op.initCode,
    callData: op.callData,
    accountGasLimits: op.accountGasLimits,
    preVerificationGas: toHex(op.preVerificationGas),
    gasFees: op.gasFees,
    paymasterAndData: op.paymasterAndData,
    signature: op.signature,
  };
}

function rpcError(code, message, data) {
  const err = new Error(message);
  err.code = code;
  if (data !== undefined) err.data = data;
  return err;
}

function formatRpcError(err) {
  return {
    code: err.code && Number.isInteger(err.code) ? err.code : -32000,
    message: err.message || String(err),
    ...(err.data === undefined ? {} : { data: err.data }),
  };
}

function randomNonce() {
  return (BigInt(Date.now()) << 160n) | ethers.toBigInt(ethers.randomBytes(20));
}

function log(config, level, ...args) {
  const order = { debug: 10, info: 20, warn: 30, error: 40 };
  if ((order[level] || 20) >= (order[config.logLevel] || 20)) {
    console[level === "debug" ? "log" : level](`[${level}]`, ...args);
  }
}

function decodeKnownError(err) {
  const data = err?.data || err?.info?.error?.data || err?.error?.data;
  if (typeof data === "string" && data.startsWith("0xfc336c41")) {
    return "Hub rejected forward.from: SENDER_PK/DEPLOYER_PK is not permissioned in the LNET Hub";
  }
  const code = err?.code ?? err?.info?.error?.code ?? err?.error?.code;
  const msg = err?.message || err?.info?.error?.message || err?.error?.message || String(err);
  if (code === -32007 || /not authorized/i.test(msg)) {
    return "LNET rejected the tx: relayer is not authorized for this transaction path";
  }
  return msg;
}

class LnetBundler {
  constructor(config, provider, wallets) {
    this.config = config;
    this.provider = provider;
    this.relayer = wallets.relayer;
    this.forwardSigner = wallets.forwardSigner;
    this.entryPoint = new ethers.Contract(config.entryPoint, ENTRYPOINT_ABI, this.relayer);
    this.hub = config.mode === "hub" ? new ethers.Contract(config.hub, HUB_ABI, this.relayer) : null;
    this.mempool = new Map();
    this.history = new Map();
    this.bundling = false;
  }

  supportedEntryPoints() {
    return [ethers.getAddress(this.config.entryPoint)];
  }

  async chainId() {
    return toHex(this.config.chainId);
  }

  async sendUserOperation(params) {
    const [rawOp, entryPointAddress] = params;
    const entryPoint = normalizeAddress(entryPointAddress, "entryPoint");
    if (entryPoint.toLowerCase() !== this.config.entryPoint.toLowerCase()) {
      throw rpcError(-32602, `unsupported EntryPoint ${entryPoint}`);
    }
    const op = normalizeUserOp(rawOp);
    if (this.config.enforceZeroGasFees && op.gasFees !== ZERO_BYTES32) {
      throw rpcError(-32602, "LNET requires packed gasFees = 0x00..00");
    }

    const userOpHash = await this.entryPoint.getUserOpHash(op);
    if (this.history.has(userOpHash) || this.mempool.has(userOpHash)) return userOpHash;

    await this.simulateValidation(op);
    const item = {
      userOpHash,
      op,
      entryPoint,
      status: "pending",
      addedAt: Date.now(),
      transactionHash: null,
      receipt: null,
      error: null,
    };
    this.mempool.set(userOpHash, item);
    this.history.set(userOpHash, item);
    log(this.config, "info", "accepted UserOp", userOpHash, "sender", op.sender);
    setImmediate(() => this.bundleNow().catch((err) => log(this.config, "error", decodeKnownError(err))));
    return userOpHash;
  }

  async simulateValidation(op) {
    if (this.config.simulationMode === "disabled") return;
    try {
      const result = await this.entryPoint.simulateValidation.staticCall(op, { gasPrice: 0n });
      const aggregator = result?.aggregatorInfo?.aggregator;
      if (aggregator && aggregator !== ZERO_ADDRESS) {
        throw rpcError(-32602, "signature aggregators are not supported by this LNET bundler");
      }
    } catch (err) {
      const unsupported =
        err.code === "BAD_DATA" ||
        /could not decode result data|function selector was not recognized|missing revert data/i.test(err.message || "");
      if (unsupported && this.config.simulationMode === "try") {
        log(this.config, "warn", "simulateValidation unavailable on EntryPoint; accepting op in try mode");
        return;
      }
      throw rpcError(-32602, "simulateValidation failed", decodeKnownError(err));
    }
  }

  async estimateUserOperationGas(params) {
    const [rawOp, entryPointAddress] = params;
    const entryPoint = normalizeAddress(entryPointAddress, "entryPoint");
    if (entryPoint.toLowerCase() !== this.config.entryPoint.toLowerCase()) {
      throw rpcError(-32602, `unsupported EntryPoint ${entryPoint}`);
    }
    const op = normalizeUserOp(rawOp);
    await this.simulateValidation(op);

    const accountGas = BigInt(op.accountGasLimits);
    return {
      preVerificationGas: toHex(op.preVerificationGas || 100_000n),
      verificationGasLimit: toHex(accountGas >> 128n || 3_000_000n),
      callGasLimit: toHex(accountGas & ((1n << 128n) - 1n) || 1_000_000n),
      paymasterVerificationGasLimit: "0x0",
      paymasterPostOpGasLimit: "0x0",
    };
  }

  getUserOperationByHash(params) {
    const hash = normalizeBytes32(params[0], "userOpHash");
    const item = this.history.get(hash);
    if (!item) return null;
    return {
      userOperation: serializeUserOp(item.op),
      entryPoint: item.entryPoint,
      transactionHash: item.transactionHash,
      blockHash: item.receipt?.blockHash || null,
      blockNumber: item.receipt?.blockNumber == null ? null : toHex(item.receipt.blockNumber),
    };
  }

  getUserOperationReceipt(params) {
    const hash = normalizeBytes32(params[0], "userOpHash");
    const item = this.history.get(hash);
    if (!item || !item.receipt) return null;
    const event = item.receipt.userOperationEvent;
    return {
      userOpHash: hash,
      entryPoint: item.entryPoint,
      sender: item.op.sender,
      nonce: toHex(item.op.nonce),
      paymaster: event?.paymaster || ZERO_ADDRESS,
      actualGasCost: toHex(event?.actualGasCost || 0n),
      actualGasUsed: toHex(event?.actualGasUsed || 0n),
      success: event?.success ?? item.receipt.status === 1,
      logs: item.receipt.logs || [],
      receipt: {
        transactionHash: txHashOf(item.receipt),
        transactionIndex: toHex(item.receipt.index ?? 0),
        blockHash: item.receipt.blockHash,
        blockNumber: toHex(item.receipt.blockNumber),
        from: item.receipt.from,
        to: item.receipt.to,
        cumulativeGasUsed: toHex(item.receipt.cumulativeGasUsed),
        gasUsed: toHex(item.receipt.gasUsed),
        effectiveGasPrice: toHex(item.receipt.gasPrice || 0n),
        status: toHex(item.receipt.status || 0),
      },
    };
  }

  pendingCount() {
    return this.mempool.size;
  }

  async bundleNow() {
    if (this.bundling || this.mempool.size === 0) return null;
    this.bundling = true;
    const items = [...this.mempool.values()].slice(0, this.config.maxBundleSize);
    try {
      const ops = items.map((item) => item.op);
      log(this.config, "info", "submitting bundle", ops.length, "mode", this.config.mode);
      const tx = this.config.mode === "hub" ? await this.submitViaHub(ops) : await this.submitDirect(ops);
      const receipt = await tx.wait();
      this.markIncluded(items, receipt);
      log(this.config, "info", "bundle included", tx.hash, "status", receipt.status);
      return tx.hash;
    } catch (err) {
      const reason = decodeKnownError(err);
      for (const item of items) {
        item.status = "failed";
        item.error = reason;
        this.mempool.delete(item.userOpHash);
      }
      throw err;
    } finally {
      this.bundling = false;
    }
  }

  async submitDirect(ops) {
    return this.entryPoint.handleOps(ops, this.config.beneficiary, {
      gasPrice: 0n,
      gasLimit: this.config.directGasLimit,
    });
  }

  async submitViaHub(ops) {
    const callData = this.entryPoint.interface.encodeFunctionData("handleOps", [ops, this.config.beneficiary]);
    const domain = {
      name: "PermissionedMetaTxHub",
      version: "1",
      chainId: this.config.chainId,
      verifyingContract: this.config.hub,
    };
    const forward = {
      from: this.forwardSigner.address,
      to: this.config.entryPoint,
      value: 0n,
      space: 0,
      nonce: randomNonce(),
      deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
      dataHash: ethers.keccak256(callData),
      caller: this.relayer.address,
    };
    const signature = await this.forwardSigner.signTypedData(domain, FORWARD_TYPES, forward);
    return this.hub.execute(forward, callData, signature, {
      gasPrice: 0n,
      gasLimit: this.config.hubGasLimit,
    });
  }

  markIncluded(items, receipt) {
    const events = new Map();
    for (const logItem of receipt.logs) {
      try {
        const parsed = this.entryPoint.interface.parseLog(logItem);
        if (parsed?.name === "UserOperationEvent") {
          events.set(parsed.args.userOpHash, {
            paymaster: parsed.args.paymaster,
            success: parsed.args.success,
            actualGasCost: parsed.args.actualGasCost,
            actualGasUsed: parsed.args.actualGasUsed,
          });
        }
      } catch {
        // Ignore logs from other contracts in the receipt.
      }
    }
    for (const item of items) {
      const event = events.get(item.userOpHash) || null;
      item.status = "included";
      item.transactionHash = txHashOf(receipt);
      item.receipt = {
        ...receipt,
        logs: receipt.logs.map((logItem) => ({
          address: logItem.address,
          topics: logItem.topics,
          data: logItem.data,
          blockHash: logItem.blockHash,
          blockNumber: toHex(logItem.blockNumber),
          transactionHash: logItem.transactionHash,
          transactionIndex: toHex(logItem.transactionIndex),
          logIndex: toHex(logItem.index),
          removed: logItem.removed,
        })),
        userOperationEvent: event,
      };
      this.mempool.delete(item.userOpHash);
    }
  }
}

async function handleRpc(bundler, payload) {
  if (!payload || payload.jsonrpc !== "2.0" || typeof payload.method !== "string") {
    throw rpcError(-32600, "invalid JSON-RPC request");
  }
  const params = payload.params || [];
  switch (payload.method) {
    case "eth_chainId":
      return bundler.chainId();
    case "eth_supportedEntryPoints":
      return bundler.supportedEntryPoints();
    case "eth_sendUserOperation":
      return bundler.sendUserOperation(params);
    case "eth_estimateUserOperationGas":
      return bundler.estimateUserOperationGas(params);
    case "eth_getUserOperationByHash":
      return bundler.getUserOperationByHash(params);
    case "eth_getUserOperationReceipt":
      return bundler.getUserOperationReceipt(params);
    case "lnet_bundlerStatus":
      return {
        mode: bundler.config.mode,
        entryPoint: bundler.config.entryPoint,
        beneficiary: bundler.config.beneficiary,
        relayer: bundler.relayer.address,
        forwardFrom: bundler.forwardSigner?.address || null,
        pending: toHex(bundler.pendingCount()),
      };
    case "lnet_bundleNow":
      return bundler.bundleNow();
    default:
      throw rpcError(-32601, `method not found: ${payload.method}`);
  }
}

function createServer(bundler) {
  return http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, pending: bundler.pendingCount() }));
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "method not allowed" }));
      return;
    }

    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) req.destroy();
    });
    req.on("end", async () => {
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }));
        return;
      }

      const requests = Array.isArray(payload) ? payload : [payload];
      const responses = await Promise.all(
        requests.map(async (request) => {
          try {
            const result = await handleRpc(bundler, request);
            return { jsonrpc: "2.0", id: request.id ?? null, result };
          } catch (err) {
            return { jsonrpc: "2.0", id: request.id ?? null, error: formatRpcError(err) };
          }
        })
      );
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(Array.isArray(payload) ? responses : responses[0]));
    });
  });
}

async function main() {
  const config = loadConfig();
  assertConfig(config);
  const provider = new ethers.JsonRpcProvider(config.rpcUrl, config.chainId);
  const wallets = loadWallets(provider, config.mode);
  if (config.beneficiary === ZERO_ADDRESS) config.beneficiary = wallets.relayer.address;
  const bundler = new LnetBundler(config, provider, wallets);

  setInterval(() => {
    bundler.bundleNow().catch((err) => log(config, "error", decodeKnownError(err)));
  }, config.autoBundleIntervalMs).unref();

  const server = createServer(bundler);
  server.on("error", (err) => {
    console.error(`bundler listen failed on ${config.host}:${config.port}:`, err.message);
    process.exit(1);
  });
  server.listen(config.port, config.host, () => {
    console.log(`LNET bundler listening on http://${config.host}:${config.port}`);
    console.log(`mode=${config.mode} entryPoint=${config.entryPoint} relayer=${wallets.relayer.address}`);
    if (wallets.forwardSigner) console.log(`hub=${config.hub} forward.from=${wallets.forwardSigner.address}`);
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error("bundler failed:", err.message || err);
    process.exit(1);
  });
}

module.exports = {
  LnetBundler,
  normalizeUserOp,
  serializeUserOp,
  loadConfig,
  createServer,
};
