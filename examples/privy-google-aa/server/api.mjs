// Session backend + policy-gated bundler proxy for the Privy AA example.
//
// This module is transport-agnostic: it exports one `handleApi(req, res)` request
// handler (plain Node http shapes) and never opens a port of its own. That is what
// lets a SINGLE service serve both the app and its API:
//
//   dev/preview -> mounted as Vite middleware (server/vite-api.mjs), so `/api/*`
//                  and the frontend share one origin and one port.
//   Vercel      -> mounted as the catch-all function `api/[...path].js`, so `/api/*`
//                  and the static build share one deployment and one domain.
//
// The browser must reach a (JWT-protected) bundler, but neither the NAAS client
// secret nor the user password may live in the browser — and neither may the
// access token itself.
//
// How it works:
//   POST /api/session   -> verifies the caller's **Privy** access token (so a
//                          session belongs to a logged-in Google user, not merely
//                          to "code running on this origin"), logs into Keycloak,
//                          and Set-Cookie's the access token as **HttpOnly**. Page
//                          JS cannot read it, so an XSS cannot exfiltrate it.
//   POST /api/bundler   -> reads the cookie the browser attached automatically,
//                          checks the UserOperation against the policy in
//                          userop-policy.mjs, and only then forwards it to the
//                          bundler with `Authorization: Bearer <token>`.
//
// The proxy is not optional: the bundler lives on another origin and expects a
// Bearer header, and an HttpOnly cookie is unreadable to fetch() on the page.
// Because the proxy carries privileged authority, it validates rather than relays.

import { fileURLToPath } from "node:url";
import { AuthError, createPrivyVerifier } from "./privy-auth.mjs";
import { createSessionCodec } from "./session-cookie.mjs";
import { PolicyError, createUserOpPolicy } from "./userop-policy.mjs";
import { createUserOpLog, outcomeFromReceipt } from "./userop-log.mjs";

// True on Vercel (and any platform that sets it): the process sits behind the
// platform's router on a real domain over HTTPS, not on loopback. It flips three
// defaults — Host allowlisting, cookie Secure, and where the write log lives.
const DEPLOYED = Boolean(process.env.VERCEL || process.env.DEPLOYED === "true");

const {
  KEYCLOAK_URL = "https://auth.l-net.io",
  KEYCLOAK_REALM = "naas-realm",
  KEYCLOAK_CLIENT_ID = "naas-client",
  KEYCLOAK_CLIENT_SECRET = "",
  NAAS_USERNAME = "",
  NAAS_PASSWORD = "",
  // Where /api/bundler forwards writes. Keep in sync with VITE_BUNDLER_URL.
  BUNDLER_URL = "https://bundler.l-net.io",
  // Extra origins allowed to use the session cross-origin. Empty by default: the
  // frontend is served by this same service, so its calls are same-origin and
  // need no CORS at all.
  TOKEN_ALLOWED_ORIGINS = "",
  // Cookie tuning. Same-origin means SameSite=Strict works everywhere; Secure is
  // implied once deployed (HTTPS). A cross-origin frontend needs
  // SameSite=None + Secure, which requires HTTPS on both sides.
  SESSION_COOKIE_NAME = "naas_session",
  SESSION_COOKIE_PATH = "/api",
  SESSION_COOKIE_SAMESITE = "Strict",
  SESSION_COOKIE_SECURE = "",
  // Optional: fixes cookie signing across restarts. Random per boot otherwise,
  // which just means old cookies stop validating after a restart. On serverless
  // each instance boots its own key, so set this to keep sessions working across
  // instances — otherwise every cold start forces one extra POST /api/session.
  SESSION_SECRET = "",
  // Privy identity. The app id is public (the browser has it too); no app secret
  // is needed because Privy publishes its signing keys as a JWKS.
  PRIVY_APP_ID = "",
  VITE_PRIVY_APP_ID = "",
  PRIVY_JWKS_URL = "",
  // Write policy. The VITE_* fallbacks let one .env drive both sides.
  ENTRYPOINT_ADDRESS = "",
  VITE_ENTRYPOINT_ADDRESS = "",
  FACTORY_ADDRESS = "",
  VITE_FACTORY_ADDRESS = "",
  // Contracts the UserOp may call. Defaults to the app's configured Storage;
  // `*` allows any target.
  ALLOWED_CALL_TARGETS = "",
  VITE_STORAGE_ADDRESS = "",
  // Function signatures the inner call may use; `*` allows any.
  ALLOWED_INNER_CALLS = "set(uint256)",
  // SQLite file holding the write log. Relative paths resolve from the server
  // directory, not the shell's cwd, so the log lands in the same place wherever
  // the dev server is started from. On a serverless platform the filesystem is
  // read-only except /tmp, so the default moves there — see HISTORY_DB_PATH.
  USEROP_LOG_DB = "",
  // How many entries GET /api/history returns by default.
  USEROP_LOG_LIMIT = "10",
} = process.env;

