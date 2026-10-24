// Key Dashboard UI, P56 (ADR-0017): every Foundry account, attaching one, the connection test, the
// Foundry each key is bound to, and the highlightable setup guide. The pure helpers (foundry.js)
// and the read cache (api.js) run under Node; the guide (help.js) runs against a small fake DOM;
// the views are checked statically. tests/console-ui.test.mjs keeps the safety invariants, which
// scan these modules too.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fakeDom, keydown } from "./console-dom.harness.mjs";

const PUBLIC = new URL("../src/console/public/", import.meta.url);
const read = (name) => readFileSync(new URL(name, PUBLIC), "utf8");
const JS = readdirSync(PUBLIC).filter((n) => n.endsWith(".js")).sort();
const source = Object.fromEntries(JS.map((n) => [n, read(n)]));
const css = read("app.css");
const html = read("index.html");

const lib = await import(new URL("lib.js", PUBLIC));
const api = await import(new URL("api.js", PUBLIC));
const dom = await import(new URL("dom.js", PUBLIC));
const foundry = await import(new URL("foundry.js", PUBLIC));
const help = await import(new URL("help.js", PUBLIC));

// ── Four accounts: two connected, one not attached, one unreadable ─────────

const SUB = "/subscriptions/00000000-0000-4000-8000-000000000001";
const armId = (rg, name) => `${SUB}/resourceGroups/${rg}/providers/Microsoft.CognitiveServices/accounts/${name}`;
const MAIN = armId("rg-gateway", "foundry-main");
const RESEARCH = armId("rg-research", "foundry-research");
const LOCKED = armId("rg-locked", "openai-locked");
const NEW = armId("rg-research", "foundry-new");
const DISCOVERY = {
  subscriptionId: "00000000-0000-4000-8000-000000000001",
  defaultFoundryId: MAIN,
  accounts: [
    { id: RESEARCH, name: "foundry-research", resourceGroup: "rg-research", location: "swedencentral", kind: "AIServices", connected: true,
      connectionId: "f0123456789ab", deployments: 2, setupCommand: "./scripts/Connect-Foundry.ps1 -FoundryId 'x'",
      networkCommand: "./scripts/Connect-Foundry.ps1 -FoundryId 'x' -ConfigurePrivateEndpoint -VnetName 'vnet-gw'" },
    { id: LOCKED, name: "openai-locked", resourceGroup: "rg-locked", location: "eastus2", kind: "OpenAI", connected: false,
      error: "AuthorizationFailed: the dashboard cannot read this account's deployments." },
    { id: MAIN, name: "foundry-main", resourceGroup: "rg-gateway", location: "eastus2", kind: "AIServices", connected: true, connectionId: "default", deployments: 3 },
    { id: NEW, name: "foundry-new", resourceGroup: "rg-research", location: "westus3", kind: "AIServices", connected: false, deployments: 1 },
  ],
};
const accounts = foundry.accountsOf(DISCOVERY);
const byId = (id) => accounts.find((a) => a.id === id);

function stubFetch(responder) {
  const calls = [];
  globalThis.fetch = async (path, init) => {
    calls.push({ path, init });
    return responder(path, init);
  };
  return calls;
}
const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, type: "basic", text: async () => JSON.stringify(body) });

// ── foundry.js: discovery and selection ─────────────────────────────────────

test("accounts: the default first, then by name; ids kept exactly; an unreadable account stays listed with its error", () => {
  assert.deepEqual(accounts.map((a) => a.name), ["foundry-main", "foundry-new", "foundry-research", "openai-locked"]);
  assert.equal(byId(MAIN).isDefault, true);
  assert.equal(byId(RESEARCH).isDefault, false);
  assert.equal(byId(RESEARCH).connectionId, "f0123456789ab");
  assert.equal(byId(RESEARCH).setupCommand, "./scripts/Connect-Foundry.ps1 -FoundryId 'x'");
  assert.match(byId(RESEARCH).networkCommand, /-ConfigurePrivateEndpoint/);
  assert.equal(byId(MAIN).networkCommand, null, "the network command is optional");
  assert.equal(byId(LOCKED).deployments, null, "an unknown count is not shown as zero");

  const locked = foundry.accountStatus(byId(LOCKED));
  assert.equal(locked.state, "error");
  assert.equal(locked.tone, "bad");
  assert.match(locked.detail, /AuthorizationFailed/, "the error is shown, not turned into 'no deployments'");
  assert.equal(foundry.accountStatus(byId(NEW)).state, "available");
  assert.equal(foundry.accountStatus(byId(MAIN)).state, "connected");
  assert.equal(foundry.accountStatus(byId(MAIN)).tone, "ok");
  const shaky = foundry.accountStatus({ ...byId(RESEARCH), error: "Deployments could not be listed." });
  assert.equal(shaky.state, "connected", "a connected account keeps its routes");
  assert.equal(shaky.tone, "warn");
  assert.match(shaky.detail, /could not be listed/);

  assert.deepEqual(foundry.summarize(accounts), { total: 4, connected: 2, available: 1, unreadable: 1, deployments: 6, deploymentsKnown: false });
  assert.equal(foundry.connectedLine(accounts), "2 Foundries connected to this API Management · 5 deployments.", "the page counts connected Foundries only (P58)");
  assert.equal(foundry.candidatesLine(accounts), "2 accounts not connected: 1 can be attached, 1 unreadable.", "Connect another Foundry counts the rest");
  assert.equal(foundry.connectedLine([]), "");

  assert.deepEqual(foundry.accountsOf({ accounts: [{ name: "no id" }, null, "x"] }), [], "entries without an id are not accounts");
  const twice = foundry.accountsOf({ accounts: [{ id: RESEARCH, name: "a" }, { id: RESEARCH.toUpperCase(), name: "b" }] });
  assert.equal(twice.length, 1, "ARM ids are case-insensitive: one account");
  assert.equal(foundry.accountsOf({ accounts: [{ id: NEW }] })[0].name, "foundry-new", "a missing name falls back to the id's last segment");
  assert.equal(foundry.KIND_LABEL.OpenAI, "Azure OpenAI");
});

