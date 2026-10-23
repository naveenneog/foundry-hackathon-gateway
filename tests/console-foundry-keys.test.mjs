import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { harness, ADMIN } from "./console.harness.mjs";
import { decodeUnsafe, verifyKey } from "../src/keys.mjs";

const TEMPLATE = readFileSync(new URL("../poc/products-keyvault/infra/product-policy.xml", import.meta.url), "utf8");
async function setup() {
  const h = harness();
  h.service.setPackTemplate(TEMPLATE);
  await h.service.migrateSigningSecret(ADMIN);
  const id = [...h.foundry.accounts.keys()][1];
  const connection = await h.service.attachFoundry(ADMIN, { foundryId: id });
  await h.service.pinModel(ADMIN, { foundryId: id, alias: "secondary", deployment: "deepseek-v4-flash" });
  return { ...h, id, connection };
}
const jwt = { owner: "a@contoso.com", subject: "team", models: ["secondary"], budget: 1000, hours: 1 };

test("selected short-lived keys bind audience, metadata and client URLs; legacy keys remain unchanged", async () => {
  const h = await setup();
  const cfg = await h.service.config({ foundryId: h.id });
  assert.equal(cfg.foundryId, h.id);
  assert.equal(cfg.gatewayUrl, h.connection.gatewayUrl);
  assert.deepEqual(cfg.models.openai, ["secondary"]);
  assert.equal(cfg.foundries.length, 2);
  const k = await h.service.issueJwt(ADMIN, { ...jwt, foundryId: h.id });
  const claims = decodeUnsafe(k.token);
  assert.equal(claims.aud, `hackathon-gateway-${h.connection.connectionId}`);
  const secret = h.vault.secrets.get("gw-signing-secret").value;
  assert.throws(() => verifyKey(k.token, secret), /audience/i);
  assert.equal(verifyKey(k.token, secret, { audience: claims.aud }).jti, k.jti);
  assert.equal(k.handout.env.OPENAI_BASE_URL, `${h.connection.gatewayUrl}/v1`);
  assert.equal(h.vault.secrets.get(k.name).tags.foundry, h.connection.connectionId);
  assert.equal((await h.service.revealKey(ADMIN, k.name)).handout.env.OPENAI_BASE_URL, `${h.connection.gatewayUrl}/v1`);
  const old = await h.service.issueJwt(ADMIN, { ...jwt, models: ["flash"] });
  assert.equal(decodeUnsafe(old.token).aud, "hackathon-gateway");
  assert.equal(old.handout.env.OPENAI_BASE_URL, "https://gw.example.net/v1");
  await assert.rejects(h.service.issueJwt(ADMIN, jwt), { status: 400 }, "no pin from another account");
});

test("bulk issue and CSVs target the selected Foundry rather than the configured default", async () => {
  const h = await setup();
  const r = await h.service.issueJwtBulk(ADMIN, { ...jwt, foundryId: h.id, entries: [{ owner: jwt.owner, subject: "batch" }] });
  assert.match(r.keysCsv, new RegExp(`${h.connection.gatewayUrl}/v1`));
  assert.equal(decodeUnsafe(r.issued[0].token).aud, `hackathon-gateway-${h.connection.connectionId}`);
  const p = await h.service.issueProductBulk(ADMIN, { foundryId: h.id, models: ["deepseek-v4-flash"], monthlyTokens: 1000,
    entries: [{ owner: jwt.owner, name: "selected" }] });
  assert.ok(p.keysCsv.includes(`${h.connection.gatewayUrl}/poc/v1`));
  const reveal = await h.service.revealKey(ADMIN, p.issued[0].name);
  assert.ok(reveal.handout.curl.includes(`${h.connection.gatewayUrl}/poc/v1`));
  assert.equal(reveal.handout.claudeSettings, null, "an OpenAI-only key must not suggest an ungranted Claude model");
});

test("product packs cannot mix accounts even when deployment names and budgets are identical", async () => {
  const h = await setup();
  const common = { owner: jwt.owner, models: ["deepseek-v4-flash"], monthlyTokens: 1000 };
  const selected = await h.service.issueProductKey(ADMIN, { ...common, foundryId: h.id, name: "secondary-prod" });
  const legacy = await h.service.issueProductKey(ADMIN, { ...common, name: "primary-prod" });
  assert.notEqual(selected.product, legacy.product);
  const apis = h.arm.products.get(selected.product).apis;
  assert.ok(apis.every((a) => a === "poc-probe" || a.includes(h.connection.connectionId)));
  assert.ok(!apis.includes("poc-openai"));
});

test("unknown/unattached selection cannot silently issue against the default account", async () => {
  const h = harness();
  await h.service.migrateSigningSecret(ADMIN);
  const other = [...h.foundry.accounts.keys()][1];
  await assert.rejects(h.service.issueJwt(ADMIN, { ...jwt, foundryId: other }), { status: 409 });
  await assert.rejects(h.service.issueProductKey(ADMIN, { owner: jwt.owner, name: "nope", foundryId: other, models: ["deepseek-v4-flash"], monthlyTokens: 1000 }), { status: 409 });
  assert.equal(h.arm.subscriptions.size, 0);
  for (const foundryId of [false, 0, {}, []]) {
    await assert.rejects(h.service.issueJwt(ADMIN, { ...jwt, foundryId }), { status: 400 }, "malformed IDs are boundary errors");
  }
});
