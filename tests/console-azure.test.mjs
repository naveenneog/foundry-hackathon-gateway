import { test } from "node:test";
import assert from "node:assert/strict";

import { managedIdentity, keyVault, apim, AzureError } from "../src/console/azure.mjs";

/** A scripted fetch: each call is matched in order against [method, url-regex, status, body, headers]. */
function scripted(steps) {
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? "GET";
    seen.push({ method, url, headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined });
    const step = steps.shift();
    assert.ok(step, `unexpected call ${method} ${url}`);
    const [m, re, status, body, headers = {}] = step;
    assert.equal(method, m, url);
    assert.match(url, re);
    return new Response(body === undefined ? null : JSON.stringify(body), { status, headers });
  };
  return { fetchImpl, seen, steps };
}
const token = async () => "TKN";
const noSleep = async () => {};
const VAULT = "https://kv-test.vault.azure.net";
const APIM_ID = "/subscriptions/s/resourceGroups/rg/providers/Microsoft.ApiManagement/service/apim-x";

test("managed identity: uses the App Service endpoint and header, and caches until near expiry", async () => {
  let now = 1_000_000;
  const s = scripted([["GET", /^https:\/\/mi\.local\/token\?resource=https%3A%2F%2Fvault\.azure\.net&api-version=2019-08-01$/, 200,
    { access_token: "A", expires_on: String(Math.floor(now / 1000) + 3600) }]]);
  const get = managedIdentity({ env: { IDENTITY_ENDPOINT: "https://mi.local/token", IDENTITY_HEADER: "H" }, fetchImpl: s.fetchImpl, now: () => now });
  assert.equal(await get("https://vault.azure.net"), "A");
  assert.equal(s.seen[0].headers["X-IDENTITY-HEADER"], "H");
  now += 60_000;
  assert.equal(await get("https://vault.azure.net"), "A", "cached");
  await assert.rejects(managedIdentity({ env: {} })("x"), AzureError);
});

test("key vault: secrets, tags by version, paged listing, keys and ES256 signing", async () => {
  const s = scripted([
    ["GET", /\/secrets\/missing\?api-version=7\.4$/, 404, { error: { code: "SecretNotFound" } }],
    ["PUT", /\/secrets\/jwt-k-1\?api-version=7\.4$/, 200, { id: `${VAULT}/secrets/jwt-k-1/abc`, value: "V", tags: { kind: "jwt" } }],
    ["GET", /\/secrets\/jwt-k-1\?api-version=7\.4$/, 200, { id: `${VAULT}/secrets/jwt-k-1/abc`, value: "V", tags: {} }],
    ["PATCH", /\/secrets\/jwt-k-1\/abc\?api-version=7\.4$/, 200, { tags: { revoked: "true" } }],
    ["GET", /\/secrets\?api-version=7\.4&maxresults=25$/, 200, { value: [{ id: `${VAULT}/secrets/a`, tags: { kind: "jwt" } }], nextLink: `${VAULT}/secrets?page=2` }],
    ["GET", /\/secrets\?page=2$/, 200, { value: [{ id: `${VAULT}/secrets/b`, contentType: "API Management subscription key" }] }],
    ["GET", /\/keys\/bundle-signing\?api-version=7\.4$/, 404, {}],
    ["POST", /\/keys\/bundle-signing\/create\?api-version=7\.4$/, 200, { key: { kid: `${VAULT}/keys/bundle-signing/v1`, kty: "EC", crv: "P-256", x: "X", y: "Y" } }],
    ["POST", /\/keys\/bundle-signing\/v1\/sign\?api-version=7\.4$/, 200, { value: Buffer.alloc(64, 1).toString("base64url") }],
  ]);
  const kv = keyVault({ vaultUrl: `${VAULT}/`, getToken: token, fetchImpl: s.fetchImpl, sleep: noSleep });
  assert.equal(await kv.getSecret("missing"), null);
  const put = await kv.setSecret("jwt-k-1", "V", { tags: { kind: "jwt" }, contentType: "application/jwt" });
  assert.equal(put.version, "abc");
  assert.deepEqual(s.seen[1].body, { value: "V", tags: { kind: "jwt" }, contentType: "application/jwt" });
  assert.equal(s.seen[1].headers.Authorization, "Bearer TKN");
  await kv.updateTags("jwt-k-1", { revoked: "true" });
  assert.deepEqual(s.seen[3].body, { tags: { revoked: "true" } }, "tag updates never resend the value");
  assert.deepEqual((await kv.listSecrets()).map((x) => x.name), ["a", "b"]);
  assert.equal(await kv.getKey("bundle-signing"), null);
  const k = await kv.createKey("bundle-signing");
  assert.deepEqual(s.seen[7].body, { kty: "EC", crv: "P-256", key_ops: ["sign", "verify"] });
  const sig = await kv.sign(k.kid, Buffer.alloc(32, 2));
  assert.equal(sig.length, 64);
  assert.deepEqual(s.seen[8].body, { alg: "ES256", value: Buffer.alloc(32, 2).toString("base64url") });
  await assert.rejects(kv.sign("https://evil.vault.azure.net/keys/x/1", Buffer.alloc(32)), /outside this vault/);
  assert.equal(s.steps.length, 0);
});

