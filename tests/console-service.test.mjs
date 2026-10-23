import { test } from "node:test";
import assert from "node:assert/strict";

import { verifyKey, decodeUnsafe } from "../src/keys.mjs";
import { openBundle } from "../src/console/bundle.mjs";
import { harness, ADMIN, ALICE, BOB } from "./console.harness.mjs";

const jwtBody = (over = {}) => ({ owner: ALICE.name, subject: "team-1", models: ["flash", "haiku-4-5"], budget: 50000, hours: 24, ...over });

test("signing secret: issuing refuses until the vault holds it; migrate copies APIM's value once", async () => {
  const { service, vault, arm, audit } = harness();
  await assert.rejects(service.issueJwt(ADMIN, jwtBody()), (e) => e.status === 409 && /signing secret/i.test(e.message));
  assert.deepEqual(await service.signingStatus(ADMIN), { vault: false, apim: true, inSync: false });

  await service.migrateSigningSecret(ADMIN);
  assert.equal((await vault.getSecret("gw-signing-secret")).value, arm.namedValues.get("hackgw-signing-key").value);
  assert.deepEqual(await service.signingStatus(ADMIN), { vault: true, apim: true, inSync: true });
  assert.ok(!JSON.stringify(audit).includes(arm.namedValues.get("hackgw-signing-key").value), "secret never logged");

  // A second migration with a different APIM value must not overwrite the vault silently.
  arm.namedValues.get("hackgw-signing-key").value = Buffer.alloc(32, 7).toString("base64");
  await assert.rejects(service.migrateSigningSecret(ADMIN), (e) => e.status === 409);
});

test("signing secret: push and rotate need explicit confirmation and make APIM match the vault", async () => {
  const { service, vault, arm } = harness();
  await service.migrateSigningSecret(ADMIN);
  await assert.rejects(service.rotateSigningSecret(ADMIN, {}), (e) => e.status === 400);
  await service.rotateSigningSecret(ADMIN, { confirm: "ROTATE" });
  const v = (await vault.getSecret("gw-signing-secret")).value;
  assert.equal(arm.namedValues.get("hackgw-signing-key").value, v);
  assert.equal(arm.namedValues.get("hackgw-signing-key").secret, true);

  arm.namedValues.get("hackgw-signing-key").value = Buffer.alloc(32, 9).toString("base64");
  assert.equal((await service.signingStatus(ADMIN)).inSync, false);
  await assert.rejects(service.pushSigningSecret(ADMIN, {}), (e) => e.status === 400);
  await service.pushSigningSecret(ADMIN, { confirm: "PUSH" });
  assert.equal((await service.signingStatus(ADMIN)).inSync, true);
});

test("signed keys: minted from the vault secret, stored with owner tags, verifiable by the gateway's rules", async () => {
  const { service, vault, audit } = harness();
  await service.migrateSigningSecret(ADMIN);
  const r = await service.issueJwt(ADMIN, jwtBody({ label: "demo" }));
  const secret = (await vault.getSecret("gw-signing-secret")).value;
  const claims = verifyKey(r.token, secret);
  assert.equal(claims.sub, "team-1");
  assert.deepEqual(claims.models, ["flash", "haiku-4-5"]);
  assert.equal(claims.expiresAt - claims.notBefore, 24 * 3600 * 1000);
  const stored = await vault.getSecret(r.name);
  assert.equal(r.name, `jwt-${r.jti.replace("_", "-")}`);
  assert.equal(stored.value, r.token);
  assert.equal(stored.tags.kind, "jwt");
  assert.equal(stored.tags.owner, ALICE.name);
  assert.equal(stored.tags.revoked, "false");
  assert.equal(r.handout.claudeSettings.env.ANTHROPIC_BASE_URL, "https://gw.example.net/claude");
  assert.ok(audit.some((e) => e.action === "issue-jwt" && e.actor === ADMIN.name && e.jti === r.jti));
  assert.ok(!JSON.stringify(audit).includes(r.token));
  await assert.rejects(service.issueJwt(ALICE, jwtBody()), (e) => e.status === 403);
  await assert.rejects(service.issueJwt(ADMIN, jwtBody({ models: ["gpt-9"] })), (e) => e.status === 400);
});

