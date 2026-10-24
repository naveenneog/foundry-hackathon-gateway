// Key Dashboard UI, P58 (ADR-0018): Foundry & models lists only the Foundries connected to this
// API Management; the subscription's other accounts appear only in Connect another Foundry. The
// pure helpers (foundry.js) run as they are; the views run against the fake DOM in
// console-dom.harness.mjs with a stubbed fetch.

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { fakeDom, fakeEvent, keydown } from "./console-dom.harness.mjs";

const PUBLIC = new URL("../src/console/public/", import.meta.url);
const api = await import(new URL("api.js", PUBLIC));
const dom = await import(new URL("dom.js", PUBLIC));
const foundry = await import(new URL("foundry.js", PUBLIC));
const help = await import(new URL("help.js", PUBLIC));
const { renderFoundry } = await import(new URL("views-foundry.js", PUBLIC));
const { foundryChooser } = await import(new URL("foundry-picker.js", PUBLIC));

// ── Five accounts: two connected, two that can be attached, one unreadable ──

const SUB = "/subscriptions/00000000-0000-4000-8000-000000000002";
const armId = (rg, name) => `${SUB}/resourceGroups/${rg}/providers/Microsoft.CognitiveServices/accounts/${name}`;
const MAIN = armId("rg-gateway", "foundry-main");
const RESEARCH = armId("rg-research", "foundry-research");
const NEW = armId("rg-research", "foundry-new");
const SPARE = armId("rg-spare", "aoai-spare");
const LOCKED = armId("rg-locked", "openai-locked");
const LOCKED_ERROR = "AuthorizationFailed: the dashboard cannot read this account's deployments.";

/** One discovery entry, as GET /api/foundries sends it; not connected unless `extra` says so. */
const account = (id, extra = {}) => ({
  id, name: id.split("/").at(-1), resourceGroup: id.split("/")[4], location: "eastus2", kind: "AIServices", connected: false, deployments: 1,
  setupCommand: `pwsh scripts/Connect-Foundry.ps1 -FoundryAccountId '${id}'`,
  networkCommand: `pwsh scripts/Connect-Foundry.ps1 -FoundryAccountId '${id}' -ConfigurePrivateEndpoint -VnetName 'vnet-gw'`,
  ...extra,
});
const discovery = (...accounts) => ({ subscriptionId: "00000000-0000-4000-8000-000000000002", defaultFoundryId: MAIN, accounts });
const FIVE = () => discovery(
  account(MAIN, { connected: true, connectionId: "default", deployments: 3 }),
  account(RESEARCH, { connected: true, connectionId: "f0123456789ab", location: "swedencentral", deployments: 2 }),
  account(NEW, { location: "westus3" }),
  account(SPARE, { kind: "OpenAI", location: "westeurope", deployments: 4 }),
  account(LOCKED, { kind: "OpenAI", deployments: 0, error: LOCKED_ERROR }),
);

// ── foundry.js: what each list counts ───────────────────────────────────────

