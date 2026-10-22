import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildUsageQuery, aggregateUsage, bucketFor } from "../src/console/usage.mjs";
import { harness, ADMIN, ALICE, BOB } from "./console.harness.mjs";

const T = Date.parse("2026-10-16T09:00:00Z");
const DAY = 86_400_000;
const TEMPLATE = readFileSync(new URL("../poc/products-keyvault/infra/product-policy.xml", import.meta.url), "utf8");

test("buildUsageQuery: token metrics by bucket, key and model, split by route, single key by validated id", () => {
  const q = buildUsageQuery({ kind: "product", days: 7 });
  assert.match(q, /^AppMetrics/);
  assert.match(q, /Name in \("Total Tokens", "Prompt Tokens", "Completion Tokens"\)/);
  assert.match(q, /Route == "poc"/);
  assert.match(q, /bin\(TimeGenerated, 1d\)/);
  assert.match(buildUsageQuery({ kind: "jwt", days: 1 }), /Route != "poc"[\s\S]*bin\(TimeGenerated, 1h\)/);
  assert.match(buildUsageQuery({ kind: "jwt", days: 30, keyId: "k_0123456789abcdef" }), /KeyId == "k_0123456789abcdef"/);
  assert.throws(() => buildUsageQuery({ kind: "jwt", days: 7, keyId: 'x" or 1==1 //' }), /key id/);
  assert.throws(() => buildUsageQuery({ kind: "both", days: 7 }), /kind/);
  assert.throws(() => buildUsageQuery({ kind: "jwt", days: 9 }), /days/);
});

test("aggregateUsage: totals, zero-filled series, by model and by key, unknown keys kept only when asked", () => {
  const b = bucketFor(7);
  const day = (n) => new Date(Date.parse("2026-10-16T00:00:00Z") - n * DAY).toISOString();
  const rows = [
    { Bucket: day(0), KeyId: "k_a", Model: "flash", Name: "Total Tokens", Tokens: 100, Calls: 2 },
    { Bucket: day(0), KeyId: "k_a", Model: "flash", Name: "Prompt Tokens", Tokens: 70, Calls: 2 },
    { Bucket: day(0), KeyId: "k_a", Model: "flash", Name: "Completion Tokens", Tokens: 30, Calls: 2 },
    { Bucket: day(2), KeyId: "k_b", Model: "haiku-4-5", Name: "Total Tokens", Tokens: 50, Calls: 1 },
    { Bucket: day(1), KeyId: "k_x", Model: "flash", Name: "Total Tokens", Tokens: 999, Calls: 9 },
  ];
  const keys = new Map([["k_a", { name: "jwt-k-a", owner: "alice@contoso.com" }], ["k_b", { name: "jwt-k-b", owner: "bob@contoso.com", label: "red" }]]);
  const u = aggregateUsage(rows, { keys, includeUnknown: false, days: 7, bucket: b, now: T });
  assert.deepEqual(u.total, { tokens: 150, prompt: 70, completion: 30, requests: 3 });
  assert.equal(u.series.length, 7);
  assert.equal(u.series.at(-1).tokens, 100);
  assert.equal(u.series.at(-3).tokens, 50);
  assert.deepEqual(u.byModel, [{ model: "flash", tokens: 100 }, { model: "haiku-4-5", tokens: 50 }]);
  assert.deepEqual(u.byKey.map((k) => [k.name, k.tokens, k.requests]), [["jwt-k-a", 100, 2], ["jwt-k-b", 50, 1]]);
  assert.equal(u.byKey[1].label, "red");
  const all = aggregateUsage(rows, { keys, includeUnknown: true, days: 7, bucket: b, now: T });
  assert.equal(all.total.tokens, 1149);
  assert.equal(all.byKey[0].name, null, "a key the vault does not hold is shown by its id");
  assert.equal(all.byKey[0].keyId, "k_x");
});

function laFake(rowsFor) {
  const calls = [];
  return { calls, async query(q, opts) { calls.push({ q, opts }); return rowsFor(q); } };
}

test("service usage: users see only their keys; admins see all; product keys join on subscription; results cached 60 s", async () => {
  const h = harness();
  h.service.setPackTemplate(TEMPLATE);
  await h.service.migrateSigningSecret(ADMIN);
  const a = await h.service.issueJwt(ADMIN, { owner: "alice@contoso.com", subject: "t", models: ["flash"], budget: 9, hours: 48 });
  await h.service.issueJwt(ADMIN, { owner: "bob@contoso.com", subject: "t", models: ["flash"], budget: 9, hours: 48 });
  const bJti = [...h.vault.secrets.values()].find((s) => s.tags.owner === "bob@contoso.com").tags.jti;
  await h.service.issueProductKey(ADMIN, { owner: "alice@contoso.com", name: "p1", models: ["claude-haiku-4-5"], monthlyTokens: 100 });
  const today = "2026-10-16T00:00:00.000Z";
  const la = laFake((q) => q.includes('Route == "poc"')
    ? [{ Bucket: today, KeyId: "poc-p1", Model: "claude-haiku-4-5", Name: "Total Tokens", Tokens: 40, Calls: 1 }]
    : [
      { Bucket: today, KeyId: a.jti, Model: "flash", Name: "Total Tokens", Tokens: 10, Calls: 1 },
      { Bucket: today, KeyId: bJti, Model: "flash", Name: "Total Tokens", Tokens: 20, Calls: 1 },
    ]);
  h.service.setUsageSource(la);
  const alice = await h.service.usage(ALICE, { kind: "jwt", days: 7 });
  assert.deepEqual(alice.byKey.map((k) => k.owner), ["alice@contoso.com"]);
  assert.equal(alice.total.tokens, 10);
  const admin = await h.service.usage(ADMIN, { kind: "jwt", days: 7 });
  assert.equal(admin.total.tokens, 30);
  assert.equal(la.calls.length, 1, "the second view reused the cached rows");
  const prod = await h.service.usage(ALICE, { kind: "product", days: 7 });
  assert.deepEqual(prod.byKey.map((k) => [k.name, k.tokens]), [["poc-key-p1", 40]]);
  h.clock.now += 61_000;
  await h.service.usage(ADMIN, { kind: "jwt", days: 7 });
  assert.equal(la.calls.length, 3);
  assert.equal(la.calls[0].opts.timespan, "P7D");
  await assert.rejects(h.service.usage(ALICE, { kind: "jwt", days: 5 }), { status: 400 });
});

test("service keyUsage: one key's series, only for its owner or an admin", async () => {
  const h = harness();
  await h.service.migrateSigningSecret(ADMIN);
  const a = await h.service.issueJwt(ADMIN, { owner: "alice@contoso.com", subject: "t", models: ["flash"], budget: 9, hours: 48 });
  const la = laFake(() => [{ Bucket: "2026-10-16T00:00:00.000Z", KeyId: a.jti, Model: "flash", Name: "Total Tokens", Tokens: 5, Calls: 1 }]);
  h.service.setUsageSource(la);
  const u = await h.service.keyUsage(ALICE, a.name, { days: 30 });
  assert.equal(u.total.tokens, 5);
  assert.match(la.calls[0].q, new RegExp(`KeyId == "${a.jti}"`));
  await assert.rejects(h.service.keyUsage(BOB, a.name, { days: 30 }), { status: 404 });
});

test("service usage without a workspace says so instead of failing", async () => {
  const h = harness();
  const u = await h.service.usage(ADMIN, { kind: "jwt", days: 7 });
  assert.equal(u.total.tokens, 0);
  assert.match(u.note, /not configured/);
});
