import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The frontend calls /api/token same-origin; Vite proxies it to the local token
// backend (server/token-server.mjs) so the NAAS secret/password stay server-side.
const TOKEN_SERVER = process.env.TOKEN_SERVER_ORIGIN || "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: TOKEN_SERVER,
        changeOrigin: true,
      },
    },
  },
});
