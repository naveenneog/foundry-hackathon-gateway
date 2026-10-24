// P59, ADR-0019: with a custom domain set, every URL the dashboard hands out names it, and nothing
// names the API Management URL; after a reset, everything names the API Management URL again. A
// scan of the console's modules fails if any of them reads the configured URL other than through
// the resolver (effectiveGatewayUrl in src/console/gateway-url.mjs).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

import { openBundle } from "../src/console/bundle.mjs";
import { harness, ADMIN } from "./console.harness.mjs";

const TEMPLATE = readFileSync(new URL("../poc/products-keyvault/infra/product-policy.xml", import.meta.url), "utf8");
const CUSTOM = { type: "Proxy", hostName: "ai.contoso.example", certificateSource: "Managed" };

/** Every output of the service that carries a gateway URL, by name. */
async function emitted(h, secondary, label) {
  const out = {};
  out.config = await h.service.config();
  out.configSecondary = await h.service.config({ foundryId: secondary });
  out.attach = await h.service.attachFoundry(ADMIN, { foundryId: secondary });
  const single = await h.service.issueJwt(ADMIN, { owner: "alex@contoso.com", subject: `s-${label}`, models: ["flash", "haiku-4-5"], budget: 100, hours: 2 });
  out.issueJwt = single.handout;
  const onSecondary = await h.service.issueJwt(ADMIN, { owner: "alex@contoso.com", subject: `x-${label}`, foundryId: secondary, models: ["sflash"], budget: 100, hours: 2 });
  out.issueJwtSecondary = onSecondary.handout;
  const bulk = await h.service.issueJwtBulk(ADMIN, { models: ["flash", "haiku-4-5"], budget: 10, hours: 2, entries: [{ owner: "sam@contoso.com", subject: `b-${label}` }] });
  out.bulkJwtRows = bulk.issued.map(({ openaiBaseUrl, anthropicBaseUrl }) => ({ openaiBaseUrl, anthropicBaseUrl }));
  out.bulkJwtCsv = bulk.keysCsv;
  const products = await h.service.issueProductBulk(ADMIN, { models: ["claude-haiku-4-5", "deepseek-v4-flash"], monthlyTokens: 100,
    entries: [{ owner: "kim@contoso.com", name: `p-${label}` }] });
  out.bulkProductRows = products.issued.map(({ openaiBaseUrl, anthropicBaseUrl }) => ({ openaiBaseUrl, anthropicBaseUrl }));
  out.bulkProductCsv = products.keysCsv;
  out.revealJwt = (await h.service.revealKey(ADMIN, single.name)).handout;
  out.revealProduct = (await h.service.revealKey(ADMIN, products.issued[0].name)).handout;
  const exported = await h.service.exportBundle(ADMIN, { names: [single.name, products.issued[0].name], recipient: "finance", passphrase: "a long enough passphrase" });
  out.bundle = openBundle(exported.bundle, { passphrase: "a long enough passphrase", publicJwk: await h.service.bundlePublicKey() }).payload.keys.map((k) => k.handout);
  return out;
}

async function setUp() {
  const h = harness();
  h.arm.hostnameConfigurations.push(CUSTOM);
  h.service.setPackTemplate(TEMPLATE);
  await h.service.migrateSigningSecret(ADMIN);
  const secondary = [...h.foundry.accounts.keys()].find((id) => id.endsWith("/aif-secondary"));
  await h.service.attachFoundry(ADMIN, { foundryId: secondary });
  await h.service.pinModel(ADMIN, { foundryId: secondary, alias: "sflash", deployment: "deepseek-v4-flash" });
  return { h, secondary };
}

test("with a custom domain set, every handout, CSV, reveal, export bundle and base URL names it, and none names the API Management URL", async () => {
  const { h, secondary } = await setUp();
  await h.service.setGatewayUrl(ADMIN, { url: "https://ai.contoso.example" });
  const out = await emitted(h, secondary, "custom");
  for (const [name, value] of Object.entries(out)) {
    const text = JSON.stringify(value);
    assert.match(text, /https:\/\/ai\.contoso\.example/, `${name} names the custom domain`);
    assert.doesNotMatch(text, /gw\.example\.net/, `${name} does not name the API Management URL`);
  }
  assert.equal(out.config.gatewayUrl, "https://ai.contoso.example");
  assert.match(out.configSecondary.gatewayUrl, /^https:\/\/ai\.contoso\.example\/foundry\/f[0-9a-f]{12}$/, "an attached Foundry keeps its path");
  assert.equal(out.issueJwt.env.OPENAI_BASE_URL, "https://ai.contoso.example/v1");
  assert.equal(out.issueJwt.claudeSettings.env.ANTHROPIC_BASE_URL, "https://ai.contoso.example/claude");
  assert.match(out.bulkProductCsv, /https:\/\/ai\.contoso\.example\/poc\/claude,https:\/\/ai\.contoso\.example\/poc\/v1/);
  assert.match(out.revealProduct.curl, /^curl -sS "https:\/\/ai\.contoso\.example\/poc\/v1\/chat\/completions"/);
});

