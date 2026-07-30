// Vercel entry point for the whole backend.
//
// One catch-all function serves every `/api/*` route (`session`, `bundler`,
// `history`, `health`), so the deployment is a single service: static frontend
// plus this function on the same domain. Same-origin by construction, which is
// what the HttpOnly `SameSite=Strict` session cookie needs.
//
// The route logic lives in ../server/api.mjs and is shared with local dev, where
// the same handler is mounted as Vite middleware (server/vite-api.mjs).

import { apiHandler } from "../server/api.mjs";

export default apiHandler();
