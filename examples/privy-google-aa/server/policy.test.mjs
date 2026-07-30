// Tests for the three security-relevant server modules. No network, no Keycloak:
// the Privy verifier takes an injected `fetchImpl`/`now`, so the JWKS is served
// from a locally generated ES256 key.
//
// Run with:  npm test   (node --test server)

import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { Interface, concat, toBeHex, zeroPadValue } from "ethers";

import { AuthError, createPrivyVerifier } from "./privy-auth.mjs";
import { createSessionCodec } from "./session-cookie.mjs";
import { createUserOpPolicy } from "./userop-policy.mjs";

// --- fixtures ----------------------------------------------------------------

const APP_ID = "test-app-id";
const KID = "test-key-1";
const NOW_MS = 1_800_000_000_000; // fixed clock: these tests must not depend on today
const now = () => NOW_MS;

const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwks = { keys: [{ ...publicKey.export({ format: "jwk" }), kid: KID, alg: "ES256", use: "sig" }] };

function b64url(value) {
  return Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
}

function privyToken({ alg = "ES256", kid = KID, signWith = privateKey, ...claims } = {}) {
  const header = b64url({ alg, kid, typ: "JWT" });
  const payload = b64url({
    iss: "privy.io",
    aud: APP_ID,
    sub: "did:privy:test-user",
    sid: "session-1",
    iat: Math.floor(NOW_MS / 1000) - 10,
    exp: Math.floor(NOW_MS / 1000) + 600,
    ...claims,
  });
  const signature = signWith
    ? sign("sha256", Buffer.from(`${header}.${payload}`), { key: signWith, dsaEncoding: "ieee-p1363" }).toString("base64url")
    : "";
  return `${header}.${payload}.${signature}`;
}

function verifier(overrides = {}) {
  return createPrivyVerifier({
    appId: APP_ID,
    jwksUrl: "https://jwks.test/keys",
    now,
    fetchImpl: async () => ({ ok: true, json: async () => jwks }),
    ...overrides,
  });
}

// --- privy-auth --------------------------------------------------------------

test("privy: accepts a well-formed token and returns the subject", async () => {
  const identity = await verifier().verify(`Bearer ${privyToken()}`);
  assert.equal(identity.sub, "did:privy:test-user");
  assert.equal(identity.sid, "session-1");
});

test("privy: rejects a missing or malformed Authorization header", async () => {
  await assert.rejects(() => verifier().verify(undefined), AuthError);
  await assert.rejects(() => verifier().verify("Bearer not-a-jwt"), AuthError);
});

test("privy: rejects a token minted for another app id", async () => {
  await assert.rejects(
    () => verifier().verify(`Bearer ${privyToken({ aud: "someone-elses-app" })}`),
    /audience is not this app id/,
  );
});

test("privy: rejects the wrong issuer", async () => {
  await assert.rejects(() => verifier().verify(`Bearer ${privyToken({ iss: "evil.io" })}`), /issuer must be privy.io/);
});

test("privy: rejects an expired token", async () => {
  const exp = Math.floor(NOW_MS / 1000) - 3600;
  await assert.rejects(() => verifier().verify(`Bearer ${privyToken({ exp })}`), /expired/);
});

test("privy: rejects alg swapping (none / HMAC confusion)", async () => {
  await assert.rejects(() => verifier().verify(`Bearer ${privyToken({ alg: "none", signWith: null })}`), /alg must be ES256/);
  await assert.rejects(() => verifier().verify(`Bearer ${privyToken({ alg: "HS256" })}`), /alg must be ES256/);
});

test("privy: rejects a token signed by a different key", async () => {
  const other = generateKeyPairSync("ec", { namedCurve: "P-256" });
  await assert.rejects(() => verifier().verify(`Bearer ${privyToken({ signWith: other.privateKey })}`), /signature is invalid/);
});

