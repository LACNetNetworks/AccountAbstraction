// Minimal token backend for the Privy AA example.
//
// The browser must send a Keycloak access token to the (JWT-protected) bundler,
// but the NAAS client secret and the user password must never live in the
// browser. This server does the Keycloak login server-side with credentials
// from .env and hands only a short-lived access token to the frontend.
//
// Run with:  node --env-file=.env server/token-server.mjs
// (the Vite dev server proxies /api -> this server; see vite.config.ts)

import { createServer } from "node:http";

const {
  KEYCLOAK_URL = "https://auth.l-net.io",
  KEYCLOAK_REALM = "naas-realm",
  KEYCLOAK_CLIENT_ID = "naas-client",
  KEYCLOAK_CLIENT_SECRET = "",
  NAAS_USERNAME = "",
  NAAS_PASSWORD = "",
  TOKEN_SERVER_HOST = "127.0.0.1",
  TOKEN_SERVER_PORT = "8787",
  // Origins allowed to read /api/token cross-origin. Empty by default: the Vite
  // proxy makes the call same-origin, so no CORS is needed at all. Set this only
  // if the frontend points VITE_TOKEN_ENDPOINT straight at this server.
  TOKEN_ALLOWED_ORIGINS = "",
} = process.env;

const ALLOWED_ORIGINS = new Set(
  TOKEN_ALLOWED_ORIGINS.split(",")
    .map((o) => o.trim())
    .filter(Boolean),
);

const TOKEN_URL = `${KEYCLOAK_URL.replace(/\/+$/, "")}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/token`;

// Cache the token in memory and refresh it shortly before it expires so the
// frontend can call /api/token freely without hammering Keycloak.
let cache = { accessToken: null, expiresAt: 0 };

function missingConfig() {
  const missing = [];
  if (!KEYCLOAK_CLIENT_SECRET) missing.push("KEYCLOAK_CLIENT_SECRET");
  if (!NAAS_USERNAME) missing.push("NAAS_USERNAME");
  if (!NAAS_PASSWORD) missing.push("NAAS_PASSWORD");
  return missing;
}

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

// This endpoint mints a real bearer token and has no authentication, so the only
// thing standing between it and a malicious page is the checks below. Listening on
// loopback is NOT one of them: the attack comes from the victim's own browser,
// which reaches 127.0.0.1 just fine.

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function hostnameOf(hostHeader) {
  if (!hostHeader) return null;
  // IPv6 authorities are bracketed: [::1]:8787
  if (hostHeader.startsWith("[")) return hostHeader.slice(0, hostHeader.indexOf("]") + 1);
  return hostHeader.split(":")[0];
}

// Blocks DNS rebinding: a page on evil.com whose DNS resolves to 127.0.0.1 still
// sends `Host: evil.com`, and its requests count as same-origin to itself, so
// Sec-Fetch-Site would happily say "same-origin". The Host is the reliable signal.
function hostAllowed(req) {
  return LOOPBACK_HOSTNAMES.has(hostnameOf(req.headers.host));
}

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // curl/scripts: no ambient credentials, nothing to steal via CSRF
  if (ALLOWED_ORIGINS.has(origin)) return true;
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

// Browsers always send Sec-Fetch-Site; its absence means a non-browser client.
function crossSite(req) {
  return req.headers["sec-fetch-site"] === "cross-site";
}

// Echo CORS only for origins explicitly allowlisted via env — never a wildcard,
// which is what let any page read the token.
function corsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin || !ALLOWED_ORIGINS.has(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST,OPTIONS",
    "access-control-allow-headers": "content-type",
    vary: "Origin",
  };
}

function json(res, status, payload, req) {
  const bodyText = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    ...(req ? corsHeaders(req) : {}),
  });
  res.end(bodyText);
}

const server = createServer(async (req, res) => {
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

  if (req.method === "GET" && req.url === "/api/health") {
    json(res, 200, { ok: true, issuer: `${KEYCLOAK_URL.replace(/\/+$/, "")}/realms/${KEYCLOAK_REALM}`, user: NAAS_USERNAME || null }, req);
    return;
  }

  if (req.url === "/api/token") {
    // POST only. A GET is a "simple" request that needs no preflight, which made
    // the token trivially fetchable from another page.
    if (req.method !== "POST") {
      json(res, 405, { error: "use POST" }, req);
      return;
    }
    const missing = missingConfig();
    if (missing.length) {
      json(res, 500, { error: `missing env: ${missing.join(", ")}` }, req);
      return;
    }
    try {
      const { accessToken, expiresIn } = await fetchToken();
      json(res, 200, { access_token: accessToken, token_type: "Bearer", expires_in: expiresIn }, req);
    } catch (err) {
      json(res, err.status || 502, { error: err.message }, req);
    }
    return;
  }

  json(res, 404, { error: "not found" }, req);
});

server.listen(Number(TOKEN_SERVER_PORT), TOKEN_SERVER_HOST, () => {
  const cfgMissing = missingConfig();
  console.log(`token backend listening on http://${TOKEN_SERVER_HOST}:${TOKEN_SERVER_PORT}`);
  console.log(`keycloak=${TOKEN_URL} client=${KEYCLOAK_CLIENT_ID} user=${NAAS_USERNAME || "(unset)"}`);
  console.log(`cors=${ALLOWED_ORIGINS.size ? [...ALLOWED_ORIGINS].join(",") : "(none — same-origin via the Vite proxy)"}`);
  if (!LOOPBACK_HOSTNAMES.has(TOKEN_SERVER_HOST)) {
    console.warn(`WARNING: TOKEN_SERVER_HOST=${TOKEN_SERVER_HOST} is not loopback — this server mints tokens without authentication and must not be exposed`);
  }
  if (cfgMissing.length) {
    console.warn(`WARNING: missing env (${cfgMissing.join(", ")}) — /api/token will return 500 until set`);
  }
});
