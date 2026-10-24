// Key Dashboard UI, P59 (ADR-0019): Settings holds the gateway URL (custom domain) and the signing
// secret. The page runs on the fake DOM with a stubbed fetch; checkGatewayUrl in lib.js is checked
// against the server's parser.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fakeDom, fakeEvent } from "./console-dom.harness.mjs";
import { parseGatewayOrigin } from "../src/console/gateway-url.mjs";

const PUBLIC = new URL("../src/console/public/", import.meta.url);
const read = (name) => readFileSync(new URL(name, PUBLIC), "utf8");
const lib = await import(new URL("lib.js", PUBLIC));
const api = await import(new URL("api.js", PUBLIC));
const dom = await import(new URL("dom.js", PUBLIC));
const { renderSettings } = await import(new URL("views-settings.js", PUBLIC));

const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, type: "basic", text: async () => JSON.stringify(body) });
const settle = async () => { for (let i = 0; i < 40; i++) await new Promise((resolve) => setImmediate(resolve)); };
const words = (node) => String(node?.textContent ?? "").replace(/\s+/g, " ");
const button = (root, re) => root.querySelectorAll("button").find((b) => re.test(b.textContent.trim()));
const APIM = "https://apim-x.azure-api.net";
const DOMAIN = "https://ai.contoso.example";
const status = (over = {}) => ({ apimUrl: APIM, customUrl: null, effectiveUrl: APIM, verified: null, updatedBy: null, updatedAt: null,
  candidates: [DOMAIN], propagationSeconds: 30, ...over });

test("checkGatewayUrl gives early feedback that matches the server's parser", () => {
  for (const input of ["https://ai.contoso.example", "HTTPS://AI.Contoso.Example/", "https://ai.contoso.example:443", " https://ai.contoso.example ",
    "http://ai.contoso.example", "https://ai.contoso.example/v1", "https://ai.contoso.example:8443", "https://10.0.0.1", "https://*.contoso.example",
    "https://user@ai.contoso.example", "https://localhost", "https://ai..contoso.example", "https://bücher.example", "ai.contoso.example", "",
    `https://${"a".repeat(64)}.example`, "https://ai.contoso.example?x=1", "https://ai.contoso.123", "https://foo.0x7f", "https://1.0x7f", "https://a.0X7F", "https://gw.0x"]) {
    let accepted = true;
    try { parseGatewayOrigin(input); } catch { accepted = false; }
    assert.equal(lib.checkGatewayUrl(input) === null, accepted, JSON.stringify(input));
  }
  assert.match(lib.checkGatewayUrl("https://ai.contoso.example/v1"), /https:\/\/ and a host name only/);
});

