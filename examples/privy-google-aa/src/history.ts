// Reads the backend's write log (GET /api/history).
//
// The rows come from the proxy, not from this page: it is the only place that
// sees every attempt, including the ones the policy blocked and the ones whose
// outcome arrived after the tab was closed. So this is a display of the server's
// record, never a client-side tally.

import { CREDENTIALS, HISTORY_ENDPOINT, ensureSession } from "./session";

export type WriteLogEntry = {
  id: number;
  at: string;
  user: string | null;
  status: "sent" | "failed" | "rejected";
  method: string | null;
  userOpHash: string | null;
  sender: string | null;
  target: string | null;
  owner: string | null;
  innerCall: string | null;
  // The value the UserOp asked to store — stored only if `success` is true.
  storedValue: string | null;
  httpStatus: number | null;
  error: string | null;
  // null means the receipt has not settled yet — not that it failed.
  success: boolean | null;
  revertReason: string | null;
  txHash: string | null;
  settledAt: string | null;
};

async function get(limit: number): Promise<Response> {
  return fetch(`${HISTORY_ENDPOINT}?limit=${limit}`, { credentials: CREDENTIALS });
}

export async function fetchWriteLog(limit = 10): Promise<WriteLogEntry[]> {
  await ensureSession();

  let res: Response;
  try {
    res = await get(limit);
    // Same 401 contract as the bundler proxy: the cookie may have expired between
    // the check and the call, and one re-login fixes it.
    if (res.status === 401) {
      await ensureSession(true);
      res = await get(limit);
    }
  } catch {
    throw new Error("session backend not reachable — start it with `npm run server`");
  }

  const body = await res.text();
  let data: { entries?: WriteLogEntry[]; error?: string };
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error(`write log endpoint returned a non-JSON ${res.status} response`);
  }
  if (!res.ok) throw new Error(data.error || `write log endpoint returned ${res.status}`);
  return data.entries || [];
}

/** One-line outcome for a row, keeping "pending" distinct from "failed". */
export function describeEntry(entry: WriteLogEntry): { label: string; tone: "ok" | "error" | "pending" } {
  if (entry.status === "rejected") return { label: "blocked by policy", tone: "error" };
  if (entry.status === "failed") return { label: "not accepted", tone: "error" };
  if (entry.success === null) return { label: "pending receipt", tone: "pending" };
  if (entry.success) return { label: "executed", tone: "ok" };
  return { label: "reverted", tone: "error" };
}

/** The reason this row ended the way it did, when there is one to show. */
export function entryDetail(entry: WriteLogEntry): string | null {
  if (entry.error) return entry.error;
  if (entry.success === false) {
    // A revert with no data is the signature of a target lacking the function.
    return entry.revertReason || "reverted with no reason data";
  }
  return null;
}