test("selection is by ARM id, case-insensitively, never by name; then the default; then the first", () => {
  const twins = foundry.accountsOf({ defaultFoundryId: MAIN, accounts: [
    { id: RESEARCH, name: "same-name", connected: true, connectionId: "f0123456789ab" },
    { id: MAIN, name: "same-name", connected: true, connectionId: "default" },
  ] });
  assert.equal(foundry.pickAccount(twins, RESEARCH.toUpperCase(), MAIN).id, RESEARCH);
  assert.equal(foundry.pickAccount(twins, "same-name", RESEARCH).id, RESEARCH, "a name never selects an account, even the first one listed");
  assert.equal(foundry.pickAccount(twins, null, MAIN).id, MAIN);
  assert.equal(foundry.pickAccount(twins, NEW, null).id, MAIN, "the default account, when nothing else matches");
  assert.equal(foundry.pickAccount([], MAIN, MAIN), null);
  assert.equal(foundry.sameAccount(MAIN, MAIN.toLowerCase()), true);
  assert.equal(foundry.sameAccount("", ""), false);

  const issuable = foundry.connectedAccounts(accounts);
  assert.deepEqual(issuable.map((a) => a.name), ["foundry-main", "foundry-research"]);
  assert.equal(foundry.pickAccount(issuable, NEW, MAIN).id, MAIN, "an account that is not attached is never kept for issuing");
});

test("two accounts deploying the same name: reads, pins, tests and issue bodies carry the account's resource id", async () => {
  const pathMain = api.apiPath("/api/models", { foundryId: MAIN });
  const pathResearch = api.apiPath("/api/models", { foundryId: RESEARCH });
  assert.notEqual(pathMain, pathResearch);
  assert.equal(new URL(pathResearch, "https://dashboard.example").searchParams.get("foundryId"), RESEARCH, "the id round-trips exactly");
  const calls = stubFetch((path) => {
    const id = new URL(path, "https://dashboard.example").searchParams.get("foundryId");
    return reply(200, { foundryId: id, deployments: [{ deployment: "gpt-4o", model: "gpt-4o", version: id === MAIN ? "2024-08-06" : "2024-11-20", route: "openai" }], pins: { openai: [], claude: [] } });
  });
  try {
    const [m, r] = await Promise.all([api.cachedGet(pathMain), api.cachedGet(pathResearch)]);
    assert.equal(calls.length, 2, "one cached read per account");
    assert.deepEqual([m.foundryId, r.foundryId], [MAIN, RESEARCH]);
    assert.notEqual(m.deployments[0].version, r.deployments[0].version, "same name, different deployments");
  } finally {
    api.invalidate();
    delete globalThis.fetch;
  }
  const research = byId(RESEARCH);
  const d = { deployment: "gpt-4o", route: "openai" };
  assert.deepEqual(foundry.pinBody(research, d, "gpt4o"), { foundryId: RESEARCH, alias: "gpt4o", deployment: "gpt-4o", route: "openai" });
  assert.deepEqual(foundry.unpinBody(research, "gpt4o", "openai"), { foundryId: RESEARCH, alias: "gpt4o", route: "openai" });
  assert.deepEqual(foundry.attachBody(byId(NEW)), { foundryId: NEW });
  assert.deepEqual(foundry.testBody(research, { route: "openai", alias: "gpt4o" }), { foundryId: RESEARCH, alias: "gpt4o", route: "openai" });
  assert.deepEqual(foundry.withFoundry({ models: ["gpt-4o"], budget: 10 }, research), { models: ["gpt-4o"], budget: 10, foundryId: RESEARCH });
  assert.throws(() => foundry.withFoundry({ models: [] }, null), /Choose the Foundry/);
  assert.throws(() => foundry.withFoundry({ models: [] }, byId(NEW)), /Attach foundry-new/, "keys are only issued for an attached account");
});

