// Verifies Privy access tokens so the session backend can tell *which* logged-in
// user is asking for a bundler write, instead of trusting "whatever code runs on
// this origin".
//
// Privy signs its access tokens with ES256 and publishes the public keys as a
// JWKS, so verification is offline and needs no Privy app secret — only the
// public app id, which the browser already has.

import { createPublicKey, timingSafeEqual, verify as verifySignature } from "node:crypto";

export class AuthError extends Error {
  constructor(message) {
    super(message);
    this.status = 401;
  }
}

const PRIVY_ISSUER = "privy.io";
// Tolerate a small clock difference between this machine and Privy.
const CLOCK_SKEW_SEC = 30;
// Never refetch the JWKS more often than this, so an unknown `kid` (or a flood of
// forged tokens carrying random kids) cannot turn into a request amplifier.
const JWKS_MIN_REFETCH_MS = 30_000;
const JWKS_TTL_MS = 10 * 60_000;

function decodeSegment(segment) {
  return Buffer.from(segment, "base64url");
}

function parseJson(buffer, what) {
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    throw new AuthError(`privy token has an unreadable ${what}`);
  }
}

export function createPrivyVerifier({ appId, jwksUrl, fetchImpl = fetch, now = () => Date.now() }) {
  if (!appId) throw new Error("createPrivyVerifier requires appId");
  const url = jwksUrl || `https://auth.privy.io/api/v1/apps/${appId}/jwks.json`;

  let keys = new Map();
  let fetchedAt = 0;
  let inFlight = null;

  async function loadJwks() {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      let res;
      try {
        res = await fetchImpl(url);
      } catch (err) {
        throw new AuthError(`cannot reach the Privy JWKS at ${url}: ${err.message}`);
      }
      if (!res.ok) throw new AuthError(`Privy JWKS returned ${res.status}`);
      const body = await res.json().catch(() => null);
      if (!body || !Array.isArray(body.keys)) throw new AuthError("Privy JWKS has no keys");
      const next = new Map();
      for (const jwk of body.keys) {
        if (!jwk.kid) continue;
        try {
          next.set(jwk.kid, createPublicKey({ key: jwk, format: "jwk" }));
        } catch {
          // Skip keys this Node build cannot import rather than failing the set.
        }
      }
      if (!next.size) throw new AuthError("Privy JWKS has no usable keys");
      keys = next;
      fetchedAt = now();
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  async function keyFor(kid) {
    const stale = now() - fetchedAt > JWKS_TTL_MS;
    if (!keys.size || stale) await loadJwks();
    let key = keys.get(kid);
    if (!key && now() - fetchedAt > JWKS_MIN_REFETCH_MS) {
      // Privy rotated keys since the last fetch.
      await loadJwks();
      key = keys.get(kid);
    }
    if (!key) throw new AuthError(`privy token signed with an unknown key (kid=${kid})`);
    return key;
  }

  /**
   * @param {string|undefined} authorization value of the Authorization header
   * @returns {Promise<{sub: string, sid?: string, expiresAt: number}>}
   */
  async function verify(authorization) {
    const match = /^Bearer\s+(.+)$/i.exec(authorization || "");
    if (!match) throw new AuthError("missing Privy access token — log in with Google first");

    const parts = match[1].trim().split(".");
    if (parts.length !== 3) throw new AuthError("privy token is not a JWT");

    const header = parseJson(decodeSegment(parts[0]), "header");
    // Pinning the algorithm is what stops `alg: none` and HMAC-confusion attacks.
    if (header.alg !== "ES256") throw new AuthError(`privy token alg must be ES256, got ${header.alg}`);
    if (!header.kid) throw new AuthError("privy token has no kid");

    const key = await keyFor(header.kid);
    const signature = decodeSegment(parts[2]);
    // JWS ES256 signatures are raw r||s, not DER — hence ieee-p1363.
    const ok = verifySignature(
      "sha256",
      Buffer.from(`${parts[0]}.${parts[1]}`),
      { key, dsaEncoding: "ieee-p1363" },
      signature,
    );
    if (!ok) throw new AuthError("privy token signature is invalid");

    const claims = parseJson(decodeSegment(parts[1]), "payload");
    const nowSec = Math.floor(now() / 1000);
    if (claims.iss !== PRIVY_ISSUER) throw new AuthError(`privy token issuer must be ${PRIVY_ISSUER}`);
    // Without the audience check, a token minted for any other Privy app would pass.
    if (!audienceMatches(claims.aud, appId)) throw new AuthError("privy token audience is not this app id");
    if (typeof claims.exp !== "number" || nowSec - CLOCK_SKEW_SEC >= claims.exp) throw new AuthError("privy token is expired");
    if (typeof claims.nbf === "number" && nowSec + CLOCK_SKEW_SEC < claims.nbf) throw new AuthError("privy token is not valid yet");
    if (!claims.sub) throw new AuthError("privy token has no subject");

    return { sub: String(claims.sub), sid: claims.sid ? String(claims.sid) : undefined, expiresAt: claims.exp * 1000 };
  }

  return { verify, jwksUrl: url };
}

function audienceMatches(aud, appId) {
  const expected = Buffer.from(appId);
  const candidates = Array.isArray(aud) ? aud : [aud];
  return candidates.some((entry) => {
    if (typeof entry !== "string") return false;
    const actual = Buffer.from(entry);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  });
}