test("azure errors name the path but never the body, and retry throttling", async () => {
  const s = scripted([
    ["PUT", /secrets\/x/, 429, {}, { "retry-after": "0" }],
    ["PUT", /secrets\/x/, 403, { error: { code: "Forbidden", message: "Caller is not authorized" } }],
  ]);
  const kv = keyVault({ vaultUrl: VAULT, getToken: token, fetchImpl: s.fetchImpl, sleep: noSleep });
  await assert.rejects(kv.setSecret("x", "SUPER-SECRET-VALUE"), (e) => {
    assert.equal(e.status, 403);
    assert.match(e.message, /PUT https:\/\/kv-test\.vault\.azure\.net\/secrets\/x failed \(403\): Forbidden/);
    assert.ok(!e.message.includes("SUPER-SECRET-VALUE"));
    assert.ok(!e.message.includes("api-version"));
    return true;
  });
});

test("apim: named values keep display name and use If-Match only on update; async PUT is polled", async () => {
  const nv = `${APIM_ID}/namedValues/hackgw-revoked-keys`;
  const s = scripted([
    ["GET", new RegExp(`${nv}\\?api-version=2024-05-01$`), 200, { properties: { displayName: "Revoked", value: ",", secret: false } }],
    ["PUT", new RegExp(`${nv}\\?api-version=2024-05-01$`), 202, {}, { location: "https://management.azure.com/op/1" }],
    ["GET", /\/op\/1$/, 202, {}],
    ["GET", /\/op\/1$/, 200, { properties: { provisioningState: "Succeeded" } }],
    ["GET", /namedValues\/new-one\?/, 404, {}],
    ["PUT", /namedValues\/new-one\?/, 201, { properties: {} }],
  ]);
  const a = apim({ apimId: APIM_ID, getToken: token, fetchImpl: s.fetchImpl, sleep: noSleep });
  await a.setNamedValue("hackgw-revoked-keys", ",k_0123456789abcdef,", { secret: false });
  assert.deepEqual(s.seen[1].body, { properties: { displayName: "Revoked", value: ",k_0123456789abcdef,", secret: false } });
  assert.equal(s.seen[1].headers["If-Match"], "*");
  await a.setNamedValue("new-one", "v", { secret: true });
  assert.equal(s.seen[5].headers["If-Match"], undefined);
  assert.equal(s.steps.length, 0);
});

test("apim: subscriptions are scoped to the product, regenerate the named slot, and change state", async () => {
  const sub = `${APIM_ID}/subscriptions/poc-a`;
  const s = scripted([
    ["PUT", new RegExp(`${sub}\\?api-version=2024-05-01$`), 201, {}],
    ["POST", new RegExp(`${sub}/listSecrets\\?`), 200, { primaryKey: "P", secondaryKey: "S" }],
    ["POST", new RegExp(`${sub}/regenerateSecondaryKey\\?`), 204],
    ["PATCH", new RegExp(`${sub}\\?`), 200, {}],
    ["GET", /\/products\?api-version/, 200, { value: [{ name: "poc-tiny-pack", properties: { displayName: "Tiny" } }] }],
  ]);
  const a = apim({ apimId: APIM_ID, getToken: token, fetchImpl: s.fetchImpl, sleep: noSleep });
  await a.createSubscription("poc-a", { productId: "poc-tiny-pack", displayName: "a" });
  assert.deepEqual(s.seen[0].body.properties, { scope: "/products/poc-tiny-pack", displayName: "a", state: "active" });
  assert.deepEqual(await a.listSubscriptionSecrets("poc-a"), { primaryKey: "P", secondaryKey: "S" });
  await a.regenerateKey("poc-a", "secondary");
  await a.setSubscriptionState("poc-a", "suspended");
  assert.deepEqual(s.seen[3].body, { properties: { state: "suspended" } });
  assert.equal(s.seen[3].headers["If-Match"], "*");
  assert.deepEqual(await a.listProducts(), [{ id: "poc-tiny-pack", displayName: "Tiny" }]);
  await assert.rejects(a.regenerateKey("poc-a", "tertiary"), AzureError);
  assert.throws(() => apim({ apimId: "/not/an/apim", getToken: token }), AzureError);
});