test("an issue form's Foundry choice drops the models and refuses answers for an earlier choice or another account", () => {
  const config = (id, aliases) => ({ foundryId: id, gatewayUrl: "https://gw.example", models: { openai: aliases, claude: [] },
    deployments: [{ deployment: "gpt-4o", model: "gpt-4o", version: "1", route: "openai" }] });
  const choice = foundry.issueChoice("jwt");
  const first = choice.choose(byId(MAIN));
  assert.deepEqual(choice.accept(first, config(MAIN, ["main-only"])).options.map((o) => o.value), ["main-only"]);
  assert.deepEqual(choice.options.map((o) => o.value), ["main-only"]);
  const second = choice.choose(byId(RESEARCH));
  assert.equal(choice.options, null, "choosing again drops the first Foundry's models");
  assert.equal(choice.isCurrent(first), false);
  assert.equal(choice.isCurrent(second), true);
  assert.deepEqual(choice.accept(first, config(MAIN, ["main-only"])), { stale: true }, "the earlier choice's answer is ignored");
  assert.equal(choice.options, null);
  assert.match(choice.accept(second, config(MAIN, ["main-only"])).error, /another Foundry/, "a config naming another account is refused");
  assert.equal(choice.options, null);
  const ok = choice.accept(second, config(RESEARCH.toUpperCase(), ["research-alias"]));
  assert.deepEqual(ok.options.map((o) => o.value), ["research-alias"]);
  assert.deepEqual(choice.body({ models: ["research-alias"], budget: 5 }), { models: ["research-alias"], budget: 5, foundryId: RESEARCH });

  const product = foundry.issueChoice("product");
  const legacy = product.choose(byId(MAIN));
  const options = product.accept(legacy, { gatewayUrl: "https://gw.example", models: {}, deployments: [{ deployment: "gpt-4o", route: "openai" }] }).options;
  assert.deepEqual(options.map((o) => o.value), ["gpt-4o"], "an older server's config without foundryId still serves the default account");
  const other = product.choose(byId(RESEARCH));
  assert.match(product.accept(other, { deployments: [] }).error, /another Foundry/, "but never another account");
  assert.equal(foundry.foreignAnswer({ foundryId: MAIN }, byId(MAIN)), null);
  assert.match(foundry.foreignAnswer({ foundryId: MAIN }, byId(RESEARCH)), /foundry-research/);

  product.choose(null);
  assert.throws(() => product.body({ models: ["gpt-4o"] }), /Choose the Foundry/);
});

test("keys show the Foundry they belong to; keys without that metadata belong to the default", () => {
  assert.deepEqual(foundry.keyFoundry({ name: "jwt-old" }), { connectionId: "default", isDefault: true, name: "Default Foundry" });
  assert.deepEqual(foundry.keyFoundry({ foundry: "f0123456789ab", foundryName: "foundry-research" }),
    { connectionId: "f0123456789ab", isDefault: false, name: "foundry-research" });
  assert.equal(foundry.keyFoundry({ foundry: "f0123456789ab" }).name, "f0123456789ab");
  assert.equal(foundry.keyFoundry({ foundry: "default", foundryName: "foundry-main" }).name, "foundry-main");
  assert.equal(foundry.accountForKey(accounts, { foundry: "f0123456789ab" }).id, RESEARCH);
  assert.equal(foundry.accountForKey(accounts, {}).id, MAIN, "a legacy key resolves to the default account");
  assert.equal(foundry.accountForKey(accounts, { foundry: "f999999999999" }), null);
  assert.equal(lib.matchesQuery({ name: "jwt-1", foundryName: "foundry-research", foundry: "f0123456789ab" }, "research"), true, "search finds keys by Foundry");
  assert.equal(lib.matchesQuery({ name: "jwt-1", foundry: "f0123456789ab" }, "f0123456789ab"), true);
});

test("deployments: Pin is refused with a reason for unattached accounts and unready or unroutable deployments", () => {
  const ready = { deployment: "gpt-4o", model: "gpt-4o", version: "2024-11-20", route: "openai", wire: "openai-chat-completions", state: "Succeeded", ready: true,
    canPin: { allowed: true, reason: "" }, pinnedAs: [{ alias: "gpt4o", route: "openai" }] };
  assert.equal(foundry.pinBlockReason(ready, false), "Attach this Foundry first.");
  assert.equal(foundry.pinBlockReason(ready, true), null);
  const unknown = { deployment: "whisper", model: "whisper", route: null, wire: "unknown", state: "Succeeded", ready: true,
    canPin: { allowed: false, reason: "'whisper' reports a model format this gateway does not route." } };
  assert.match(foundry.pinBlockReason(unknown, true), /whisper/);
  assert.equal(foundry.pinBlockReason({ deployment: "x" }, true), "This deployment cannot be pinned.");

  assert.deepEqual(foundry.deploymentState(ready), { label: "ready", tone: "ok", reason: null });
  const creating = foundry.deploymentState({ deployment: "x", state: "Creating", ready: false, canPin: { allowed: false, reason: "'x' is Creating, not Succeeded." } });
  assert.equal(creating.tone, "warn");
  assert.match(creating.reason, /Creating/);
  assert.equal(foundry.deploymentState({ state: "Failed", ready: false }).tone, "bad");
  assert.match(foundry.deploymentState({ ready: false }).reason, /not ready/i, "a missing state still says why");
  assert.equal(foundry.routeReason(ready), null);
  assert.match(foundry.routeReason(unknown), /whisper/);
  assert.match(foundry.routeReason({ deployment: "y", route: null }), /format/);

  assert.equal(foundry.matchesDeployment(ready, "GPT4O"), true, "pinned aliases are searchable");
  assert.equal(foundry.matchesDeployment(ready, "2024-11 openai"), true);
  assert.equal(foundry.matchesDeployment(ready, "claude"), false);
  assert.equal(foundry.matchesDeployment(unknown, ""), true);
});

