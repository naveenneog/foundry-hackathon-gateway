// P59, ADR-0019: an admin-set gateway URL (custom domain). Accepted only as https://<hostname>, saved
// only when ARM lists the hostname as a gateway (Proxy) hostname of this API Management, kept in
// Key Vault, audit-logged, and applied without a restart.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { parseGatewayOrigin, gatewayHostnames, GATEWAY_URL_SECRET, GATEWAY_URL_TTL_MS } from "../src/console/gateway-url.mjs";
import { apim } from "../src/console/azure.mjs";
import { createService } from "../src/console/service.mjs";
import { createHandler } from "../src/console/server.mjs";
import { harness, ADMIN, ALICE } from "./console.harness.mjs";

const CUSTOM = { type: "Proxy", hostName: "ai.contoso.example", certificateSource: "Managed", defaultSslBinding: true };
const withDomain = (h, ...entries) => { h.arm.hostnameConfigurations.push(CUSTOM, ...entries); return h; };

test("parseGatewayOrigin: https and a host name only, lowercased; no path, query, user info, other port, IP literal or wildcard", () => {
  for (const [input, origin] of [
    ["https://ai.contoso.example", "https://ai.contoso.example"],
    ["HTTPS://AI.Contoso.Example/", "https://ai.contoso.example"],
    ["https://ai.contoso.example:443", "https://ai.contoso.example"],
    ["  https://ai.contoso.example  ", "https://ai.contoso.example"],
    ["https://xn--bcher-kva.example", "https://xn--bcher-kva.example"],
  ]) assert.equal(parseGatewayOrigin(input), origin, input);
  for (const input of [
    "http://ai.contoso.example", "ai.contoso.example", "https://ai.contoso.example/v1", "https://ai.contoso.example/?x=1", "https://ai.contoso.example?x=1",
    "https://ai.contoso.example#top", "https://user@ai.contoso.example", "https://user:pw@ai.contoso.example", "https://ai.contoso.example:8443",
    "https://ai.contoso.example:", "https://10.0.0.1", "https://10.0.0.1:443", "https://[::1]", "https://ai.contoso.123", "https://*.contoso.example",
    "https://localhost", "https://ai_contoso.example", "https://-ai.contoso.example", "https://ai-.contoso.example", "https://ai..contoso.example",
    "https://ai.contoso.example.", "https://bücher.example", "https://ai.contoso.example\\@evil.example", "https://ai.contoso.example%2f",
    "https://ai.contoso.example /", "https:// ai.contoso.example", `https://${"a".repeat(64)}.example`, `https://${Array(64).fill("abc").join(".")}.example`,
    "", null, undefined, 42, ["https://ai.contoso.example"], { toString: () => "https://ai.contoso.example" },
  ]) assert.throws(() => parseGatewayOrigin(input), (e) => e.name === "InputError" && /https:\/\/ and a host name only/.test(e.message), String(input));
});

test("gatewayHostnames: the Proxy entries ARM reports, lowercased, without wildcards or other endpoint types", () => {
  assert.deepEqual(gatewayHostnames({ hostnameConfigurations: [
    { type: "Proxy", hostName: "apim-x.azure-api.net", certificateSource: "BuiltIn" }, { type: "Proxy", hostName: "AI.Contoso.Example" },
    { type: "Proxy", hostName: "*.contoso.example" }, { type: "DeveloperPortal", hostName: "developer.contoso.example" },
    { type: "Management", hostName: "mgmt.contoso.example" }, { type: "Portal", hostName: "portal.contoso.example" },
    { type: "Scm", hostName: "scm.contoso.example" }, { type: "ConfigurationApi", hostName: "config.contoso.example" }, { type: "Proxy" }, null,
  ] }), ["apim-x.azure-api.net", "ai.contoso.example"]);
  assert.deepEqual(gatewayHostnames({}), []);
  assert.deepEqual(gatewayHostnames(null), []);
});

