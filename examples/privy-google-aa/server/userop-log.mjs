// Persistent log of the UserOperations this backend was asked to send.
//
// The proxy is the only place that sees every write attempt — including the ones
// the policy rejects, which never reach the chain and would otherwise leave no
// trace anywhere. It is also the only place that can tie a UserOp to the Privy
// user who asked for it.
//
// Inclusion is not execution (the EntryPoint catches a reverting call and still
// emits a receipt), so a row is written when the request is handled and *settled*
// later from the bundler receipt: success plus, when the target left revert data,
// the decoded reason.

import { DatabaseSync } from "node:sqlite";
import { AbiCoder, Interface, dataSlice, isHexString } from "ethers";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS userop_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at    INTEGER NOT NULL,
  user_sub      TEXT,
  status        TEXT NOT NULL,   -- rejected | failed | sent
  method        TEXT,
  user_op_hash  TEXT,
  sender        TEXT,
  target        TEXT,
  owner         TEXT,
  inner_call    TEXT,            -- e.g. set(uint256), or the bare selector
  stored_value  TEXT,            -- decimal string: JSON has no bigint
  http_status   INTEGER,
  error         TEXT,
  success       INTEGER,         -- NULL until the receipt settles it
  revert_reason TEXT,
  tx_hash       TEXT,            -- only known once the receipt arrives
  settled_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_userop_log_created ON userop_log(created_at DESC);
`;

// Columns added after the first release. A db file from an earlier run already
// exists on any machine that ran this, and CREATE TABLE IF NOT EXISTS would
// silently leave it on the old shape.
const ADDED_COLUMNS = [
  ["inner_call", "TEXT"],
  ["stored_value", "TEXT"],
  ["tx_hash", "TEXT"],
];

function migrate(db) {
  const present = new Set(db.prepare("SELECT name FROM pragma_table_info('userop_log')").all().map((r) => r.name));
  for (const [name, type] of ADDED_COLUMNS) {
    if (!present.has(name)) db.exec(`ALTER TABLE userop_log ADD COLUMN ${name} ${type}`);
  }
}

// Values reaching here can come from an untrusted request body, so cap them
// rather than let a caller write megabytes into the log by hand.
const MAX_FIELD = 200;

function clip(value) {
  if (value == null) return null;
  const text = typeof value === "string" ? value : String(value);
  return text.length > MAX_FIELD ? `${text.slice(0, MAX_FIELD)}…` : text;
}

export function createUserOpLog({ path, now = () => Date.now() }) {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  migrate(db);

  const insert = db.prepare(`
    INSERT INTO userop_log
      (created_at, user_sub, status, method, user_op_hash, sender, target, owner, inner_call, stored_value, http_status, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectRecent = db.prepare(`SELECT * FROM userop_log ORDER BY id DESC LIMIT ?`);
  // `tx_hash IS NULL` also covers rows settled before that column existed: they
  // get backfilled on the next read instead of needing a manual fixup.
  const selectPending = db.prepare(`
    SELECT id, user_op_hash FROM userop_log
    WHERE status = 'sent' AND user_op_hash IS NOT NULL AND (success IS NULL OR tx_hash IS NULL)
    ORDER BY id DESC LIMIT ?
  `);
  const update = db.prepare(
    `UPDATE userop_log SET success = ?, revert_reason = ?, tx_hash = ?, settled_at = ? WHERE id = ?`,
  );

  return {
    path,

    record(entry) {
      const { lastInsertRowid } = insert.run(
        now(),
        clip(entry.userSub),
        entry.status,
        clip(entry.method),
        clip(entry.userOpHash),
        clip(entry.sender),
        clip(entry.target),
        clip(entry.owner),
        clip(entry.innerCall),
        clip(entry.storedValue),
        entry.httpStatus == null ? null : Number(entry.httpStatus),
        clip(entry.error),
      );
      return Number(lastInsertRowid);
    },

    /** Rows still waiting for a receipt, newest first. */
    pending(limit = 10) {
      return selectPending.all(limit).map((row) => ({ id: row.id, userOpHash: row.user_op_hash }));
    },

    settle(id, { success, revertReason = null, transactionHash = null }) {
      update.run(success ? 1 : 0, clip(revertReason), clip(transactionHash), now(), id);
    },

    recent(limit = 10) {
      return selectRecent.all(limit).map(toEntry);
    },

    close() {
      db.close();
    },
  };
}