test("attaching configures routing only: the UI always says access is not verified yet", () => {
  const s = foundry.attachSummary({ attached: true, foundryId: RESEARCH, foundryName: "foundry-research", connectionId: "f0123456789ab",
    gatewayUrl: "https://gw.example/foundry/f0123456789ab", setupCommand: "./scripts/Connect-Foundry.ps1 -FoundryId 'x'",
    message: "Routing configured. Gateway inference permissions and private-network access still need to be verified." });
  assert.notEqual(s.tone, "ok", "an attachment is never presented as a working connection");
  assert.match(s.title, /not verified/i);
  assert.ok(s.lines.includes("Routing configured. Gateway inference permissions and private-network access still need to be verified."), "the server's message is kept");
  assert.ok(s.lines.some((l) => /does not grant/.test(l) && /private network/.test(l) && /test/.test(l)));
  assert.equal(s.setupCommand, "./scripts/Connect-Foundry.ps1 -FoundryId 'x'");
  assert.equal(s.gatewayUrl, "https://gw.example/foundry/f0123456789ab");
  const bare = foundry.attachSummary({ attached: true });
  assert.ok(bare.lines.some((l) => /does not grant/.test(l)), "even when the server says nothing");
  assert.equal(bare.setupCommand, null);
});

test("the connection test: unavailable with a reason until attached and pinned; failures say what to check", () => {
  assert.deepEqual(foundry.testAvailability(byId(NEW), null), { allowed: false, reason: "Attach this Foundry first.", choices: [] });
  const none = foundry.testAvailability(byId(RESEARCH), { openai: [], claude: [] });
  assert.equal(none.allowed, false);
  assert.match(none.reason, /Pin an alias/);
  const some = foundry.testAvailability(byId(RESEARCH), { openai: [{ alias: "gpt4o", deployment: "gpt-4o" }], claude: [{ alias: "haiku-4-5", deployment: "claude-haiku-4-5" }] });
  assert.equal(some.allowed, true);
  assert.deepEqual(some.choices.map((c) => c.value), ["openai:gpt4o", "claude:haiku-4-5"]);
  assert.deepEqual(foundry.parseChoice("claude:haiku-4-5"), { route: "claude", alias: "haiku-4-5" });
  assert.equal(foundry.parseChoice("bogus"), null);
  assert.equal(foundry.parseChoice("other:x"), null);

  assert.deepEqual(foundry.testGuidance({ ok: true, status: 200 }), []);
  const denied = foundry.testGuidance({ ok: false, status: 403 }).join(" ");
  assert.match(denied, /setup command/);
  assert.match(denied, /role/);
  assert.match(denied, /public network access|private DNS/, "a 403 can also be a disabled public endpoint");
  for (const status of [0, 500, 502, 504, undefined]) {
    const g = foundry.testGuidance({ ok: false, status }).join(" ");
    assert.match(g, /virtual network/, String(status));
    assert.match(g, /private DNS/, String(status));
  }
  assert.match(foundry.testGuidance({ ok: false, status: 404 }).join(" "), /pinned|attach/i);
  assert.match(foundry.testGuidance({ ok: false, status: 429 }).join(" "), /quota|rate/i);

  const failed = foundry.testSummary({ ok: false, status: 403, detail: "The principal lacks the required data action." }, "gpt4o");
  assert.equal(failed.tone, "bad");
  assert.match(failed.title, /403/);
  assert.ok(failed.lines.includes("The principal lacks the required data action."));
  assert.ok(failed.guidance.length > 0);
  const passed = foundry.testSummary({ ok: true, status: 200, detail: "pong" }, "gpt4o");
  assert.equal(passed.tone, "ok");
  assert.match(passed.title, /gpt4o/);
  assert.deepEqual(passed.guidance, []);
});

