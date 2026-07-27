"use strict";

const { createRemoteJWKSet, jwtVerify } = require("jose");

// Extracts a Bearer token from an incoming HTTP request's Authorization header.
function bearerToken(req) {
  const header = req.headers["authorization"] || req.headers["Authorization"];
  if (!header || typeof header !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

// Builds a Keycloak JWT authenticator. When auth is disabled it returns a
// no-op verifier so the caller can stay agnostic. Validation is fully offline:
// the access token signature is checked against the realm JWKS (cached by jose),
// then issuer / expiry / (optional) audience / (optional) azp are enforced.
function createAuthenticator(auth) {
  if (!auth || !auth.enabled) {
    return {
      enabled: false,
      async verifyRequest() {
        throw new Error("authentication is disabled");
      },
    };
  }

  if (!auth.issuer) throw new Error("Keycloak auth enabled but issuer is missing");
  if (!auth.jwksUri) throw new Error("Keycloak auth enabled but jwksUri is missing");

  const jwks = createRemoteJWKSet(new URL(auth.jwksUri));

  // Collect the token's roles from both the realm (`realm_access.roles`) and the
  // configured client (`resource_access[clientId].roles`), so `bundler-writer`
  // works whether it's defined as a realm role or a client role.
  function tokenRoles(payload) {
    const roles = new Set();
    for (const r of payload.realm_access?.roles || []) roles.add(r);
    if (auth.clientId) {
      for (const r of payload.resource_access?.[auth.clientId]?.roles || []) roles.add(r);
    }
    return roles;
  }

  async function verifyRequest(req) {
    const token = bearerToken(req);
    if (!token) {
      throw new Error("missing bearer token: send 'Authorization: Bearer <access_token>'");
    }

    let payload;
    try {
      ({ payload } = await jwtVerify(token, jwks, {
        issuer: auth.issuer,
        audience: auth.audience || undefined,
        algorithms: ["RS256"],
      }));
    } catch (err) {
      throw new Error(`invalid token: ${err.code || err.message}`);
    }

    // Keycloak stamps the authorized party (client id) in `azp`. When a client
    // id is configured, reject tokens issued to any other client.
    if (auth.clientId && payload.azp && payload.azp !== auth.clientId) {
      throw new Error(`token azp '${payload.azp}' is not the allowed client '${auth.clientId}'`);
    }

    // Enforce a required role (e.g. bundler-writer) when configured.
    if (auth.requiredRole && !tokenRoles(payload).has(auth.requiredRole)) {
      throw new Error(`token missing required role '${auth.requiredRole}'`);
    }

    return payload;
  }

  return { enabled: true, verifyRequest };
}

module.exports = { createAuthenticator, bearerToken };
