import {
  AbiCoder,
  BrowserProvider,
  Contract,
  Interface,
  JsonRpcProvider,
  concat,
  dataSlice,
  getBytes,
  isHexString,
  toBeHex,
  zeroPadValue,
} from "ethers";
import type { Eip1193Provider } from "ethers";
import { lnet } from "./lnet";
import { BUNDLER_PROXY_ENDPOINT, CREDENTIALS, ensureSession } from "./session";

const UO =
  "(address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)";

const ENTRYPOINT_ABI = [
  `function getUserOpHash(${UO} userOp) view returns (bytes32)`,
  // Emitted when the *execution* phase reverts. handleOps itself does not revert
  // in that case, so this log is the only place the reason survives.
  "event UserOperationRevertReason(bytes32 indexed userOpHash, address indexed sender, uint256 nonce, bytes revertReason)",
];
const FACTORY_ABI = [
  "function getAddress(address owner, uint256 salt) view returns (address)",
  "function createAccount(address owner, uint256 salt) returns (address)",
];
const ACCOUNT_ABI = ["function execute(address dest, uint256 value, bytes func)"];

export type PackedUserOperation = {
  sender: string;
  nonce: bigint;
  initCode: string;
  callData: string;
  accountGasLimits: string;
  preVerificationGas: bigint;
  gasFees: string;
  paymasterAndData: string;
  signature: string;
};

type ReceiptLog = { address?: string; topics?: string[]; data?: string };

export type UserOpReceipt = {
  userOpHash?: string;
  sender?: string;
  // ERC-4337: the *execution* result, which is NOT the transaction status. A
  // bundled UserOp whose inner call reverted still lands in a successful tx.
  success?: boolean;
  logs?: ReceiptLog[];
  [key: string]: unknown;
};

export type SendUserOpResult = {
  owner: string;
  smartAccount: string;
  userOpHash: string;
  receipt: UserOpReceipt;
  success: boolean;
  revertReason: string | null;
};

const STORAGE_READ_ABI = ["function value() view returns (uint256)"];

const provider = new JsonRpcProvider(lnet.rpcUrl, lnet.id);
const factory = new Contract(lnet.factory, FACTORY_ABI, provider);
const entryPoint = new Contract(lnet.entryPoint, ENTRYPOINT_ABI, provider);
const accountIface = new Interface(ACCOUNT_ABI);

// Reads Storage.value() through the bundler's read RPC proxy (no token needed).
export async function readStorageValue(address: string): Promise<bigint> {
  const storage = new Contract(address, STORAGE_READ_ABI, provider);
  return storage.value();
}

export type TargetInspection = {
  hasCode: boolean;
  /** Whether the target answered value(), i.e. whether it looks like Storage. */
  storageReadable: boolean;
};

// Signing is the point of no return for a wrong target, because the two ways a
// write can silently do nothing are both invisible afterwards: a CALL to an
// address with no code succeeds without executing anything, and a contract with a
// fallback() swallows set(uint256) the same way. Neither leaves a failed receipt,
// so the address has to be checked before the UserOp exists.
export async function inspectTarget(address: string): Promise<TargetInspection> {
  const code = await provider.getCode(address);
  if (code === "0x") return { hasCode: false, storageReadable: false };
  try {
    await readStorageValue(address);
    return { hasCode: true, storageReadable: true };
  } catch {
    // Reverted, or returned something that is not a uint256: it has code, but it
    // does not behave like the Storage contract this app calls.
    return { hasCode: true, storageReadable: false };
  }
}

function pack128(hi: bigint | number, lo: bigint | number): string {
  return zeroPadValue(toBeHex((BigInt(hi) << 128n) | BigInt(lo)), 32);
}

function randomSalt(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return (BigInt(Date.now()) << 160n) | BigInt(`0x${hex}`);
}

function serializeUserOp(op: PackedUserOperation) {
  return {
    sender: op.sender,
    nonce: toBeHex(op.nonce),
    initCode: op.initCode,
    callData: op.callData,
    accountGasLimits: op.accountGasLimits,
    preVerificationGas: toBeHex(op.preVerificationGas),
    gasFees: op.gasFees,
    paymasterAndData: op.paymasterAndData,
    signature: op.signature,
  };
}

// Signals a dead/missing session cookie: the proxy answers 401 when the browser
// sent no usable cookie, so the caller can re-establish one and retry.
const UNAUTHORIZED = -32001;

async function rpc<T>(url: string, method: string, params: unknown[], authed = false): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // Sends the HttpOnly session cookie on the proxied (write) path only.
    credentials: authed ? CREDENTIALS : "omit",
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });

  const text = await response.text();
  // `error` is a JSON-RPC object from the bundler, or a plain string from the proxy.
  let payload: { result?: T; error?: string | { code?: number; message?: string; data?: string } };
  try {
    payload = JSON.parse(text);
  } catch {
    throw Object.assign(new Error(`${url} returned a non-JSON ${response.status} response`), {
      code: response.status === 401 ? UNAUTHORIZED : undefined,
    });
  }

  // The proxy reports its own failures with a plain `{ error: "..." }` body, not
  // a JSON-RPC envelope — 401 there means "no session", not a bundler error.
  const error = payload.error;
  if (typeof error === "string") {
    throw Object.assign(new Error(error), { code: response.status === 401 ? UNAUTHORIZED : undefined });
  }
  if (error) {
    const err = new Error(`${error.message}${error.data ? `\n${error.data}` : ""}`);
    (err as { code?: number }).code = error.code;
    throw err;
  }
  return payload.result as T;
}

