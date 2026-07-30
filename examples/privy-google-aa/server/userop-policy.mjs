// Policy gate for the bundler proxy.
//
// The proxy holds a privileged Keycloak token, so anything it forwards is signed
// off by this backend's authority. Forwarding arbitrary JSON-RPC would make it a
// confused deputy: an XSS on the page cannot read the token, but it can ask the
// embedded Privy wallet to sign a UserOperation (embedded wallets sign without a
// user prompt) and then post it here. This module is what keeps that blast radius
// to "write a number to an allowed Storage contract".
//
// Same framing as LnetVerifyingPaymaster in this repo: the policy is off-chain and
// deliberately an allow-list, not an economic control.

import { AbiCoder, Interface, dataSlice, getAddress, id, isHexString } from "ethers";

export class PolicyError extends Error {
  constructor(message) {
    super(message);
    this.status = 403;
  }
}

// Only writes need this proxy; reads go straight to the bundler unauthenticated.
const ALLOWED_METHODS = new Set(["eth_sendUserOperation"]);

const accountIface = new Interface(["function execute(address dest, uint256 value, bytes func)"]);
const factoryIface = new Interface(["function createAccount(address owner, uint256 salt) returns (address)"]);

const EXECUTE_SELECTOR = accountIface.getFunction("execute").selector;
const CREATE_ACCOUNT_SELECTOR = factoryIface.getFunction("createAccount").selector;
const ZERO_WORD = `0x${"00".repeat(32)}`;

export const DEFAULT_INNER_SELECTORS = ["set(uint256)"];

