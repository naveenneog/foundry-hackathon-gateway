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
});

test("main: the scheduler sweeps on its interval, logs failures, and can be disabled", async () => {
  const ticks = [];
  const logs = [];
  const timers = [];
  const fakeTimers = { setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearInterval: () => {} };
  let fail = false;
  const service = { runRotationSweep: async () => { ticks.push(1); if (fail) throw new Error("vault down"); return { rotated: ["a"], failed: [] }; } };
  const stop = startScheduler({ service, minutes: 60, log: (e) => logs.push(e), timers: fakeTimers });
  assert.equal(timers[0].ms, 3_600_000);
  await timers[0].fn();
  fail = true;
  await timers[0].fn();
  assert.equal(ticks.length, 2);
  assert.ok(logs.some((e) => e.action === "rotation-sweep" && e.rotated === 1));
  assert.ok(logs.some((e) => e.level === "error" && /vault down/.test(e.error)));
  stop();
  assert.equal(startScheduler({ service, minutes: 0, log: () => {}, timers: fakeTimers }), null);
});