// Read methods need no auth and go straight to the bundler's RPC proxy.
async function bundlerRpc<T>(method: string, params: unknown[]): Promise<T> {
  return rpc<T>(lnet.bundlerUrl, method, params);
}

// Write methods (eth_sendUserOperation) go through the backend proxy, which holds
// the Keycloak token in an HttpOnly cookie and adds the Bearer header itself. On
// an unauthorized answer (expired cookie or token), re-login once and retry.
async function bundlerSend<T>(method: string, params: unknown[]): Promise<T> {
  await ensureSession();
  try {
    return await rpc<T>(BUNDLER_PROXY_ENDPOINT, method, params, true);
  } catch (err) {
    if ((err as { code?: number }).code === UNAUTHORIZED) {
      await ensureSession(true);
      return rpc<T>(BUNDLER_PROXY_ENDPOINT, method, params, true);
    }
    throw err;
  }
}

async function waitForUserOpReceipt(userOpHash: string): Promise<UserOpReceipt> {
  for (let i = 0; i < 60; i++) {
    const receipt = await bundlerRpc<UserOpReceipt | null>("eth_getUserOperationReceipt", [userOpHash]);
    if (receipt) return receipt;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`Timed out waiting for ${userOpHash}`);
}

const ERROR_STRING_SELECTOR = "0x08c379a0"; // Error(string)
const PANIC_SELECTOR = "0x4e487b71"; // Panic(uint256)

// Turns raw revert data into something readable. Empty data is the common case
// here: calling a contract that has no matching function and no fallback reverts
// with nothing at all, so there is no reason to decode — only the absence of one.
function decodeRevertData(data: string): string | null {
  if (!isHexString(data) || data === "0x") return null;
  try {
    if (data.startsWith(ERROR_STRING_SELECTOR)) {
      return AbiCoder.defaultAbiCoder().decode(["string"], dataSlice(data, 4))[0] as string;
    }
    if (data.startsWith(PANIC_SELECTOR)) {
      const [code] = AbiCoder.defaultAbiCoder().decode(["uint256"], dataSlice(data, 4));
      return `Panic(0x${(code as bigint).toString(16)})`;
    }
  } catch {
    // fall through: report the raw bytes rather than swallowing them
  }
  return `custom error ${data.length > 66 ? `${data.slice(0, 66)}...` : data}`;
}

// The EntryPoint catches a reverting execution instead of reverting handleOps, so
// a failed UserOp still produces a receipt with success=false. This digs the
// reason out of the UserOperationRevertReason log the EntryPoint emitted.
function revertReasonFromReceipt(receipt: UserOpReceipt, userOpHash: string): string | null {
  const topic = entryPoint.interface.getEvent("UserOperationRevertReason")?.topicHash;
  if (!topic) return null;
  for (const log of receipt.logs || []) {
    const topics = log.topics || [];
    if (topics[0]?.toLowerCase() !== topic.toLowerCase()) continue;
    if (topics[1]?.toLowerCase() !== userOpHash.toLowerCase()) continue;
    try {
      const parsed = entryPoint.interface.parseLog({ topics: [...topics], data: log.data || "0x" });
      if (parsed) return decodeRevertData(parsed.args.revertReason as string);
    } catch {
      return null;
    }
  }
  return null;
}

export async function sendExecuteUserOp(params: {
  ethereumProvider: Eip1193Provider;
  target: string;
  targetCalldata: string;
}): Promise<SendUserOpResult> {
  const browserProvider = new BrowserProvider(params.ethereumProvider);
  const signer = await browserProvider.getSigner();
  const owner = await signer.getAddress();

  const salt = randomSalt();
  const smartAccount = await factory.getFunction("getAddress(address,uint256)")(owner, salt);
  const initCode = concat([lnet.factory, factory.interface.encodeFunctionData("createAccount", [owner, salt])]);
  const callData = accountIface.encodeFunctionData("execute", [params.target, 0, params.targetCalldata]);

  const op: PackedUserOperation = {
    sender: smartAccount,
    nonce: 0n,
    initCode,
    callData,
    accountGasLimits: pack128(3_000_000, 1_000_000),
    preVerificationGas: 100_000n,
    gasFees: pack128(0, 0),
    paymasterAndData: "0x",
    signature: "0x",
  };

  const userOpHash = await entryPoint.getUserOpHash(op);
  op.signature = await signer.signMessage(getBytes(userOpHash));

  const returnedHash = await bundlerSend<string>("eth_sendUserOperation", [serializeUserOp(op), lnet.entryPoint]);
  if (returnedHash.toLowerCase() !== userOpHash.toLowerCase()) {
    throw new Error(`Bundler returned ${returnedHash}, expected ${userOpHash}`);
  }

  const receipt = await waitForUserOpReceipt(userOpHash);
  // Inclusion is not execution: report what the receipt actually says instead of
  // assuming the call did what it was meant to do.
  const success = receipt.success !== false;
  return {
    owner,
    smartAccount,
    userOpHash,
    receipt,
    success,
    revertReason: success ? null : revertReasonFromReceipt(receipt, userOpHash),
  };
}