const privyAppId = PRIVY_APP_ID || VITE_PRIVY_APP_ID;
const entryPoint = ENTRYPOINT_ADDRESS || VITE_ENTRYPOINT_ADDRESS;
const factory = FACTORY_ADDRESS || VITE_FACTORY_ADDRESS;
const allowedTargets = list(ALLOWED_CALL_TARGETS || VITE_STORAGE_ADDRESS);
const allowedInnerCalls = list(ALLOWED_INNER_CALLS);

const ALLOWED_ORIGINS = new Set(list(TOKEN_ALLOWED_ORIGINS));

const TOKEN_URL = `${KEYCLOAK_URL.replace(/\/+$/, "")}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/token`;

const COOKIE_SAMESITE = SESSION_COOKIE_SAMESITE || "Strict";
// SameSite=None is meaningless (and rejected by browsers) without Secure; a
// deployed origin is HTTPS, so Secure is the default there.
const COOKIE_SECURE =
  SESSION_COOKIE_SECURE === "true" || COOKIE_SAMESITE.toLowerCase() === "none" || (DEPLOYED && SESSION_COOKIE_SECURE !== "false");

function list(value) {
  return (value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function missingConfig() {
  const missing = [];
  if (!KEYCLOAK_CLIENT_SECRET) missing.push("KEYCLOAK_CLIENT_SECRET");
  if (!NAAS_USERNAME) missing.push("NAAS_USERNAME");
  if (!NAAS_PASSWORD) missing.push("NAAS_PASSWORD");
  if (!privyAppId) missing.push("PRIVY_APP_ID (or VITE_PRIVY_APP_ID)");
  if (!entryPoint) missing.push("ENTRYPOINT_ADDRESS (or VITE_ENTRYPOINT_ADDRESS)");
  return missing;
}

const session = createSessionCodec({
  name: SESSION_COOKIE_NAME,
  path: SESSION_COOKIE_PATH,
  sameSite: COOKIE_SAMESITE,
  secure: COOKIE_SECURE,
  secret: SESSION_SECRET || undefined,
});

const HISTORY_LIMIT = Math.max(1, Number(USEROP_LOG_LIMIT) || 10);
const HISTORY_DB_PATH = historyDbPath();

function historyDbPath() {
  // Only /tmp is writable on a serverless instance, and it is per-instance and
  // wiped on cold start: the log is a convenience there, not durable storage.
  if (!USEROP_LOG_DB) return DEPLOYED ? "/tmp/userops.db" : fileURLToPath(new URL("userops.db", import.meta.url));
  return USEROP_LOG_DB.startsWith("/") ? USEROP_LOG_DB : fileURLToPath(new URL(USEROP_LOG_DB, import.meta.url));
}

// Built lazily so a missing/invalid address or an unavailable node:sqlite fails on
// the first request with a readable error instead of crashing at import time —
// which on serverless would take the whole function down, including the writes
// that do not need the log at all.
let privy = null;
let policy = null;
let log = null;

function privyVerifier() {
  if (!privy) privy = createPrivyVerifier({ appId: privyAppId, jwksUrl: PRIVY_JWKS_URL || undefined });
  return privy;
}

function writePolicy() {
  if (!policy) {
    policy = createUserOpPolicy({
      entryPoint,
      factory,
      allowedTargets,
      allowedInnerSignatures: allowedInnerCalls,
    });
  }
  return policy;
}

// A write must not fail because the audit log cannot open. node:sqlite needs
// Node >= 22.5 and a writable path; if either is missing, degrade to a log that
// records nothing and says so, rather than 500-ing every UserOperation.
function userOpLog() {
  if (!log) {
    try {
      log = createUserOpLog({ path: HISTORY_DB_PATH });
    } catch (err) {
      console.warn(`WARNING: write log disabled (${HISTORY_DB_PATH}): ${err.message}`);
      log = disabledLog(err.message);
    }
  }
  return log;
}

function disabledLog(reason) {
  return {
    path: HISTORY_DB_PATH,
    unavailable: reason,
    record: () => null,
    pending: () => [],
    settle: () => {},
    recent: () => [],
  };
}

// --- Keycloak ----------------------------------------------------------------

// Cache the Keycloak token in memory so repeated logins (page reloads, new tabs,
// cookie expiry) do not hammer Keycloak for a token that is still valid. The
// cache is per process, so a serverless instance warms up its own.
let cache = { accessToken: null, expiresAt: 0, expiresIn: 0 };

async function fetchToken() {
  const now = Date.now();
  if (cache.accessToken && now < cache.expiresAt) return cache;

  const body = new URLSearchParams({
    grant_type: "password",
    client_id: KEYCLOAK_CLIENT_ID,
    client_secret: KEYCLOAK_CLIENT_SECRET,
    username: NAAS_USERNAME,
    password: NAAS_PASSWORD,
    scope: "openid",
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    const reason = data.error_description || data.error || `token endpoint returned ${res.status}`;
    const err = new Error(reason);
    err.status = res.status || 502;
    throw err;
  }

  const ttlMs = Number(data.expires_in || 60) * 1000;
  cache = {
    accessToken: data.access_token,
    // Refresh 30s early (never negative).
    expiresAt: now + Math.max(ttlMs - 30_000, 5_000),
    expiresIn: Number(data.expires_in || 60),
  };
  return cache;
}

// The backend minted this token seconds ago, so the payload is trusted here; the
// signature check belongs to the bundler. Reading `exp` only lets us expire the
// session cookie in step with the token it carries.
function tokenExpiryMs(token) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return payload.exp ? Number(payload.exp) * 1000 : null;
  } catch {
    return null;
  }
}

// --- request guards ----------------------------------------------------------

// The session cookie is ambient credentials, so every request that can use it
// needs the CSRF checks below. Listening on loopback is NOT one of them: the
// attack comes from the victim's own browser, which reaches 127.0.0.1 just fine.
// SameSite=Strict already keeps the cookie off cross-site requests; these checks
// are the second layer.

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

// The authority the browser actually addressed. A platform router rewrites `Host`
// to its own internal value on some setups and puts the public one in
// `X-Forwarded-Host`, so that header is what the Origin must be compared against
// — but only when we know a trusted proxy is in front (deployed), since any
// client can invent the header otherwise.
function requestHost(req) {
  const forwarded = DEPLOYED ? String(req.headers["x-forwarded-host"] || "").split(",")[0].trim() : "";
  return forwarded || req.headers.host;
}

function hostnameOf(hostHeader) {
  if (!hostHeader) return null;
  // IPv6 authorities are bracketed: [::1]:5173
  if (hostHeader.startsWith("[")) return hostHeader.slice(0, hostHeader.indexOf("]") + 1);
  return hostHeader.split(":")[0];
}

// Blocks DNS rebinding against a local dev server: a page on evil.com whose DNS
// resolves to 127.0.0.1 still sends `Host: evil.com`, and its requests count as
// same-origin to itself, so both Sec-Fetch-Site and an Origin/Host comparison
// would happily agree. The Host is the reliable signal — but only when we know
// which hosts are legitimate. Deployed, the platform router decides that (the
// domain set can include preview URLs and custom domains we cannot enumerate),
// so the check applies to local runs, where the answer is exactly "loopback".
function hostAllowed(req) {
  if (DEPLOYED) return true;
  return LOOPBACK_HOSTNAMES.has(hostnameOf(requestHost(req)));
}

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // curl/scripts: no cookie jar, so nothing to ride on
  if (ALLOWED_ORIGINS.has(origin)) return true;
  try {
    const { hostname, host } = new URL(origin);
    // The frontend is served by this same service, so a legitimate browser call
    // is same-origin: its Origin authority equals the host it was sent to.
    if (host === requestHost(req)) return true;
    return !DEPLOYED && LOOPBACK_HOSTNAMES.has(hostname);
  } catch {
    return false;
  }
}

