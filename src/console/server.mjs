/**
 * HTTP layer for the admin console: routing, authentication, role gates, CSRF defence, security
 * headers and error mapping. Business rules live in service.mjs; this file only translates.
 *
 * CSRF: every state change must be `application/json` (a cross-site form cannot send that without
 * a CORS preflight, which this server never approves) AND carry an Origin whose host equals the
 * request's Host. ADR-0013.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { parsePrincipal, roleOf, can } from "./auth.mjs";

const PUBLIC_DIR = fileURLToPath(new URL("./public/", import.meta.url));
const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/app.css": ["app.css", "text/css; charset=utf-8"],
  "/lib.js": ["lib.js", "text/javascript; charset=utf-8"],
  "/api.js": ["api.js", "text/javascript; charset=utf-8"],
  "/dom.js": ["dom.js", "text/javascript; charset=utf-8"],
  "/charts.js": ["charts.js", "text/javascript; charset=utf-8"],
  "/period.js": ["period.js", "text/javascript; charset=utf-8"],
  "/secret.js": ["secret.js", "text/javascript; charset=utf-8"],
  "/views-overview.js": ["views-overview.js", "text/javascript; charset=utf-8"],
  "/views-keys.js": ["views-keys.js", "text/javascript; charset=utf-8"],
  "/views-drawer.js": ["views-drawer.js", "text/javascript; charset=utf-8"],
  "/views-issue.js": ["views-issue.js", "text/javascript; charset=utf-8"],
  "/views-admin.js": ["views-admin.js", "text/javascript; charset=utf-8"],
  "/foundry.js": ["foundry.js", "text/javascript; charset=utf-8"],
  "/foundry-picker.js": ["foundry-picker.js", "text/javascript; charset=utf-8"],
  "/foundry-connect.js": ["foundry-connect.js", "text/javascript; charset=utf-8"],
  "/views-foundry.js": ["views-foundry.js", "text/javascript; charset=utf-8"],
  "/help.js": ["help.js", "text/javascript; charset=utf-8"],
};
const MAX_BODY = 64 * 1024;
const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
    "object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
  "Strict-Transport-Security": "max-age=31536000",
  "Cross-Origin-Opener-Policy": "same-origin",
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const NAME = "([A-Za-z0-9-]{1,127})";
/** A usage period from the query string: days, or from and to (P59). The service validates them. */
const periodOf = (q) => ({ days: q.get("days") ?? undefined, from: q.get("from") ?? undefined, to: q.get("to") ?? undefined });
/** [method, pattern, action for can(), handler(ctx)] — action "open" skips authentication. */
const routes = [
  ["GET", /^\/healthz$/, "open", () => ({ status: 200, body: { ok: true } })],
  ["GET", /^\/api\/me$/, "read-own", ({ actor }) => ({ body: { name: actor.name, role: actor.role } })],
  ["GET", /^\/api\/config$/, "read-own", ({ service, q }) => service.config({ foundryId: q.get("foundryId") ?? undefined })],
  ["GET", /^\/api\/keys$/, "read-own", async ({ service, actor, q }) => ({ keys: await service.listKeys(actor, { kind: q.get("kind") ?? undefined, status: q.get("status") ?? "active" }) })],
  ["GET", new RegExp(`^/api/keys/${NAME}$`), "read-own", ({ service, actor, m }) => service.revealKey(actor, m[1])],
  ["GET", /^\/api\/bundle-key$/, "read-own", ({ service }) => service.bundlePublicKey()],
  ["GET", /^\/api\/signing$/, "sync-secret", ({ service, actor }) => service.signingStatus(actor)],
  ["POST", /^\/api\/signing\/migrate$/, "sync-secret", ({ service, actor }) => service.migrateSigningSecret(actor)],
  ["POST", /^\/api\/signing\/push$/, "sync-secret", ({ service, actor, body }) => service.pushSigningSecret(actor, body)],
  ["POST", /^\/api\/signing\/rotate$/, "sync-secret", ({ service, actor, body }) => service.rotateSigningSecret(actor, body)],
  ["POST", /^\/api\/jwt$/, "issue", async ({ service, actor, body }) => ({ status: 201, body: await service.issueJwt(actor, body) })],
  ["POST", /^\/api\/products$/, "issue", async ({ service, actor, body }) => ({ status: 201, body: await service.issueProductKey(actor, body) })],
  ["POST", new RegExp(`^/api/keys/${NAME}/revoke$`), "revoke", ({ service, actor, m }) => service.revokeJwt(actor, m[1])],
  ["POST", new RegExp(`^/api/keys/${NAME}/rotate$`), "rotate", ({ service, actor, m }) => service.rotateProductKey(actor, m[1])],
  ["POST", new RegExp(`^/api/keys/${NAME}/state$`), "suspend", ({ service, actor, m, body }) => service.setProductState(actor, m[1], body?.state)],
  ["POST", new RegExp(`^/api/keys/${NAME}/automation$`), "automation", ({ service, actor, m, body }) => service.setAutomation(actor, m[1], body?.rotateDays)],
  ["POST", /^\/api\/sweep$/, "rotate", ({ service }) => service.runSweep()],
  ["GET", /^\/api\/models$/, "models", ({ service, actor, q }) => service.listModels(actor, { foundryId: q.get("foundryId") ?? undefined })],
  ["GET", /^\/api\/foundries$/, "models", ({ service, actor }) => service.listFoundries(actor)],
  ["POST", /^\/api\/foundries\/attach$/, "models", ({ service, actor, body }) => service.attachFoundry(actor, body)],
  ["POST", /^\/api\/foundries\/test$/, "models", ({ service, actor, body }) => service.testFoundry(actor, body)],
  ["POST", /^\/api\/models\/pin$/, "models", ({ service, actor, body }) => service.pinModel(actor, body)],
  ["POST", /^\/api\/models\/unpin$/, "models", ({ service, actor, body }) => service.unpinModel(actor, body)],
  ["POST", /^\/api\/jwt\/bulk$/, "issue", ({ service, actor, body }) => service.issueJwtBulk(actor, body)],
  ["POST", /^\/api\/products\/bulk$/, "issue", ({ service, actor, body }) => service.issueProductBulk(actor, body)],
  ["POST", new RegExp(`^/api/keys/${NAME}/owner$`), "owner", ({ service, actor, m, body }) => service.setOwner(actor, m[1], body)],
  ["POST", new RegExp(`^/api/keys/${NAME}/archive$`), "archive", ({ service, actor, m }) => service.archiveKey(actor, m[1])],
  ["POST", new RegExp(`^/api/keys/${NAME}/delete$`), "delete", ({ service, actor, m }) => service.deleteKey(actor, m[1])],
  ["GET", /^\/api\/usage$/, "read-own", ({ service, actor, q }) => service.usage(actor, { kind: q.get("kind") ?? undefined, ...periodOf(q) })],
  ["GET", new RegExp(`^/api/usage/${NAME}$`), "read-own", ({ service, actor, m, q }) => service.keyUsage(actor, m[1], periodOf(q))],
  ["POST", /^\/api\/export$/, "export", ({ service, actor, body }) => service.exportBundle(actor, body)],
];