test("privy: rejects a tampered payload", async () => {
  const [header, , signature] = privyToken().split(".");
  const forged = b64url({ iss: "privy.io", aud: APP_ID, sub: "did:privy:someone-else", exp: Math.floor(NOW_MS / 1000) + 600 });
  await assert.rejects(() => verifier().verify(`Bearer ${header}.${forged}.${signature}`), /signature is invalid/);
});

test("privy: rejects an unknown kid without refetching in a tight loop", async () => {
  let fetches = 0;
  const v = verifier({
    fetchImpl: async () => {
      fetches += 1;
      return { ok: true, json: async () => jwks };
    },
  });
  await assert.rejects(() => v.verify(`Bearer ${privyToken({ kid: "rotated-away" })}`), /unknown key/);
  await assert.rejects(() => v.verify(`Bearer ${privyToken({ kid: "rotated-away-2" })}`), /unknown key/);
  assert.equal(fetches, 1, "a flood of unknown kids must not amplify into JWKS requests");
});

// --- session-cookie ---------------------------------------------------------

function codec(overrides = {}) {
  return createSessionCodec({ name: "naas_session", secret: "test-secret", now, ...overrides });
}

const SESSION = { accessToken: "keycloak.access.token", sub: "did:privy:test-user", expiresAt: NOW_MS + 300_000 };

test("cookie: round-trips the token and the subject", () => {
  const c = codec();
  const parsed = c.parse(cookieHeaderFrom(c.serialize(SESSION)));
  assert.deepEqual(parsed, SESSION);
});

test("cookie: is HttpOnly, SameSite=Strict and NOT persisted to disk", () => {
  const header = codec().serialize(SESSION);
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Strict/);
  assert.match(header, /Path=\/api/);
  // No Max-Age and no Expires => a session cookie, kept in memory only.
  assert.doesNotMatch(header, /Max-Age/);
  assert.doesNotMatch(header, /Expires/);
});

test("cookie: rejects a forged subject (MAC covers the payload)", () => {
  const c = codec();
  const value = cookieValueFrom(c.serialize(SESSION));
  const [payload, mac] = value.split(".");
  const forged = Buffer.from(
    JSON.stringify({ at: SESSION.accessToken, sub: "did:privy:someone-else", exp: SESSION.expiresAt }),
  ).toString("base64url");
  assert.equal(c.parse(`naas_session=${forged}.${mac}`), null);
  assert.equal(c.parse(`naas_session=${payload}.${mac.slice(0, -2)}xx`), null);
});

test("cookie: rejects a cookie signed with another key", () => {
  const value = cookieValueFrom(codec({ secret: "other-secret" }).serialize(SESSION));
  assert.equal(codec().parse(`naas_session=${value}`), null);
});

test("cookie: treats an expired payload as no session", () => {
  const c = codec();
  const value = cookieValueFrom(c.serialize({ ...SESSION, expiresAt: NOW_MS - 1 }));
  assert.equal(c.parse(`naas_session=${value}`), null);
});

test("cookie: clear() expires it", () => {
  assert.match(codec().clear(), /Max-Age=0/);
});

function cookieValueFrom(setCookieHeader) {
  return setCookieHeader.slice(setCookieHeader.indexOf("=") + 1, setCookieHeader.indexOf(";"));
}

function cookieHeaderFrom(setCookieHeader) {
  return `naas_session=${cookieValueFrom(setCookieHeader)}`;
}

// --- userop-policy ----------------------------------------------------------

const ENTRYPOINT = "0x9fD181236dA8c890bD5007b44B80E395E130c57D";
const FACTORY = "0x5589A0E344688976e473FD56BAe94411d9d56f67";
const STORAGE = "0xDcEA70eDDFA7EAB3590A1Ac7c00B48D36b4a13c6";
const OWNER = "0x1111111111111111111111111111111111111111";
const SENDER = "0x2222222222222222222222222222222222222222";

