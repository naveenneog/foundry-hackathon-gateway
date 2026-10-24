// Key Dashboard UI, P59: the setup guide's steps for the gateway URL, the usage period and the
// chargeback report. Show me highlights the real controls (period.js, views-chargeback.js,
// views-settings.js) on the fake DOM; Escape still closes the guide.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeDom, keydown } from "./console-dom.harness.mjs";

const PUBLIC = new URL("../src/console/public/", import.meta.url);
const api = await import(new URL("api.js", PUBLIC));
const dom = await import(new URL("dom.js", PUBLIC));
const help = await import(new URL("help.js", PUBLIC));
const { periodControl } = await import(new URL("period.js", PUBLIC));
const { chargebackCard } = await import(new URL("views-chargeback.js", PUBLIC));
const { renderSettings } = await import(new URL("views-settings.js", PUBLIC));

const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, type: "basic", text: async () => JSON.stringify(body) });
const settle = async () => { for (let i = 0; i < 40; i++) await new Promise((resolve) => setImmediate(resolve)); };
const step = (id) => help.STEPS.find((s) => s.id === id);
const say = (id) => [step(id).title, ...step(id).text].join(" ");

test("the guide has steps for the gateway URL, the usage period and the chargeback report, each on its own page", () => {
  assert.deepEqual(help.STEPS.map((s) => s.id), ["discover", "attach", "access", "pin", "gateway", "issue", "distribute", "period", "chargeback"],
    "the gateway URL before keys are issued; usage and chargeback after they are handed out");
  assert.deepEqual([step("gateway").routes, step("gateway").go, step("gateway").target, step("gateway").where], [["settings"], "settings", "gateway-url", "Settings"]);
  assert.deepEqual([step("period").routes, step("period").go, step("period").target], [["overview", "short-lived", "product"], "overview", "usage-period"]);
  assert.deepEqual([step("chargeback").routes, step("chargeback").go, step("chargeback").target], [["overview"], "overview", "chargeback"]);
  for (const re of [/custom domain of this API Management/, /Azure portal/, /keep working/, /Reset to API Management URL/]) assert.match(say("gateway"), re);
  for (const re of [/Custom/, /UTC/, /90 days/, /by the hour/]) assert.match(say("period"), re);
  for (const re of [/CSV/, /key and model/, /unknown/, /no prices/, /CCU/]) assert.match(say("chargeback"), re);
  assert.match(help.NOTES.join(" "), /never sends a request to it/);
});

function mount(view, route) {
  const went = [];
  const guide = help.createGuide({ go: (hash) => went.push(hash) });
  const main = dom.el("main", { id: "main" }, view);
  dom.addChildren(globalThis.document.body, guide.button, main, guide.panel);
  guide.routed(view, route);
  return { guide, went };
}
function showMe(guide, id) {
  guide.open(id, guide.button);
  guide.panel.querySelector("[data-help-show]").click();
}

test("on the Overview, Show me highlights the usage period and the chargeback card; Escape closes the guide", () => {
  const doc = fakeDom();
  globalThis.document = doc;
  try {
    const ctx = { period: 30 };
    const view = dom.el("div", { class: "view" }, dom.el("header", {}, periodControl(30, () => {})), chargebackCard(ctx).card);
    const { guide, went } = mount(view, "overview");
    showMe(guide, "period");
    const period = view.querySelector('[data-help="usage-period"]');
    assert.ok(period.classList.contains("help-target"));
    assert.match(period.getAttribute("data-help-label"), /^Step 8 of 9: Choose the usage period$/);
    assert.equal(doc.activeElement.getAttribute("type"), "radio");
    assert.equal(doc.activeElement.value, "30", "focus lands on the chosen period");

    showMe(guide, "chargeback");
    const card = view.querySelector('[data-help="chargeback"]');
    assert.equal(period.classList.contains("help-target"), false, "one highlight at a time");
    assert.ok(card.classList.contains("help-target"));
    assert.equal(doc.activeElement.tagName, "button");
    assert.match(doc.activeElement.textContent, /Download CSV/, "focus lands on Download CSV");
    assert.deepEqual(went, [], "already on the Overview: nothing navigates");

    doc.activeElement.dispatchEvent(keydown("Escape"));
    assert.equal(guide.panel.hidden, true, "Escape closes the guide");
    assert.equal(card.classList.contains("help-target"), false, "and clears the highlight");
  } finally {
    delete globalThis.document;
  }
});

test("Show me for the gateway URL goes to Settings by a fixed route, then highlights the field there", async () => {
  const doc = fakeDom();
  globalThis.document = doc;
  globalThis.CSS = { escape: (s) => String(s) };
  globalThis.fetch = async (path) => (path === "/api/gateway-url"
    ? reply(200, { apimUrl: "https://apim-x.azure-api.net", customUrl: null, effectiveUrl: "https://apim-x.azure-api.net", verified: null,
      updatedBy: null, updatedAt: null, candidates: [], propagationSeconds: 30 })
    : reply(200, { vault: true, apim: true, inSync: true }));
  try {
    const overview = dom.el("div", { class: "view" }, dom.el("h1", {}, "Overview"));
    const { guide, went } = mount(overview, "overview");
    showMe(guide, "gateway");
    assert.deepEqual(went, ["#/settings"]);
    const settings = dom.el("div", { class: "view" });
    dom.setChildren(doc.querySelector("main"), settings);
    renderSettings(settings);
    guide.routed(settings, "settings");
    await settle();
    const card = settings.querySelector('[data-help="gateway-url"]');
    assert.ok(card.classList.contains("help-target"));
    assert.match(card.getAttribute("data-help-label"), /^Step 5 of 9: /);
    assert.equal(doc.activeElement, card.querySelector('input[type="url"]'), "focus lands on the gateway URL field");
    doc.activeElement.dispatchEvent(keydown("Escape"));
    assert.equal(guide.panel.hidden, true);
  } finally {
    api.invalidate();
    for (const name of ["document", "CSS", "fetch"]) delete globalThis[name];
  }
});

test("Show me for the usage period from a page without it goes to the Overview", () => {
  const doc = fakeDom();
  globalThis.document = doc;
  try {
    const { guide, went } = mount(dom.el("div", { class: "view" }, dom.el("h1", {}, "Export")), "export");
    showMe(guide, "period");
    showMe(guide, "chargeback");
    assert.deepEqual(went, ["#/overview", "#/overview"]);
  } finally {
    delete globalThis.document;
  }
});
