import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, ADMIN, ALICE } from "./console.harness.mjs";

const selected = (h) => [...h.foundry.accounts.keys()][1];

test("all Foundries and fresh deployments appear; unconnected account can be browsed but not pinned", async () => {
  const h = harness();
  const result = await h.service.listFoundries(ADMIN);
  assert.equal(result.accounts.length, 2);
  assert.equal(result.accounts[0].connected, true);
  assert.equal(result.accounts[1].connected, false);
  const m = await h.service.listModels(ADMIN, { foundryId: selected(h) });
  assert.equal(m.connected, false);
  assert.deepEqual(m.pins, { openai: [], claude: [] });
  assert.ok(m.deployments.some((d) => d.deployment === "deepseek-v4-flash"));
  h.foundry.accounts.get(selected(h)).deployments.push({
    name: "newly-deployed", properties: { model: { name: "gpt-new", format: "OpenAI" }, provisioningState: "Succeeded" },
  });
  assert.ok((await h.service.listModels(ADMIN, { foundryId: selected(h) })).deployments.some((d) => d.deployment === "newly-deployed"));
  await assert.rejects(h.service.pinModel(ADMIN, { foundryId: selected(h), alias: "other", deployment: "deepseek-v4-flash" }), { status: 409 });
  await assert.rejects(h.service.listFoundries(ALICE), { status: 403 });
});

test("attach persists only after provisioning; duplicate names can be pinned independently", async () => {
  const h = harness();
  const id = selected(h);
  const r = await h.service.attachFoundry(ADMIN, { foundryId: id });
  assert.equal(r.attached, true);
  assert.match(r.gatewayUrl, /\/foundry\/f[0-9a-f]+$/);
  assert.match(r.setupCommand, /Connect-Foundry\.ps1/);
  assert.match(r.message, /permissions|network/i);
  assert.equal(h.arm.apis.size, 4);
  await h.service.pinModel(ADMIN, { foundryId: id, alias: "flash", deployment: "deepseek-v4-flash" });
  const other = await h.service.listModels(ADMIN, { foundryId: id });
  assert.deepEqual(other.pins.openai, [{ alias: "flash", deployment: "deepseek-v4-flash" }]);
  assert.equal(h.arm.namedValues.get("hackgw-model-map").value, "flash=deepseek-v4-flash");
  assert.equal((await h.service.listFoundries(ADMIN)).accounts[1].connected, true);
  await h.service.unpinModel(ADMIN, { foundryId: id, alias: "flash", route: "openai" }).then(
    () => assert.fail("last pin must stay"), (e) => assert.equal(e.status, 400));
});

test("partial attachment is not reported as connected, and retry repairs it", async () => {
  const h = harness();
  const original = h.arm.setApiPolicy;
  h.arm.setApiPolicy = async () => { throw new Error("policy rejected"); };
  await assert.rejects(h.service.attachFoundry(ADMIN, { foundryId: selected(h) }), /policy rejected/);
  assert.equal((await h.service.listFoundries(ADMIN)).accounts[1].connected, false);
  h.arm.setApiPolicy = original;
  await h.service.attachFoundry(ADMIN, { foundryId: selected(h) });
  assert.equal((await h.service.listFoundries(ADMIN)).accounts[1].connected, true);
  await assert.rejects(h.service.attachFoundry(ADMIN, { foundryId: selected(h).replace("/s/", "/foreign/") }), /configured subscription/);
});

test("connection test uses a bounded key on the selected routes and reports backend failures", async () => {
  let request;
  const h = harness({ inferenceFetch: async (url, options) => {
    request = { url, options };
    return Response.json({ error: "missing inference permission" }, { status: 403 });
  } });
  await h.service.migrateSigningSecret(ADMIN);
  const attached = await h.service.attachFoundry(ADMIN, { foundryId: selected(h) });
  await h.service.pinModel(ADMIN, { foundryId: selected(h), alias: "other", deployment: "deepseek-v4-flash" });
  const r = await h.service.testFoundry(ADMIN, { foundryId: selected(h), alias: "other", route: "openai" });
  assert.deepEqual([r.ok, r.status], [false, 403]);
  assert.match(r.detail, /permission|network/i);
  assert.equal(request.url, `${attached.gatewayUrl}/v1/chat/completions`);
  assert.equal(JSON.parse(request.options.body).max_tokens, 16);
  assert.equal(request.options.redirect, "error");
  assert.ok(!JSON.stringify(r).includes("eyJ"));
  await assert.rejects(h.service.testFoundry(ALICE, { foundryId: selected(h), alias: "other", route: "openai" }), { status: 403 });
});

test("DNS failure gets precise private-network guidance without exposing the backend body", async () => {
  const h = harness({ inferenceFetch: async () => Response.json({
    error: { message: "gateway_error: No such host is known. PRIVATE_RESPONSE_SENTINEL" },
  }, { status: 500 }) });
  await h.service.migrateSigningSecret(ADMIN);
  const r = await h.service.testFoundry(ADMIN, { alias: "flash", route: "openai" });
  assert.equal(r.code, "backend_dns");
  assert.match(r.detail, /private.*DNS/i);
  assert.ok(!JSON.stringify(r).includes("PRIVATE_RESPONSE_SENTINEL"));
  const selectedModel = await h.service.listModels(ADMIN);
  assert.match(selectedModel.networkCommand, /ConfigurePrivateEndpoint/);
});
