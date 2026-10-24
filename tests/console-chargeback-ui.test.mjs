// Key Dashboard UI, P59 (ADR-0020): the Overview's chargeback card downloads a CSV for the period
// the Overview shows; the Overview names usage whose key is gone by its key id. Both run on the
// fake DOM in console-dom.harness.mjs with a stubbed fetch.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveObjectURL } from "node:buffer";
import { fakeDom } from "./console-dom.harness.mjs";

const PUBLIC = new URL("../src/console/public/", import.meta.url);
const api = await import(new URL("api.js", PUBLIC));
const dom = await import(new URL("dom.js", PUBLIC));
const { chargebackCard } = await import(new URL("views-chargeback.js", PUBLIC));
const { renderOverview } = await import(new URL("views-overview.js", PUBLIC));

const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, type: "basic", text: async () => JSON.stringify(body) });
const settle = async () => { for (let i = 0; i < 40; i++) await new Promise((resolve) => setImmediate(resolve)); };
const words = (node) => String(node?.textContent ?? "").replace(/[\s\u2009\u202f]+/g, " ");
const CSV = "period_start_utc,period_end_utc\r\n2026-10-01T00:00:00Z,2026-10-05T23:59:59Z";

const realSetTimeout = globalThis.setTimeout;

function mount(responder) {
  const doc = fakeDom();
  globalThis.document = doc;
  // A toast removes itself after 6 or 15 s; those timers must not keep the test process alive.
  globalThis.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, ms, ...args).unref();
  const calls = [];
  const downloads = [];
  globalThis.fetch = async (path, init) => {
    calls.push({ path, method: init?.method, body: init?.body ? JSON.parse(init.body) : undefined });
    return responder(path, init);
  };
  // downloadText clicks a temporary link and revokes its object URL at once: read the file in the click.
  doc.body.addEventListener("click", (e) => {
    const href = e.target.getAttribute?.("href");
    if (href?.startsWith("blob:")) downloads.push({ name: e.target.getAttribute("download"), blob: resolveObjectURL(href) });
  });
  dom.addChildren(doc.body, dom.el("div", { id: "toasts" }));
  return { doc, calls, downloads };
}
function unmount() {
  api.invalidate();
  globalThis.setTimeout = realSetTimeout;
  for (const name of ["document", "fetch", "ResizeObserver"]) delete globalThis[name];
}

test("the chargeback card downloads the CSV for the chosen period and kind, then says how much it holds", async () => {
  const page = mount(() => reply(200, { filename: "chargeback-2026-10-09-2026-10-16.csv", csv: CSV, rows: 12, totals: { tokens: 34_567, requests: 9 } }));
  try {
    const ctx = { period: 7 };
    const { card, sync } = chargebackCard(ctx);
    dom.addChildren(page.doc.body, card);
    assert.equal(card.getAttribute("data-help"), "chargeback", "the guide can highlight it");
    const title = card.querySelector("h2");
    assert.equal(title.textContent, "Chargeback report");
    assert.equal(card.getAttribute("aria-labelledby"), title.getAttribute("id"));
    assert.match(words(card), /one row per key and model/i);
    assert.match(words(card), /No prices/);
    assert.match(words(card), /CCU/);
    assert.match(words(card), /Covers last 7 days/);
    const group = card.querySelector("fieldset");
    assert.equal(group.querySelector("legend").textContent, "Keys in the report");
    assert.deepEqual(group.querySelectorAll('input[type="radio"]').map((r) => [r.value, r.checked]), [["all", true], ["jwt", false], ["product", false]]);
    const download = card.querySelectorAll("button").find((b) => /Download CSV/.test(b.textContent));
    assert.ok(download.hasAttribute("data-help-focus"));

    download.click();
    await settle();
    assert.deepEqual(page.calls.map((c) => [c.method, c.path, c.body]), [["POST", "/api/chargeback", { days: 7, kind: "all" }]]);
    assert.equal(page.downloads.length, 1);
    assert.equal(page.downloads[0].name, "chargeback-2026-10-09-2026-10-16.csv");
    assert.equal(await page.downloads[0].blob.text(), CSV, "the server's CSV, byte for byte");
    assert.match(page.downloads[0].blob.type, /^text\/csv/);
    assert.match(words(page.doc.getElementById("toasts")), /12 rows, 34,567 tokens/);

    const jwt = group.querySelectorAll('input[type="radio"]').find((r) => r.value === "jwt");
    for (const r of group.querySelectorAll('input[type="radio"]')) r.checked = r === jwt;
    jwt.dispatchEvent({ type: "change", bubbles: true, preventDefault() {}, stopPropagation() {} });
    ctx.period = { from: "2026-10-01", to: "2026-10-05" };
    sync();
    assert.match(words(card), /Covers Oct 1 – 5, 2026 \(UTC\)/);
    download.click();
    await settle();
    assert.deepEqual(page.calls.at(-1).body, { from: "2026-10-01", to: "2026-10-05", kind: "jwt" });
  } finally {
    unmount();
  }
});

