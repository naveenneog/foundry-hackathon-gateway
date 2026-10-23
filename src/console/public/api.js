// Key Dashboard — the only module that talks to the server. No DOM, so Node tests import it.
//
// Every request is same-origin with credentials; every state change is a POST with a JSON body
// (the server refuses anything else, ADR-0013). Redirects are not followed: the API never
// redirects, so a redirect means the platform sign-in has expired and wants the login page.
// Key values (GET /api/keys/{name}) are never cached; lists and usage are cached briefly so
// switching views does not re-query, and nothing is ever polled.

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
  get signedOut() {
    return this.status === 401;
  }
}

const MESSAGES = {
  0: "The dashboard could not reach the server. Check the connection, then try again.",
  401: "Your session has ended. Sign in again.",
  403: "Your role does not allow this.",
  404: "Not found.",
  409: "That conflicts with the current state. Refresh and try again.",
  413: "That request is too large.",
  429: "Too many requests. Wait a moment, then try again.",
  502: "Azure did not answer as expected. Try again shortly.",
  503: "The service is unavailable. Try again shortly.",
};

const MAX_MESSAGE = 400;

export async function request(method, path, body) {
  if (typeof path !== "string" || !path.startsWith("/api/")) throw new Error("Only same-origin API paths are requested.");
  const init = { method, credentials: "same-origin", redirect: "manual", cache: "no-store", headers: { Accept: "application/json" } };
  if (method !== "GET") {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body ?? {});
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, MESSAGES[0]);
  }
  if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) throw new ApiError(401, MESSAGES[401]);
  let data = null;
  try {
    const text = await res.text();
    data = text ? JSON.parse(text) : {};
  } catch {
    data = null;
  }
  if (!res.ok) {
    const own = typeof data?.error === "string" && data.error.trim() ? data.error.trim().slice(0, MAX_MESSAGE) : null;
    throw new ApiError(res.status, res.status === 401 ? MESSAGES[401] : own ?? MESSAGES[res.status] ?? `Request failed (${res.status}).`);
  }
  if (data === null || typeof data !== "object") throw new ApiError(res.status, "The server sent an unexpected response.");
  return data;
}

export const get = (path) => request("GET", path);
export const post = (path, body = {}) => request("POST", path, body);

/** Builds `/api/...?a=1&b=2`, encoding every value. */
export function apiPath(path, params = {}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

export const keyPath = (name, action) => `/api/keys/${encodeURIComponent(name)}${action ? `/${action}` : ""}`;

/** Reveals a key's value and client setup. Deliberately uncached; only secret.js calls this. */
export const fetchSecret = (name) => get(keyPath(name));

// ── Short-lived read cache ─────────────────────────────────────────────────

const cache = new Map();
const CACHEABLE = [/^\/api\/(config|models|bundle-key)$/, /^\/api\/keys\?/, /^\/api\/usage(\?|\/[A-Za-z0-9-]+\?)/];

export function isCacheable(path) {
  return CACHEABLE.some((re) => re.test(path));
}

/**
 * GET through a cache: `ttl` in ms (Infinity = for this page load), `fresh` to bypass it.
 * Concurrent callers share one request; a failed request is not remembered.
 */
export function cachedGet(path, { ttl = 60_000, fresh = false } = {}) {
  if (!isCacheable(path)) throw new Error(`Never cached: ${path}`);
  const hit = cache.get(path);
  if (!fresh && hit && (hit.pending || Date.now() - hit.at < ttl)) return hit.promise;
  const entry = { at: Date.now(), pending: true, promise: null };
  entry.promise = get(path).then(
    (data) => {
      entry.pending = false;
      entry.at = Date.now();
      return data;
    },
    (error) => {
      if (cache.get(path) === entry) cache.delete(path);
      throw error;
    },
  );
  cache.set(path, entry);
  return entry.promise;
}

/** Drops cached reads whose path starts with any prefix (no prefix drops everything). */
export function invalidate(...prefixes) {
  for (const key of [...cache.keys()]) if (!prefixes.length || prefixes.some((p) => key.startsWith(p))) cache.delete(key);
}
