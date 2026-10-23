import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

import { createHandler } from "../src/console/server.mjs";
import { harness, ADMIN, ALICE } from "./console.harness.mjs";

const ROLE_TYP = "http://schemas.microsoft.com/ws/2008/06/identity/claims/role";
const principal = (who, roles) => Buffer.from(JSON.stringify({
  auth_typ: "aad", name_typ: "name", role_typ: ROLE_TYP,
  claims: [{ typ: "preferred_username", val: who.name }, { typ: "oid", val: who.oid }, ...roles.map((r) => ({ typ: ROLE_TYP, val: r }))],
})).toString("base64");
const AS = { admin: { "x-ms-client-principal": principal(ADMIN, ["Console.Admin"]) }, alice: { "x-ms-client-principal": principal(ALICE, ["Console.User"]) } };
const TEMPLATE = readFileSync(new URL("../poc/products-keyvault/infra/product-policy.xml", import.meta.url), "utf8");

let server, base, h;
before(async () => {
  h = harness();
  h.service.setPackTemplate(TEMPLATE);
  h.service.setUsageSource({ async query() { return []; } });
  server = createServer(createHandler({ service: h.service, env: { WEBSITE_AUTH_ENABLED: "True" }, log: () => {} }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  await post("/api/signing/migrate", AS.admin, {});
});
after(() => server.close());

const get = (path, who) => fetch(base + path, { headers: who });
const post = (path, who, body) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", origin: base, ...who }, body: JSON.stringify(body ?? {}) });

test("admin-only dashboard routes refuse a user with 403", async () => {
  const cases = [
    ["GET", "/api/models"], ["POST", "/api/models/pin"], ["POST", "/api/models/unpin"],
    ["POST", "/api/jwt/bulk"], ["POST", "/api/products/bulk"],
    ["POST", "/api/keys/poc-key-x/owner"], ["POST", "/api/keys/poc-key-x/archive"], ["POST", "/api/keys/poc-key-x/delete"],
  ];
  for (const [m, p] of cases) {
    const r = m === "GET" ? await get(p, AS.alice) : await post(p, AS.alice, {});
    assert.equal(r.status, 403, `${m} ${p}`);
  }
});

test("models, pinning and config's deployments over HTTP", async () => {
  const models = await (await get("/api/models", AS.admin)).json();
  assert.ok(models.deployments.some((d) => d.deployment === "claude-sonnet-5"));
  const pin = await post("/api/models/pin", AS.admin, { alias: "sonnet-5", deployment: "claude-sonnet-5" });
  assert.equal(pin.status, 200);
  assert.equal((await post("/api/models/pin", AS.admin, { alias: "sonnet", deployment: "claude-sonnet-5" })).status, 400);
  assert.equal((await get("/api/config", AS.alice)).status, 403);
  const cfg = await (await get("/api/config", AS.admin)).json();
  assert.ok(cfg.deployments.some((d) => d.deployment === "deepseek-v4-flash"));
});

test("keys are listed by kind and status from the query string; bad values are 400", async () => {
  const issued = await post("/api/products", AS.admin, { owner: ALICE.name, name: "srv1", models: ["claude-haiku-4-5"], monthlyTokens: 100 });
  assert.equal(issued.status, 201);
  assert.equal((await get("/api/keys?kind=product", AS.alice)).status, 403);
  const prod = await (await get("/api/keys?kind=product", AS.admin)).json();
  assert.deepEqual(prod.keys.map((k) => k.name), ["poc-key-srv1"]);
  assert.ok((await (await get("/api/keys?kind=jwt", AS.admin)).json()).keys.every((k) => k.kind === "jwt"));
  assert.equal((await get("/api/keys?kind=nope", AS.admin)).status, 400);
  assert.equal((await get("/api/keys?status=gone", AS.admin)).status, 400);
  await post("/api/keys/poc-key-srv1/archive", AS.admin, {});
  const archived = await (await get("/api/keys?kind=product&status=archived", AS.admin)).json();
  assert.equal(archived.keys[0].status, "archived");
  assert.equal((await post("/api/keys/poc-key-srv1/delete", AS.admin, {})).status, 200);
  assert.equal((await fetch(base + "/api/keys/poc-key-srv1", { method: "DELETE", headers: { origin: base, ...AS.admin } })).status, 404, "no DELETE verb");
});

test("bulk issue, owner change and usage over HTTP", async () => {
  const bulk = await (await post("/api/jwt/bulk", AS.admin, { models: ["flash"], budget: 10, hours: 2, entries: [{ owner: ALICE.name, subject: "a" }, { owner: "x", subject: "b" }] })).json();
  assert.equal(bulk.issued.length, 1);
  assert.equal(bulk.failed[0].index, 1);
  const name = bulk.issued[0].name;
  const own = await post(`/api/keys/${name}/owner`, AS.admin, { owner: "carol@contoso.com", label: "moved" });
  assert.deepEqual(await own.json(), { name, owner: "carol@contoso.com", label: "moved" });
  assert.match(bulk.keysCsv, /^participant,owner,key,/);
  assert.equal((await get("/api/usage?kind=jwt&days=30", AS.alice)).status, 403);
  const u = await (await get("/api/usage?kind=jwt&days=30", AS.admin)).json();
  assert.equal(u.days, 30);
  assert.equal((await get("/api/usage?kind=jwt&days=2", AS.admin)).status, 400);
  assert.equal((await get(`/api/usage/${name}?days=7`, AS.alice)).status, 403);
  assert.equal((await get(`/api/usage/${name}?days=7`, AS.admin)).status, 200);
  const sweep = await (await post("/api/sweep", AS.admin, {})).json();
  assert.deepEqual(Object.keys(sweep).sort(), ["archived", "deleted", "failed", "rotated"]);
});

test("every browser module in public/ is served as JavaScript, and nothing else in src/ is", async () => {
  const { readdirSync } = await import("node:fs");
  const mods = readdirSync(new URL("../src/console/public/", import.meta.url)).filter((f) => f.endsWith(".js"));
  assert.ok(mods.length >= 10);
  for (const f of mods) {
    const r = await get(`/${f}`, AS.alice);
    assert.equal(r.status, 200, f);
    assert.match(r.headers.get("content-type"), /^text\/javascript/, f);
  }
  assert.equal((await get("/service.mjs", AS.alice)).status, 404);
  assert.equal((await get("/views-nope.js", AS.alice)).status, 404);
});

test("Foundry discovery, attachment, scoped pins and key issue are wired through HTTP", async () => {
  assert.equal((await get("/api/foundries", AS.alice)).status, 403);
  assert.equal((await post("/api/foundries/attach", AS.alice, {})).status, 403);
  const foundries = await (await get("/api/foundries", AS.admin)).json();
  assert.equal(foundries.accounts.length, 2);
  const foundryId = foundries.accounts[1].id;
  const query = `?foundryId=${encodeURIComponent(foundryId)}`;
  const models = await (await get(`/api/models${query}`, AS.admin)).json();
  assert.equal(models.connected, false);
  assert.equal((await get(`/api/config${query}`, AS.admin)).status, 409);
  const attached = await post("/api/foundries/attach", AS.admin, { foundryId });
  assert.equal(attached.status, 200);
  assert.equal((await post("/api/models/pin", AS.admin, { foundryId, alias: "secondary", deployment: "deepseek-v4-flash" })).status, 200);
  const config = await (await get(`/api/config${query}`, AS.admin)).json();
  assert.equal(config.foundryId, foundryId);
  assert.deepEqual(config.models.openai, ["secondary"]);
  assert.ok(config.gatewayUrl.includes("/foundry/"));
  const key = await post("/api/jwt", AS.admin, { owner: ADMIN.name, subject: "selected", foundryId, models: ["secondary"], budget: 10, hours: 1 });
  assert.equal(key.status, 201);
  assert.ok((await key.json()).handout.env.OPENAI_BASE_URL.startsWith(config.gatewayUrl));
  assert.equal((await post("/api/foundries/test", AS.alice, { foundryId })).status, 403);
});