export function createUserOpPolicy({
  entryPoint,
  factory,
  // Empty/undefined means "any target"; `["*"]` is the explicit opt-out.
  allowedTargets = [],
  allowedInnerSignatures = DEFAULT_INNER_SELECTORS,
  limits = {},
}) {
  const expectedEntryPoint = normalize(entryPoint, "entryPoint");
  const expectedFactory = factory ? normalize(factory, "factory") : null;

  const anyTarget = allowedTargets.length === 0 || allowedTargets.includes("*");
  const targets = new Set(anyTarget ? [] : allowedTargets.map((t) => normalize(t, "allowed target")));

  const anySelector = allowedInnerSignatures.includes("*");
  // Built even when `*` opts out of enforcement: knowing a selector's signature is
  // what lets the write log show *which* call was made, not just its 4 bytes.
  const innerSelectors = new Map(
    allowedInnerSignatures.filter((sig) => sig !== "*").map((sig) => [id(sig).slice(0, 10).toLowerCase(), sig]),
  );

  const caps = {
    verificationGasLimit: BigInt(limits.verificationGasLimit ?? 5_000_000),
    callGasLimit: BigInt(limits.callGasLimit ?? 2_000_000),
    preVerificationGas: BigInt(limits.preVerificationGas ?? 500_000),
    callDataBytes: Number(limits.callDataBytes ?? 4_096),
  };

  /**
   * Throws PolicyError if the request must not be forwarded.
   * @returns {{method: string, sender: string, target: string, owner: string|null}}
   */
  function check(request) {
    // A batch would let one allowed call smuggle in a dozen unchecked ones.
    if (Array.isArray(request)) throw new PolicyError("batched JSON-RPC is not allowed on this endpoint");
    if (!request || typeof request !== "object") throw new PolicyError("request body must be a JSON-RPC object");

    const method = request.method;
    if (!ALLOWED_METHODS.has(method)) {
      throw new PolicyError(
        `method ${method || "(none)"} is not allowed here — this endpoint only proxies ${[...ALLOWED_METHODS].join(", ")}`,
      );
    }

    const params = request.params;
    if (!Array.isArray(params) || params.length !== 2) throw new PolicyError(`${method} takes [userOp, entryPoint]`);

    // Pinning the EntryPoint stops the token from being spent on a foreign one.
    if (normalize(params[1], "entryPoint") !== expectedEntryPoint) {
      throw new PolicyError(`entryPoint must be ${expectedEntryPoint}`);
    }

    const op = params[0];
    if (!op || typeof op !== "object") throw new PolicyError("userOp must be an object");

    const sender = normalize(op.sender, "sender");

    // LNET has no fee market and gas is free: a non-zero fee is always a mistake
    // or an attempt to drain something.
    if (word(op.gasFees, "gasFees") !== ZERO_WORD) {
      throw new PolicyError("gasFees must be zero on LNET (maxFeePerGas = maxPriorityFeePerGas = 0)");
    }

    const gasLimits = word(op.accountGasLimits, "accountGasLimits");
    const verificationGasLimit = BigInt(dataSlice(gasLimits, 0, 16));
    const callGasLimit = BigInt(dataSlice(gasLimits, 16, 32));
    ceiling("verificationGasLimit", verificationGasLimit, caps.verificationGasLimit);
    ceiling("callGasLimit", callGasLimit, caps.callGasLimit);
    ceiling("preVerificationGas", quantity(op.preVerificationGas, "preVerificationGas"), caps.preVerificationGas);

    // This example sponsors nothing; an unexpected paymaster would be someone
    // else's deposit being spent through our authority.
    if (op.paymasterAndData && op.paymasterAndData !== "0x") {
      throw new PolicyError("paymasterAndData must be empty for this app");
    }

    const owner = checkInitCode(op.initCode, expectedFactory);
    const { target, inner } = checkCallData(op.callData);

    return { method, sender, target, owner, inner };
  }

  function checkInitCode(initCode, expectedFactoryAddress) {
    if (!initCode || initCode === "0x") return null; // account already deployed
    if (!isHexString(initCode) || initCode.length < 2 + 40) throw new PolicyError("initCode is malformed");
    const usedFactory = normalize(dataSlice(initCode, 0, 20), "initCode factory");
    if (expectedFactoryAddress && usedFactory !== expectedFactoryAddress) {
      throw new PolicyError(`initCode must deploy through ${expectedFactoryAddress}`);
    }
    const call = dataSlice(initCode, 20);
    if (dataSlice(call, 0, 4).toLowerCase() !== CREATE_ACCOUNT_SELECTOR.toLowerCase()) {
      throw new PolicyError("initCode must call createAccount(address,uint256)");
    }
    try {
      const [ownerArg] = factoryIface.decodeFunctionData("createAccount", call);
      return getAddress(ownerArg);
    } catch {
      throw new PolicyError("initCode createAccount arguments are malformed");
    }
  }

  function checkCallData(callData) {
    if (!isHexString(callData)) throw new PolicyError("callData must be hex");
    if ((callData.length - 2) / 2 > caps.callDataBytes) {
      throw new PolicyError(`callData exceeds ${caps.callDataBytes} bytes`);
    }
    if (dataSlice(callData, 0, 4).toLowerCase() !== EXECUTE_SELECTOR.toLowerCase()) {
      throw new PolicyError("callData must be LnetAccount.execute(address,uint256,bytes)");
    }

    let dest;
    let value;
    let inner;
    try {
      [dest, value, inner] = accountIface.decodeFunctionData("execute", callData);
    } catch {
      throw new PolicyError("callData execute arguments are malformed");
    }

    // Value transfers are never part of this app's flow.
    if (BigInt(value) !== 0n) throw new PolicyError("execute value must be 0");

    const target = getAddress(dest);
    if (!anyTarget && !targets.has(target)) {
      throw new PolicyError(
        `target ${target} is not allowed — add it to ALLOWED_CALL_TARGETS (or set ALLOWED_CALL_TARGETS=* to allow any)`,
      );
    }

    const selector = inner === "0x" ? "0x" : dataSlice(inner, 0, 4).toLowerCase();
    if (!anySelector && !innerSelectors.has(selector)) {
      throw new PolicyError(
        `inner call ${selector} is not allowed — allowed: ${[...innerSelectors.values()].join(", ")}`,
      );
    }

    const signature = innerSelectors.get(selector) || null;
    return { target, inner: { selector, signature, value: decodeSingleUint(signature, inner) } };
  }

  return {
    check,
    describe: () => ({
      methods: [...ALLOWED_METHODS],
      entryPoint: expectedEntryPoint,
      factory: expectedFactory,
      targets: anyTarget ? "*" : [...targets],
      innerCalls: anySelector ? "*" : [...innerSelectors.values()],
    }),
  };
}

// The argument of a one-uint256 call such as set(uint256) — the number this app
// asks the Storage contract to keep. Returned as a decimal string: JSON has no
// bigint, and the log only ever displays it. Anything else is left undecoded
// rather than guessed at: a lone 32-byte word could equally be an address.
const SINGLE_UINT = /^[A-Za-z_]\w*\(uint256\)$/;

function decodeSingleUint(signature, innerCalldata) {
  if (!signature || !SINGLE_UINT.test(signature)) return null;
  try {
    const [value] = AbiCoder.defaultAbiCoder().decode(["uint256"], dataSlice(innerCalldata, 4));
    return value.toString();
  } catch {
    return null;
  }
}

function normalize(value, what) {
  if (typeof value !== "string") throw new PolicyError(`${what} must be an address`);
  try {
    return getAddress(value);
  } catch {
    throw new PolicyError(`${what} must be an address`);
  }
}

function word(value, what) {
  if (!isHexString(value, 32)) throw new PolicyError(`${what} must be a 32-byte hex value`);
  return value.toLowerCase();
}

function quantity(value, what) {
  try {
    return BigInt(value);
  } catch {
    throw new PolicyError(`${what} must be a number`);
  }
}

function ceiling(what, actual, cap) {
  if (actual > cap) throw new PolicyError(`${what} ${actual} exceeds the allowed ${cap}`);
}
