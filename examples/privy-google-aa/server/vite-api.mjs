// Mounts the `/api` backend inside the Vite dev/preview server.
//
// This is the local half of "one service": instead of a second process on :8787
// with Vite proxying to it, the same handler that runs as a Vercel function runs
// here as connect middleware. One port, one origin, one command — and the cookie
// is a first-party cookie of the app's own origin in dev exactly as in production.
//
// Vite only exposes VITE_* vars to the browser and does not put anything into
// process.env, so the plugin loads the whole .env into process.env before
// importing the backend (which reads its config at module scope). Nothing here
// reaches the client bundle: that comes from `import.meta.env`, which Vite still
// filters by prefix.

import { loadEnv } from "vite";

export function apiPlugin() {
  return {
    name: "lnet-api-backend",
    // `config` runs before the server is created, so the env is in place by the
    // time the handler module is imported below.
    config(_config, { mode }) {
      const env = loadEnv(mode, process.cwd(), "");
      for (const [key, value] of Object.entries(env)) {
        // A real environment variable wins over the file, as in any deployment.
        if (process.env[key] === undefined) process.env[key] = value;
      }
    },
    async configureServer(server) {
      server.middlewares.use(await middleware());
    },
    // `vite preview` serves the production build; without this, /api would 404
    // there and the built app could not be smoke-tested locally.
    async configurePreviewServer(server) {
      server.middlewares.use(await middleware());
    },
  };
}

async function middleware() {
  // Imported lazily: the module reads process.env at import time, and `config`
  // above only just filled it in.
  const { apiHandler, describeApi } = await import("./api.mjs");
  const { lines, warnings } = describeApi();
  for (const line of lines) console.log(`  api  ${line}`);
  for (const warning of warnings) console.warn(`  api  WARNING: ${warning}`);
  return apiHandler();
}