test("the APIM adapter reads the service with the api-version it already uses and returns its hostname configurations", async () => {
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    seen.push({ url, method: init.method ?? "GET" });
    return new Response(JSON.stringify({ name: "apim-x", properties: { gatewayUrl: "https://apim-x.azure-api.net",
      hostnameConfigurations: [{ type: "Proxy", hostName: "apim-x.azure-api.net", certificateSource: "BuiltIn" }, { ...CUSTOM, certificateStatus: "Completed" }] } }),
    { status: 200, headers: { "content-type": "application/json" } });
  };
  const id = "/subscriptions/s/resourceGroups/rg/providers/Microsoft.ApiManagement/service/apim-x";
  const service = await apim({ apimId: id, getToken: async () => "TKN", fetchImpl }).getService();
  assert.deepEqual(seen, [{ url: `https://management.azure.com${id}?api-version=2024-05-01`, method: "GET" }]);
  assert.equal(service.gatewayUrl, "https://apim-x.azure-api.net");
  assert.deepEqual(gatewayHostnames(service), ["apim-x.azure-api.net", "ai.contoso.example"]);
});

test("setting the gateway URL: admin only, strict input, and only a gateway hostname of this API Management", async () => {
  const h = withDomain(harness(), { type: "DeveloperPortal", hostName: "developer.contoso.example" }, { type: "Proxy", hostName: "*.wild.example" });
  await assert.rejects(h.service.setGatewayUrl(ALICE, { url: "https://ai.contoso.example" }), { status: 403 });
  await assert.rejects(h.service.gatewayUrlStatus(ALICE), { status: 403 });
  await assert.rejects(h.service.resetGatewayUrl(ALICE), { status: 403 });
  await assert.rejects(h.service.setGatewayUrl(ADMIN, { url: "https://ai.contoso.example/v1" }), { status: 400, message: /https:\/\/ and a host name only/ });
  for (const url of ["https://developer.contoso.example", "https://api.wild.example", "https://elsewhere.example"]) {
    await assert.rejects(h.service.setGatewayUrl(ADMIN, { url }), { status: 400, message: /not a gateway hostname of this API Management\. Add it as a custom domain/ }, url);
  }
  assert.equal(h.vault.secrets.has(GATEWAY_URL_SECRET), false, "nothing stored after a refusal");
  assert.equal(h.audit.some((e) => /gateway-url/.test(e.action)), false);

  const r = await h.service.setGatewayUrl(ADMIN, { url: "HTTPS://AI.Contoso.Example/" });
  assert.equal(r.changed, true);
  assert.equal(r.effectiveUrl, "https://ai.contoso.example");
  assert.equal(r.apimUrl, "https://gw.example.net");
  const secret = h.vault.secrets.get(GATEWAY_URL_SECRET);
  assert.deepEqual(JSON.parse(secret.value), { url: "https://ai.contoso.example" });
  assert.equal(secret.contentType, "application/json");
  assert.deepEqual(secret.tags, { kind: "gateway-url", updatedBy: ADMIN.name, updatedAt: "2026-10-16T09:00:00.000Z" });
  const set = h.audit.find((e) => e.action === "set-gateway-url");
  assert.deepEqual({ actor: set.actor, from: set.from, to: set.to }, { actor: ADMIN.name, from: "https://gw.example.net", to: "https://ai.contoso.example" });

  const again = await h.service.setGatewayUrl(ADMIN, { url: "https://ai.contoso.example" });
  assert.equal(again.changed, false);
  assert.equal(h.vault.calls.filter(([op, name]) => op === "setSecret" && name === GATEWAY_URL_SECRET).length, 1, "an unchanged URL writes no new version");
});