const accountIface = new Interface(["function execute(address dest, uint256 value, bytes func)"]);
const factoryIface = new Interface(["function createAccount(address owner, uint256 salt) returns (address)"]);
const storageIface = new Interface(["function set(uint256 v)", "function value() view returns (uint256)"]);

function pack128(hi, lo) {
  return zeroPadValue(toBeHex((BigInt(hi) << 128n) | BigInt(lo)), 32);
}

function userOp(overrides = {}) {
  return {
    sender: SENDER,
    nonce: "0x0",
    initCode: concat([FACTORY, factoryIface.encodeFunctionData("createAccount", [OWNER, 1n])]),
    callData: accountIface.encodeFunctionData("execute", [STORAGE, 0, storageIface.encodeFunctionData("set", [42n])]),
    accountGasLimits: pack128(3_000_000, 1_000_000),
    preVerificationGas: "0x186a0",
    gasFees: pack128(0, 0),
    paymasterAndData: "0x",
    signature: "0xdeadbeef",
    ...overrides,
  };
}

function request(op = userOp(), entryPoint = ENTRYPOINT, method = "eth_sendUserOperation") {
  return { jsonrpc: "2.0", id: 1, method, params: [op, entryPoint] };
}

const policy = createUserOpPolicy({ entryPoint: ENTRYPOINT, factory: FACTORY, allowedTargets: [STORAGE] });

test("policy: accepts the app's own UserOperation", () => {
  const checked = policy.check(request());
  assert.equal(checked.target, STORAGE);
  assert.equal(checked.owner, OWNER);
  assert.equal(checked.sender, SENDER);
});

test("policy: reports the inner call and the value it would store", () => {
  const { inner } = policy.check(request());
  assert.equal(inner.signature, "set(uint256)");
  assert.equal(inner.selector, storageIface.getFunction("set").selector.toLowerCase());
  // Decimal string, not a bigint: this ends up in JSON and in the write log.
  assert.equal(inner.value, "42");
});

test("policy: an unknown inner call is reported by selector, with no value guessed", () => {
  // ALLOWED_INNER_CALLS=* still labels what it knows, and stays silent otherwise:
  // a lone 32-byte word could be an address just as easily as a number.
  const open = createUserOpPolicy({ entryPoint: ENTRYPOINT, allowedTargets: ["*"], allowedInnerSignatures: ["*"] });
  const callData = accountIface.encodeFunctionData("execute", [STORAGE, 0, "0xdeadbeef"]);
  const { inner } = open.check(request(userOp({ callData })));
  assert.equal(inner.selector, "0xdeadbeef");
  assert.equal(inner.signature, null);
  assert.equal(inner.value, null);
});

test("policy: only proxies eth_sendUserOperation", () => {
  assert.throws(() => policy.check(request(userOp(), ENTRYPOINT, "eth_chainId")), /not allowed here/);
  assert.throws(() => policy.check(request(userOp(), ENTRYPOINT, "debug_bundler_dumpMempool")), /not allowed here/);
});

test("policy: rejects batches, which could smuggle unchecked calls", () => {
  assert.throws(() => policy.check([request(), request()]), /batched JSON-RPC is not allowed/);
});

test("policy: pins the EntryPoint", () => {
  assert.throws(() => policy.check(request(userOp(), "0x0000000000000000000000000000000000000009")), /entryPoint must be/);
});

test("policy: requires zero gas fees (LNET has no fee market)", () => {
  assert.throws(() => policy.check(request(userOp({ gasFees: pack128(1, 1) }))), /gasFees must be zero/);
});

test("policy: caps gas limits", () => {
  assert.throws(() => policy.check(request(userOp({ accountGasLimits: pack128(50_000_000, 1_000_000) }))), /verificationGasLimit/);
  assert.throws(() => policy.check(request(userOp({ accountGasLimits: pack128(3_000_000, 90_000_000) }))), /callGasLimit/);
  assert.throws(() => policy.check(request(userOp({ preVerificationGas: "0x5f5e100" }))), /preVerificationGas/);
});

