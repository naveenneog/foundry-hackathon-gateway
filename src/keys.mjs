/**
 * Key minting and verification.
 *
 * A "key" here is a compact HS256 JWS. We implement it directly on node:crypto rather than
 * pulling in a JWT library, for three reasons:
 *   1. zero dependencies means nothing to audit, patch or vendor at an event;
 *   2. the verification rules are the security boundary, so they should be readable in full;
 *   3. APIM's validate-jwt is the real enforcement point — this module must agree with it
 *      exactly, and the easiest way to guarantee that is to keep it small.
 *
 * Deliberate scope limit: verifyKey proves *authenticity* only. Whether a key is currently
 * usable — window, model, budget — is entitlement.decide()'s job. Keeping these apart means an
 * expired key reports "expired" instead of a baffling "invalid signature".
 */

import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";

export class KeyError extends Error {
  constructor(message) {
    super(message);
    this.name = "KeyError";
  }
}

export const ISSUER = "foundry-hackathon-gateway";
export const AUDIENCE = "hackathon-gateway";
const ALG = "HS256";

/**
 * Minimum decoded key material for HS256, in bytes.
 * Enforced on the DECODED bytes, not the string length, so a short passphrase cannot slip through.
 */
const MIN_KEY_BYTES = 32;

/** Standard Base64 only — no base64url. APIM's <key> element is Base64-decoded. */
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

const b64url = (buf) => Buffer.from(buf).toString("base64url");
const fromB64url = (s) => Buffer.from(s, "base64url");

/**
 * Turn the stored secret into the HMAC key, exactly as APIM does.
 *
 * This is the single most dangerous line in the project. APIM's validate-jwt documents that a
 * symmetric key "must be provided inline within the policy in the Base64-encoded form" — it
 * Base64-DECODES the named value and uses those bytes as the key. If we signed with the ASCII
 * bytes of the same string instead, every signature would mismatch and the gateway would reject
 * every key it ever issued.
 *
 * That failure is closed (nothing is granted), but it disables the only authentication control,
 * and it looks intermittent rather than broken, so it is easy to misdiagnose under pressure.
 * See ADR-0005.
 */
function keyMaterial(secret) {
  if (typeof secret !== "string" || secret.trim() === "") {
    throw new KeyError("Signing secret is missing.");
  }
  if (!BASE64_RE.test(secret)) {
    throw new KeyError(
      "Signing secret must be standard Base64 (A-Z a-z 0-9 + / =). " +
      "It is key material, not a passphrase — generate it with generateSecret()."
    );
  }
  const bytes = Buffer.from(secret, "base64");
  if (bytes.length < MIN_KEY_BYTES) {
    throw new KeyError(
      `Signing secret must decode to at least ${MIN_KEY_BYTES} bytes, got ${bytes.length}.`
    );
  }
  return bytes;
}

const sign = (input, secret) =>
  createHmac("sha256", keyMaterial(secret)).update(input).digest();

/**
 * Compare two buffers without leaking their contents through timing.
 * timingSafeEqual throws on a length mismatch, so guard that first.
 */
const safeEqual = (a, b) => a.length === b.length && timingSafeEqual(a, b);

/**
 * Mint a participant key.
 * @returns {{token: string, jti: string, claims: object}}
 */
export function mintKey({
  secret,
  subject,
  models,
  budget,
  notBefore,
  expiresAt,
  audience = AUDIENCE,
  issuer = ISSUER,
  label,
}) {
  // Validates shape and length, and throws a KeyError explaining the fix if either is wrong.
  keyMaterial(secret);

  if (typeof subject !== "string" || subject.trim() === "") {
    throw new KeyError("A subject (participant or team id) is required.");
  }
  if (!Array.isArray(models) || models.length === 0) {
    throw new KeyError("At least one model must be granted.");
  }
  if (typeof budget !== "number" || !Number.isFinite(budget) || budget <= 0) {
    throw new KeyError("Budget must be a positive number of tokens.");
  }
  if (!Number.isFinite(notBefore) || !Number.isFinite(expiresAt)) {
    throw new KeyError("notBefore and expiresAt must be epoch milliseconds.");
  }
  if (expiresAt <= notBefore) {
    throw new KeyError("The access window must end after it starts.");
  }

  const jti = `k_${randomBytes(8).toString("hex")}`;

  const claims = {
    iss: issuer,
    aud: audience,
    sub: subject.trim(),
    jti,
    iat: Math.floor(Date.now() / 1000),
    // RFC 7519 requires NumericDate — seconds, not milliseconds. APIM's validate-jwt
    // reads exp the same way; getting this wrong yields keys that never expire.
    nbf: Math.floor(notBefore / 1000),
    exp: Math.floor(expiresAt / 1000),
    models: models.map((m) => String(m).trim().toLowerCase()).join(","),
    budget,
    ...(label ? { label } : {}),
  };

  const header = { alg: ALG, typ: "JWT" };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const token = `${signingInput}.${b64url(sign(signingInput, secret))}`;

  return { token, jti, claims };
}