test("reset writes an empty setting instead of deleting the secret, logs both URLs, and the API Management URL is back at once", async () => {
  const h = withDomain(harness());
  const before = await h.service.resetGatewayUrl(ADMIN);
  assert.equal(before.changed, false, "nothing to reset");
  assert.equal(h.vault.secrets.has(GATEWAY_URL_SECRET), false, "and nothing written");
  await h.service.setGatewayUrl(ADMIN, { url: "https://ai.contoso.example" });
  const r = await h.service.resetGatewayUrl(ADMIN);
  assert.equal(r.changed, true);
  assert.equal(r.effectiveUrl, "https://gw.example.net");
  assert.equal(r.customUrl, null);
  assert.deepEqual(JSON.parse(h.vault.secrets.get(GATEWAY_URL_SECRET).value), { url: null });
  assert.equal(h.vault.calls.some(([op]) => op === "deleteSecret"), false, "a deleted secret could not be written again while soft-deleted (U54)");
  const reset = h.audit.find((e) => e.action === "reset-gateway-url");
  assert.deepEqual({ from: reset.from, to: reset.to }, { from: "https://ai.contoso.example", to: "https://gw.example.net" });
  assert.equal((await h.service.config()).gatewayUrl, "https://gw.example.net");
  await h.service.setGatewayUrl(ADMIN, { url: "https://ai.contoso.example" });
  assert.equal((await h.service.config()).gatewayUrl, "https://ai.contoso.example", "it can be set again after a reset");
});

test("status: the URL in use, the API Management URL, who changed it, the gateway custom domains on offer and the propagation time", async () => {
  const h = withDomain(harness(), { type: "Proxy", hostName: "*.wild.example" }, { type: "Management", hostName: "mgmt.contoso.example" });
  const empty = await h.service.gatewayUrlStatus(ADMIN);
  assert.deepEqual(empty, { apimUrl: "https://gw.example.net", customUrl: null, effectiveUrl: "https://gw.example.net", verified: null,
    updatedBy: null, updatedAt: null, candidates: ["https://ai.contoso.example"], propagationSeconds: GATEWAY_URL_TTL_MS / 1000 });
  assert.equal(GATEWAY_URL_TTL_MS, 30_000);
  await h.service.setGatewayUrl(ADMIN, { url: "https://ai.contoso.example" });
  const set = await h.service.gatewayUrlStatus(ADMIN);
  assert.deepEqual([set.customUrl, set.effectiveUrl, set.verified, set.updatedBy], ["https://ai.contoso.example", "https://ai.contoso.example", true, ADMIN.name]);
});

test("another replica picks the change up within 30 s; a domain removed from API Management falls back to its URL; a bad stored value is ignored", async () => {
  const h = withDomain(harness());
  const other = createService({ vault: h.vault, arm: h.arm, foundry: h.foundry, clock: () => h.clock.now, gatewayUrl: "https://gw.example.net" });
  assert.equal((await other.config()).gatewayUrl, "https://gw.example.net");
  await h.service.setGatewayUrl(ADMIN, { url: "https://ai.contoso.example" });
  assert.equal((await h.service.config()).gatewayUrl, "https://ai.contoso.example", "the replica that saved it uses it at once");
  h.clock.now += GATEWAY_URL_TTL_MS - 1;
  assert.equal((await other.config()).gatewayUrl, "https://gw.example.net", "the other replica's answer is still cached");
  h.clock.now += 1;
  assert.equal((await other.config()).gatewayUrl, "https://ai.contoso.example", "and is refreshed after 30 s, without a restart");

  h.arm.hostnameConfigurations.splice(h.arm.hostnameConfigurations.indexOf(CUSTOM), 1);
  h.clock.now += GATEWAY_URL_TTL_MS;
  assert.equal((await h.service.config()).gatewayUrl, "https://gw.example.net", "the hostname is checked again when the setting is read again");
  const status = await h.service.gatewayUrlStatus(ADMIN);
  assert.deepEqual([status.customUrl, status.verified, status.effectiveUrl], ["https://ai.contoso.example", false, "https://gw.example.net"]);
  assert.match(status.problem, /no longer a gateway hostname of this API Management/);

  h.arm.hostnameConfigurations.push(CUSTOM, { type: "Proxy", hostName: "evil.example" });
  for (const value of ["not json", JSON.stringify({ url: "https://evil.example/x" }), JSON.stringify({ url: "http://evil.example" }), JSON.stringify({ url: 7 })]) {
    h.vault.secrets.get(GATEWAY_URL_SECRET).value = value;
    h.clock.now += GATEWAY_URL_TTL_MS;
    assert.equal((await h.service.config()).gatewayUrl, "https://gw.example.net", value);
    assert.match((await h.service.gatewayUrlStatus(ADMIN)).problem, /not a valid https origin/, value);
  }
});

