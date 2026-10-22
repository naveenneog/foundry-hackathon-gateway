import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { harness, ADMIN, ALICE } from "./console.harness.mjs";
import { loadConfig, startScheduler } from "../src/console/main.mjs";

const run = (args, env = {}) => spawnSync(process.execPath, ["scripts/open-bundle.mjs", ...args], {
  encoding: "utf8", env: { ...process.env, ...env },
});

test("open-bundle: verifies, then decrypts to a file; tampered or unsigned bundles are refused", async () => {
  const { service } = harness();
  await service.migrateSigningSecret(ADMIN);
  const k = await service.issueJwt(ADMIN, { owner: ALICE.name, subject: "t", models: ["flash"], budget: 10, hours: 1 });
  const { bundle, passphrase } = await service.exportBundle(ADMIN, { names: [k.name], recipient: "Alice" });
  const dir = mkdtempSync(join(tmpdir(), "bundle-"));
  try {
    writeFileSync(join(dir, "b.json"), JSON.stringify(bundle));
    writeFileSync(join(dir, "key.json"), JSON.stringify(await service.bundlePublicKey()));
    const out = join(dir, "keys.json");
    const ok = run([join(dir, "b.json"), "--key", join(dir, "key.json"), "--out", out], { BUNDLE_PASSPHRASE: passphrase });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stderr, /Signed by admin@contoso\.com/);
    assert.ok(!ok.stdout.includes(k.token) && !ok.stderr.includes(k.token), "the key is written to the file, not the terminal");
    assert.equal(JSON.parse(readFileSync(out, "utf8")).keys[0].value, k.token);

    const tampered = structuredClone(bundle);
    tampered.header.recipient = "Mallory";
    writeFileSync(join(dir, "t.json"), JSON.stringify(tampered));
    const bad = run([join(dir, "t.json"), "--key", join(dir, "key.json"), "--out", join(dir, "x.json")], { BUNDLE_PASSPHRASE: passphrase });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /Bad signature/);

    const wrong = run([join(dir, "b.json"), "--key", join(dir, "key.json"), "--out", join(dir, "y.json")], { BUNDLE_PASSPHRASE: "definitely the wrong one" });
    assert.equal(wrong.status, 1);
    assert.match(wrong.stderr, /wrong passphrase/);
    assert.equal(run([]).status, 2, "usage");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("main: configuration is validated before the server starts", () => {
  const good = { KEY_VAULT_URL: "https://kv-x.vault.azure.net", APIM_RESOURCE_ID: "/subscriptions/s/resourceGroups/r/providers/Microsoft.ApiManagement/service/a",
    GATEWAY_URL: "https://a.azure-api.net" };
  const c = loadConfig(good);
  assert.equal(c.port, 8080);
  assert.equal(c.sweepMinutes, 60);
  assert.equal(loadConfig({ ...good, ROTATION_SWEEP_MINUTES: "0" }).sweepMinutes, 0);
  assert.throws(() => loadConfig({ ...good, KEY_VAULT_URL: "http://kv-x.vault.azure.net" }), /KEY_VAULT_URL/);
  assert.throws(() => loadConfig({ ...good, GATEWAY_URL: "" }), /GATEWAY_URL/);
  assert.throws(() => loadConfig({ ...good, ROTATION_SWEEP_MINUTES: "-1" }), /ROTATION_SWEEP_MINUTES/);
  assert.equal(c.foundryAccountId, null);
  assert.equal(c.workspaceId, null);
  const full = loadConfig({ ...good, FOUNDRY_ACCOUNT_ID: "/subscriptions/s/resourceGroups/r/providers/Microsoft.CognitiveServices/accounts/aif", LOG_WORKSPACE_ID: "0b6f2c1e-1111-2222-3333-444455556666" });
  assert.equal(full.workspaceId, "0b6f2c1e-1111-2222-3333-444455556666");
  assert.throws(() => loadConfig({ ...good, FOUNDRY_ACCOUNT_ID: "/subscriptions/s/x" }), /FOUNDRY_ACCOUNT_ID/);
  assert.throws(() => loadConfig({ ...good, LOG_WORKSPACE_ID: "../x" }), /LOG_WORKSPACE_ID/);
});

test("main: the scheduler sweeps on its interval, logs failures, and can be disabled", async () => {
  const ticks = [];
  const logs = [];
  const timers = [];
  const fakeTimers = { setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearInterval: () => {} };
  let fail = false;
  const service = { runSweep: async () => { ticks.push(1); if (fail) throw new Error("vault down"); return { rotated: ["a"], archived: ["b", "c"], deleted: [], failed: [] }; } };
  const stop = startScheduler({ service, minutes: 60, log: (e) => logs.push(e), timers: fakeTimers });
  assert.equal(timers[0].ms, 3_600_000);
  await timers[0].fn();
  fail = true;
  await timers[0].fn();
  assert.equal(ticks.length, 2);
  assert.ok(logs.some((e) => e.action === "sweep" && e.rotated === 1 && e.archived === 2 && e.deleted === 0));
  assert.ok(logs.some((e) => e.level === "error" && /vault down/.test(e.error)));
  stop();
  assert.equal(startScheduler({ service, minutes: 0, log: () => {}, timers: fakeTimers }), null);
});

test("automation: one sweep, a summary log line, and a failing exit code when any key failed", async () => {
  const { runOnce } = await import("../src/console/automation.mjs");
  const logs = [];
  const ok = await runOnce({ service: { runSweep: async () => ({ rotated: ["a"], archived: [], deleted: ["d"], failed: [] }) }, log: (e) => logs.push(e) });
  assert.equal(ok, 0);
  assert.deepEqual(logs.at(-1), { level: "info", actor: "automation", action: "sweep", rotated: 1, archived: 0, deleted: 1, failed: [] });
  assert.equal(await runOnce({ service: { runSweep: async () => ({ rotated: [], archived: [], deleted: [], failed: ["x"] }) }, log: () => {} }), 1);
  assert.equal(await runOnce({ service: { runSweep: async () => { throw new Error("vault down"); } }, log: (e) => logs.push(e) }), 1);
  assert.ok(logs.some((e) => e.level === "error" && /vault down/.test(e.error)));
});