test("the page counts only connected Foundries; Connect another Foundry counts and searches the rest", () => {
  const all = foundry.accountsOf(FIVE());
  assert.deepEqual(foundry.unconnectedAccounts(all).map((a) => a.name), ["aoai-spare", "foundry-new", "openai-locked"], "unreadable accounts included");
  assert.deepEqual(foundry.unconnectedAccounts(null), []);

  assert.equal(foundry.connectedLine(all), "2 Foundries connected to this API Management · 5 deployments.");
  assert.equal(foundry.connectedLine(all.filter((a) => a.isDefault)), "1 Foundry connected to this API Management · 3 deployments.");
  assert.equal(foundry.connectedLine(foundry.unconnectedAccounts(all)), "", "with none connected, the empty state speaks instead");
  const uncounted = foundry.accountsOf(discovery(account(MAIN, { connected: true, connectionId: "default", deployments: undefined })));
  assert.equal(foundry.connectedLine(uncounted), "1 Foundry connected to this API Management · 0 deployments in those that could be read.");

  assert.equal(foundry.candidatesLine(all), "3 accounts not connected: 2 can be attached, 1 unreadable.");
  assert.equal(foundry.candidatesLine(all, 1), "3 accounts not connected: 2 can be attached, 1 unreadable · 1 shown.");
  assert.equal(foundry.candidatesLine(all, 3), "3 accounts not connected: 2 can be attached, 1 unreadable.", "an unfiltered list says nothing about shown");
  assert.equal(foundry.candidatesLine(foundry.connectedAccounts(all)), "");

  const spare = all.find((a) => a.id === SPARE);
  assert.equal(foundry.matchesAccount(spare, "WESTEUROPE openai"), true, "region and kind, any case");
  assert.equal(foundry.matchesAccount(spare, "rg-spare"), true, "resource group");
  assert.equal(foundry.matchesAccount(spare, "spare locked"), false, "every term must match");
  assert.equal(foundry.matchesAccount(all.find((a) => a.id === LOCKED), "unreadable"), true, "the state is searchable");
  assert.equal(foundry.matchesAccount(spare, "  "), true);
});

// ── The Foundry page and Connect another Foundry, on the fake DOM ──────────

const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, type: "basic", text: async () => JSON.stringify(body) });
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve)); };
const words = (node) => String(node?.textContent ?? "").replace(/\s+/g, " ");
const radios = (root) => root.querySelectorAll('input[type="radio"]').map((r) => r.value);
const button = (root, re) => root.querySelectorAll("button").find((b) => re.test(b.textContent.trim()));
const openDialogs = (doc) => doc.querySelectorAll("dialog[open]");
function pick(root, id) {
  const radio = root.querySelectorAll('input[type="radio"]').find((r) => r.value === id);
  radio.checked = true;
  radio.dispatchEvent(fakeEvent("change"));
}
function type(input, value) {
  input.value = value;
  input.dispatchEvent(fakeEvent("input"));
}

/**
 * Renders Foundry & models. Discovery answers come from `answers`, the last one repeating; an
 * answer may be a promise, to hold it back. Each account's models are an empty list;
 * `attach(body)` answers POST /api/foundries/attach.
 */