test("the optional private-network command: from the latest answer that has one; DNS shadowing and timeouts point to it", () => {
  const net = "./scripts/Connect-Foundry.ps1 -FoundryId 'x' -ConfigurePrivateEndpoint -VnetName 'vnet-gw'";
  assert.deepEqual(foundry.commandsFor({ setupCommand: "role-a" }, { setupCommand: "role-b", networkCommand: net }, null), { setup: "role-a", network: net });
  assert.deepEqual(foundry.commandsFor(null, {}, { setupCommand: " " }), { setup: null, network: null }, "both are optional");
  assert.equal(foundry.attachSummary({ attached: true, networkCommand: net }).networkCommand, net);
  assert.equal(foundry.attachSummary({ attached: true }).networkCommand, null);

  const dns = foundry.testSummary({ ok: false, status: 502, code: "backend_dns", detail: "The gateway's network resolved the account to no private address." }, "o4");
  assert.equal(dns.tone, "bad", "DNS shadowing is a failure, never a working connection");
  assert.equal(dns.suggestNetwork, true);
  assert.match(dns.guidance.join(" "), /private DNS zone/);
  assert.match(dns.guidance.join(" "), /DNS record/);
  assert.ok(dns.lines.includes("The gateway's network resolved the account to no private address."));
  for (const status of [0, 502, 503, 504, undefined]) assert.equal(foundry.testSummary({ ok: false, status }, "x").suggestNetwork, true, String(status));
  for (const r of [{ ok: false, status: 403 }, { ok: false, status: 404 }, { ok: false, status: 429 }, { ok: true, status: 200 }]) {
    assert.equal(foundry.testSummary(r, "x").suggestNetwork, false, JSON.stringify(r));
  }
});

// ── api.js: what Refresh drops ──────────────────────────────────────────────

test("Foundry reads are cached per full query; Refresh drops every Foundry read and nothing else", async () => {
  assert.deepEqual([...foundry.FOUNDRY_CACHES], ["/api/foundries", "/api/models", "/api/config"]);
  const calls = stubFetch((path) => reply(200, { path }));
  const foundryReads = ["/api/foundries", "/api/config", api.apiPath("/api/config", { foundryId: MAIN }), api.apiPath("/api/config", { foundryId: RESEARCH }),
    "/api/models", api.apiPath("/api/models", { foundryId: RESEARCH })];
  const keyList = "/api/keys?kind=jwt&status=active";
  try {
    for (const p of [...foundryReads, keyList]) await api.cachedGet(p);
    for (const p of [...foundryReads, keyList]) await api.cachedGet(p);
    assert.equal(calls.length, 7, "each full query is its own entry, read once");
    api.invalidate(...foundry.FOUNDRY_CACHES);
    for (const p of [...foundryReads, keyList]) await api.cachedGet(p);
    assert.equal(calls.length, 13, "every Foundry read is fetched again");
    assert.equal(calls.filter((c) => c.path === keyList).length, 1, "the key list is not");
    for (const p of ["/api/models/pin", "/api/foundries/test", "/api/keys/jwt-abc", `/api/keys/jwt-abc?foundryId=${encodeURIComponent(MAIN)}`, "/api/config?foundryId=a&x=1"]) {
      assert.throws(() => api.cachedGet(p), /Never cached/, p);
    }
  } finally {
    api.invalidate();
    delete globalThis.fetch;
  }
});

// ── Views, statically: every request names its account ─────────────────────