function toEntry(row) {
  return {
    id: row.id,
    at: new Date(row.created_at).toISOString(),
    user: row.user_sub,
    status: row.status,
    method: row.method,
    userOpHash: row.user_op_hash,
    sender: row.sender,
    target: row.target,
    owner: row.owner,
    innerCall: row.inner_call,
    // What the UserOp asked to store — actually stored only if success is true.
    storedValue: row.stored_value,
    httpStatus: row.http_status,
    error: row.error,
    // null = no receipt yet; the distinction from `false` is the whole point.
    success: row.success == null ? null : row.success === 1,
    revertReason: row.revert_reason,
    txHash: row.tx_hash,
    settledAt: row.settled_at ? new Date(row.settled_at).toISOString() : null,
  };
}

// --- receipt reading ---------------------------------------------------------

const entryPointIface = new Interface([
  "event UserOperationRevertReason(bytes32 indexed userOpHash, address indexed sender, uint256 nonce, bytes revertReason)",
]);
const REVERT_REASON_TOPIC = entryPointIface.getEvent("UserOperationRevertReason").topicHash.toLowerCase();

const ERROR_STRING_SELECTOR = "0x08c379a0"; // Error(string)
const PANIC_SELECTOR = "0x4e487b71"; // Panic(uint256)

// Mirrors decodeRevertData in src/userOp.ts: same wire format, different runtime
// (browser vs server), so the two cannot share a module.
export function decodeRevertData(data) {
  if (!isHexString(data) || data === "0x") return null;
  try {
    if (data.startsWith(ERROR_STRING_SELECTOR)) {
      return AbiCoder.defaultAbiCoder().decode(["string"], dataSlice(data, 4))[0];
    }
    if (data.startsWith(PANIC_SELECTOR)) {
      const [code] = AbiCoder.defaultAbiCoder().decode(["uint256"], dataSlice(data, 4));
      return `Panic(0x${code.toString(16)})`;
    }
  } catch {
    // fall through: the raw bytes beat swallowing the failure
  }
  return `custom error ${data.length > 66 ? `${data.slice(0, 66)}…` : data}`;
}

// The ERC-4337 receipt nests the transaction receipt; on LNET that tx is the Hub
// meta-tx that carried the bundle, which is what a block explorer can be pointed at.
function transactionHashOf(receipt) {
  return receipt.receipt?.transactionHash || receipt.logs?.[0]?.transactionHash || null;
}

/**
 * Reads execution outcome out of an eth_getUserOperationReceipt result.
 * @returns {{success: boolean, revertReason: string|null, transactionHash: string|null}|null}
 *          null while still pending.
 */
export function outcomeFromReceipt(receipt, userOpHash) {
  if (!receipt) return null;
  const transactionHash = transactionHashOf(receipt);
  const success = receipt.success !== false;
  if (success) return { success: true, revertReason: null, transactionHash };

  for (const log of receipt.logs || []) {
    const topics = log.topics || [];
    // The receipt carries every log in the transaction, and on LNET one Hub
    // meta-tx can bundle several UserOps — so match the hash, not just the topic.
    if (topics[0]?.toLowerCase() !== REVERT_REASON_TOPIC) continue;
    if (topics[1]?.toLowerCase() !== userOpHash.toLowerCase()) continue;
    try {
      const parsed = entryPointIface.parseLog({ topics: [...topics], data: log.data || "0x" });
      return { success: false, revertReason: decodeRevertData(parsed.args.revertReason), transactionHash };
    } catch {
      break;
    }
  }
  // The EntryPoint only emits the event when the revert carried data; a contract
  // with no matching function and no fallback reverts with none at all.
  return { success: false, revertReason: null, transactionHash };
}
