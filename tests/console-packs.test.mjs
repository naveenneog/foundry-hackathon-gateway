import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { packId, renderPackPolicy, packRoutes, resolveGrant } from "../src/console/packs.mjs";
import { harness, ADMIN, ALICE } from "./console.harness.mjs";

const TEMPLATE = readFileSync(new URL("../poc/products-keyvault/infra/product-policy.xml", import.meta.url), "utf8");
const grantable = [
  { deployment: "claude-haiku-4-5", route: "claude" },
  { deployment: "claude-sonnet-5", route: "claude" },
  { deployment: "deepseek-v4-flash", route: "openai" },
];

test("packId is stable for the same model set and budget, in any order, and differs otherwise", () => {
  const a = packId(["claude-sonnet-5", "claude-haiku-4-5"], 1000);
  assert.match(a, /^pk-[0-9a-f]{12}$/);
  assert.equal(a, packId(["claude-haiku-4-5", "claude-sonnet-5"], 1000));
  assert.notEqual(a, packId(["claude-haiku-4-5"], 1000));
  assert.notEqual(a, packId(["claude-haiku-4-5", "claude-sonnet-5"], 1001));
});

test("resolveGrant: one or several known deployments, nothing else", () => {
  assert.deepEqual(resolveGrant(["deepseek-v4-flash"], grantable).map((g) => g.route), ["openai"]);
  assert.throws(() => resolveGrant([], grantable), /at least one model/);
  assert.throws(() => resolveGrant(["claude-opus-9"], grantable), /not a ready Foundry deployment/);
  assert.throws(() => resolveGrant("claude-haiku-4-5", grantable), /at least one model/);
  assert.deepEqual(resolveGrant(["claude-haiku-4-5", "claude-haiku-4-5"], grantable).length, 1);
});

test("renderPackPolicy fills every placeholder and emits per-key token usage", () => {
  const xml = renderPackPolicy(TEMPLATE, { models: ["claude-haiku-4-5", "deepseek-v4-flash"], keyTokens: 5000, poolTokens: 1000000, tpm: 20000 });
  assert.doesNotMatch(xml.replace(/<!--[\s\S]*?-->/g, ""), /__[A-Z_]+__/);
  assert.throws(() => renderPackPolicy("<p>__NEW_KNOB__</p>", { models: ["m"], keyTokens: 1, poolTokens: 1, tpm: 1 }), /placeholder/);
  assert.match(xml, /"claude-haiku-4-5\|deepseek-v4-flash"\.Split\('\|'\)/);
  assert.match(xml, /token-quota="5000"/);
  assert.match(xml, /<llm-emit-token-metric namespace="hackathongw">[\s\S]*name="KeyId" value="@\(context\.Subscription\.Id\)"[\s\S]*name="Route" value="poc"/);
  assert.throws(() => renderPackPolicy(TEMPLATE, { models: ['x"y'], keyTokens: 1, poolTokens: 1, tpm: 1 }), /deployment name/);
});

test("packRoutes links the routes the models need, plus the probe", () => {
  assert.deepEqual(packRoutes([{ route: "claude" }, { route: "claude" }]), ["poc-claude", "poc-probe"]);
  assert.deepEqual(packRoutes([{ route: "openai" }, { route: "claude" }]), ["poc-claude", "poc-openai", "poc-probe"]);
});

test("service: a product key on chosen models creates the pack once and reuses it", async () => {
  const h = harness();
  h.service.setPackTemplate(TEMPLATE);
  await assert.rejects(h.service.issueProductKey(ALICE, { owner: "alice@contoso.com", name: "a1", models: ["claude-haiku-4-5"], monthlyTokens: 5000 }), { status: 403 });
  const one = await h.service.issueProductKey(ADMIN, { owner: "alice@contoso.com", name: "a1", models: ["claude-haiku-4-5"], monthlyTokens: 5000 });
  assert.match(one.product, /^pk-[0-9a-f]{12}$/);
  const p = h.arm.products.get(one.product);
  assert.deepEqual(p.apis.sort(), ["poc-claude", "poc-probe"]);
  assert.match(p.policy, /"claude-haiku-4-5"\.Split/);
  const two = await h.service.issueProductKey(ADMIN, { owner: "bob@contoso.com", name: "b1", models: ["claude-haiku-4-5"], monthlyTokens: 5000 });
  assert.equal(two.product, one.product);
  assert.equal(h.arm.calls.filter((c) => c[0] === "createProduct").length, 1);
  const tags = h.vault.secrets.get("poc-key-a1").tags;
  assert.equal(tags.models, "claude-haiku-4-5");
  assert.equal(tags.monthlyTokens, "5000");
  assert.equal(tags.product, one.product);
});

test("service: several models must be explicit, and expiry is recorded when asked for", async () => {
  const h = harness();
  h.service.setPackTemplate(TEMPLATE);
  const r = await h.service.issueProductKey(ADMIN, { owner: "alice@contoso.com", name: "multi", models: ["deepseek-v4-flash", "claude-sonnet-5"], monthlyTokens: 9000, expiresDays: 30 });
  assert.deepEqual(h.arm.products.get(r.product).apis.sort(), ["poc-claude", "poc-openai", "poc-probe"]);
  assert.equal(h.vault.secrets.get("poc-key-multi").tags.expires, "2026-11-15T09:00:00.000Z");
  await assert.rejects(h.service.issueProductKey(ADMIN, { owner: "a@contoso.com", name: "bad", models: ["nope"], monthlyTokens: 9 }), { status: 400 });
  await assert.rejects(h.service.issueProductKey(ADMIN, { owner: "a@contoso.com", name: "bad", models: ["claude-sonnet-5"], monthlyTokens: 0 }), { status: 400 });
  await assert.rejects(h.service.issueProductKey(ADMIN, { owner: "a@contoso.com", name: "bad", models: ["claude-sonnet-5"], monthlyTokens: 9, expiresDays: 0 }), { status: 400 });
});

test("service: a pack left without its policy by an earlier failure is repaired before reuse", async () => {
  const h = harness();
  h.service.setPackTemplate(TEMPLATE);
  const id = packId(["claude-haiku-4-5"], 5000);
  await h.arm.createProduct(id, { displayName: "half-made", description: "" });
  await h.service.issueProductKey(ADMIN, { owner: "alice@contoso.com", name: "fix", models: ["claude-haiku-4-5"], monthlyTokens: 5000 });
  assert.match(h.arm.products.get(id).policy, /"claude-haiku-4-5"\.Split/);
  assert.deepEqual(h.arm.products.get(id).apis.sort(), ["poc-claude", "poc-probe"]);
});