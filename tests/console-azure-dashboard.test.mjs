import { test } from "node:test";
import assert from "node:assert/strict";

import { keyVault, apim, foundryAccount, logAnalytics, AzureError } from "../src/console/azure.mjs";

function scripted(steps) {
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? "GET";
    seen.push({ method, url, headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined });
    const step = steps.shift();
    assert.ok(step, `unexpected call ${method} ${url}`);
    const [m, re, status, body, headers] = step;
    assert.equal(method, m, url);
    assert.match(url, re);
    const raw = typeof body === "string";
    return new Response(body === undefined ? null : raw ? body : JSON.stringify(body), { status, headers: headers ?? (raw ? {} : { "content-type": "application/json" }) });
  };
  return { fetchImpl, seen, steps };
}
const token = async (resource) => `TKN:${resource}`;
const noSleep = async () => {};
const APIM_ID = "/subscriptions/s/resourceGroups/rg/providers/Microsoft.ApiManagement/service/apim-x";
const AIF_ID = "/subscriptions/s/resourceGroups/rg-ai/providers/Microsoft.CognitiveServices/accounts/aif-x";

test("foundry: reads the account and every page of its deployments", async () => {
  const s = scripted([
    ["GET", /\/accounts\/aif-x\?api-version=2024-10-01$/, 200, { name: "aif-x", location: "eastus2" }],
    ["GET", /\/accounts\/aif-x\/deployments\?api-version=2024-10-01$/, 200, { value: [{ name: "a" }], nextLink: "https://management.azure.com/next?x=1" }],
    ["GET", /\/next\?x=1$/, 200, { value: [{ name: "b" }] }],
  ]);
  const f = foundryAccount({ accountId: AIF_ID, getToken: token, fetchImpl: s.fetchImpl, sleep: noSleep });
  const acct = await f.getAccount();
  assert.deepEqual(acct, { name: "aif-x", resourceGroup: "rg-ai", location: "eastus2", deployments: [{ name: "a" }, { name: "b" }] });
  assert.equal(s.seen[0].headers.Authorization, "Bearer TKN:https://management.azure.com");
  assert.throws(() => foundryAccount({ accountId: "/subscriptions/s/x", getToken: token }), AzureError);
});

test("apim: product create, policy, API link, subscription count and deletes", async () => {
  const s = scripted([
    ["GET", /\/products\/pk-1\?api-version=2024-05-01$/, 404, { error: { code: "ResourceNotFound" } }],
    ["PUT", /\/products\/pk-1\?api-version=2024-05-01$/, 201, { name: "pk-1" }],
    ["PUT", /\/products\/pk-1\/policies\/policy\?api-version=2024-05-01$/, 201, {}],
    ["PUT", /\/products\/pk-1\/apis\/poc-claude\?api-version=2024-05-01$/, 201, {}],
    ["GET", /\/products\/pk-1\/subscriptions\?\$top=1&api-version=2024-05-01$/, 200, { value: [{ name: "s" }] }],
    ["DELETE", /\/subscriptions\/poc-x\?api-version=2024-05-01$/, 200],
    ["DELETE", /\/products\/pk-1\?deleteSubscriptions=false&api-version=2024-05-01$/, 200],
  ]);
  const a = apim({ apimId: APIM_ID, getToken: token, fetchImpl: s.fetchImpl, sleep: noSleep });
  assert.equal(await a.getProduct("pk-1"), null);
  await a.createProduct("pk-1", { displayName: "D", description: "Models: x" });
  assert.deepEqual(s.seen[1].body.properties, { displayName: "D", description: "Models: x", subscriptionRequired: true, approvalRequired: false, state: "notPublished" });
  await a.setProductPolicy("pk-1", "<policies/>");
  assert.deepEqual(s.seen[2].body.properties, { format: "rawxml", value: "<policies/>" });
  await a.linkProductApi("pk-1", "poc-claude");
  assert.equal(await a.hasProductSubscriptions("pk-1"), true);
  await a.deleteSubscription("poc-x");
  assert.equal(s.seen[5].headers["If-Match"], "*");
  await a.deleteProduct("pk-1");
});

test("apim: deleting a subscription that is already gone is not an error", async () => {
  const s = scripted([["DELETE", /\/subscriptions\/gone\?/, 404, { error: { code: "ResourceNotFound" } }]]);
  await apim({ apimId: APIM_ID, getToken: token, fetchImpl: s.fetchImpl, sleep: noSleep }).deleteSubscription("gone");
});

test("key vault: deleteSecret is a soft delete and tolerates a missing secret", async () => {
  const s = scripted([
    ["DELETE", /\/secrets\/jwt-k-1\?api-version=7\.4$/, 200, {}],
    ["DELETE", /\/secrets\/gone\?api-version=7\.4$/, 404, { error: { code: "SecretNotFound" } }],
  ]);
  const v = keyVault({ vaultUrl: "https://kv.vault.azure.net", getToken: token, fetchImpl: s.fetchImpl, sleep: noSleep });
  await v.deleteSecret("jwt-k-1");
  await v.deleteSecret("gone");
});

test("log analytics: posts the query with a timespan and returns rows as objects", async () => {
  const s = scripted([["POST", /^https:\/\/api\.loganalytics\.io\/v1\/workspaces\/ws-1\/query$/, 200, {
    tables: [{ columns: [{ name: "KeyId" }, { name: "tokens" }], rows: [["k_1", 10], ["k_2", 5]] }],
  }]]);
  const la = logAnalytics({ workspaceId: "ws-1", getToken: token, fetchImpl: s.fetchImpl, sleep: noSleep });
  const rows = await la.query("AppMetrics | take 1", { timespan: "P7D" });
  assert.deepEqual(rows, [{ KeyId: "k_1", tokens: 10 }, { KeyId: "k_2", tokens: 5 }]);
  assert.deepEqual(s.seen[0].body, { query: "AppMetrics | take 1", timespan: "P7D" });
  assert.equal(s.seen[0].headers.Authorization, "Bearer TKN:https://api.loganalytics.io");
  assert.throws(() => logAnalytics({ workspaceId: "../x", getToken: token }), AzureError);
});

test("apim: a policy PUT that answers with the policy XML is a success, not a JSON error (found live)", async () => {
  const xml = "<!--\r\n    comment\r\n-->\r\n<policies />";
  const s = scripted([["PUT", /\/products\/pk-1\/policies\/policy\?/, 201, xml, { "content-type": "application/vnd.ms-azure-apim.policy.raw+xml; charset=utf-8" }]]);
  await apim({ apimId: APIM_ID, getToken: token, fetchImpl: s.fetchImpl, sleep: noSleep }).setProductPolicy("pk-1", xml);
});

test("an error response that is not JSON still reports its status, without the body", async () => {
  const s = scripted([["PUT", /\/products\/pk-1\/policies\/policy\?/, 400, "<error>bad <policies> near secret</error>", { "content-type": "text/xml" }]]);
  await assert.rejects(apim({ apimId: APIM_ID, getToken: token, fetchImpl: s.fetchImpl, sleep: noSleep }).setProductPolicy("pk-1", "<p/>"),
    (e) => e instanceof AzureError && e.status === 400 && !/secret/.test(e.message));
});