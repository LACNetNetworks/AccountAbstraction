import { BrowserProvider, Contract, Interface, JsonRpcProvider, concat, getBytes, toBeHex, zeroPadValue } from "ethers";
import type { Eip1193Provider } from "ethers";
import { lnet } from "./lnet";

const UO =
  "(address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)";

const ENTRYPOINT_ABI = [`function getUserOpHash(${UO} userOp) view returns (bytes32)`];
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

export type SendUserOpResult = {
  owner: string;
  smartAccount: string;
  userOpHash: string;
  receipt: unknown;
};

const provider = new JsonRpcProvider(lnet.rpcUrl, lnet.id);
const factory = new Contract(lnet.factory, FACTORY_ABI, provider);
const entryPoint = new Contract(lnet.entryPoint, ENTRYPOINT_ABI, provider);
const accountIface = new Interface(ACCOUNT_ABI);

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

async function bundlerRpc<T>(method: string, params: unknown[]): Promise<T> {
  const response = await fetch(lnet.bundlerUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });
  const payload = await response.json();
  if (payload.error) {
    throw new Error(`${payload.error.message}${payload.error.data ? `\n${payload.error.data}` : ""}`);
  }
  return payload.result as T;
}

async function waitForUserOpReceipt(userOpHash: string) {
  for (let i = 0; i < 60; i++) {
    const receipt = await bundlerRpc<unknown | null>("eth_getUserOperationReceipt", [userOpHash]);
    if (receipt) return receipt;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`Timed out waiting for ${userOpHash}`);
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

  const returnedHash = await bundlerRpc<string>("eth_sendUserOperation", [serializeUserOp(op), lnet.entryPoint]);
  if (returnedHash.toLowerCase() !== userOpHash.toLowerCase()) {
    throw new Error(`Bundler returned ${returnedHash}, expected ${userOpHash}`);
  }

  const receipt = await waitForUserOpReceipt(userOpHash);
  return { owner, smartAccount, userOpHash, receipt };
}