test("listing and reveal: admin only; a key's owner is refused (ADR-0016)", async () => {
  const { service } = harness();
  await service.migrateSigningSecret(ADMIN);
  const a = await service.issueJwt(ADMIN, jwtBody());
  const b = await service.issueJwt(ADMIN, jwtBody({ owner: BOB.name, subject: "team-2" }));
  const p = await service.issueProductKey(ADMIN, { owner: ALICE.name, name: "alice-pack", product: "poc-tiny-pack" });

  await assert.rejects(service.listKeys(ALICE), (e) => e.status === 403);
  const all = await service.listKeys(ADMIN);
  assert.deepEqual(all.map((k) => k.name).sort(), [a.name, b.name, p.name].sort());
  assert.ok(all.every((k) => !("value" in k)), "listing never carries values");
  assert.equal((await service.listKeys(ADMIN)).filter((k) => k.kind).length >= 3, true);
  assert.ok(!(await service.listKeys(ADMIN)).some((k) => k.name === "gw-signing-secret"));

  const revealed = await service.revealKey(ADMIN, a.name);
  assert.equal(revealed.value, a.token);
  await assert.rejects(service.revealKey(ALICE, a.name), (e) => e.status === 403, "not even the owner");
  await assert.rejects(service.revealKey(ADMIN, "nope-missing"), (e) => e.status === 404);
  await assert.rejects(service.revealKey(ADMIN, "gw-signing-secret"), (e) => e.status === 404, "the signing secret is never revealable");
  const pr = await service.revealKey(ADMIN, p.name);
  assert.equal(pr.handout.claudeSettings.env.ANTHROPIC_API_KEY, pr.value);
});

test("revocation: adds the jti to the gateway's list, tags the secret, and is idempotent", async () => {
  const { service, arm, vault } = harness();
  await service.migrateSigningSecret(ADMIN);
  const a = await service.issueJwt(ADMIN, jwtBody());
  await assert.rejects(service.revokeJwt(ALICE, a.name), (e) => e.status === 403);
  await service.revokeJwt(ADMIN, a.name);
  await service.revokeJwt(ADMIN, a.name);
  assert.equal(arm.namedValues.get("hackgw-revoked-keys").value, `,${a.jti},`);
  assert.equal((await vault.getSecret(a.name)).tags.revoked, "true");
  assert.equal(decodeUnsafe((await vault.getSecret(a.name)).value).jti, a.jti);
});

test("product keys: issue, rotate alternates slots and refreshes the vault, suspend and resume", async () => {
  const { service, arm, vault, clock } = harness();
  const p = await service.issueProductKey(ADMIN, { owner: ALICE.name, name: "alice-pack", product: "poc-claude-pack", rotateDays: 7 });
  const sub = arm.subscriptions.get("poc-alice-pack");
  assert.equal(sub.scope, "/products/poc-claude-pack");
  let s = await vault.getSecret("poc-key-alice-pack");
  assert.equal(s.value, sub.primaryKey);
  assert.equal(s.contentType, "API Management subscription key");
  assert.deepEqual([s.tags.slot, s.tags.kind, s.tags.owner, s.tags.rotateDays], ["primary", "product", ALICE.name, "7"]);
  await assert.rejects(service.issueProductKey(ADMIN, { owner: ALICE.name, name: "alice-pack", product: "poc-claude-pack" }), (e) => e.status === 409);

  const oldPrimary = sub.primaryKey;
  clock.now += 1000;
  await service.rotateProductKey(ADMIN, p.name);
  s = await vault.getSecret(p.name);
  assert.equal(s.tags.slot, "secondary");
  assert.equal(s.value, sub.secondaryKey);
  assert.equal(sub.primaryKey, oldPrimary, "the slot in use is not regenerated");
  assert.equal(s.tags.rotatedAt, new Date(clock.now).toISOString());
  await service.rotateProductKey(ADMIN, p.name);
  assert.equal((await vault.getSecret(p.name)).tags.slot, "primary");
  assert.notEqual(sub.primaryKey, oldPrimary);

  await service.setProductState(ADMIN, p.name, "suspended");
  assert.equal(sub.state, "suspended");
  assert.equal((await vault.getSecret(p.name)).tags.state, "suspended");
  await service.setProductState(ADMIN, p.name, "active");
  assert.equal(sub.state, "active");
  await assert.rejects(service.setProductState(ADMIN, p.name, "deleted"), (e) => e.status === 400);
  await assert.rejects(service.rotateProductKey(ALICE, p.name), (e) => e.status === 403);
});

