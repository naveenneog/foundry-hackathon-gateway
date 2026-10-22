import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { statusOf, archivedAtOf, deleteAfterOf, isArchiveDue, isDeleteDue, pruneRevocations } from "../src/console/lifecycle.mjs";
import { harness, ADMIN, ALICE, BOB } from "./console.harness.mjs";

const T = Date.parse("2026-10-16T09:00:00Z");
const DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString();
const TEMPLATE = readFileSync(new URL("../poc/products-keyvault/infra/product-policy.xml", import.meta.url), "utf8");

test("statusOf: archived, revoked, expired, suspended and active", () => {
  assert.equal(statusOf("jwt", { expires: iso(T + DAY) }, T), "active");
  assert.equal(statusOf("jwt", { expires: iso(T - 1) }, T), "expired");
  assert.equal(statusOf("jwt", { expires: iso(T + DAY), revoked: "true" }, T), "revoked");
  assert.equal(statusOf("jwt", { archived: "true", expires: iso(T + DAY) }, T), "archived");
  assert.equal(statusOf("product", { state: "suspended" }, T), "suspended");
  assert.equal(statusOf("product", { state: "active", expires: iso(T - 1) }, T), "expired");
  assert.equal(statusOf("product", { state: "active" }, T), "active");
});

test("archive and delete timing: expired keys count as archived from their expiry; deletion 30 days later", () => {
  const expired = { expires: iso(T - DAY) };
  assert.equal(isArchiveDue("jwt", expired, T), true);
  assert.equal(archivedAtOf(expired), iso(T - DAY));
  assert.equal(deleteAfterOf(expired), iso(T + 29 * DAY));
  assert.equal(isDeleteDue({ archived: "true", archivedAt: iso(T - 30 * DAY) }, T), true);
  assert.equal(isDeleteDue({ archived: "true", archivedAt: iso(T - 29 * DAY) }, T), false);
  assert.equal(isDeleteDue({ archived: "true" }, T), false, "no archivedAt: never auto-deleted");
  assert.equal(isArchiveDue("jwt", { revoked: "true", expires: iso(T + DAY) }, T), true);
  assert.equal(isArchiveDue("product", { state: "suspended" }, T), false, "suspension alone does not archive");
  assert.equal(isArchiveDue("jwt", { archived: "true", expires: iso(T - DAY) }, T), false);
});

test("pruneRevocations drops only jtis known to have expired", () => {
  const list = ",k_aaaaaaaaaaaaaaaa,k_bbbbbbbbbbbbbbbb,k_cccccccccccccccc,";
  const expiry = new Map([["k_aaaaaaaaaaaaaaaa", T - 1], ["k_bbbbbbbbbbbbbbbb", T + DAY]]);
  assert.equal(pruneRevocations(list, expiry, T), ",k_bbbbbbbbbbbbbbbb,k_cccccccccccccccc,");
  assert.equal(pruneRevocations(",", expiry, T), ",");
});

async function issueJwt(h, owner, hours = 1) {
  return h.service.issueJwt(ADMIN, { owner, subject: "t1", models: ["flash"], budget: 1000, hours });
}

test("listKeys: active by default, archived on request, filtered by kind, with status and deletion date", async () => {
  const h = harness();
  await h.service.migrateSigningSecret(ADMIN);
  const a = await issueJwt(h, "alice@contoso.com", 1);
  const b = await issueJwt(h, "alice@contoso.com", 48);
  h.service.setPackTemplate(TEMPLATE);
  await h.service.issueProductKey(ADMIN, { owner: "alice@contoso.com", name: "p1", models: ["claude-haiku-4-5"], monthlyTokens: 100 });
  h.clock.now = T + 2 * 3_600_000;
  const active = await h.service.listKeys(ALICE);
  assert.deepEqual(active.map((k) => k.name).sort(), [b.name, "poc-key-p1"].sort());
  const jwtOnly = await h.service.listKeys(ALICE, { kind: "jwt" });
  assert.deepEqual(jwtOnly.map((k) => k.name), [b.name]);
  assert.deepEqual(jwtOnly[0].models, ["flash"]);
  const archived = await h.service.listKeys(ALICE, { status: "archived" });
  assert.deepEqual(archived.map((k) => k.name), [a.name]);
  assert.equal(archived[0].status, "expired");
  assert.equal(archived[0].archived, true);
  assert.equal(archived[0].deleteAfter, iso(T + 3_600_000 + 30 * DAY));
  assert.deepEqual(await h.service.listKeys(BOB), []);
});