async function mountFoundry(answers, { attach } = {}) {
  const doc = fakeDom();
  globalThis.document = doc;
  globalThis.CSS = { escape: (s) => String(s).replace(/["\\]/g, "\\$&") };
  const calls = [];
  globalThis.fetch = async (path, init) => {
    calls.push({ path, method: init?.method, body: init?.body ? JSON.parse(init.body) : undefined });
    const url = new URL(path, "https://dashboard.example");
    if (url.pathname === "/api/models") return reply(200, { foundryId: url.searchParams.get("foundryId"), deployments: [], pins: { openai: [], claude: [] } });
    if (url.pathname === "/api/foundries/attach" && attach) return attach(JSON.parse(init.body));
    return reply(404, { error: `No stub for ${path}.` });
  };
  const queue = [...answers];
  const helpCalls = [];
  const ctx = {
    foundries: async () => structuredClone(await (queue.length > 1 ? queue.shift() : queue[0])),
    config: async (foundryId) => ({ foundryId, gatewayUrl: "https://gw.example" }),
    help: (step, opener) => helpCalls.push({ step, opener, dialogsOpen: doc.querySelectorAll("dialog[open]").length }),
  };
  const view = dom.el("div", { class: "view" });
  dom.addChildren(doc.body, dom.el("main", { id: "main" }, view));
  renderFoundry(view, ctx);
  await settle();
  return { doc, view, calls, helpCalls };
}
function unmount() {
  api.invalidate();
  for (const name of ["document", "CSS", "fetch"]) delete globalThis[name];
}
function openConnect(page, root = page.view) {
  const connect = button(root, /^Connect another Foundry$/);
  connect.focus();
  connect.click();
  return { connect, dialog: openDialogs(page.doc).at(-1) };
}

test("Foundry & models lists only the Foundries connected to this API Management", async () => {
  const page = await mountFoundry([FIVE()]);
  try {
    assert.deepEqual(radios(page.view), [MAIN, RESEARCH], "the default first, then the attached account");
    const text = words(page.view);
    for (const absent of ["foundry-new", "aoai-spare", "openai-locked", "AuthorizationFailed", "Not attached", "Unreadable"]) {
      assert.ok(!text.includes(absent), `${absent} is not on the page`);
    }
    assert.match(text, /2 Foundries connected to this API Management · 5 deployments\./);
    const lede = words(page.view.querySelector(".lede"));
    assert.match(lede, /connected to this API Management/);
    assert.doesNotMatch(lede, /subscription|every/i, "the lede describes connected Foundries, not the subscription");
    assert.ok(button(page.view, /^Connect another Foundry$/), "the way to connect another account");
  } finally {
    unmount();
  }
});

test("Connect another Foundry: a modal dialog listing every unconnected account, with search, Attach or the read error, the commands and help", async () => {
  const page = await mountFoundry([FIVE()]);
  try {
    const { connect, dialog } = openConnect(page);
    assert.equal(openDialogs(page.doc).length, 1);
    assert.equal(dialog.modal, true, "opened with showModal, so the page behind is inert");
    assert.equal(page.doc.getElementById(dialog.getAttribute("aria-labelledby"))?.textContent.trim(), "Connect another Foundry", "labelled by its title");
    assert.deepEqual(radios(dialog), [SPARE, NEW, LOCKED], "every account not connected, the unreadable one included");
    assert.match(words(dialog), /3 accounts not connected: 2 can be attached, 1 unreadable\./);
    const search = dialog.querySelector('input[type="search"]');
    assert.equal(page.doc.activeElement, search, "focus starts in the search box");

    type(search, "locked");
    assert.deepEqual(radios(dialog), [LOCKED]);
    assert.match(words(dialog), /· 1 shown\./);
    assert.match(words(dialog.querySelector(".connect-details") ?? dialog), /Choose an account to see what attaching it needs\./, "no details for an account the search hides");
    assert.equal(button(dialog, /^Attach /), undefined);
    pick(dialog, LOCKED);
    const locked = words(dialog.querySelector(".connect-details"));
    assert.match(locked, /cannot read this account/);
    assert.ok(locked.includes(LOCKED_ERROR), "the read error, not an empty account");
    assert.equal(button(dialog, /^Attach /), undefined, "an unreadable account offers no Attach");

    type(search, "nothing like this");
    assert.match(words(dialog), /No accounts match\./);
    button(dialog, /^Clear search$/).click();
    assert.deepEqual(radios(dialog), [SPARE, NEW, LOCKED]);

    pick(dialog, NEW);
    assert.ok(button(dialog, /^Attach foundry-new$/), "Attach for the chosen account");
    const chosen = words(dialog.querySelector(".connect-details"));
    assert.ok(chosen.includes(NEW), "its resource ID");
    assert.ok(chosen.includes(`pwsh scripts/Connect-Foundry.ps1 -FoundryAccountId '${NEW}'`), "its role setup command");
    assert.ok(chosen.includes("-ConfigurePrivateEndpoint"), "its optional network command");
    assert.equal(dialog.querySelector("details.network-setup")?.open, false, "folded until needed");

    button(dialog, /^How attaching works$/).click();
    assert.equal(dialog.open, false, "help closes the dialog first: the guide is inert behind a modal (U50)");
    assert.deepEqual(page.helpCalls.map((c) => [c.step, c.opener, c.dialogsOpen]), [["attach", connect, 0]], "the guide opens once no modal dialog is open");
    assert.equal(page.doc.activeElement, connect, "focus is back on Connect another Foundry");
  } finally {
    unmount();
  }
});

test("the connect dialog keeps Tab inside and returns focus to its opener when closed", async () => {
  const page = await mountFoundry([FIVE()]);
  try {
    const { connect, dialog } = openConnect(page);
    const first = dialog.querySelector('button[aria-label="Close"]');
    const last = button(dialog, /^Close$/);
    last.focus();
    const forward = keydown("Tab");
    last.dispatchEvent(forward);
    assert.equal(forward.defaultPrevented, true);
    assert.equal(page.doc.activeElement, first, "Tab from the last control wraps to the first");
    first.dispatchEvent(keydown("Tab", { shiftKey: true }));
    assert.equal(page.doc.activeElement, last, "Shift+Tab from the first wraps to the last");
    last.click();
    assert.equal(openDialogs(page.doc).length, 0);
    assert.equal(page.doc.activeElement, connect, "focus returns to Connect another Foundry");
  } finally {
    unmount();
  }
});

test("attaching from the dialog closes it and selects the account in the connected list", async () => {
  const after = FIVE();
  Object.assign(after.accounts[2], { connected: true, connectionId: "f00000000000a" });
  const page = await mountFoundry([FIVE(), after], {
    attach: (body) => reply(200, { attached: true, foundryId: body.foundryId, foundryName: "foundry-new", connectionId: "f00000000000a",
      gatewayUrl: "https://gw.example/foundry/f00000000000a", setupCommand: "pwsh scripts/Connect-Foundry.ps1 -FoundryAccountId 'x'",
      message: "Routing configured. Gateway inference permissions and private-network access still need to be verified." }),
  });
  try {
    const { dialog } = openConnect(page);
    pick(dialog, NEW);
    button(dialog, /^Attach foundry-new$/).click();
    button(openDialogs(page.doc).at(-1), /^Cancel$/).click();
    await settle();
    assert.equal(page.calls.some((c) => c.method === "POST"), false, "cancelling sends nothing");
    assert.deepEqual(openDialogs(page.doc), [dialog], "and keeps the dialog open");

    button(dialog, /^Attach foundry-new$/).click();
    const confirm = openDialogs(page.doc).at(-1);
    assert.notEqual(confirm, dialog, "attaching is confirmed first");
    assert.match(words(confirm), /Attach foundry-new\?/);
    button(confirm, /^Attach Foundry$/).click();
    await settle();
    assert.deepEqual(page.calls.filter((c) => c.method === "POST").map((c) => [c.path, c.body]), [["/api/foundries/attach", { foundryId: NEW }]]);
    assert.equal(openDialogs(page.doc).length, 0, "the dialog closed");
    assert.deepEqual(radios(page.view), [MAIN, NEW, RESEARCH], "the account joined the connected list");
    assert.equal(page.view.querySelector('input[type="radio"]:checked')?.value, NEW, "selected");
    const text = words(page.view);
    assert.match(text, /Routing configured\. Access is not verified yet\./);
    assert.ok(!text.includes("aoai-spare"), "the other accounts stay out of the page");
    assert.equal(page.doc.activeElement?.textContent.trim(), "Copy command", "focus moves on to the setup command");
  } finally {
    unmount();
  }
});

test("an attach that finishes after the dialog was closed still selects the account, without taking focus", async () => {
  const after = FIVE();
  Object.assign(after.accounts[3], { connected: true, connectionId: "f00000000000b" });
  let release;
  const answer = new Promise((resolve) => { release = resolve; });
  const page = await mountFoundry([FIVE(), after], { attach: () => answer });
  try {
    const { dialog } = openConnect(page);
    pick(dialog, SPARE);
    button(dialog, /^Attach aoai-spare$/).click();
    button(openDialogs(page.doc).at(-1), /^Attach Foundry$/).click();
    await settle();
    assert.match(words(dialog.querySelector(".connect-progress")), /Attaching aoai-spare\. API Management can take a minute or two\./);
    button(dialog, /^Close$/).click();
    const elsewhere = page.view.querySelector('input[aria-label="Search deployments"]');
    elsewhere.focus();
    release(reply(200, { attached: true, foundryId: SPARE, connectionId: "f00000000000b" }));
    await settle();
    assert.deepEqual(radios(page.view), [MAIN, SPARE, RESEARCH], "the account joined the connected list");
    assert.equal(page.view.querySelector('input[type="radio"]:checked')?.value, SPARE, "selected");
    assert.equal(page.doc.activeElement, elsewhere, "focus stays where the admin is working");
  } finally {
    unmount();
  }
});

test("an admin who moves focus while the page reloads after an attach keeps it", async () => {
  const after = FIVE();
  Object.assign(after.accounts[2], { connected: true, connectionId: "f00000000000a" });
  let release;
  const reloaded = new Promise((resolve) => { release = () => resolve(after); });
  const page = await mountFoundry([FIVE(), reloaded], { attach: (body) => reply(200, { attached: true, foundryId: body.foundryId, connectionId: "f00000000000a" }) });
  try {
    const { dialog } = openConnect(page);
    pick(dialog, NEW);
    button(dialog, /^Attach foundry-new$/).click();
    button(openDialogs(page.doc).at(-1), /^Attach Foundry$/).click();
    await settle();
    assert.equal(openDialogs(page.doc).length, 0, "the dialog closed and the page is reloading");
    const elsewhere = page.view.querySelector('input[aria-label="Search deployments"]');
    elsewhere.focus();
    release();
    await settle();
    assert.equal(page.view.querySelector('input[type="radio"]:checked')?.value, NEW, "the account is selected");
    assert.equal(page.doc.activeElement, elsewhere, "focus stays where the admin moved it during the reload");
  } finally {
    unmount();
  }
});

test("a failed attach keeps the dialog open with the error and focus on Attach; the connected list is unchanged", async () => {
  const page = await mountFoundry([FIVE()], { attach: () => reply(502, { error: "API Management rejected the backend." }) });
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { dialog } = openConnect(page);
    pick(dialog, NEW);
    const attach = button(dialog, /^Attach foundry-new$/);
    attach.focus();
    attach.click();
    button(openDialogs(page.doc).at(-1), /^Attach Foundry$/).click();
    await settle();
    assert.deepEqual(openDialogs(page.doc), [dialog], "the connect dialog stays open");
    const details = words(dialog.querySelector(".connect-details"));
    assert.match(details, /Attaching failed\./);
    assert.match(details, /API Management rejected the backend\./);
    assert.equal(page.doc.activeElement?.textContent.trim(), "Attach foundry-new", "focus is on Attach, to try again");
    assert.ok(dialog.contains(page.doc.activeElement), "the Attach button now in the dialog, not the one the error replaced");
    assert.deepEqual(radios(page.view), [MAIN, RESEARCH]);
  } finally {
    mock.timers.reset();
    unmount();
  }
});

test("with no Foundry connected, the page shows an empty state whose Connect another Foundry opens the dialog", async () => {
  const page = await mountFoundry([discovery(account(NEW), account(LOCKED, { kind: "OpenAI", deployments: 0, error: LOCKED_ERROR }))]);
  try {
    assert.deepEqual(radios(page.view), []);
    const empty = page.view.querySelector(".state-empty");
    assert.match(words(empty), /No Foundry is connected to this API Management yet\./);
    assert.doesNotMatch(words(page.view), /foundry-new|openai-locked/);
    const { dialog } = openConnect(page, empty);
    assert.deepEqual(radios(dialog), [NEW, LOCKED]);
  } finally {
    unmount();
  }
});

test("with no account found at all, the page and the dialog each say so", async () => {
  const page = await mountFoundry([discovery()]);
  try {
    assert.match(words(page.view.querySelector(".state-empty")), /No Foundry is connected to this API Management yet\./);
    const { dialog } = openConnect(page, page.view.querySelector(".state-empty"));
    assert.deepEqual(radios(dialog), []);
    assert.match(words(dialog), /No other Foundry accounts were found\./);
    assert.match(words(dialog), /00000000-0000-4000-8000-000000000002/, "names the subscription searched");
  } finally {
    unmount();
  }
});

test("the guide: Attach a Foundry describes and highlights Connect another Foundry; Escape still closes the guide", async () => {
  const page = await mountFoundry([FIVE()]);
  const guide = help.createGuide({ go: () => {} });
  try {
    const say = (id) => help.STEPS.find((s) => s.id === id).text.join(" ");
    assert.match(say("discover"), /connected to this API Management/);
    assert.match(say("attach"), /Connect another Foundry/);
    assert.match(say("issue"), /connected to this API Management/);

    dom.addChildren(page.doc.body, guide.button, guide.panel);
    guide.routed(page.view, "models");
    guide.open("discover", guide.button);
    guide.panel.querySelector("[data-help-show]").click();
    assert.equal(page.doc.activeElement?.textContent.trim(), "Refresh from Azure", "Find Foundry accounts still lands on Refresh");

    guide.open("attach", guide.button);
    guide.panel.querySelector("[data-help-show]").click();
    const connect = button(page.view, /^Connect another Foundry$/);
    const marked = page.view.querySelectorAll(".help-target");
    assert.equal(marked.length, 1);
    assert.ok(marked[0].contains(connect), "the highlight is around Connect another Foundry");
    assert.equal(marked[0].getAttribute("data-help-label"), "Step 2 of 6: Attach a Foundry");
    assert.equal(page.doc.activeElement, connect, "and keyboard focus is on it");
    connect.dispatchEvent(keydown("Escape"));
    assert.equal(guide.panel.hidden, true, "Escape closes the guide");
    assert.equal(page.view.querySelectorAll(".help-target").length, 0, "and clears the highlight");
  } finally {
    unmount();
  }
});

// ── The issue forms' Foundry choice (foundry-picker.js) ────────────────────

async function mountPicker(answer) {
  const doc = fakeDom();
  globalThis.document = doc;
  const chosen = [];
  const picker = foundryChooser({ foundries: async () => structuredClone(answer), help: () => {} }, { onChoose: (a) => chosen.push(a?.id ?? null) });
  dom.addChildren(doc.body, picker.wrap);
  await settle();
  return { picker, chosen };
}

test("the issue forms offer connected Foundries only and do not count the others", async () => {
  const { picker, chosen } = await mountPicker(FIVE());
  try {
    assert.deepEqual(radios(picker.wrap), [MAIN, RESEARCH]);
    assert.deepEqual(chosen, [MAIN], "the default is chosen first");
    const text = words(picker.wrap);
    assert.doesNotMatch(text, /more accounts?|not attached|not readable/i, "no hint counting the subscription's other accounts");
    assert.match(text, /Only Foundries connected to this API Management are offered\./);
  } finally {
    unmount();
  }
});

test("with no Foundry connected, the issue forms say so and link to Foundry & models without counting accounts", async () => {
  const { picker, chosen } = await mountPicker(discovery(account(NEW), account(LOCKED, { kind: "OpenAI", deployments: 0, error: LOCKED_ERROR })));
  try {
    assert.deepEqual(radios(picker.wrap), []);
    assert.deepEqual(chosen, [null], "nothing can be chosen");
    const empty = picker.wrap.querySelector(".state-empty");
    assert.match(words(empty), /No Foundry is connected to this API Management yet\./);
    assert.doesNotMatch(words(empty), /\d/, "no count of the subscription's accounts");
    assert.match(words(empty.querySelector('a[href="#/models"]')), /Foundry & models/);
  } finally {
    unmount();
  }
});