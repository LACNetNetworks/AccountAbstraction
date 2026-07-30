// Session handling for the JWT-protected bundler.
//
// The access token is NOT fetched into the page any more: the backend
// (server/token-server.mjs) keeps it in an HttpOnly cookie, so nothing here can
// read it — and neither can injected script. This module only:
//
//   1. proves who is asking, by sending the Privy access token of the logged-in
//      user to POST /api/session, which is what mints the cookie, and
//   2. sends write RPCs to /api/bundler, which attaches the bundler's Bearer
//      header server-side using the cookie the browser sent automatically.
//
// The cookie is unreadable to fetch(), so the browser can no longer talk to the
// bundler directly for authenticated calls; the proxy endpoint is the write path.
//
// Note the asymmetry: the Privy token travels in a header (immune to CSRF by
// construction) and only on login; the session cookie is ambient, which is why the
// backend also checks Origin/Sec-Fetch-Site and sets SameSite=Strict.

const API_BASE = (import.meta.env.VITE_API_BASE || "/api").replace(/\/+$/, "");

export const SESSION_ENDPOINT = `${API_BASE}/session`;
export const BUNDLER_PROXY_ENDPOINT = `${API_BASE}/bundler`;
export const HISTORY_ENDPOINT = `${API_BASE}/history`;

// Cookies only ride along cross-origin with `include`. Same-origin (the default:
// Vite proxies /api to the backend) needs nothing special, and `same-origin`
// keeps the credentials from leaking if the base is ever repointed by mistake.
export const CREDENTIALS: RequestCredentials = /^https?:\/\//i.test(import.meta.env.VITE_API_BASE || "")
  ? "include"
  : "same-origin";

// The backend not running is the most common failure here, and it does not
// surface as a clean error: Vite's proxy turns ECONNREFUSED into a text/plain
// 500, so the status alone says nothing useful. Name the fix instead.
const BACKEND_DOWN = `session backend not reachable at ${API_BASE} — start it with \`npm run server\` (or run both with \`npm run dev:all\`)`;

// Only the expiry hint is cached — there is no token to cache. It saves a
// round trip per write while the cookie is known to still be good.
let expiresAt = 0;
let inFlight: Promise<void> | null = null;

// Privy's access token comes from a React hook, so App.tsx registers the getter
// here instead of this module reaching into Privy itself.
type PrivyTokenProvider = () => Promise<string | null>;
let privyToken: PrivyTokenProvider | null = null;

export function setPrivyTokenProvider(provider: PrivyTokenProvider | null): void {
  privyToken = provider;
  // A different user (or a logout) must not inherit the previous session.
  expiresAt = 0;
}

async function createSession(): Promise<void> {
  if (!privyToken) throw new Error("not logged in — sign in with Google before sending a UserOperation");
  const identity = await privyToken();
  if (!identity) throw new Error("Privy returned no access token — sign in with Google again");

  let res: Response;
  try {
    res = await fetch(SESSION_ENDPOINT, {
      method: "POST",
      credentials: CREDENTIALS,
      // A header, not a cookie: this is the one call that proves identity, and a
      // header cannot be replayed by a cross-site request.
      headers: { authorization: `Bearer ${identity}` },
    });
  } catch {
    // No response at all: nothing is proxying /api on this origin.
    throw new Error(BACKEND_DOWN);
  }

  // token-server.mjs always answers with JSON, including on error. A non-JSON
  // body therefore means we never reached it — the proxy failed, or something
  // else is serving this origin (e.g. another dev server on the same port).
  const body = await res.text();
  let data: { authenticated?: boolean; expires_at?: number; error?: string };
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error(`${BACKEND_DOWN} (got a non-JSON ${res.status} response)`);
  }

  if (!res.ok || !data.authenticated) {
    // Real backend errors carry `error` — missing env, or Keycloak's own reason.
    throw new Error(data.error || `session backend returned ${res.status} without a session`);
  }

  // Renew 30s early; fall back to a short window if the backend sent no expiry.
  const ttlMs = data.expires_at ? data.expires_at - Date.now() : 60_000;
  expiresAt = Date.now() + Math.max(ttlMs - 30_000, 5_000);
}

/** Ensures the HttpOnly session cookie is set (and fresh) before a write call. */
export async function ensureSession(forceRefresh = false): Promise<void> {
  if (!forceRefresh && Date.now() < expiresAt) return;
  if (!inFlight) {
    inFlight = createSession().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

/** Drops the local expiry hint and asks the backend to clear the cookie. */
export async function endSession(): Promise<void> {
  expiresAt = 0;
  await fetch(SESSION_ENDPOINT, { method: "DELETE", credentials: CREDENTIALS }).catch(() => {});
}