test("archiveKey and deleteKey: admin only; only archived keys are deleted; product deletion removes the subscription and an empty pack", async () => {
  const h = harness();
  h.service.setPackTemplate(TEMPLATE);
  const p = await h.service.issueProductKey(ADMIN, { owner: "alice@contoso.com", name: "p1", models: ["claude-haiku-4-5"], monthlyTokens: 100 });
  await assert.rejects(h.service.archiveKey(ALICE, "poc-key-p1"), { status: 403 });
  await assert.rejects(h.service.deleteKey(ADMIN, "poc-key-p1"), { status: 409 });
  await h.service.archiveKey(ADMIN, "poc-key-p1");
  assert.equal(h.arm.subscriptions.get("poc-p1").state, "suspended", "an archived product key stops working");
  const tags = h.vault.secrets.get("poc-key-p1").tags;
  assert.equal(tags.archived, "true");
  assert.equal(tags.archivedAt, iso(T));
  await h.service.deleteKey(ADMIN, "poc-key-p1");
  assert.equal(h.vault.secrets.has("poc-key-p1"), false);
  assert.equal(h.arm.subscriptions.has("poc-p1"), false);
  assert.equal(h.arm.products.has(p.product), false, "the pk- pack had no other key");
  assert.ok(h.audit.some((e) => e.action === "delete-key" && e.name === "poc-key-p1"));
  await assert.rejects(h.service.deleteKey(ADMIN, "poc-key-p1"), { status: 404 });
});

test("deleteKey keeps a legacy pack and keeps a revoked jti that has not expired", async () => {
  const h = harness();
  await h.service.migrateSigningSecret(ADMIN);
  const k = await issueJwt(h, "alice@contoso.com", 48);
  await h.service.revokeJwt(ADMIN, k.name);
  assert.equal(h.vault.secrets.get(k.name).tags.archived, "true", "revoking archives");
  await h.service.deleteKey(ADMIN, k.name);
  assert.match(h.arm.namedValues.get("hackgw-revoked-keys").value, new RegExp(k.jti));
  await h.service.issueProductKey(ADMIN, { owner: "alice@contoso.com", name: "legacy", product: "poc-claude-pack" });
  await h.service.archiveKey(ADMIN, "poc-key-legacy");
  await h.service.deleteKey(ADMIN, "poc-key-legacy");
  assert.equal(h.arm.products.has("poc-claude-pack"), true);
});

test("setOwner: admin re-tags a key, and the new owner sees it", async () => {
  const h = harness();
  await h.service.issueProductKey(ADMIN, { owner: "alice@contoso.com", name: "x1", product: "poc-claude-pack" });
  await assert.rejects(h.service.setOwner(ALICE, "poc-key-x1", { owner: "bob@contoso.com" }), { status: 403 });
  await assert.rejects(h.service.setOwner(ADMIN, "poc-key-x1", { owner: "not-an-email" }), { status: 400 });
  const r = await h.service.setOwner(ADMIN, "poc-key-x1", { owner: "Bob@Contoso.com", label: "team red" });
  assert.deepEqual(r, { name: "poc-key-x1", owner: "bob@contoso.com", label: "team red" });
  assert.deepEqual((await h.service.listKeys(BOB)).map((k) => k.name), ["poc-key-x1"]);
  assert.deepEqual(await h.service.listKeys(ALICE), []);
});

test("runSweep: rotates due keys, archives expired ones (suspending products), deletes after 30 days, prunes revocations", async () => {
  const h = harness();
  h.service.setPackTemplate(TEMPLATE);
  await h.service.migrateSigningSecret(ADMIN);
  const short = await issueJwt(h, "alice@contoso.com", 1);
  await h.service.revokeJwt(ADMIN, short.name);
  await h.service.issueProductKey(ADMIN, { owner: "alice@contoso.com", name: "exp", models: ["claude-haiku-4-5"], monthlyTokens: 100, expiresDays: 1 });
  await h.service.issueProductKey(ADMIN, { owner: "alice@contoso.com", name: "rot", models: ["claude-haiku-4-5"], monthlyTokens: 100, rotateDays: 1 });

  h.clock.now = T + 2 * DAY;
  const first = await h.service.runSweep();
  assert.deepEqual(first.rotated, ["poc-key-rot"]);
  assert.deepEqual(first.archived, ["poc-key-exp"]);
  assert.equal(h.arm.subscriptions.get("poc-exp").state, "suspended");
  assert.equal(h.arm.namedValues.get("hackgw-revoked-keys").value, ",", "the revoked key has expired, so its entry is pruned");

  h.clock.now = T + 33 * DAY;
  const later = await h.service.runSweep();
  assert.deepEqual(later.deleted.sort(), [short.name, "poc-key-exp"].sort());
  assert.equal(h.vault.secrets.has("poc-key-exp"), false);
  assert.equal(h.arm.subscriptions.has("poc-exp"), false);
  assert.ok(h.arm.products.has(h.vault.secrets.get("poc-key-rot").tags.product), "a pack still used by another key is kept");
  assert.deepEqual(later.failed, []);
});