test("after a reset the same outputs name the API Management URL again, without a restart", async () => {
  const { h, secondary } = await setUp();
  await h.service.setGatewayUrl(ADMIN, { url: "https://ai.contoso.example" });
  await h.service.resetGatewayUrl(ADMIN);
  const out = await emitted(h, secondary, "reset");
  for (const [name, value] of Object.entries(out)) {
    const text = JSON.stringify(value);
    assert.match(text, /https:\/\/gw\.example\.net/, `${name} names the API Management URL`);
    assert.doesNotMatch(text, /ai\.contoso\.example/, `${name} no longer names the custom domain`);
  }
});

// ── The scan: who may read the configured URL ───────────────────────────────

const SRC = new URL("../src/console/", import.meta.url);
const PUBLIC = new URL("public/", SRC);
const stripComments = (code) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");

/**
 * Where the configured gateway URL (GATEWAY_URL, loadConfig's gatewayUrl, createService's
 * gatewayUrl option) is read other than through the resolver. Returns the violations found.
 */
function gatewayUrlBypasses(sources) {
  const out = [];
  const bare = (code) => [...code.matchAll(/(?<![.\w$])gatewayUrl(?![\w$])(?!\s*:)/g)].length;
  for (const [file, text] of Object.entries(sources)) {
    const code = stripComments(text);
    if (file !== "main.mjs" && /\bGATEWAY_URL\b|\bcfg\.gatewayUrl\b/.test(code)) out.push(`${file}: reads the GATEWAY_URL setting`);
    if (file.startsWith("public/") && /azure-api\.net/.test(code)) out.push(`${file}: names an API Management host`);
    if (!["gateway-url.mjs", "service-foundries.mjs"].includes(file) && /\bserverUrl\s*\(/.test(code)) {
      out.push(`${file}: uses the API Management URL meant for requests the dashboard itself sends`);
    }
    // The configured URL lives on the server; a browser module only displays the server's apimUrl field.
    if (!file.startsWith("public/") && !["gateway-url.mjs", "service.mjs"].includes(file) && /\bapimUrl\b/.test(code)) out.push(`${file}: holds the configured URL`);
    // Formatters receive a URL from their caller; main.mjs validates the setting; service.mjs hands
    // its option to the resolver. Any other module with a bare gatewayUrl variable has its own copy.
    if (!["main.mjs", "service.mjs", "gateway-url.mjs", "handout.mjs", "connections.mjs"].includes(file) && bare(code) > 0) {
      out.push(`${file}: keeps a gatewayUrl of its own`);
    }
  }
  const service = stripComments(sources["service.mjs"] ?? "");
  if (bare(service) !== 2 || !/gatewayUrlApi\(\{[^}]*\bapimUrl: gatewayUrl\b/.test(service)) {
    out.push("service.mjs: the gatewayUrl option goes somewhere other than gatewayUrlApi");
  }
  return out;
}

const read = () => ({
  ...Object.fromEntries(readdirSync(SRC).filter((n) => n.endsWith(".mjs")).map((n) => [n, readFileSync(new URL(n, SRC), "utf8")])),
  ...Object.fromEntries(readdirSync(PUBLIC).filter((n) => /\.(?:js|html)$/.test(n)).map((n) => [`public/${n}`, readFileSync(new URL(n, PUBLIC), "utf8")])),
});

test("no console module reads the configured gateway URL except through the resolver", () => {
  assert.deepEqual(gatewayUrlBypasses(read()), []);
});

test("the scan catches each way around the resolver", () => {
  const sources = read();
  const mutate = (file, find, replace) => {
    assert.ok(sources[file].includes(find), `${file} contains ${find}`);
    return { ...sources, [file]: sources[file].replace(find, replace) };
  };
  const cases = [
    [mutate("service.mjs", "const connections = foundriesApi({ vault, arm, foundry, gateway,", "const connections = foundriesApi({ vault, arm, foundry, gateway, gatewayUrl,"), /service\.mjs: the gatewayUrl option/],
    [mutate("service.mjs", "jwtHandout({ gatewayUrl: connection.gatewayUrl,", "jwtHandout({ gatewayUrl: gatewayUrl,"), /service\.mjs: the gatewayUrl option/],
    [mutate("service.mjs", "openaiBaseUrl: req.models.length > claude.length ? `${connection.gatewayUrl}/v1`", "openaiBaseUrl: req.models.length > claude.length ? `${cfg.gatewayUrl}/v1`"), /service\.mjs: reads the GATEWAY_URL setting/],
    [mutate("service-foundries.mjs", "export function foundriesApi({", "export function foundriesApi({ gatewayUrl,"), /service-foundries\.mjs: keeps a gatewayUrl of its own/],
    [mutate("service-usage.mjs", "export function usageApi({", "const x = cfg.gatewayUrl;\nexport function usageApi({"), /service-usage\.mjs: reads the GATEWAY_URL setting/],
    [mutate("service-lifecycle.mjs", "export function lifecycleApi(ctx) {", "export function lifecycleApi(ctx) {\n  const u = ctx.gateway.serverUrl();"), /service-lifecycle\.mjs: uses the API Management URL/],
    [mutate("public/views-foundry.js", "\"Keys for this Foundry call \"", "\"Keys for this Foundry call https://apim-x.azure-api.net \""), /views-foundry\.js: names an API Management host/],
    [mutate("handout.mjs", "const trim = (url)", "const apimUrl = 1;\nconst trim = (url)"), /handout\.mjs: holds the configured URL/],
  ];
  for (const [mutated, expected] of cases) assert.match(gatewayUrlBypasses(mutated).join("\n"), expected);
});