/**
 * Read the claims WITHOUT verifying the signature.
 * For display and diagnostics only — never for an access decision.
 */
export function decodeUnsafe(token) {
  if (typeof token !== "string") throw new KeyError("Token must be a string.");
  const parts = token.split(".");
  if (parts.length !== 3) throw new KeyError("Token is not a compact JWS.");
  try {
    return JSON.parse(fromB64url(parts[1]).toString("utf8"));
  } catch {
    throw new KeyError("Token payload is not valid JSON.");
  }
}

/**
 * Verify authenticity and return a grant shaped for entitlement.decide().
 * Throws KeyError on anything suspicious.
 */
export function verifyKey(token, secret, { audience = AUDIENCE, issuer = ISSUER } = {}) {
  // Throws if the secret is not decodable Base64 key material of sufficient length.
  keyMaterial(secret);

  if (typeof token !== "string" || token.trim() === "") {
    throw new KeyError("No token supplied.");
  }

  const parts = token.split(".");
  if (parts.length !== 3) throw new KeyError("Token is not a compact JWS.");
  const [headerB64, payloadB64, signatureB64] = parts;

  let header;
  try {
    header = JSON.parse(fromB64url(headerB64).toString("utf8"));
  } catch {
    throw new KeyError("Token header is not valid JSON.");
  }

  // Pin the algorithm. Accepting whatever the header claims is how alg:none and
  // algorithm-confusion attacks work.
  if (header?.alg !== ALG) {
    throw new KeyError(`Unexpected token algorithm: ${header?.alg}. Only ${ALG} is accepted.`);
  }

  const expected = sign(`${headerB64}.${payloadB64}`, secret);
  let actual;
  try {
    actual = fromB64url(signatureB64);
  } catch {
    throw new KeyError("Token signature is not valid base64url.");
  }
  if (!safeEqual(expected, actual)) throw new KeyError("Token signature does not match.");

  let claims;
  try {
    claims = JSON.parse(fromB64url(payloadB64).toString("utf8"));
  } catch {
    throw new KeyError("Token payload is not valid JSON.");
  }

  if (claims.iss !== issuer) throw new KeyError("Token was issued by a different issuer.");
  if (claims.aud !== audience) throw new KeyError("Token is for a different audience.");
  if (typeof claims.sub !== "string" || claims.sub === "") {
    throw new KeyError("Token has no subject.");
  }
  if (typeof claims.models !== "string") throw new KeyError("Token has no model grant.");
  if (typeof claims.budget !== "number") throw new KeyError("Token has no budget.");
  if (typeof claims.exp !== "number") throw new KeyError("Token has no expiry.");

  return {
    sub: claims.sub,
    jti: claims.jti,
    label: claims.label,
    models: claims.models.split(",").map((m) => m.trim()).filter(Boolean),
    budget: claims.budget,
    // Back to milliseconds, which is what the decision engine and JS dates use.
    notBefore: typeof claims.nbf === "number" ? claims.nbf * 1000 : undefined,
    expiresAt: claims.exp * 1000,
  };
}

/**
 * Generate a signing secret.
 *
 * Standard, padded Base64 — NOT base64url. APIM Base64-decodes the <key> named value, so the
 * stored form must be decodable by a standard decoder. An earlier version substituted `-` and `_`
 * for `+` and `/`, which produced a value APIM could decode only about a quarter of the time,
 * making the gateway's behaviour depend on which random bytes happened to be drawn.
 */
export function generateSecret() {
  return randomBytes(32).toString("base64");
}
