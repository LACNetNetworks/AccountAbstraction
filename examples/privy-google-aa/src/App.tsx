import { useCallback, useEffect, useMemo, useState } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { Interface, isAddress } from "ethers";
import { lnet } from "./lnet";
import { CopyButton } from "./CopyButton";
import { endSession, setPrivyTokenProvider } from "./session";
import { describeEntry, entryDetail, fetchWriteLog, type WriteLogEntry } from "./history";
import { sendExecuteUserOp, readStorageValue, inspectTarget } from "./userOp";

const STORAGE_ABI = ["function set(uint256 v)", "function value() view returns (uint256)"];
const storageIface = new Interface(STORAGE_ABI);

// Addresses and hashes are too wide for a table row; the full value stays in the
// cell's title attribute.
function shortHex(value: string | null): string {
  if (!value) return "—";
  return value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}

// Two different identities, and the row may hold either: the owner EOA comes from
// the UserOp's initCode (so it is absent once the account is already deployed),
// while the Privy user is whoever the backend verified before minting the session.
function ownerTitle(entry: WriteLogEntry): string | undefined {
  const parts = [entry.owner, entry.user].filter(Boolean);
  return parts.length ? parts.join(" · ") : undefined;
}

function formatTime(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleTimeString();
}

type Status = {
  state: "idle" | "running" | "ok" | "error";
  message: string;
};

