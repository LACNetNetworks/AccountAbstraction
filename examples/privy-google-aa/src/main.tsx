import "./polyfills";
import React from "react";
import ReactDOM from "react-dom/client";
import { PrivyProvider } from "@privy-io/react-auth";
import { App } from "./App";
import { lnetPrivyChain } from "./lnet";
import "./styles.css";

const appId = import.meta.env.VITE_PRIVY_APP_ID;

if (!appId) {
  throw new Error("Missing VITE_PRIVY_APP_ID. Copy .env.example to .env and fill your Privy app id.");
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <PrivyProvider
      appId={appId}
      config={{
        loginMethods: ["google"],
        appearance: {
          theme: "light",
          accentColor: "#0f766e",
          logo: undefined,
        },
        embeddedWallets: {
          ethereum: {
            createOnLogin: "users-without-wallets",
          },
        },
        defaultChain: lnetPrivyChain as any,
        supportedChains: [lnetPrivyChain as any],
      }}
    >
      <App />
    </PrivyProvider>
  </React.StrictMode>,
);
