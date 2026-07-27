import { useEffect, useMemo, useState } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { Interface, isAddress } from "ethers";
import { lnet } from "./lnet";
import { sendExecuteUserOp, readStorageValue } from "./userOp";

const STORAGE_ABI = ["function set(uint256 v)", "function value() view returns (uint256)"];
const storageIface = new Interface(STORAGE_ABI);

type Status = {
  state: "idle" | "running" | "ok" | "error";
  message: string;
};

export function App() {
  const { ready, authenticated, login, logout, user } = usePrivy();
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

  const wallet = useMemo(() => wallets.find((item) => item.walletClientType === "privy") || wallets[0], [wallets]);
  const googleAccount = user?.google?.email || user?.email?.address || "Google user";

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
      setStatus({ state: "ok", message: "UserOperation included. Storage.set executed." });
    } catch (error) {
      setStatus({ state: "error", message: error instanceof Error ? error.message : String(error) });
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
          <button className="secondary" onClick={logout}>
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
          <button onClick={loginWithGoogle}>Continue with Google</button>
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
              <button disabled={status.state === "running" || !wallet} onClick={sendUserOp}>
                Sign with Google wallet and send UserOp
              </button>
              <button className="secondary" disabled={!storageAddress} onClick={showStorageValue}>
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
              <button disabled={storageModal.loading} onClick={showStorageValue}>
                Refresh
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
