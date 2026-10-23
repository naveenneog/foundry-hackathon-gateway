import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { connectionInfo, accountEndpoints, provisionConnection } from "../src/console/connections.mjs";
import { fakeArm } from "./console.harness.mjs";

const ID = "/subscriptions/sub/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/second";
const account = { id: ID, name: "second", kind: "AIServices", properties: { customSubDomainName: "published-name" } };
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
export const templates = {
  openai: read("infra/policy.xml"), claude: read("infra/policy-claude.xml"),
  productOpenai: read("poc/products-keyvault/infra/api-openai-policy.xml"),
  productClaude: read("poc/products-keyvault/infra/api-claude-policy.xml"),
};

test("connections isolate account audiences, maps, routes and API ids while default stays unchanged", () => {
  const c = connectionInfo(account, "https://gw.example.net");
  const other = connectionInfo({ ...account, id: ID.replace("/second", "/third") }, "https://gw.example.net");
  assert.notEqual(c.id, other.id);
  assert.notEqual(c.audience, other.audience);
  assert.match(c.gatewayUrl, /^https:\/\/gw\.example\.net\/foundry\/f[0-9a-f]{12}$/);
  assert.notEqual(c.mapNames.openai, other.mapNames.openai);
  const legacy = connectionInfo(account, "https://gw.example.net", true);
  assert.equal(legacy.id, "default");
  assert.equal(legacy.gatewayUrl, "https://gw.example.net");
  assert.equal(legacy.audience, "hackathon-gateway");
  assert.equal(legacy.mapNames.openai, "hackgw-model-map");
});

test("backend hosts derive from ARM custom subdomain, not account name or submitted endpoints", () => {
  assert.deepEqual(accountEndpoints(account), {
    openai: "https://published-name.openai.azure.com/openai/v1",
    claude: "https://published-name.services.ai.azure.com/anthropic",
    audience: "https://ai.azure.com",
  });
  assert.equal(accountEndpoints({ ...account, kind: "OpenAI" }).audience, "https://ai.azure.com");
  assert.throws(() => accountEndpoints({ ...account, properties: { customSubDomainName: "evil.test/steal" } }), /subdomain/);
  assert.throws(() => accountEndpoints({ ...account, kind: "SpeechServices" }), /Foundry or Azure OpenAI/);
});

test("attachment provisions full policy copies, account-local model maps and operations; retry preserves pins", async () => {
  const arm = fakeArm();
  const c = connectionInfo(account, "https://gw.example.net");
  await provisionConnection(arm, c, account, templates);
  assert.equal(arm.backends.size, 2);
  assert.equal(arm.apis.size, 4);
  const openai = arm.apis.get(c.apiIds.openai);
  assert.equal(openai.properties.path, `foundry/${c.id}/v1`);
  assert.match(openai.policy, new RegExp(`<audience>${c.audience}</audience>`));
  assert.ok(openai.policy.includes(`{{${c.mapNames.openai}}}`));
  assert.ok(!openai.policy.includes("<audience>hackathon-gateway</audience>"));
  assert.ok(openai.policy.includes("validate-jwt") && openai.policy.includes("llm-token-limit"));
  assert.ok(openai.policy.includes(`backend-id="${c.backendIds.openai}"`));
  assert.deepEqual([...openai.operations.keys()].sort(), ["chat-completions", "list-models"]);
  assert.equal(openai.diagnostic.metrics, true);
  assert.deepEqual(openai.diagnostic.frontend.request, { headers: [], body: { bytes: 0 } });
  for (const [id, api] of arm.apis) {
    assert.ok(Buffer.byteLength(api.policy) <= 16 * 1024, `${id}: APIM's measured 16 KiB policy payload limit`);
    if (!id.includes("product")) {
      for (const guard of ["validate-jwt", "llm-token-limit", "grantedModels", "hackgw-revoked-keys"]) {
        assert.ok(api.policy.includes(guard), `${id} retains ${guard}`);
      }
    }
  }
  await arm.setNamedValue(c.mapNames.openai, "pinned=deployment", { secret: false });
  await provisionConnection(arm, c, account, templates);
  assert.equal(arm.namedValues.get(c.mapNames.openai).value, "pinned=deployment");
  assert.equal(arm.namedValues.get("hackgw-model-map").value, "flash=deepseek-v4-flash");
});

test("new and repaired APIs fail closed before any operation becomes reachable", async () => {
  const arm = fakeArm();
  const operation = arm.putOperation;
  arm.putOperation = async (apiId, id, properties) => {
    assert.ok(arm.apis.get(apiId).policy?.includes("attachment_incomplete"), "deny policy precedes reachable operations");
    return operation(apiId, id, properties);
  };
  const c = connectionInfo(account, "https://gw.example.net");
  await provisionConnection(arm, c, account, templates);
  await provisionConnection(arm, c, account, templates);
  assert.ok([...arm.apis.values()].every((a) => !a.policy.includes("attachment_incomplete")));
});
