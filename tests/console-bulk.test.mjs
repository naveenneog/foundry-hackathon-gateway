import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { harness, ADMIN, ALICE } from "./console.harness.mjs";

const TEMPLATE = readFileSync(new URL("../poc/products-keyvault/infra/product-policy.xml", import.meta.url), "utf8");
const rows = (n, f) => Array.from({ length: n }, (_, i) => f(i));

test("bulk hackathon keys: issues every valid row, reports bad rows by index, returns no key values", async () => {
  const h = harness();
  await h.service.migrateSigningSecret(ADMIN);
  await assert.rejects(h.service.issueJwtBulk(ALICE, { models: ["flash"], budget: 10, hours: 1, entries: [] }), { status: 403 });
  const entries = [
    { owner: "a@contoso.com", subject: "team-1" },
    { owner: "not-an-email", subject: "team-2" },
    { owner: "c@contoso.com", subject: "bad subject!" },
    { owner: "d@contoso.com", subject: "team-4" },
  ];
  const r = await h.service.issueJwtBulk(ADMIN, { models: ["flash", "haiku-4-5"], budget: 1000, hours: 24, label: "batch", entries });
  assert.deepEqual(r.issued.map((x) => x.owner), ["a@contoso.com", "d@contoso.com"]);
  assert.deepEqual(r.failed.map((x) => x.index), [1, 2]);
  assert.match(r.failed[0].error, /Owner/);
  assert.doesNotMatch(JSON.stringify(r), /eyJ/, "no token in the response");
  const tags = h.vault.secrets.get(r.issued[0].name).tags;
  assert.equal(tags.models, "flash,haiku-4-5");
  assert.equal(tags.label, "batch");
  assert.ok(h.audit.some((e) => e.action === "issue-jwt-bulk" && e.issued === 2 && e.failed === 2));
});

test("bulk: batches are 1–50 rows, and the shared grant is validated once for the whole batch", async () => {
  const h = harness();
  await h.service.migrateSigningSecret(ADMIN);
  await assert.rejects(h.service.issueJwtBulk(ADMIN, { models: ["flash"], budget: 10, hours: 1, entries: rows(51, (i) => ({ owner: "a@contoso.com", subject: `s${i}` })) }), { status: 400 });
  await assert.rejects(h.service.issueJwtBulk(ADMIN, { models: ["flash"], budget: 10, hours: 1, entries: [] }), { status: 400 });
  await assert.rejects(h.service.issueJwtBulk(ADMIN, { models: ["nope"], budget: 10, hours: 1, entries: [{ owner: "a@contoso.com", subject: "s" }] }), { status: 400 });
  const r = await h.service.issueJwtBulk(ADMIN, { models: ["flash"], budget: 10, hours: 1, entries: rows(50, (i) => ({ owner: "a@contoso.com", subject: `s${i}` })) });
  assert.equal(r.issued.length, 50);
});

test("bulk product keys: one pack for the batch, duplicates and bad names fail per row", async () => {
  const h = harness();
  h.service.setPackTemplate(TEMPLATE);
  const r = await h.service.issueProductBulk(ADMIN, { models: ["claude-haiku-4-5", "deepseek-v4-flash"], monthlyTokens: 5000, rotateDays: 30, entries: [
    { owner: "a@contoso.com", name: "team-a" },
    { owner: "b@contoso.com", name: "team-a" },
    { owner: "c@contoso.com", name: "Bad_Name" },
    { owner: "d@contoso.com", name: "team-d" },
  ] });
  assert.deepEqual(r.issued.map((x) => x.name), ["poc-key-team-a", "poc-key-team-d"]);
  assert.deepEqual(r.failed.map((x) => x.index), [1, 2]);
  assert.match(r.failed[0].error, /already exists/);
  assert.equal(h.arm.calls.filter((c) => c[0] === "createProduct").length, 1);
  assert.equal(h.vault.secrets.get("poc-key-team-d").tags.rotateDays, "30");
  assert.doesNotMatch(JSON.stringify(r), /[0-9a-f]{32}/, "no key value in the response");
  await assert.rejects(h.service.issueProductBulk(ADMIN, { models: [], monthlyTokens: 5, entries: [{ owner: "a@contoso.com", name: "x1" }] }), { status: 400 });
});

test("export takes up to 500 keys, so a bulk batch can leave in one bundle", async () => {
  const h = harness();
  const names = Array.from({ length: 501 }, (_, i) => `jwt-k-${String(i).padStart(16, "0")}`);
  await assert.rejects(h.service.exportBundle(ADMIN, { names, recipient: "r" }), { status: 400, message: /1–500/ });
});
