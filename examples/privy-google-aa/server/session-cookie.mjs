// The HttpOnly session cookie.
//
// The cookie carries the Keycloak access token plus the Privy subject it was
// issued to, HMAC-signed so the backend can trust that pairing: without the MAC,
// anyone able to reach this server could hand-craft a cookie claiming a different
// `sub` and pollute the audit trail (or, later, dodge a per-user rate limit).
//
// It is a *session* cookie — no Max-Age, no Expires — so browsers keep it in
// memory only and never write the token to the cookie database on disk. Its real
// lifetime comes from the `exp` inside the payload, which the backend enforces.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Treat a token as gone slightly before it really expires, so the frontend
// re-establishes the session instead of racing the bundler.
const EXPIRY_SKEW_MS = 5_000;

export function createSessionCodec({ name, path = "/api", sameSite = "Strict", secure = false, secret, now = () => Date.now() }) {
  // A per-boot random key is fine here: a restart simply invalidates old cookies,
  // and the frontend re-creates the session on the first 401.
  const key = secret ? Buffer.from(secret) : randomBytes(32);

  function mac(payloadB64) {
    return createHmac("sha256", key).update(payloadB64).digest("base64url");
  }

  function attributes(extra) {
    const attrs = [`${name}=${extra.value}`, "HttpOnly", `Path=${path}`, `SameSite=${sameSite}`];
    if (secure) attrs.push("Secure");
    if (extra.expire) attrs.push("Max-Age=0");
    return attrs.join("; ");
  }

  /** @param {{accessToken: string, sub: string, expiresAt: number}} session */
  function serialize(session) {
    const payload = Buffer.from(
      JSON.stringify({ at: session.accessToken, sub: session.sub, exp: session.expiresAt }),
    ).toString("base64url");
    return attributes({ value: `${payload}.${mac(payload)}` });
  }

  function clear() {
    return attributes({ value: "", expire: true });
  }

  /** @returns {{accessToken: string, sub: string, expiresAt: number}|null} */
  function parse(cookieHeader) {
    const raw = readCookie(cookieHeader, name);
    if (!raw) return null;

    const split = raw.lastIndexOf(".");
    if (split < 1) return null;
    const payloadB64 = raw.slice(0, split);
    const provided = Buffer.from(raw.slice(split + 1), "base64url");
    const expected = Buffer.from(mac(payloadB64), "base64url");
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;

    let payload;
    try {
      payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    } catch {
      return null;
    }
    if (!payload?.at || !payload?.sub) return null;
    if (typeof payload.exp === "number" && now() + EXPIRY_SKEW_MS >= payload.exp) return null;
    return { accessToken: payload.at, sub: payload.sub, expiresAt: payload.exp ?? null };
  }

  return { serialize, clear, parse, cookieName: name };
}

function readCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return null;
}
