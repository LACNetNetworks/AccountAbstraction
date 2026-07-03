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

const ZERO_BYTES32 = ethers.ZeroHash;
const ZERO_ADDRESS = ethers.ZeroAddress;

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
    simulationMode: process.env.BUNDLER_SIMULATION || fileConfig.simulation || "try",
    maxBundleSize: Number(process.env.BUNDLER_MAX_BUNDLE_SIZE || fileConfig.maxBundleSize || fileConfig.autoBundleMempoolSize || 10),
    autoBundleIntervalMs: Number(process.env.BUNDLER_AUTO_BUNDLE_MS || fileConfig.autoBundleIntervalMs || ((fileConfig.autoBundleInterval || 3) * 1000)),
    bundleGasLimit: BigInt(process.env.BUNDLER_BUNDLE_GAS_LIMIT || fileConfig.bundleGasLimit || 8_000_000),
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
  if (!["try", "required", "disabled"].includes(config.simulationMode)) {
    throw new Error("BUNDLER_SIMULATION must be 'try', 'required', or 'disabled'");
  }
}

function loadWallets(provider) {
  const relayerPk = process.env.RELAYER_PK || process.env.PRIVATE_KEY;
  if (!relayerPk) {
    throw new Error("Missing RELAYER_PK or PRIVATE_KEY for the direct raw-tx bundler relayer");
  }
  const relayer = new ethers.Wallet(relayerPk, provider);
  return { relayer };
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

function log(config, level, ...args) {
  const order = { debug: 10, info: 20, warn: 30, error: 40 };
  if ((order[level] || 20) >= (order[config.logLevel] || 20)) {
    console[level === "debug" ? "log" : level](`[${level}]`, ...args);
  }
}

function decodeKnownError(err) {
  const code = err?.code ?? err?.info?.error?.code ?? err?.error?.code;
  const msg = err?.message || err?.info?.error?.message || err?.error?.message || String(err);
  if (code === -32007 || /not authorized/i.test(msg)) {
    return "LNET rejected the direct handleOps tx: relayer lacks direct raw-tx writer permission";
  }
  return msg;
}

class LnetBundler {
  constructor(config, provider, wallets) {
    this.config = config;
    this.provider = provider;
    this.relayer = wallets.relayer;
    this.entryPoint = new ethers.Contract(config.entryPoint, ENTRYPOINT_ABI, this.relayer);
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

  async proxyRpc(method, params) {
    return this.provider.send(method, params);
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
      const revertData = err?.data || err?.info?.error?.data || err?.error?.data;
      const noRevertData = revertData == null || revertData === "0x";
      const unsupported =
        err.code === "BAD_DATA" ||
        noRevertData ||
        /could not decode result data|function selector was not recognized|missing revert data|no data present|require\(false\)/i.test(err.message || "");
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
      log(this.config, "info", "submitting direct bundle", ops.length);
      const tx = await this.submitDirect(ops);
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
      gasLimit: this.config.bundleGasLimit,
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
    case "eth_call":
    case "eth_getCode":
    case "eth_blockNumber":
    case "eth_getBalance":
    case "eth_getTransactionReceipt":
      return bundler.proxyRpc(payload.method, params);
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
        mode: "direct",
        entryPoint: bundler.config.entryPoint,
        beneficiary: bundler.config.beneficiary,
        relayer: bundler.relayer.address,
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
    const corsHeaders = {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type",
    };

    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders);
      res.end();
      return;
    }

    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { ...corsHeaders, "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, pending: bundler.pendingCount() }));
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { ...corsHeaders, "content-type": "application/json" });
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
        res.writeHead(400, { ...corsHeaders, "content-type": "application/json" });
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
      res.writeHead(200, { ...corsHeaders, "content-type": "application/json" });
      res.end(JSON.stringify(Array.isArray(payload) ? responses : responses[0]));
    });
  });
}

async function main() {
  const config = loadConfig();
  assertConfig(config);
  const provider = new ethers.JsonRpcProvider(config.rpcUrl, config.chainId);
  const wallets = loadWallets(provider);
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
    console.log(`mode=direct entryPoint=${config.entryPoint} relayer=${wallets.relayer.address}`);
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
