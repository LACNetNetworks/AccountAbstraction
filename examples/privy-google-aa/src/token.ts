// Fetches the bundler access token from the local token backend (server/token-server.mjs).
//
// The backend performs the Keycloak login with the NAAS client secret + user
// credentials from .env and returns only a short-lived access token. This module
// caches it in memory and refreshes it shortly before expiry.

const TOKEN_ENDPOINT = import.meta.env.VITE_TOKEN_ENDPOINT || "/api/token";

// The backend not running is the most common failure here, and it does not
// surface as a clean error: Vite's proxy turns ECONNREFUSED into a text/plain
// 500, so the status alone says nothing useful. Name the fix instead.
const BACKEND_DOWN = `token backend not reachable at ${TOKEN_ENDPOINT} — start it with \`npm run server\` (or run both with \`npm run dev:all\`)`;

let cached: { token: string; expiresAt: number } | null = null;
let inFlight: Promise<string> | null = null;

async function requestToken(): Promise<string> {
  let res: Response;
  try {
    res = await fetch(TOKEN_ENDPOINT, { method: "POST" });
  } catch {
    // No response at all: nothing is proxying /api on this origin.
    throw new Error(BACKEND_DOWN);
  }

  // token-server.mjs always answers with JSON, including on error. A non-JSON
  // body therefore means we never reached it — the proxy failed, or something
  // else is serving this origin (e.g. another dev server on the same port).
  const body = await res.text();
  let data: { access_token?: string; expires_in?: number; error?: string };
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error(`${BACKEND_DOWN} (got a non-JSON ${res.status} response)`);
  }

  if (!res.ok || !data.access_token) {
    // Real backend errors carry `error` — missing env, or Keycloak's own reason.
    throw new Error(data.error || `token backend returned ${res.status} without an access_token`);
  }
  const ttlMs = Number(data.expires_in || 60) * 1000;
  cached = { token: data.access_token, expiresAt: Date.now() + Math.max(ttlMs - 30_000, 5_000) };
  return cached.token;
}

export async function getBundlerToken(forceRefresh = false): Promise<string> {
  if (!forceRefresh && cached && Date.now() < cached.expiresAt) return cached.token;
  if (!inFlight) {
    inFlight = requestToken().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}
