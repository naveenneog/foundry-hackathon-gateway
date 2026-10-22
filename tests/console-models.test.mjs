import { test } from "node:test";
import assert from "node:assert/strict";

import { pinsFromMaps, mapsFromPins, applyPin, applyUnpin, describeDeployments } from "../src/console/pinning.mjs";
import { buildCatalogue } from "../src/foundry.mjs";
import { harness, ADMIN, ALICE } from "./console.harness.mjs";

const dep = (name, format, model = name, state = "Succeeded") => ({ name, properties: { model: { name: model, format, version: "1" }, provisioningState: state } });
const catalogue = buildCatalogue([{ name: "aif", resourceGroup: "rg", location: "eastus2", deployments: [
  dep("deepseek-v4-flash", "DeepSeek"),
  dep("claude-haiku-4-5", "Anthropic"),
  dep("claude-sonnet-5", "Anthropic"),
  dep("gpt-x", "OpenAI", "gpt-x", "Creating"),
  dep("mystery", "Unheard"),
] }]);
const pins = pinsFromMaps({ openai: "flash=deepseek-v4-flash", claude: "haiku-4-5=claude-haiku-4-5" });

test("pinsFromMaps and mapsFromPins round-trip, and an empty route is written as the empty map", () => {
  assert.deepEqual(pins, { openai: [{ alias: "flash", deployment: "deepseek-v4-flash" }], claude: [{ alias: "haiku-4-5", deployment: "claude-haiku-4-5" }] });
  assert.deepEqual(mapsFromPins(pins), { openai: "flash=deepseek-v4-flash", claude: "haiku-4-5=claude-haiku-4-5" });
  assert.deepEqual(mapsFromPins({ openai: pins.openai, claude: [] }), { openai: "flash=deepseek-v4-flash", claude: ";" });
});

test("a pin goes to the deployment's own route, never the one asked for", () => {
  const next = applyPin(pins, catalogue, { alias: "sonnet-5", deployment: "claude-sonnet-5" });
  assert.deepEqual(next.claude.map((p) => p.alias), ["haiku-4-5", "sonnet-5"]);
  assert.throws(() => applyPin(pins, catalogue, { alias: "s5", deployment: "claude-sonnet-5", route: "openai" }), /Anthropic Messages/);
});

test("pinning refuses unknown, unready and unroutable deployments", () => {
  assert.throws(() => applyPin(pins, catalogue, { alias: "x", deployment: "nope" }), /not deployed/);
  assert.throws(() => applyPin(pins, catalogue, { alias: "x", deployment: "gpt-x" }), /Creating/);
  assert.throws(() => applyPin(pins, catalogue, { alias: "x", deployment: "mystery" }), /does not know how to route/);
});

test("pinning refuses duplicate aliases across routes, reserved Claude slots and malformed aliases", () => {
  assert.throws(() => applyPin(pins, catalogue, { alias: "flash", deployment: "claude-sonnet-5" }), /already pinned/);
  assert.throws(() => applyPin(pins, catalogue, { alias: "sonnet", deployment: "claude-sonnet-5" }), /Claude Code model slot/);
  for (const alias of ["", "a;b", "a=b", "UPPER ok?", "-lead", "x".repeat(65)]) {
    assert.throws(() => applyPin(pins, catalogue, { alias, deployment: "claude-sonnet-5" }), /Alias/, alias);
  }
});

test("unpinning removes one alias and refuses to remove the last pin", () => {
  const next = applyUnpin(pins, { alias: "flash", route: "openai" });
  assert.deepEqual(next.openai, []);
  assert.throws(() => applyUnpin(next, { alias: "haiku-4-5", route: "claude" }), /At least one model/);
  assert.throws(() => applyUnpin(pins, { alias: "nope", route: "openai" }), /not pinned/);
});

test("describeDeployments marks pins, the pin verdict and a suggested alias", () => {
  const d = describeDeployments(catalogue, pins);
  const haiku = d.find((x) => x.deployment === "claude-haiku-4-5");
  assert.deepEqual(haiku.pinnedAs, [{ alias: "haiku-4-5", route: "claude" }]);
  assert.equal(haiku.canPin.allowed, true);
  assert.equal(d.find((x) => x.deployment === "claude-sonnet-5").suggestedAlias, "sonnet-5");
  assert.equal(d.find((x) => x.deployment === "gpt-x").canPin.allowed, false);
});

test("service: listModels, pinModel and unpinModel are admin-only and write both named values", async () => {
  const h = harness();
  await assert.rejects(h.service.listModels(ALICE), { status: 403 });
  await assert.rejects(h.service.pinModel(ALICE, { alias: "sonnet-5", deployment: "claude-sonnet-5" }), { status: 403 });
  const list = await h.service.listModels(ADMIN);
  assert.ok(list.deployments.some((d) => d.deployment === "claude-sonnet-5"));
  const r = await h.service.pinModel(ADMIN, { alias: "sonnet-5", deployment: "claude-sonnet-5" });
  assert.deepEqual(r.pins.claude.map((p) => p.alias), ["haiku-4-5", "sonnet-5"]);
  assert.equal(h.arm.namedValues.get("hackgw-claude-model-map").value, "haiku-4-5=claude-haiku-4-5;sonnet-5=claude-sonnet-5");
  await assert.rejects(h.service.pinModel(ADMIN, { alias: "sonnet", deployment: "claude-sonnet-5" }), { status: 400 });
  await h.service.unpinModel(ADMIN, { alias: "flash", route: "openai" });
  assert.equal(h.arm.namedValues.get("hackgw-model-map").value, ";");
  assert.ok(h.audit.some((e) => e.action === "pin-model" && e.alias === "sonnet-5"));
});

test("service: config lists only ready, routable Foundry deployments for product keys", async () => {
  const h = harness();
  const cfg = await h.service.config();
  assert.deepEqual(cfg.deployments.map((d) => d.deployment).sort(), ["claude-haiku-4-5", "claude-sonnet-5", "deepseek-v4-flash"]);
  assert.equal(cfg.deployments.find((d) => d.deployment === "claude-sonnet-5").route, "claude");
});