function send(res, status, body, headers = {}) {
  const payload = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(payload);
}

async function readJson(req) {
  const type = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") throw new HttpError(415, "Send application/json.");
  const origin = req.headers.origin;
  let originHost = null;
  try {
    originHost = origin ? new URL(origin).host : null;
  } catch { /* falls through to the 403 below */ }
  if (!originHost || originHost !== req.headers.host) throw new HttpError(403, "Cross-origin request refused.");
  if (req.headers["sec-fetch-site"] && !["same-origin", "none"].includes(req.headers["sec-fetch-site"])) {
    throw new HttpError(403, "Cross-site request refused.");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, "Request body too large.");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, "Body is not valid JSON.");
  }
}

export function createHandler({ service, env = process.env, log = (e) => console.log(JSON.stringify(e)) }) {
  return async function handler(req, res) {
    const started = Date.now();
    const url = new URL(req.url, "http://localhost");
    let status = 500;
    let actor = null;
    try {
      if (req.method === "GET" && STATIC[url.pathname]) {
        const [file, type] = STATIC[url.pathname];
        status = 200;
        return send(res, 200, await readFile(join(PUBLIC_DIR, file)), { "Content-Type": type, "Cache-Control": "no-cache" });
      }
      let m = null;
      const route = routes.find(([method, re]) => method === req.method && (m = url.pathname.match(re)));
      if (!route) throw new HttpError(404, "Not found.");
      const [, , action, fn] = route;
      if (action !== "open") {
        const principal = parsePrincipal(req.headers, env);
        const decision = can(principal, action);
        if (!decision.ok) throw new HttpError(decision.status, decision.status === 401 ? "Sign in first." : "Your role does not allow this.");
        actor = { name: principal.name, oid: principal.oid, role: roleOf(principal) };
      }
      const body = req.method === "POST" ? await readJson(req) : undefined;
      const out = await fn({ service, actor, body, m, q: url.searchParams });
      const wrapped = out && typeof out === "object" && "body" in out && Object.keys(out).every((k) => k === "body" || k === "status") ? out : { body: out };
      status = wrapped.status ?? 200;
      return send(res, status, wrapped.body, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    } catch (e) {
      const known = e instanceof HttpError || e?.name === "ServiceError" || e?.name === "AzureError";
      status = known ? (e.name === "AzureError" ? 502 : e.status) : 500;
      const message = known ? e.message : "Internal error.";
      if (!known) log({ level: "error", path: url.pathname, error: String(e?.stack ?? e).slice(0, 2000) });
      return send(res, status, { error: message }, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    } finally {
      if (url.pathname !== "/healthz") {
        log({ level: "request", method: req.method, path: url.pathname, status, actor: actor?.name ?? null, ms: Date.now() - started });
      }
    }
  };
}