// Browsers always send Sec-Fetch-Site; its absence means a non-browser client.
function crossSite(req) {
  return req.headers["sec-fetch-site"] === "cross-site";
}

// Echo CORS only for origins explicitly allowlisted via env — never a wildcard,
// which is both useless and illegal with credentialed requests.
function corsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin || !ALLOWED_ORIGINS.has(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type,authorization",
    "access-control-allow-credentials": "true",
    vary: "Origin",
  };
}

function json(res, status, payload, req, extraHeaders) {
  const bodyText = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    // The session state is per-cookie and short-lived; never let it be cached.
    "cache-control": "no-store",
    ...(req ? corsHeaders(req) : {}),
    ...(extraHeaders || {}),
  });
  res.end(bodyText);
}

const MAX_BODY_BYTES = 1_000_000;

function readBody(req) {
  // Serverless adapters (including Vercel's) parse and attach the body before
  // the handler runs, which leaves the stream drained — reading it again would
  // hang or come back empty. Reuse what they parsed, and re-serialize the object
  // form so the bytes forwarded to the bundler stay valid JSON.
  if (req.body !== undefined && req.body !== null) {
    if (Buffer.isBuffer(req.body)) return Promise.resolve(req.body);
    if (typeof req.body === "string") return Promise.resolve(Buffer.from(req.body));
    return Promise.resolve(Buffer.from(JSON.stringify(req.body)));
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("request body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Keeps the audit line readable: did:privy:clxxxxx... is long and the tail is
// what distinguishes users.
function shortSub(sub) {
  return sub.length > 24 ? `${sub.slice(0, 12)}…${sub.slice(-6)}` : sub;
}

// --- routes ------------------------------------------------------------------

async function handleSession(req, res) {
  if (req.method === "GET") {
    const current = session.parse(req.headers.cookie);
    json(res, 200, { authenticated: Boolean(current), expires_at: current?.expiresAt ?? null, user: current?.sub ?? null }, req);
    return;
  }

  if (req.method === "DELETE") {
    json(res, 200, { authenticated: false }, req, { "set-cookie": session.clear() });
    return;
  }

  if (req.method !== "POST") {
    json(res, 405, { error: "use POST to create, GET to inspect, DELETE to end the session" }, req);
    return;
  }

  const missing = missingConfig();
  if (missing.length) {
    json(res, 500, { error: `missing env: ${missing.join(", ")}` }, req);
    return;
  }

  // Identity first: no valid Privy login, no session — and therefore no way to
  // reach the bundler through this backend at all.
  let identity;
  try {
    identity = await privyVerifier().verify(req.headers.authorization);
  } catch (err) {
    if (err instanceof AuthError) {
      json(res, err.status, { error: err.message }, req);
      return;
    }
    throw err;
  }

  try {
    const { accessToken } = await fetchToken();
    const expiresAt = tokenExpiryMs(accessToken) ?? Date.now() + 60_000;
    const cookie = session.serialize({ accessToken, sub: identity.sub, expiresAt });
    // Browsers cap a cookie at ~4KB; past that it is silently dropped and every
    // write then fails with no visible cause.
    if (cookie.length > 3800) {
      console.warn(`WARNING: session cookie is ${cookie.length} bytes — close to the 4KB browser limit`);
    }
    console.log(`session created user=${shortSub(identity.sub)}`);
    json(res, 200, { authenticated: true, expires_at: expiresAt, user: identity.sub }, req, { "set-cookie": cookie });
  } catch (err) {
    json(res, err.status || 502, { error: err.message }, req);
  }
}

async function handleBundler(req, res) {
  if (req.method !== "POST") {
    json(res, 405, { error: "use POST" }, req);
    return;
  }

  const current = session.parse(req.headers.cookie);
  if (!current) {
    // 401 is the frontend's signal to POST /api/session and retry.
    json(res, 401, { error: "no session — POST /api/session first" }, req);
    return;
  }

  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    json(res, err.status || 400, { error: err.message }, req);
    return;
  }

  let request;
  try {
    request = JSON.parse(body.toString("utf8"));
  } catch {
    json(res, 400, { error: "request body must be JSON" }, req);
    return;
  }

  let checked;
  try {
    checked = writePolicy().check(request);
  } catch (err) {
    if (err instanceof PolicyError) {
      console.warn(`policy REJECT user=${shortSub(current.sub)} reason=${err.message}`);
      // Rejected writes never reach the chain, so this log is the only record
      // they ever leave. The addresses come from an unvalidated body — they are
      // logged as claimed, not as verified facts.
      userOpLog().record({
        userSub: current.sub,
        status: "rejected",
        method: request?.method,
        sender: request?.params?.[0]?.sender,
        httpStatus: err.status,
        error: err.message,
      });
      json(res, err.status, { error: `rejected by policy: ${err.message}` }, req);
      return;
    }
    throw err;
  }

  let upstream;
  try {
    upstream = await fetch(BUNDLER_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${current.accessToken}` },
      body,
    });
  } catch (err) {
    userOpLog().record({
      userSub: current.sub,
      status: "failed",
      method: checked.method,
      sender: checked.sender,
      target: checked.target,
      owner: checked.owner,
      innerCall: checked.inner?.signature || checked.inner?.selector,
      storedValue: checked.inner?.value,
      httpStatus: 502,
      error: `bundler unreachable: ${err.message}`,
    });
    json(res, 502, { error: `bundler unreachable at ${BUNDLER_URL}: ${err.message}` }, req);
    return;
  }

  const text = await upstream.text();
  const answer = parseJson(text);
  userOpLog().record({
    userSub: current.sub,
    // The bundler answering 200 with a JSON-RPC error is still a rejected write.
    status: answer?.error || !upstream.ok ? "failed" : "sent",
    method: checked.method,
    userOpHash: typeof answer?.result === "string" ? answer.result : null,
    sender: checked.sender,
    target: checked.target,
    owner: checked.owner,
    innerCall: checked.inner?.signature || checked.inner?.selector,
    storedValue: checked.inner?.value,
    httpStatus: upstream.status,
    error: answer?.error ? answer.error.message || JSON.stringify(answer.error) : null,
  });
  console.log(
    `forward user=${shortSub(current.sub)} method=${checked.method} sender=${checked.sender} target=${checked.target} status=${upstream.status}`,
  );
  res.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") || "application/json",
    "cache-control": "no-store",
    ...corsHeaders(req),
  });
  res.end(text);
}

// A row is written when the write is forwarded, but the outcome only exists
// later, in the receipt. Reads need no token, so the backend settles pending rows
// itself rather than trusting the page to report how its own write turned out.
async function settlePending(limit) {
  await Promise.all(
    userOpLog()
      .pending(limit)
      .map(async ({ id, userOpHash }) => {
        try {
          const response = await fetch(BUNDLER_URL, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getUserOperationReceipt", params: [userOpHash] }),
          });
          const outcome = outcomeFromReceipt(parseJson(await response.text())?.result, userOpHash);
          if (outcome) userOpLog().settle(id, outcome);
        } catch {
          // Still pending as far as we know; the next read tries again.
        }
      }),
  );
}

async function handleHistory(req, res) {
  if (req.method !== "GET") {
    json(res, 405, { error: "use GET" }, req);
    return;
  }
  // The log names users and their accounts, so it lives behind the same session
  // as the writes it records.
  if (!session.parse(req.headers.cookie)) {
    json(res, 401, { error: "no session — POST /api/session first" }, req);
    return;
  }

  const requested = Number(new URL(req.url, "http://localhost").searchParams.get("limit"));
  const limit = Math.min(100, Math.max(1, Number.isFinite(requested) && requested > 0 ? requested : HISTORY_LIMIT));

  await settlePending(limit);
  const store = userOpLog();
  json(
    res,
    200,
    {
      entries: store.recent(limit),
      db: HISTORY_DB_PATH,
      // Set when the log could not be opened: the writes still go through, but
      // this list will stay empty, and the frontend should say why.
      unavailable: store.unavailable ?? null,
      // /tmp on serverless is per-instance and wiped on cold start.
      ephemeral: DEPLOYED && HISTORY_DB_PATH.startsWith("/tmp/"),
    },
    req,
  );
}

/**
 * Serves `/api/*`. Plain Node `(req, res)` shapes, so it works as Vite middleware,
 * as a Vercel function, and inside a bare `http.createServer`.
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {(err?: unknown) => void} [next] called for paths this backend does not
 *        own, so a host (Vite) can fall through to serving the frontend. Without
 *        it, unknown paths answer 404.
 */
export async function handleApi(req, res, next) {
  const path = (req.url || "").split("?")[0];

  if (!path.startsWith("/api")) {
    if (next) return next();
    json(res, 404, { error: "not found" }, req);
    return;
  }

  if (!hostAllowed(req)) {
    json(res, 421, { error: "unexpected Host — this server only answers on loopback" });
    return;
  }
  if (crossSite(req) || !originAllowed(req)) {
    json(res, 403, { error: "cross-origin requests are not allowed" });
    return;
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders(req));
    res.end();
    return;
  }

  if (req.method === "GET" && path === "/api/health") {
    json(
      res,
      200,
      {
        ok: true,
        mode: DEPLOYED ? "deployed" : "local",
        issuer: `${KEYCLOAK_URL.replace(/\/+$/, "")}/realms/${KEYCLOAK_REALM}`,
        user: NAAS_USERNAME || null,
        bundler: BUNDLER_URL,
        privy_app_id: privyAppId || null,
        policy: entryPoint ? writePolicy().describe() : null,
        missing_env: missingConfig(),
      },
      req,
    );
    return;
  }

  if (path === "/api/session") {
    await handleSession(req, res);
    return;
  }

  if (path === "/api/bundler") {
    await handleBundler(req, res);
    return;
  }

  if (path === "/api/history") {
    await handleHistory(req, res);
    return;
  }

  if (path === "/api/token") {
    // Deliberately gone: handing the token to page JS is exactly what the
    // HttpOnly-cookie strategy removes.
    json(res, 410, { error: "/api/token was removed — the token now lives in an HttpOnly cookie; use POST /api/session + POST /api/bundler" }, req);
    return;
  }

  json(res, 404, { error: "not found" }, req);
}

/** Errors must not leave a request hanging; the caller decides where they go. */
export function apiHandler({ onError } = {}) {
  return (req, res, next) =>
    handleApi(req, res, next).catch((err) => {
      if (onError) onError(err);
      else console.error(`api error: ${err?.stack || err}`);
      if (!res.headersSent) json(res, 500, { error: "internal error" }, req);
      else res.end();
    });
}

/** One-line summary of how this backend is configured, for a boot log. */
export function describeApi() {
  const lines = [
    `mode=${DEPLOYED ? "deployed (platform-routed, HTTPS)" : "local"}`,
    `keycloak=${TOKEN_URL} client=${KEYCLOAK_CLIENT_ID} user=${NAAS_USERNAME || "(unset)"}`,
    `bundler=${BUNDLER_URL}`,
    `privy app=${privyAppId || "(unset)"} jwks=${privyAppId ? privyVerifier().jwksUrl : "(n/a)"}`,
  ];
  if (entryPoint) {
    const described = writePolicy().describe();
    lines.push(
      `policy methods=${described.methods.join(",")} entryPoint=${described.entryPoint} targets=${
        described.targets === "*" ? "*" : described.targets.join(",") || "(none)"
      } innerCalls=${described.innerCalls === "*" ? "*" : described.innerCalls.join(",")}`,
    );
  }
  lines.push(
    `cookie=${SESSION_COOKIE_NAME} HttpOnly Path=${SESSION_COOKIE_PATH} SameSite=${COOKIE_SAMESITE}${COOKIE_SECURE ? " Secure" : ""} (session cookie — not stored on disk)`,
  );
  lines.push(`cors=${ALLOWED_ORIGINS.size ? [...ALLOWED_ORIGINS].join(",") : "(none — the frontend is same-origin)"}`);
  lines.push(`write log=${HISTORY_DB_PATH} (GET /api/history returns the last ${HISTORY_LIMIT})`);

  const warnings = [];
  if (ALLOWED_ORIGINS.size && COOKIE_SAMESITE.toLowerCase() !== "none") {
    warnings.push(
      `TOKEN_ALLOWED_ORIGINS is set but SameSite=${COOKIE_SAMESITE} — browsers will not send the session cookie cross-site (needs SESSION_COOKIE_SAMESITE=None + HTTPS)`,
    );
  }
  if (!allowedTargets.length) {
    warnings.push(
      "no ALLOWED_CALL_TARGETS and no VITE_STORAGE_ADDRESS — the policy accepts a UserOp calling ANY contract (the inner-call allowlist still applies). Set ALLOWED_CALL_TARGETS to lock this down.",
    );
  } else if (allowedTargets.includes("*")) {
    warnings.push("ALLOWED_CALL_TARGETS=* — the policy will accept a UserOp calling any contract");
  }
  if (DEPLOYED && !SESSION_SECRET) {
    warnings.push("no SESSION_SECRET — each serverless instance signs cookies with its own key, so sessions do not survive a cold start");
  }
  const cfgMissing = missingConfig();
  if (cfgMissing.length) warnings.push(`missing env (${cfgMissing.join(", ")}) — POST /api/session will return 500 until set`);

  return { lines, warnings };
}
