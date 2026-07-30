import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error - plain .mjs, no types; it is the same backend the deployed
// function imports (see api/[...path].js).
import { apiPlugin } from "./server/vite-api.mjs";

// One service, one port: the `/api` backend runs *inside* this dev server as
// middleware instead of as a separate process behind a proxy, mirroring the
// deployed shape (static build + `/api` function on the same domain). The NAAS
// secret/password stay server-side, and the session cookie is a first-party
// cookie of the app's own origin.
export default defineConfig({
  plugins: [react(), apiPlugin()],
});