test("a refused report shows the server's reason, downloads nothing and leaves the button usable", async () => {
  const page = mount(() => reply(409, { error: "Usage is not configured: the dashboard has no Log Analytics workspace." }));
  try {
    const { card } = chargebackCard({ period: 30 });
    dom.addChildren(page.doc.body, card);
    const download = card.querySelectorAll("button").find((b) => /Download CSV/.test(b.textContent));
    download.click();
    await settle();
    assert.equal(page.downloads.length, 0);
    assert.match(words(page.doc.getElementById("toasts")), /not configured/);
    assert.equal(download.hasAttribute("aria-busy"), false);
  } finally {
    unmount();
  }
});

test("the Overview shows the chargeback card for its period and names usage whose key is gone by its key id", async () => {
  const usage = (kind) => ({ kind, days: 7, from: "2026-10-09T09:00:00.000Z", to: "2026-10-16T09:00:00.000Z", total: { tokens: 12, requests: 2, prompt: 0, completion: 0 },
    series: [], byModel: [{ model: "flash", tokens: 12 }],
    byKey: kind === "jwt" ? [{ name: null, keyId: "k_gone", owner: null, tokens: 12, requests: 2 }] : [] });
  const page = mount((path) => {
    const url = new URL(path, "https://dashboard.example");
    if (url.pathname === "/api/keys") return reply(200, { keys: [] });
    if (url.pathname === "/api/usage") return reply(200, usage(url.searchParams.get("kind")));
    return reply(404, { error: `No stub for ${path}` });
  });
  globalThis.ResizeObserver = class { observe() {} unobserve() {} };
  try {
    const ctx = { period: 7, setPeriod(p) { ctx.period = p; } };
    const view = dom.el("div", { class: "view" });
    dom.addChildren(page.doc.body, dom.el("main", { id: "main" }, view));
    renderOverview(view, ctx);
    await settle();
    const names = view.querySelectorAll(".barlist-name").map((n) => n.textContent);
    assert.deepEqual(names, ["Unknown key k_gone"], "never an empty name");
    const card = view.querySelector('[data-help="chargeback"]');
    assert.ok(card, "the Overview has the chargeback card");
    assert.match(words(card), /Covers last 7 days/);
  } finally {
    unmount();
  }
});

test("the Overview keeps the card's period in step with its own", () => {
  const overview = readFileSync(new URL("views-overview.js", PUBLIC), "utf8");
  assert.match(overview, /import \{ chargebackCard \} from "\.\/views-chargeback\.js";/);
  assert.match(overview, /ctx\.setPeriod\(p\); chargeback\.sync\(\);/);
  const server = readFileSync(new URL("../src/console/server.mjs", import.meta.url), "utf8");
  assert.match(server, /"\/views-chargeback\.js": \["views-chargeback\.js", "text\/javascript; charset=utf-8"\]/);
});
