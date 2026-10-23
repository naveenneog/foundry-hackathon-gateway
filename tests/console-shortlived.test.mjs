import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { harness, ADMIN, ALICE } from "./console.harness.mjs";
import { can } from "../src/console/auth.mjs";
import { statusOf } from "../src/console/lifecycle.mjs";
import { keysCsv, indexCsv, csvSafe } from "../src/console/csv.mjs";
import { verifyKey } from "../src/keys.mjs";

const T = Date.parse("2026-10-16T09:00:00Z");
const HOUR = 3_600_000;
const TEMPLATE = readFileSync(new URL("../poc/products-keyvault/infra/product-policy.xml", import.meta.url), "utf8");
const claims = (token) => JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));

test("short-lived keys start in N hours, like admin.ps1: nbf is now+N, exp is nbf+window", async () => {
  const h = harness();
  await h.service.migrateSigningSecret(ADMIN);
  const r = await h.service.issueJwt(ADMIN, { owner: "alice@contoso.com", subject: "t1", models: ["flash"], budget: 100, hours: 48, startInHours: 6 });
  const c = claims(r.token);
  assert.equal(c.nbf * 1000, T + 6 * HOUR);
  assert.equal(c.exp * 1000, T + 54 * HOUR);
  assert.equal(r.notBefore, T + 6 * HOUR);
  const tags = h.vault.secrets.get(r.name).tags;
  assert.equal(tags.notBefore, new Date(T + 6 * HOUR).toISOString());
  assert.equal(statusOf("jwt", tags, T), "scheduled");
  assert.equal(statusOf("jwt", tags, T + 6 * HOUR), "active");
  const zero = await h.service.issueJwt(ADMIN, { owner: "alice@contoso.com", subject: "t2", models: ["flash"], budget: 100, hours: 1 });
  assert.equal(claims(zero.token).nbf * 1000, T, "default: immediately");
  for (const bad of [-1, 2161, "x", 1.5e9]) {
    await assert.rejects(h.service.issueJwt(ADMIN, { owner: "a@contoso.com", subject: "t", models: ["flash"], budget: 1, hours: 1, startInHours: bad }), { status: 400 });
  }
  const secret = Buffer.from(h.arm.namedValues.get("hackgw-signing-key").value, "base64");
  assert.ok(secret.length > 0 && typeof verifyKey === "function");
});

test("a scheduled key is listed as active (not archived) until it expires", async () => {
  const h = harness();
  await h.service.migrateSigningSecret(ADMIN);
  const r = await h.service.issueJwt(ADMIN, { owner: "alice@contoso.com", subject: "t1", models: ["flash"], budget: 100, hours: 2, startInHours: 24 });
  const active = await h.service.listKeys(ADMIN, { kind: "jwt" });
  assert.deepEqual(active.map((k) => [k.name, k.status]), [[r.name, "scheduled"]]);
});

test("the dashboard is for admins only: Console.User and no role are refused everywhere", () => {
  const user = { name: "alice@contoso.com", roles: ["Console.User"] };
  const admin = { name: "admin@contoso.com", roles: ["Console.Admin"] };
  for (const action of ["read-own", "issue", "export"]) assert.deepEqual(can(user, action), { ok: false, status: 403 }, action);
  assert.deepEqual(can(admin, "read-own"), { ok: true });
  assert.deepEqual(can(null, "read-own"), { ok: false, status: 401 });
});

test("service refuses a non-admin even when called directly (defence in depth)", async () => {
  const h = harness();
  await assert.rejects(h.service.listKeys(ALICE), { status: 403 });
  await assert.rejects(h.service.usage(ALICE, { kind: "jwt", days: 7 }), { status: 403 });
});

test("bulk short-lived keys return the keys and a keys.csv like admin.ps1, plus a key-free index.csv", async () => {
  const h = harness();
  await h.service.migrateSigningSecret(ADMIN);
  const r = await h.service.issueJwtBulk(ADMIN, { models: ["flash", "haiku-4-5"], budget: 1000, hours: 24, startInHours: 2,
    entries: [{ owner: "a@contoso.com", subject: "team-1" }, { owner: "x", subject: "bad" }, { owner: "b@contoso.com", subject: "=cmd" }] });
  assert.equal(r.issued.length, 1);
  assert.match(r.issued[0].token, /^eyJ/);
  const lines = r.keysCsv.split("\r\n");
  assert.equal(lines[0], "participant,owner,key,key_id,models,openai_base_url,anthropic_base_url,anthropic_model,budget_tokens,valid_from_utc,valid_until_utc");
  assert.match(lines[1], /^team-1,a@contoso\.com,eyJ[^,]+,k_[0-9a-f]{16},flash haiku-4-5,https:\/\/gw\.example\.net\/v1,https:\/\/gw\.example\.net\/claude,haiku-4-5,1000,2026-10-16 11:00,2026-10-17 11:00$/);
  assert.doesNotMatch(r.indexCsv, /eyJ/, "the index has no keys");
  assert.match(r.indexCsv.split("\r\n")[1], /^team-1,a@contoso\.com,k_[0-9a-f]{16},jwt-k-/);
  assert.equal(r.failed.length, 2, "the subject =cmd is not a valid subject");
});

test("bulk product keys return their keys and a keys.csv", async () => {
  const h = harness();
  h.service.setPackTemplate(TEMPLATE);
  const r = await h.service.issueProductBulk(ADMIN, { models: ["claude-haiku-4-5"], monthlyTokens: 5000, entries: [{ owner: "a@contoso.com", name: "team-a" }] });
  assert.match(r.issued[0].key, /^[0-9a-f]{32}$/);
  const lines = r.keysCsv.split("\r\n");
  assert.equal(lines[0], "name,owner,key,models,anthropic_base_url,openai_base_url,key_header,monthly_tokens,expires_utc");
  assert.match(lines[1], /^team-a,a@contoso\.com,[0-9a-f]{32},claude-haiku-4-5,https:\/\/gw\.example\.net\/poc\/claude,,x-api-key \(Claude\) \/ api-key \(OpenAI\),5000,$/);
});

test("csvSafe neutralises spreadsheet formulas and quotes separators", () => {
  assert.equal(csvSafe("=1+1"), "'=1+1");
  assert.equal(csvSafe("@x"), "'@x");
  assert.equal(csvSafe("a,b"), '"a,b"');
  assert.equal(csvSafe('a"b'), '"a""b"');
  assert.equal(keysCsv([], "jwt").split("\r\n").length, 1);
  assert.equal(indexCsv([], "product").split("\r\n").length, 1);
});