/** Renders Settings. `answers` maps "METHOD path" to a function returning a reply; calls are recorded. */
async function mount(answers) {
  const doc = fakeDom();
  globalThis.document = doc;
  globalThis.CSS = { escape: (s) => String(s).replace(/["\\]/g, "\\$&") };
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, ms, ...args).unref();
  const calls = [];
  globalThis.fetch = async (path, init) => {
    const method = init?.method ?? "GET";
    calls.push({ method, path, body: init?.body ? JSON.parse(init.body) : undefined });
    const answer = answers[`${method} ${path}`];
    return answer ? answer(calls.at(-1).body) : reply(404, { error: `No stub for ${method} ${path}` });
  };
  const ctx = {};
  const view = dom.el("div", { class: "view" });
  dom.addChildren(doc.body, dom.el("main", { id: "main" }, view), dom.el("div", { id: "toasts" }));
  renderSettings(view, ctx);
  await settle();
  return { doc, view, calls, restore: () => { globalThis.setTimeout = realSetTimeout; } };
}
function unmount(page) {
  page.restore();
  api.invalidate();
  for (const name of ["document", "CSS", "fetch"]) delete globalThis[name];
}
const signing = () => reply(200, { vault: true, apim: true, inSync: true });

test("Settings shows the URL keys are handed out with, the API Management URL that keeps working, and the custom domains on offer", async () => {
  const page = await mount({ "GET /api/gateway-url": () => reply(200, status()), "GET /api/signing": signing });
  try {
    assert.equal(page.view.querySelector(".view-title").textContent, "Settings");
    const card = page.view.querySelector('[data-help="gateway-url"]');
    assert.ok(card, "the guide can highlight the gateway URL card");
    assert.equal(card.querySelector("h2").textContent, "Gateway URL");
    assert.match(words(card), new RegExp(`New keys use ${APIM.replace(/[.]/g, "\\.")}`));
    assert.match(words(card), /API Management URL/);
    assert.match(words(card), /keep working/, "says that keys already handed out keep working");
    assert.match(words(card), /30 seconds/, "says how long other replicas take");
    const input = card.querySelector('input[type="url"]');
    const label = card.querySelectorAll("label").find((l) => l.getAttribute("for") === input.getAttribute("id"));
    assert.equal(label.textContent, "Gateway URL (custom domain)");
    assert.ok(input.hasAttribute("data-help-focus"));
    const hint = input.getAttribute("aria-describedby").split(" ").map((id) => page.doc.getElementById(id)?.textContent ?? "").join(" ");
    assert.match(hint, /custom domain of this API Management/);
    assert.equal(button(card, /^Reset to API Management URL$/).hidden, true, "nothing to reset");
    const use = button(card, new RegExp(`^Use ${DOMAIN.replace(/[.]/g, "\\.")}$`));
    use.click();
    assert.equal(input.value, DOMAIN, "a custom domain on offer fills the field");
    assert.equal(page.doc.activeElement, input);
    assert.ok(page.view.querySelectorAll("h2").some((h) => h.textContent === "Signing secret"), "the signing secret is on the same page");
    assert.ok(button(page.view, /^Rotate signing secret/), "with its actions");
  } finally {
    unmount(page);
  }
});

test("Save refuses an invalid URL on its field without a request, shows the server's refusal, and on success drops the cached Foundry config", async () => {
  let current = status();
  let configReads = 0;
  const page = await mount({
    "GET /api/gateway-url": () => reply(200, current),
    "GET /api/signing": signing,
    "GET /api/config": () => { configReads++; return reply(200, { gatewayUrl: current.effectiveUrl }); },
    "POST /api/gateway-url": (body) => {
      if (body.url !== DOMAIN) return reply(400, { error: "elsewhere.example is not a gateway hostname of this API Management. Add it as a custom domain of the Gateway endpoint in API Management first." });
      current = status({ customUrl: DOMAIN, effectiveUrl: DOMAIN, verified: true, updatedBy: "admin@contoso.com", updatedAt: "2026-10-16T09:00:00.000Z" });
      return reply(200, { changed: true, ...current });
    },
  });
  try {
    await api.cachedGet("/api/config", { ttl: Infinity });
    const card = page.view.querySelector('[data-help="gateway-url"]');
    const input = card.querySelector('input[type="url"]');
    const form = card.querySelector("form");
    const posts = () => page.calls.filter((c) => c.method === "POST");

    input.value = "https://ai.contoso.example/v1";
    form.dispatchEvent(fakeEvent("submit"));
    await settle();
    assert.deepEqual(posts(), [], "refused in the browser");
    assert.equal(input.getAttribute("aria-invalid"), "true");
    assert.equal(page.doc.activeElement, input);
    assert.match(page.doc.getElementById(`${input.getAttribute("id")}-error`).textContent, /https:\/\/ and a host name only/);

    input.value = "https://elsewhere.example";
    form.dispatchEvent(fakeEvent("submit"));
    await settle();
    assert.equal(posts().length, 1);
    assert.match(page.doc.getElementById(`${input.getAttribute("id")}-error`).textContent, /Add it as a custom domain/, "the server's reason, on the field");
    assert.equal(page.doc.activeElement, input);

    input.value = DOMAIN;
    form.dispatchEvent(fakeEvent("submit"));
    await settle();
    assert.deepEqual(posts().at(-1).body, { url: DOMAIN });
    assert.equal(input.hasAttribute("aria-invalid"), false);
    assert.match(words(card), new RegExp(`New keys use ${DOMAIN.replace(/[.]/g, "\\.")}`));
    assert.match(words(card), /custom domain/);
    assert.match(words(card), /admin@contoso\.com/, "who changed it");
    assert.equal(button(card, /^Reset to API Management URL$/).hidden, false);
    assert.match(words(page.doc.getElementById("toasts")), new RegExp(`${APIM.replace(/[.]/g, "\\.")}`), "the toast says the API Management URL keeps working");
    await api.cachedGet("/api/config", { ttl: Infinity });
    assert.equal(configReads, 2, "forms read the Foundry config again, with the new base URL");
  } finally {
    unmount(page);
  }
});

test("Reset asks first, then uses the API Management URL again and keeps focus in the card", async () => {
  let current = status({ customUrl: DOMAIN, effectiveUrl: DOMAIN, verified: true, updatedBy: "admin@contoso.com", updatedAt: "2026-10-16T09:00:00.000Z" });
  const page = await mount({
    "GET /api/gateway-url": () => reply(200, current),
    "GET /api/signing": signing,
    "POST /api/gateway-url/reset": () => { current = status({ updatedBy: "admin@contoso.com", updatedAt: "2026-10-16T09:05:00.000Z" }); return reply(200, { changed: true, ...current }); },
  });
  try {
    const card = page.view.querySelector('[data-help="gateway-url"]');
    const reset = button(card, /^Reset to API Management URL$/);
    assert.equal(reset.hidden, false);
    reset.focus();
    reset.click();
    await settle();
    button(page.doc.querySelectorAll("dialog[open]").at(-1), /^Cancel$/).click();
    await settle();
    assert.equal(page.calls.filter((c) => c.method === "POST").length, 0, "Cancel changes nothing");
    assert.equal(reset.hidden, false);
    reset.click();
    await settle();
    const dialog = page.doc.querySelectorAll("dialog[open]").at(-1);
    assert.ok(dialog, "a confirmation first");
    assert.match(words(dialog), /keep working/);
    button(dialog, /^Reset$/).click();
    await settle();
    assert.equal(page.calls.filter((c) => c.method === "POST" && c.path === "/api/gateway-url/reset").length, 1);
    assert.match(words(card), new RegExp(`New keys use ${APIM.replace(/[.]/g, "\\.")}`));
    assert.equal(reset.hidden, true);
    assert.equal(page.doc.activeElement, card.querySelector('input[type="url"]'), "focus moves to the field, not to the hidden button");
  } finally {
    unmount(page);
  }
});

test("a custom domain API Management no longer lists is shown as a problem, with Reset", async () => {
  const page = await mount({
    "GET /api/gateway-url": () => reply(200, status({ customUrl: DOMAIN, verified: false, candidates: [],
      problem: "ai.contoso.example is no longer a gateway hostname of this API Management, so keys use the API Management URL." })),
    "GET /api/signing": signing,
  });
  try {
    const card = page.view.querySelector('[data-help="gateway-url"]');
    assert.match(words(card.querySelector(".callout")), /no longer a gateway hostname/);
    assert.match(words(card), new RegExp(`New keys use ${APIM.replace(/[.]/g, "\\.")}`));
    assert.match(words(card), /no gateway custom domain/i, "says that none is on offer");
    assert.equal(button(card, /^Reset to API Management URL$/).hidden, false);
  } finally {
    unmount(page);
  }
});

test("app wiring: Settings replaces the Signing page, old links still arrive, and the module is served", () => {
  const app = read("app.js");
  assert.match(app, /\{ id: "settings", label: "Settings", render: \(root, ctx\) => renderSettings\(root, ctx\) \}/);
  assert.doesNotMatch(app, /id: "signing"/);
  assert.match(app, /ALIASES = Object\.freeze\(\{ signing: "settings" \}\)/, "#/signing still opens Settings");
  assert.doesNotMatch(read("views-admin.js"), /renderSigning/, "the signing view moved to views-settings.js");
  assert.match(read("index.html"), /<link rel="modulepreload" href="\/views-settings\.js">/);
  const server = readFileSync(new URL("../src/console/server.mjs", import.meta.url), "utf8");
  assert.match(server, /"\/views-settings\.js": \["views-settings\.js", "text\/javascript; charset=utf-8"\]/);
});