test("automation: the sweep rotates only enrolled, due keys and survives one failure", async () => {
  const { service, arm, vault, clock, audit } = harness();
  await service.issueProductKey(ADMIN, { owner: ALICE.name, name: "due-pack", product: "poc-tiny-pack", rotateDays: 1 });
  await service.issueProductKey(ADMIN, { owner: ALICE.name, name: "manual-pack", product: "poc-tiny-pack" });
  await service.issueProductKey(ADMIN, { owner: BOB.name, name: "broken-pack", product: "poc-tiny-pack", rotateDays: 1 });
  arm.subscriptions.delete("poc-broken-pack");
  await service.setAutomation(ADMIN, "poc-key-manual-pack", null);

  assert.deepEqual(await service.runRotationSweep(), { rotated: [], failed: [] }, "nothing due yet");
  clock.now += 2 * 86_400_000;
  const r = await service.runRotationSweep();
  assert.deepEqual(r.rotated, ["poc-key-due-pack"]);
  assert.deepEqual(r.failed, ["poc-key-broken-pack"]);
  assert.equal((await vault.getSecret("poc-key-manual-pack")).tags.slot, "primary");
  assert.ok(audit.some((e) => e.action === "rotate-product" && e.actor === "scheduler"));

  await service.setAutomation(ADMIN, "poc-key-manual-pack", 30);
  assert.equal((await vault.getSecret("poc-key-manual-pack")).tags.rotateDays, "30");
  await assert.rejects(service.setAutomation(ADMIN, "poc-key-manual-pack", 365), (e) => e.status === 400);
  await assert.rejects(service.setAutomation(ALICE, "poc-key-manual-pack", 7), (e) => e.status === 403);
});

test("export: admin-only, signed by the vault key, opens with the published key, generated passphrase shown once", async () => {
  const { service } = harness();
  await service.migrateSigningSecret(ADMIN);
  const a = await service.issueJwt(ADMIN, jwtBody());
  const p = await service.issueProductKey(ADMIN, { owner: ALICE.name, name: "alice-pack", product: "poc-tiny-pack" });

  await assert.rejects(service.exportBundle(ALICE, { names: [a.name], recipient: "Alice" }), (e) => e.status === 403);
  await assert.rejects(service.exportBundle(ADMIN, { names: [], recipient: "Alice" }), (e) => e.status === 400);
  await assert.rejects(service.exportBundle(ADMIN, { names: ["gw-signing-secret"], recipient: "Alice" }), (e) => e.status === 404);

  const out = await service.exportBundle(ADMIN, { names: [a.name, p.name], recipient: "Alice (team-1)" });
  assert.ok(out.passphrase.length >= 16);
  assert.match(out.filename, /^keys-.*\.bundle\.json$/);
  const jwk = await service.bundlePublicKey();
  const opened = openBundle(out.bundle, { passphrase: out.passphrase, publicJwk: jwk });
  assert.equal(opened.header.issuedBy.name, ADMIN.name);
  assert.equal(opened.header.recipient, "Alice (team-1)");
  assert.deepEqual(opened.payload.keys.map((k) => k.name), [a.name, p.name]);
  assert.equal(opened.payload.keys[0].value, a.token);

  const own = await service.exportBundle(ADMIN, { names: [a.name], recipient: "x", passphrase: "admin chosen passphrase" });
  assert.equal(own.passphrase, undefined, "an admin-chosen passphrase is never echoed");
  assert.equal(openBundle(own.bundle, { passphrase: "admin chosen passphrase", publicJwk: jwk }).payload.keys.length, 1);
});