test("pin, unpin, attach and test requests are built by the helpers that name the account", () => {
  const fv = source["views-foundry.js"];
  assert.match(fv, /post\("\/api\/models\/pin", pinBody\(/);
  assert.match(fv, /post\("\/api\/models\/unpin", unpinBody\(/);
  assert.match(fv, /post\("\/api\/foundries\/attach", attachBody\(/);
  assert.match(fv, /post\("\/api\/foundries\/test", testBody\(/);
  assert.deepEqual(JS.filter((n) => /\/api\/(?:models\/(?:un)?pin|foundries\/(?:attach|test))/.test(source[n])), ["views-foundry.js"]);
  assert.ok((fv.match(/invalidate\(\.\.\.FOUNDRY_CACHES\)/g) ?? []).length >= 2, "Refresh and Attach drop every Foundry read");
  assert.match(fv, /invalidate\("\/api\/models", "\/api\/config"\)/, "pin and unpin drop models and config");
  assert.match(fv, /confirmDialog\(\{[^}]*title: "Send a test request\?"/, "the paid test request is confirmed first");
  assert.match(fv, /confirmDialog\(\{[^}]*title: `Attach \$\{/, "attaching is confirmed first");
  assert.match(fv, /errorState\(/, "a failed read is an error, not an empty list");
  assert.doesNotMatch(fv, /\bsetupCommand\s*\(|\bnetworkCommand\s*\(/, "operator commands are text to copy, never called");
  assert.deepEqual(JS.filter((n) => /\b(?:el|createElement)\(\s*["'`]script\b/i.test(source[n])), [], "no module creates a script element");
});

test("the network setup command is optional, separate from the role command, copy-only, and says what it changes and costs", () => {
  const fv = source["views-foundry.js"];
  assert.match(fv, /commandsFor\(/);
  assert.match(fv, /el\("details", \{ class: \["disclosure", "network-setup"/, "a separate, optional block");
  assert.match(fv, /copyButton\(\(\) => command, \{ label: "Copy network command"/);
  assert.match(fv, /does not change the account's public network access or firewall/);
  assert.match(fv, /billed/, "with a cost note");
  assert.match(fv, /"network-setup", suggested \? "is-suggested" : null\], open: suggested \}/, "open when the last test pointed at the network");
  assert.match(fv, /if \(outcome\.suggestNetwork && networkBox\) \{\s*networkBox\.open = true;/, "and opened as soon as such a test fails");
});

test("single and bulk issue send the chosen Foundry; changing it drops the model picker", () => {
  const vi = source["views-issue.js"];
  assert.match(vi, /import \{ foundryChooser \} from "\.\/foundry-picker\.js";/);
  assert.match(vi, /issueChoice\(kind\)/);
  assert.match(vi, /\.choice\.body\(check\.body\)/, "single issue");
  assert.match(vi, /\.choice\.body\(settings\.body\)/, "bulk issue");
  assert.match(vi, /picker = null;\s*const ticket = choice\.choose\(account\);/, "the old picker goes before the new Foundry's models load");
  assert.match(vi, /"data-help": "bulk-rows"/);
  const fp = source["foundry-picker.js"];
  assert.match(fp, /connectedAccounts\(/, "only connected accounts are offered");
  assert.match(fp, /href: "#\/models"/, "with nothing connected, the way to attach one");
  assert.match(fp, /"data-help": "issue-foundry"/);
});

test("the key list, the drawer and search show each key's Foundry", () => {
  for (const name of ["views-keys.js", "views-drawer.js"]) assert.match(source[name], /keyFoundry\(/, name);
  assert.match(source["views-drawer.js"], /add\("Foundry"/);
});

test("app wiring: the Models page is Foundry & models, config is read per Foundry, and the guide follows every route", () => {
  const app = source["app.js"];
  assert.match(app, /\{ id: "models", label: "Foundry & models"/);
  assert.match(app, /config: \(foundryId\) => cachedGet\(apiPath\("\/api\/config", \{ foundryId \}\), \{ ttl: Infinity \}\)/);
  assert.match(app, /foundries: \(\{ fresh = false \} = \{\}\) => cachedGet\("\/api\/foundries", \{ ttl: Infinity, fresh \}\)/);
  assert.match(app, /r\.render\(view, ctx, sub\);\s*if \(moveFocus\) view\.querySelector\("\.view-title"\)\?\.focus\(\);\s*(?:\/\/[^\n]*\n\s*)?guide\?\.routed\(view, /,
    "every route tells the guide what is on screen, after the title takes focus, so a pending highlight can move it");
  assert.match(app, /ctx\.help = /);
  assert.match(html, /<div id="help-slot"><\/div>/);
  assert.doesNotMatch(source["views-admin.js"], /renderModels|\/api\/models/, "the old single-account Models view is gone");
});

// ── help.js: the steps ──────────────────────────────────────────────────────

test("six guide steps from discovery to distribution, each pointing at a section that a view marks", () => {
  assert.deepEqual(help.STEPS.map((s) => s.id), ["discover", "attach", "access", "pin", "issue", "distribute"]);
  const marked = new Set(JS.flatMap((n) => [...source[n].matchAll(/"data-help": "([a-z-]+)"/g)].map((m) => m[1])));
  for (const s of help.STEPS) {
    assert.ok(marked.has(s.target), `${s.id}: a view marks [data-help="${s.target}"]`);
    assert.ok(s.routes.length > 0, s.id);
    for (const r of s.routes) assert.match(r, /^(?:models|(?:short-lived|product)\/(?:issue|bulk))$/, `${s.id}: ${r}`);
    assert.ok(s.title && s.where && s.text.length, s.id);
  }
});

test("the guide explains permissions, networking, aliases, refresh and safe distribution", () => {
  const words = [...help.STEPS.flatMap((s) => [s.title, ...s.text]), ...help.NOTES].join(" ");
  for (const re of [/metadata/, /inference/, /does not grant/, /private DNS/, /virtual network/, /setup command/, /network setup command/, /alias/, /deployment name/, /Refresh/,
    /Issued to/, /dashboard access/, /no key values/, /keys\.csv/, /index\.csv/, /encrypted bundle/, /a few tokens/]) {
    assert.match(words, re);
  }
  assert.doesNotMatch(words, /\bOwner\b|your keys/i);
});

// ── help.js: the panel and highlights, on a small fake DOM ─────────────────

const modelsView = () => dom.el("div", { class: "view" },
  dom.el("section", { class: "card", "data-help": "foundry-accounts" }, dom.el("h2", {}, "Foundry accounts"),
    dom.el("button", { type: "button", "data-help-focus": true }, "Refresh from Azure")),
  dom.el("section", { class: "card", "data-help": "foundry-attach" },
    dom.el("button", { type: "button", "data-help-focus": true, "aria-describedby": "attach-hint" }, "Attach")),
  dom.el("section", { class: "card", "data-help": "foundry-deployments" }, dom.el("h2", {}, "Deployments")));
const overviewView = () => dom.el("div", { class: "view" }, dom.el("h1", {}, "Overview"));

function mountGuide({ route = "models", view = modelsView, reduced = false } = {}) {
  const doc = fakeDom();
  globalThis.document = doc;
  if (reduced) globalThis.matchMedia = (query) => ({ matches: query === "(prefers-reduced-motion: reduce)" });
  const went = [];
  const guide = help.createGuide({ go: (hash) => went.push(hash) });
  const main = dom.el("main", { id: "main" });
  dom.addChildren(doc.body, guide.button, main, guide.panel);
  const show = (v, r) => { dom.setChildren(main, v); guide.routed(v, r); };
  show(view(), route);
  return { doc, guide, went, main, show };
}
function unmount() {
  delete globalThis.document;
  delete globalThis.matchMedia;
}
const currentStep = (guide) => guide.panel.querySelector('[aria-current="step"]')?.textContent ?? "";

test("the guide opens from Help, closes on Escape and gives focus back to what opened it", () => {
  const { doc, guide } = mountGuide();
  try {
    assert.equal(guide.panel.hidden, true, "closed until asked for");
    assert.equal(guide.button.getAttribute("aria-controls"), guide.panel.getAttribute("id"));
    assert.equal(guide.button.getAttribute("aria-expanded"), "false");
    guide.button.focus();
    guide.button.click();
    assert.equal(guide.panel.hidden, false);
    assert.equal(guide.button.getAttribute("aria-expanded"), "true");
    assert.ok(doc.body.classList.contains("help-open"), "the page docks the panel beside the content");
    assert.ok(guide.panel.contains(doc.activeElement), "focus moves into the guide");
    doc.activeElement.dispatchEvent(keydown("Escape"));
    assert.equal(guide.panel.hidden, true, "Escape closes it");
    assert.equal(guide.button.getAttribute("aria-expanded"), "false");
    assert.equal(doc.body.classList.contains("help-open"), false);
    assert.equal(doc.activeElement, guide.button, "focus returns to Help");

    const ask = dom.el("button", { type: "button" }, "Which Foundry?");
    dom.addChildren(doc.body, ask);
    guide.open("issue", ask);
    assert.match(currentStep(guide), /Choose the Foundry/, "a contextual link opens its own step");
    doc.activeElement.dispatchEvent(keydown("Escape"));
    assert.equal(doc.activeElement, ask, "focus returns to the contextual link");
    guide.open("issue", ask);
    ask.remove();
    guide.close();
    assert.equal(doc.activeElement, guide.button, "or to Help when that link has gone");
  } finally {
    unmount();
  }
});

test("Show me highlights the step's section on this page: outline class, step label, focus and an aria description", () => {
  const { doc, guide, went, main } = mountGuide();
  try {
    guide.open("discover", guide.button);
    guide.panel.querySelector("[data-help-show]").click();
    const section = main.querySelector('[data-help="foundry-accounts"]');
    const control = section.querySelector("[data-help-focus]");
    assert.deepEqual(went, [], "already on the page: nothing navigates");
    assert.ok(section.classList.contains("help-target"));
    assert.match(section.getAttribute("data-help-label"), /^Step 1 of 6: Find Foundry accounts$/);
    assert.equal(doc.activeElement, control, "keyboard focus lands on the step's control");
    assert.deepEqual(control.focusOptions, { preventScroll: true });
    assert.deepEqual(section.scrolledWith, { block: "center", behavior: "smooth" });
    const ids = control.getAttribute("aria-describedby").split(" ");
    assert.match(ids.map((id) => doc.getElementById(id)?.textContent ?? "").join(" "), /subscription/, "described by the step's own text");
  } finally {
    unmount();
  }
});

test("with reduced motion the highlight scrolls without animation; a section without a control takes focus itself", () => {
  const { doc, guide, main } = mountGuide({ reduced: true });
  try {
    guide.open("pin", guide.button);
    guide.panel.querySelector("[data-help-show]").click();
    const section = main.querySelector('[data-help="foundry-deployments"]');
    assert.deepEqual(section.scrolledWith, { block: "center", behavior: "auto" });
    assert.equal(section.getAttribute("tabindex"), "-1");
    assert.equal(doc.activeElement, section);
    guide.close();
    assert.equal(section.classList.contains("help-target"), false, "closing the guide clears the highlight");
    assert.equal(section.hasAttribute("tabindex"), false, "the temporary tabindex goes");
    assert.equal(section.hasAttribute("aria-describedby"), false);
    assert.equal(section.hasAttribute("data-help-label"), false);
  } finally {
    unmount();
  }
});

test("Show me for another page goes there by a fixed route, highlights once it renders, and leaving clears it", () => {
  const { doc, guide, went, show } = mountGuide({ route: "overview", view: overviewView });
  try {
    guide.open("attach", guide.button);
    guide.panel.querySelector("[data-help-show]").click();
    assert.deepEqual(went, ["#/models"]);
    const view = modelsView();
    show(view, "models");
    const section = view.querySelector('[data-help="foundry-attach"]');
    const attach = section.querySelector("[data-help-focus]");
    assert.ok(section.classList.contains("help-target"));
    assert.equal(doc.activeElement, attach);
    assert.match(attach.getAttribute("aria-describedby"), /^attach-hint \S+$/, "its own description stays; the step's is added");

    show(overviewView(), "overview");
    assert.equal(section.classList.contains("help-target"), false, "leaving the page clears the highlight");
    assert.equal(section.hasAttribute("data-help-label"), false);
    assert.equal(attach.getAttribute("aria-describedby"), "attach-hint", "attributes are restored exactly");

    guide.panel.querySelector("[data-help-show]").click();
    show(dom.el("div", {}, "Export"), "export");
    const later = modelsView();
    show(later, "models");
    assert.equal(later.querySelector('[data-help="foundry-attach"]').classList.contains("help-target"), false,
      "a pending highlight is dropped when another page loads instead");
  } finally {
    unmount();
  }
});

test("Escape anywhere closes the guide and its highlight and restores focus, but a modal dialog's Escape stays its own; Back and Next move between steps", () => {
  const { doc, guide, main } = mountGuide();
  try {
    const ask = dom.el("button", { type: "button" }, "How this works");
    dom.addChildren(main, ask);
    guide.open("discover", ask);
    guide.panel.querySelector("[data-help-show]").click();
    const section = main.querySelector('[data-help="foundry-accounts"]');
    const control = section.querySelector("[data-help-focus]");
    assert.equal(doc.activeElement, control, "Show me moved focus onto the page");

    const dialog = dom.el("dialog", {});
    dialog.setAttribute("open", "");
    dom.addChildren(doc.body, dialog);
    const fromDialog = keydown("Escape");
    dialog.dispatchEvent(fromDialog);
    assert.equal(fromDialog.defaultPrevented, false, "a modal dialog's Escape is its own");
    assert.ok(section.classList.contains("help-target"), "so the highlight stays");
    assert.equal(guide.panel.hidden, false, "and so does the guide");
    dialog.remove();

    const escape = keydown("Escape");
    control.dispatchEvent(escape);
    assert.equal(escape.defaultPrevented, true);
    assert.equal(guide.panel.hidden, true, "Escape on the highlighted control closes the guide");
    assert.equal(guide.button.getAttribute("aria-expanded"), "false");
    assert.equal(doc.body.classList.contains("help-open"), false, "the page is no longer docked");
    assert.equal(section.classList.contains("help-target"), false, "the highlight goes with it");
    assert.equal(section.hasAttribute("data-help-label"), false);
    assert.equal(control.hasAttribute("aria-describedby"), false, "the control's aria description is restored");
    assert.equal(doc.activeElement, ask, "focus returns to what opened the guide");
    const late = keydown("Escape");
    doc.body.dispatchEvent(late);
    assert.equal(late.defaultPrevented, false, "a closed guide no longer listens");

    guide.open("discover", guide.button);
    const next = guide.panel.querySelector("[data-help-next]");
    const back = guide.panel.querySelector("[data-help-back]");
    assert.equal(back.getAttribute("aria-disabled"), "true", "no step before the first");
    next.focus();
    next.click();
    assert.match(currentStep(guide), /Attach a Foundry/);
    for (let i = 0; i < 10; i++) next.click();
    assert.match(currentStep(guide), /Hand out keys/);
    assert.equal(next.getAttribute("aria-disabled"), "true");
    assert.equal(doc.activeElement, next, "focus stays on Next");
    back.click();
    assert.match(currentStep(guide), /Choose the Foundry/);
  } finally {
    unmount();
  }
});

// ── Styles: visible in both themes, calm with reduced motion ────────────────

const tokens = Object.fromEntries([...css.matchAll(/--([\w-]+):\s*light-dark\((#[0-9a-f]{6}),\s*(#[0-9a-f]{6})\)/gi)].map((m) => [m[1], [m[2], m[3]]]));
const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const block = (at) => {
  const start = css.indexOf(at);
  assert.notEqual(start, -1, at);
  let depth = 0;
  for (let i = css.indexOf("{", start); i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}" && --depth === 0) return css.slice(start, i + 1);
  }
  return "";
};

test("the highlight is a visible outline with a step label, in both themes, forced colours and reduced motion", () => {
  assert.match(css, /\.help-target \{[^}]*outline: 3px solid var\(--help-ring\)/);
  assert.match(css, /\.help-target::before \{[^}]*content: attr\(data-help-label\)/);
  assert.match(block("@media (prefers-reduced-motion: reduce)"), /\.help-target[^{]*\{[^}]*animation: none/);
  assert.match(block("@media (forced-colors: active)"), /\.help-target[^{]*\{[^}]*Highlight/);
  assert.match(block("@media (min-width: 900px)"), /\.help-open \{[^}]*grid-template-columns/, "docked beside the content from 900px");
  const failures = [];
  for (const [fg, bg, min] of [["help-ring", "bg", 3], ["help-ring", "surface", 3], ["help-ring", "surface-2", 3], ["help-ring", "selected-bg", 3], ["on-help", "help-ring", 4.5]]) {
    assert.ok(tokens[fg] && tokens[bg], `--${fg} and --${bg} are light-dark() tokens`);
    ["light", "dark"].forEach((theme, i) => {
      const ratio = contrast(tokens[fg][i], tokens[bg][i]);
      if (ratio < min) failures.push(`${theme}: --${fg} on --${bg} is ${ratio.toFixed(2)}:1`);
    });
  }
  assert.deepEqual(failures, []);
  assert.notEqual(tokens["help-ring"][0], tokens.focus[0], "a highlight is not mistaken for keyboard focus");
});