test("the dashboard never sends a request to the admin-provided URL: the connection test still calls API Management's URL", async () => {
  const requests = [];
  const h = withDomain(harness({ inferenceFetch: async (url) => { requests.push(url); return Response.json({ ok: true }); } }));
  await h.service.migrateSigningSecret(ADMIN);
  await h.service.setGatewayUrl(ADMIN, { url: "https://ai.contoso.example" });
  assert.deepEqual(requests, [], "saving it sends nothing");
  const secondary = [...h.foundry.accounts.keys()].find((id) => id.endsWith("/aif-secondary"));
  const attached = await h.service.attachFoundry(ADMIN, { foundryId: secondary });
  await h.service.pinModel(ADMIN, { foundryId: secondary, alias: "flash", deployment: "deepseek-v4-flash" });
  await h.service.testFoundry(ADMIN, { foundryId: secondary, alias: "flash", route: "openai" });
  await h.service.testFoundry(ADMIN, { alias: "flash", route: "openai" });
  assert.deepEqual(requests, [`https://gw.example.net/foundry/${attached.connectionId}/v1/chat/completions`, "https://gw.example.net/v1/chat/completions"]);
  assert.equal(attached.gatewayUrl, `https://ai.contoso.example/foundry/${attached.connectionId}`, "while what it hands out names the custom domain");
});

test("over HTTP: GET and POST /api/gateway-url and POST /api/gateway-url/reset, same-origin JSON, admins only", async () => {
  const h = withDomain(harness());
  const principal = (who, role) => Buffer.from(JSON.stringify({ auth_typ: "aad", role_typ: "roles",
    claims: [{ typ: "preferred_username", val: who.name }, { typ: "roles", val: role }] })).toString("base64");
  const admin = { "x-ms-client-principal": principal(ADMIN, "Console.Admin") };
  const user = { "x-ms-client-principal": principal(ALICE, "Console.User") };
  const server = createServer(createHandler({ service: h.service, env: { WEBSITE_AUTH_ENABLED: "True" }, log: () => {} }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (who) => fetch(`${base}/api/gateway-url`, { headers: who });
  const post = (path, who, body, origin = base) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", origin, ...who }, body: JSON.stringify(body) });
  try {
    assert.equal((await get(user)).status, 403);
    const status = await get(admin);
    assert.equal(status.status, 200);
    assert.equal(status.headers.get("cache-control"), "no-store");
    assert.deepEqual((await status.json()).candidates, ["https://ai.contoso.example"]);
    assert.equal((await post("/api/gateway-url", user, { url: "https://ai.contoso.example" })).status, 403);
    assert.equal((await post("/api/gateway-url", admin, { url: "https://ai.contoso.example" }, "https://evil.example")).status, 403);
    assert.equal((await post("/api/gateway-url", admin, { url: "https://elsewhere.example" })).status, 400);
    const saved = await post("/api/gateway-url", admin, { url: "https://ai.contoso.example" });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).effectiveUrl, "https://ai.contoso.example");
    assert.equal((await post("/api/gateway-url/reset", user, {})).status, 403);
    const reset = await post("/api/gateway-url/reset", admin, {});
    assert.equal((await reset.json()).effectiveUrl, "https://gw.example.net");
  } finally {
    server.close();
  }
});