export function App() {
  const { ready, authenticated, login, logout, user, getAccessToken } = usePrivy();
  const { wallets } = useWallets();
  const [storageAddress, setStorageAddress] = useState(lnet.storage);
  const [value, setValue] = useState("42");
  const [status, setStatus] = useState<Status>({ state: "idle", message: "Ready" });
  const [result, setResult] = useState<unknown>(null);
  const [storageModal, setStorageModal] = useState<{
    open: boolean;
    loading: boolean;
    value: string | null;
    error: string | null;
  }>({ open: false, loading: false, value: null, error: null });
  const [confirmSend, setConfirmSend] = useState(false);
  const [writeLog, setWriteLog] = useState<WriteLogEntry[]>([]);
  const [logError, setLogError] = useState<string | null>(null);
  const [logLoading, setLogLoading] = useState(false);

  const wallet = useMemo(() => wallets.find((item) => item.walletClientType === "privy") || wallets[0], [wallets]);
  const googleAccount = user?.google?.email || user?.email?.address || "Google user";
  const busy = status.state === "running";

  // The backend mints a bundler session only for a verified Privy user, so it
  // needs this token. Clearing it on logout is what stops a stale session from
  // outliving the login it belongs to.
  useEffect(() => {
    setPrivyTokenProvider(authenticated ? getAccessToken : null);
    return () => setPrivyTokenProvider(null);
  }, [authenticated, getAccessToken]);

  useEffect(() => {
    function onUnhandledRejection(event: PromiseRejectionEvent) {
      const reason = event.reason instanceof Error ? event.reason.message : String(event.reason);
      if (reason.includes("Login with Google not allowed")) {
        event.preventDefault();
        setStatus({
          state: "error",
          message:
            "Privy rejected Google login. Enable Google in the Privy dashboard and allow http://127.0.0.1:5173 for this app/client.",
        });
      }
    }

    window.addEventListener("unhandledrejection", onUnhandledRejection);
    return () => window.removeEventListener("unhandledrejection", onUnhandledRejection);
  }, []);

  async function loginWithGoogle() {
    try {
      setStatus({ state: "running", message: "Opening Google login..." });
      await login();
      setStatus({ state: "idle", message: "Ready" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus({
        state: "error",
        message: message.includes("Login with Google not allowed")
          ? "Privy rejected Google login. Enable Google in the Privy dashboard and allow http://127.0.0.1:5173 for this app."
          : message,
      });
    }
  }

  // Drop the backend cookie too, not just the Privy session — otherwise the
  // bundler session outlives the logout that was supposed to end it.
  async function signOut() {
    await endSession();
    await logout();
  }

  // The log lives on the server, so a refresh is the only way to see rows that
  // settled after this tab last looked — or that another tab wrote.
  const refreshWriteLog = useCallback(async () => {
    setLogLoading(true);
    try {
      setWriteLog(await fetchWriteLog(10));
      setLogError(null);
    } catch (error) {
      setLogError(error instanceof Error ? error.message : String(error));
    } finally {
      setLogLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!authenticated) {
      // The rows name a user and their account; they must not outlive the login.
      setWriteLog([]);
      setLogError(null);
      return;
    }
    void refreshWriteLog();
  }, [authenticated, refreshWriteLog]);

  async function sendUserOp() {
    setResult(null);
    if (!wallet) {
      setStatus({ state: "error", message: "No embedded wallet found after login." });
      return;
    }
    if (!isAddress(storageAddress)) {
      setStatus({ state: "error", message: "Storage address is not valid." });
      return;
    }

    // Preflight, because after signing there is nothing left to detect: a call to
    // an address with no code reports success and stores nothing.
    setStatus({ state: "running", message: "Checking the target contract..." });
    let inspection;
    try {
      inspection = await inspectTarget(storageAddress);
    } catch (error) {
      setStatus({
        state: "error",
        message: `Could not read ${storageAddress} from ${lnet.rpcUrl}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
      return;
    }

    if (!inspection.hasCode) {
      setStatus({
        state: "error",
        message: `${storageAddress} has no contract code. A call to an address without code succeeds without executing anything, so the UserOperation would report success and store nothing. Nothing was signed.`,
      });
      return;
    }

    if (!inspection.storageReadable) {
      // It has code but does not answer value(). Worth stopping for, not worth
      // forbidding: the address may be a Storage variant this app cannot read.
      setConfirmSend(true);
      return;
    }

    await performSend();
  }

  async function performSend() {
    if (!wallet) return;
    try {
      setStatus({ state: "running", message: "Preparing Google wallet signature..." });
      await wallet.switchChain(lnet.id).catch(() => undefined);
      const ethereumProvider = await wallet.getEthereumProvider();
      const targetCalldata = storageIface.encodeFunctionData("set", [BigInt(value || "0")]);

      setStatus({ state: "running", message: "Sending UserOperation to bundler..." });
      const response = await sendExecuteUserOp({
        ethereumProvider,
        target: storageAddress,
        targetCalldata,
      });
      setResult(response);

      // A reverted inner call is still a *included* UserOp: the EntryPoint catches
      // the revert, so the bundler returns a normal receipt with success=false.
      // Reporting "executed" on that would be a lie, and it is exactly what a
      // wrong target address looks like.
      if (!response.success) {
        setStatus({
          state: "error",
          message: response.revertReason
            ? `UserOperation included, but execution reverted: ${response.revertReason}`
            : `UserOperation included, but execution reverted with no reason data — ${storageAddress} likely has no set(uint256).`,
        });
        return;
      }
      setStatus({ state: "ok", message: "UserOperation included. Storage.set executed." });
    } catch (error) {
      setStatus({ state: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      // The backend recorded the attempt either way — a policy rejection is
      // exactly the kind of row worth seeing right after it happens.
      void refreshWriteLog();
    }
  }

  async function showStorageValue() {
    if (!isAddress(storageAddress)) {
      setStorageModal({ open: true, loading: false, value: null, error: "Storage address is not valid." });
      return;
    }
    setStorageModal({ open: true, loading: true, value: null, error: null });
    try {
      const current = await readStorageValue(storageAddress);
      setStorageModal({ open: true, loading: false, value: current.toString(), error: null });
    } catch (error) {
      setStorageModal({
        open: true,
        loading: false,
        value: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // The preflight left the status on "running"; clearing it keeps the Send button
  // from staying disabled after a cancel.
  function cancelSend() {
    setConfirmSend(false);
    setStatus({ state: "idle", message: "Ready" });
  }

  function closeStorageModal() {
    setStorageModal((prev) => ({ ...prev, open: false }));
  }

  if (!ready) {
    return <main className="shell">Loading Privy...</main>;
  }

  return (
    <main className="shell">
      <section className="topbar">
        <div>
          <h1>LNET Google AA</h1>
          <p>Sign an ERC-4337 UserOperation with a Google-created embedded wallet.</p>
        </div>
        {authenticated ? (
          <button className="secondary" onClick={signOut}>
            Logout
          </button>
        ) : null}
      </section>

      {!authenticated ? (
        <section className="panel">
          <h2>Google sign-in</h2>
          <p>The Google account creates an embedded EVM wallet. That EOA becomes the owner of `LnetAccount`.</p>
          <p className="notice">
            If Google returns 403, enable Google login and allow <code>http://127.0.0.1:5173</code> in the Privy dashboard for this App ID.
          </p>
          <button className={busy ? "busy" : undefined} disabled={busy} aria-busy={busy} onClick={loginWithGoogle}>
            {busy ? "Waiting for Google..." : "Continue with Google"}
          </button>
        </section>
      ) : (
        <section className="grid">
          <div className="panel">
            <h2>Signer</h2>
            <dl>
              <dt>User</dt>
              <dd>{googleAccount}</dd>
              <dt>Owner wallet</dt>
              <dd>{wallet?.address || "Creating wallet..."}</dd>
              <dt>Bundler</dt>
              <dd>{lnet.bundlerUrl}</dd>
              <dt>EntryPoint</dt>
              <dd>{lnet.entryPoint}</dd>
            </dl>
          </div>

          <div className="panel">
            <h2>Call Storage.set</h2>
            <label>
              Storage contract
              <input
                value={storageAddress}
                onChange={(event) => setStorageAddress(event.target.value)}
                placeholder="0x..."
                spellCheck={false}
              />
            </label>
            <label>
              Value
              <input value={value} onChange={(event) => setValue(event.target.value)} inputMode="numeric" />
            </label>
            <div className="button-row">
              <button className={busy ? "busy" : undefined} disabled={busy || !wallet} aria-busy={busy} onClick={sendUserOp}>
                {busy ? status.message : "Sign with Google wallet and send UserOp"}
              </button>
              <button className="secondary" disabled={busy || !storageAddress} onClick={showStorageValue}>
                View current value
              </button>
            </div>
          </div>
        </section>
      )}

      <section className={`status ${status.state}`}>
        <strong>{status.state.toUpperCase()}</strong>
        <span>{status.message}</span>
      </section>

      {result ? (
        <section className="panel">
          <h2>Result</h2>
          <pre>{JSON.stringify(result, null, 2)}</pre>
        </section>
      ) : null}

      {authenticated ? (
        <section className="panel history">
          <div className="history-head">
            <h2>Last 10 writes</h2>
            <button className="secondary" disabled={logLoading} onClick={() => void refreshWriteLog()}>
              {logLoading ? "Loading..." : "Refresh"}
            </button>
          </div>
          <p className="history-note">
            Recorded by the backend proxy — including attempts the policy blocked, which never reach the chain. The outcome
            comes from the UserOperation receipt, so "pending" is not "failed".
          </p>
          {logError ? <p className="modal-error">{logError}</p> : null}
          {!logError && !writeLog.length ? <p className="history-empty">No writes recorded yet.</p> : null}
          {writeLog.length ? (
            <div className="history-scroll">
              <table className="history-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th title="The EOA that signed the UserOperation — the Google embedded wallet">Owner</th>
                    <th>Target</th>
                    <th title="The set(uint256) argument — actually stored only when the outcome is executed">Value</th>
                    <th>UserOp</th>
                    <th title="Hash of the transaction that carried the bundle">Tx</th>
                    <th>Outcome</th>
                  </tr>
                </thead>
                <tbody>
                  {writeLog.map((entry) => {
                    const outcome = describeEntry(entry);
                    const detail = entryDetail(entry);
                    return (
                      <tr key={entry.id}>
                        <td>{formatTime(entry.at)}</td>
                        <td title={ownerTitle(entry)}>{shortHex(entry.owner)}</td>
                        <td title={entry.target || undefined}>{shortHex(entry.target)}</td>
                        <td className={entry.success === false ? "history-void" : undefined} title={entry.innerCall || undefined}>
                          {entry.storedValue ?? "—"}
                        </td>
                        <td title={entry.userOpHash || undefined}>{shortHex(entry.userOpHash)}</td>
                        <td title={entry.txHash || undefined}>
                          {entry.txHash ? (
                            <span className="hash-cell">
                              {shortHex(entry.txHash)}
                              <CopyButton value={entry.txHash} label="transaction hash" />
                            </span>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td>
                          {/* The reason lives in the tooltip now that Detail is gone —
                              dropping it would lose why a write failed. */}
                          <span className={`tag ${outcome.tone}`} title={detail || undefined}>
                            {outcome.label}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>
      ) : null}

      {confirmSend ? (
        <div className="modal-overlay" onClick={cancelSend}>
          <div className="modal" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <h2>This may not be the Storage contract</h2>
            <p className="modal-address">{storageAddress}</p>
            <p>
              It has contract code, but it did not answer <code>value()</code>, so it may not implement{" "}
              <code>set(uint256)</code> either. If it does not, the call reverts — or a <code>fallback()</code> swallows
              it and the write reports success while storing nothing.
            </p>
            <div className="button-row">
              <button className="secondary" onClick={cancelSend}>
                Cancel
              </button>
              <button
                onClick={() => {
                  setConfirmSend(false);
                  void performSend();
                }}
              >
                Send anyway
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {storageModal.open ? (
        <div className="modal-overlay" onClick={closeStorageModal}>
          <div className="modal" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <h2>Current Storage value</h2>
            <p className="modal-address">{storageAddress}</p>
            {storageModal.loading ? (
              <p>Reading from chain...</p>
            ) : storageModal.error ? (
              <p className="modal-error">{storageModal.error}</p>
            ) : (
              <p className="modal-value">{storageModal.value}</p>
            )}
            <div className="button-row">
              <button className="secondary" onClick={closeStorageModal}>
                Close
              </button>
              <button
                className={storageModal.loading ? "busy" : undefined}
                disabled={storageModal.loading}
                aria-busy={storageModal.loading}
                onClick={showStorageValue}
              >
                {storageModal.loading ? "Reading..." : "Refresh"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
