import { test } from "node:test";
import assert from "node:assert/strict";
import { foundryDirectory } from "../src/console/azure-foundries.mjs";

const ID = "/subscriptions/sub/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/primary";
const OTHER = ID.replace("/rg/", "/other-rg/").replace("/primary", "/secondary");
const token = async () => "FAKE";

test("subscription discovery follows pages, includes both Foundry and OpenAI, and shows unreadable deployments", async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    if (url.includes("/subscriptions/sub/providers/")) return Response.json({
      value: [{ id: ID, name: "primary", kind: "AIServices", location: "eastus2", properties: { customSubDomainName: "primary" } }],
      nextLink: "https://management.azure.com/accounts-page-2",
    });
    if (url.endsWith("/accounts-page-2")) return Response.json({ value: [
      { id: OTHER, name: "secondary", kind: "OpenAI", location: "westus", properties: { customSubDomainName: "secondary" } },
      { id: ID.replace("/primary", "/speech"), name: "speech", kind: "SpeechServices" },
    ] });
    if (url.includes("/secondary/deployments")) return Response.json({ error: { code: "AuthorizationFailed", message: "No deployment read." } }, { status: 403 });
    if (url.includes("/primary/deployments")) return Response.json({ value: [{ name: "model-1" }], nextLink: "https://management.azure.com/deployments-page-2" });
    if (url.endsWith("/deployments-page-2")) return Response.json({ value: [{ name: "model-2" }] });
    throw new Error(`Unexpected ${url}`);
  };
  const f = foundryDirectory({ accountId: ID, getToken: token, fetchImpl, sleep: async () => {} });
  const accounts = await f.listAccounts();
  assert.deepEqual(accounts.map((a) => a.name), ["primary", "secondary"]);
  assert.deepEqual(accounts[0].deployments.map((d) => d.name), ["model-1", "model-2"]);
  assert.match(accounts[1].error, /AuthorizationFailed/);
  assert.equal(accounts[1].deployments.length, 0);
  assert.ok(seen.some((u) => u.endsWith("deployments-page-2")));
});

test("account lookup validates subscription and resource type before making any HTTP request", async () => {
  let calls = 0;
  const f = foundryDirectory({ accountId: ID, getToken: token, fetchImpl: async () => { calls++; throw new Error("unexpected"); } });
  for (const id of ["https://evil.test", ID.replace("/sub/", "/another/"), ID + "/deployments/model", ID.replace("accounts", "secrets")]) {
    await assert.rejects(f.getAccount(id), /account resource id|configured subscription/);
  }
  assert.equal(calls, 0);
});

test("discovery rejects an untrusted pagination origin and does not treat denied account listing as empty", async () => {
  const contacted = [];
  const f = foundryDirectory({ accountId: ID, getToken: token, fetchImpl: async (url) => {
    contacted.push(url);
    return Response.json({ value: [], nextLink: "https://evil.test/steal" });
  } });
  await assert.rejects(f.listAccounts(), /pagination/);
  assert.ok(contacted.every((url) => new URL(url).origin === "https://management.azure.com"), "never send a token-bearing request to the rejected origin");
  const denied = foundryDirectory({ accountId: ID, getToken: token, fetchImpl: async () =>
    Response.json({ error: { code: "AuthorizationFailed" } }, { status: 403 }) });
  await assert.rejects(denied.listAccounts(), /AuthorizationFailed/);
});

test("malformed ARM success responses are errors, not a misleading empty model list", async () => {
  for (const body of [{}, { value: "not-an-array" }]) {
    const f = foundryDirectory({ accountId: ID, getToken: token, fetchImpl: async () => Response.json(body) });
    await assert.rejects(f.listAccounts(), /ARM list response/);
  }
  const wrong = foundryDirectory({ accountId: ID, getToken: token, fetchImpl: async () =>
    Response.json({ id: OTHER, name: "other", kind: "AIServices" }) });
  await assert.rejects(wrong.getAccount(ID), /metadata does not match/);
});
