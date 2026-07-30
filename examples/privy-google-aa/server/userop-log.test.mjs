import assert from "node:assert/strict";
import { test } from "node:test";
import { AbiCoder, Interface, id, zeroPadValue } from "ethers";
import { createUserOpLog, decodeRevertData, outcomeFromReceipt } from "./userop-log.mjs";

const HASH = `0x${"ab".repeat(32)}`;
const TX = `0x${"ef".repeat(32)}`;
const SENDER = "0x0BA145F1AbC02872D78E0801814B1C4c1b8DDeac";
const REVERT_TOPIC = id("UserOperationRevertReason(bytes32,address,uint256,bytes)");

function log(revertData, { userOpHash = HASH } = {}) {
  return {
    topics: [REVERT_TOPIC, userOpHash, zeroPadValue(SENDER, 32)],
    data: AbiCoder.defaultAbiCoder().encode(["uint256", "bytes"], [0n, revertData]),
  };
}

function newLog() {
  // :memory: keeps the suite from leaving a db file behind.
  return createUserOpLog({ path: ":memory:" });
}

test("log: keeps the stored value and the tx hash of a settled write", () => {
  const store = newLog();
  const id = store.record({ status: "sent", userOpHash: HASH, innerCall: "set(uint256)", storedValue: "42" });
  store.settle(id, { success: true, transactionHash: TX });

  const [entry] = store.recent(1);
  assert.equal(entry.innerCall, "set(uint256)");
  assert.equal(entry.storedValue, "42");
  assert.equal(entry.txHash, TX);
  assert.equal(entry.success, true);
  store.close();
});

test("log: records a forwarded write and reads it back newest-first", () => {
  const store = newLog();
  store.record({ userSub: "did:privy:a", status: "sent", method: "eth_sendUserOperation", userOpHash: HASH, sender: SENDER, target: "0xdead" });
  store.record({ userSub: "did:privy:a", status: "rejected", method: "eth_sendUserOperation", error: "target not allowed" });

  const entries = store.recent(10);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].status, "rejected");
  assert.equal(entries[1].userOpHash, HASH);
  // Not yet settled: unknown outcome must not read as failure.
  assert.equal(entries[1].success, null);
  assert.match(entries[0].at, /^\d{4}-\d{2}-\d{2}T/);
  store.close();
});

test("log: returns only the last N entries", () => {
  const store = newLog();
  for (let i = 0; i < 25; i++) store.record({ status: "sent", userOpHash: `0x${String(i).padStart(4, "0")}` });
  const entries = store.recent(10);
  assert.equal(entries.length, 10);
  assert.equal(entries[0].userOpHash, "0x0024");
  assert.equal(entries[9].userOpHash, "0x0015");
  store.close();
});

test("log: only rows awaiting a receipt are pending, and settling clears them", () => {
  const store = newLog();
  const sent = store.record({ status: "sent", userOpHash: HASH });
  store.record({ status: "rejected", error: "nope" });
  store.record({ status: "sent" }); // no hash: nothing to settle against

  assert.deepEqual(store.pending(10), [{ id: sent, userOpHash: HASH }]);

  // Settled without a tx hash: still pending, so the hash gets backfilled.
  store.settle(sent, { success: false, revertReason: "boom" });
  assert.deepEqual(store.pending(10), [{ id: sent, userOpHash: HASH }]);

  store.settle(sent, { success: false, revertReason: "boom", transactionHash: TX });
  assert.deepEqual(store.pending(10), []);
  assert.equal(store.recent(10).length, 3); // settling updates, never inserts
  const settled = store.recent(10).find((entry) => entry.id === sent);
  assert.equal(settled.success, false);
  assert.equal(settled.revertReason, "boom");
  assert.ok(settled.settledAt);
  store.close();
});

test("log: clips oversized fields instead of storing an unbounded body", () => {
  const store = newLog();
  store.record({ status: "rejected", error: "x".repeat(5000) });
  assert.ok(store.recent(1)[0].error.length <= 201);
  store.close();
});

test("receipt: pending receipt leaves the row unsettled", () => {
  assert.equal(outcomeFromReceipt(null, HASH), null);
});

test("receipt: success needs no reason, and carries the tx hash", () => {
  assert.deepEqual(outcomeFromReceipt({ success: true, logs: [], receipt: { transactionHash: TX } }, HASH), {
    success: true,
    revertReason: null,
    transactionHash: TX,
  });
});

test("receipt: falls back to a log's tx hash when the nested receipt has none", () => {
  const entry = { success: true, logs: [{ topics: [], data: "0x", transactionHash: TX }] };
  assert.equal(outcomeFromReceipt(entry, HASH).transactionHash, TX);
});

test("receipt: decodes Error(string) from the EntryPoint's revert log", () => {
  const data = new Interface(["function Error(string)"]).encodeFunctionData("Error", ["only owner"]);
  const outcome = outcomeFromReceipt({ success: false, logs: [log(data)], receipt: { transactionHash: TX } }, HASH);
  assert.deepEqual(outcome, { success: false, revertReason: "only owner", transactionHash: TX });
});

test("receipt: a revert with no data yields success=false and no reason", () => {
  // What a contract without the function (and without a fallback) produces: the
  // EntryPoint emits no event at all, so there is nothing to decode.
  assert.deepEqual(outcomeFromReceipt({ success: false, logs: [] }, HASH), {
    success: false,
    revertReason: null,
    transactionHash: null,
  });
});

test("receipt: ignores a revert log belonging to another UserOp in the same tx", () => {
  const other = `0x${"cd".repeat(32)}`;
  const data = new Interface(["function Error(string)"]).encodeFunctionData("Error", ["someone else's revert"]);
  const outcome = outcomeFromReceipt({ success: false, logs: [log(data, { userOpHash: other })] }, HASH);
  assert.deepEqual(outcome, { success: false, revertReason: null, transactionHash: null });
});

test("revert data: Panic and custom errors stay readable", () => {
  const panic = `0x4e487b71${AbiCoder.defaultAbiCoder().encode(["uint256"], [0x11]).slice(2)}`;
  assert.equal(decodeRevertData(panic), "Panic(0x11)");
  assert.equal(decodeRevertData("0xdeadbeef"), "custom error 0xdeadbeef");
  assert.equal(decodeRevertData("0x"), null);
});