test("policy: refuses an unexpected paymaster", () => {
  assert.throws(() => policy.check(request(userOp({ paymasterAndData: `0x${"11".repeat(20)}` }))), /paymasterAndData must be empty/);
});

test("policy: refuses a foreign factory in initCode", () => {
  const initCode = concat([
    "0x9999999999999999999999999999999999999999",
    factoryIface.encodeFunctionData("createAccount", [OWNER, 1n]),
  ]);
  assert.throws(() => policy.check(request(userOp({ initCode }))), /must deploy through/);
});

test("policy: accepts an already-deployed account (empty initCode)", () => {
  assert.equal(policy.check(request(userOp({ initCode: "0x" }))).owner, null);
});

test("policy: the callData must be LnetAccount.execute", () => {
  const raw = storageIface.encodeFunctionData("set", [42n]);
  assert.throws(() => policy.check(request(userOp({ callData: raw }))), /must be LnetAccount.execute/);
});

test("policy: blocks a target that is not allow-listed", () => {
  const callData = accountIface.encodeFunctionData("execute", [
    "0x3333333333333333333333333333333333333333",
    0,
    storageIface.encodeFunctionData("set", [42n]),
  ]);
  assert.throws(() => policy.check(request(userOp({ callData }))), /is not allowed/);
});

// This is the one that matters: an XSS can make the embedded wallet sign
// anything, so the inner call is the last line of defense.
test("policy: blocks an arbitrary inner call on an allowed target", () => {
  const erc20 = new Interface(["function transfer(address to, uint256 amount)"]);
  const callData = accountIface.encodeFunctionData("execute", [
    STORAGE,
    0,
    erc20.encodeFunctionData("transfer", ["0x4444444444444444444444444444444444444444", 10n ** 18n]),
  ]);
  assert.throws(() => policy.check(request(userOp({ callData }))), /inner call .* is not allowed/);
});

test("policy: blocks value transfers", () => {
  const callData = accountIface.encodeFunctionData("execute", [
    STORAGE,
    10n ** 18n,
    storageIface.encodeFunctionData("set", [42n]),
  ]);
  assert.throws(() => policy.check(request(userOp({ callData }))), /value must be 0/);
});

test("policy: rejects malformed input instead of forwarding it", () => {
  assert.throws(() => policy.check(null), /must be a JSON-RPC object/);
  assert.throws(() => policy.check({ method: "eth_sendUserOperation", params: [userOp()] }), /takes \[userOp, entryPoint\]/);
  assert.throws(() => policy.check(request(userOp({ sender: "not-an-address" }))), /sender must be an address/);
  assert.throws(() => policy.check(request(userOp({ gasFees: "0x00" }))), /32-byte hex/);
  assert.throws(() => policy.check(request(userOp({ callData: "zzz" }))), /callData must be hex/);
});

test("policy: ALLOWED_CALL_TARGETS=* opts out of the target check only", () => {
  const open = createUserOpPolicy({ entryPoint: ENTRYPOINT, factory: FACTORY, allowedTargets: ["*"] });
  const callData = accountIface.encodeFunctionData("execute", [
    "0x3333333333333333333333333333333333333333",
    0,
    storageIface.encodeFunctionData("set", [7n]),
  ]);
  assert.equal(open.check(request(userOp({ callData }))).target, "0x3333333333333333333333333333333333333333");
  // The inner-call allowlist still applies.
  const erc20 = new Interface(["function approve(address spender, uint256 amount)"]);
  const bad = accountIface.encodeFunctionData("execute", [
    STORAGE,
    0,
    erc20.encodeFunctionData("approve", ["0x4444444444444444444444444444444444444444", 1n]),
  ]);
  assert.throws(() => open.check(request(userOp({ callData: bad }))), /inner call .* is not allowed/);
});
