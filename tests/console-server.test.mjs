import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { createHandler } from "../src/console/server.mjs";
import { harness, ADMIN, ALICE, BOB } from "./console.harness.mjs";

const ROLE_TYP = "http://schemas.microsoft.com/ws/2008/06/identity/claims/role";
const principal = (who, roles) => Buffer.from(JSON.stringify({
  auth_typ: "aad", name_typ: "name", role_typ: ROLE_TYP,
  claims: [{ typ: "preferred_username", val: who.name }, { typ: "oid", val: who.oid }, ...roles.map((r) => ({ typ: ROLE_TYP, val: r }))],
})).toString("base64");
const AS = {
  admin: { "x-ms-client-principal": principal(ADMIN, ["Console.Admin"]) },
  alice: { "x-ms-client-principal": principal(ALICE, ["Console.User"]) },
  bob: { "x-ms-client-principal": principal(BOB, ["Console.User"]) },
  norole: { "x-ms-client-principal": principal(BOB, []) },
};

let server, base, h;
before(async () => {
  h = harness();
  const handler = createHandler({ service: h.service, env: { WEBSITE_AUTH_ENABLED: "True" }, log: () => {} });
  server = createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const get = (path, who = {}) => fetch(base + path, { headers: who });
const post = (path, who, body, extra = {}) => fetch(base + path, {
  method: "POST",
  headers: { "content-type": "application/json", origin: base, ...who, ...extra },
  body: JSON.stringify(body ?? {}),
});

test("no principal is 401, a principal without a console role is 403", async () => {
  assert.equal((await get("/api/me")).status, 401);
  assert.equal((await get("/api/me", AS.norole)).status, 403);
  const me = await (await get("/api/me", AS.alice)).json();
  assert.deepEqual(me, { name: ALICE.name, role: "user" });
});

test("health is open; static app is served with a strict CSP; APIs are not cached", async () => {
  assert.equal((await get("/healthz")).status, 200);
  const page = await get("/", AS.alice);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);
  assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
  assert.match(await page.text(), /<title>[^<]*Console/);
  assert.equal((await get("/api/me", AS.alice)).headers.get("cache-control"), "no-store");
  assert.equal((await get("/../../package.json", AS.alice)).status, 404);
});

test("state changes require JSON and a same-origin Origin", async () => {
  await post("/api/signing/migrate", AS.admin, {});
  const noJson = await fetch(base + "/api/jwt", { method: "POST", headers: { ...AS.admin, origin: base, "content-type": "text/plain" }, body: "{}" });
  assert.equal(noJson.status, 415);
  assert.equal((await post("/api/jwt", AS.admin, {}, { origin: "https://evil.example" })).status, 403);
  const noOrigin = await fetch(base + "/api/jwt", { method: "POST", headers: { ...AS.admin, "content-type": "application/json" }, body: "{}" });
  assert.equal(noOrigin.status, 403);
  const bad = await fetch(base + "/api/jwt", { method: "POST", headers: { ...AS.admin, origin: base, "content-type": "application/json" }, body: "{not json" });
  assert.equal(bad.status, 400);
});

test("only admins issue, revoke, rotate, export and manage the signing secret", async () => {
  const body = { owner: ALICE.name, subject: "team-1", models: ["flash"], budget: 1000, hours: 1 };
  for (const [path, b] of [["/api/jwt", body], ["/api/products", {}], ["/api/export", { names: [], recipient: "x" }],
    ["/api/signing/migrate", {}], ["/api/signing/rotate", { confirm: "ROTATE" }], ["/api/sweep", {}]]) {
    assert.equal((await post(path, AS.alice, b)).status, 403, path);
  }
  assert.equal((await get("/api/signing", AS.alice)).status, 403);

  const issued = await post("/api/jwt", AS.admin, body);
  assert.equal(issued.status, 201);
  const { name, token } = await issued.json();
  assert.ok(token);
  assert.equal((await post(`/api/keys/${name}/revoke`, AS.alice, {})).status, 403);
  assert.equal((await post(`/api/keys/${name}/revoke`, AS.admin, {})).status, 200);
});

test("users list and reveal only their own keys; another user's key is 404", async () => {
  const k = await (await post("/api/jwt", AS.admin, { owner: ALICE.name, subject: "a", models: ["haiku-4-5"], budget: 1000, hours: 2 })).json();
  const aliceKeys = await (await get("/api/keys", AS.alice)).json();
  assert.ok(aliceKeys.keys.some((x) => x.name === k.name));
  assert.ok(aliceKeys.keys.every((x) => !("value" in x)));
  assert.ok((await (await get("/api/keys", AS.bob)).json()).keys.every((x) => x.owner === BOB.name));
  const r = await get(`/api/keys/${k.name}`, AS.alice);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).value, k.token);
  assert.equal((await get(`/api/keys/${k.name}`, AS.bob)).status, 404);
  assert.equal((await get("/api/keys/gw-signing-secret", AS.admin)).status, 404);
});

test("admin export returns a signed bundle and a one-time passphrase; the public key is published", async () => {
  const k = await (await post("/api/jwt", AS.admin, { owner: BOB.name, subject: "b", models: ["flash"], budget: 10, hours: 1 })).json();
  const r = await post("/api/export", AS.admin, { names: [k.name], recipient: "Bob" });
  assert.equal(r.status, 200);
  const out = await r.json();
  assert.ok(out.bundle.signature && out.passphrase && out.filename);
  const jwk = await (await get("/api/bundle-key", AS.bob)).json();
  assert.equal(jwk.crv, "P-256");
  assert.ok(!("d" in jwk), "never the private part");
});

test("validation and service errors map to status codes without stack traces", async () => {
  const r = await post("/api/jwt", AS.admin, { owner: "x", subject: "t", models: ["flash"], budget: 1, hours: 1 });
  assert.equal(r.status, 400);
  const body = await r.json();
  assert.match(body.error, /Owner/);
  assert.ok(!JSON.stringify(body).includes("at "));
  assert.equal((await get("/api/nope", AS.admin)).status, 404);
  assert.equal((await post("/api/keys/poc-key-missing/state", AS.admin, { state: "suspended" })).status, 404);
});
