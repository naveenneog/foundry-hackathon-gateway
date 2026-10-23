// Key Dashboard UI: static security invariants plus unit tests for the browser modules that run
// under Node (lib.js and api.js have no DOM; dom.js touches `document` only when called).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const PUBLIC = new URL("../src/console/public/", import.meta.url);
const read = (name) => readFileSync(new URL(name, PUBLIC), "utf8");
const JS = readdirSync(PUBLIC).filter((n) => n.endsWith(".js")).sort();
const source = Object.fromEntries(JS.map((n) => [n, read(n)]));
const html = read("index.html");
const css = read("app.css");
const charter = JSON.parse(readFileSync(new URL("../.ironclad/charter.json", import.meta.url), "utf8"));

const lib = await import(new URL("lib.js", PUBLIC));
const api = await import(new URL("api.js", PUBLIC));
const dom = await import(new URL("dom.js", PUBLIC));

const offenders = (re, files = JS) => files.filter((n) => re.test(source[n]));

// ── Static security invariants ─────────────────────────────────────────────

test("no HTML-string sinks or dynamic code anywhere in the browser modules", () => {
  for (const [label, re] of [
    ["innerHTML/outerHTML", /\.\s*(?:innerHTML|outerHTML)\b/],
    ["insertAdjacentHTML", /\binsertAdjacentHTML\b/],
    ["document.write", /\bdocument\s*\.\s*write(?:ln)?\s*\(/],
    ["eval", /\beval\s*\(/],
    ["new Function", /\bnew\s+Function\s*\(|\bFunction\s*\(\s*["'`]/],
    ["string timers", /\bset(?:Timeout|Interval)\s*\(\s*["'`]/],
    ["createContextualFragment", /\bcreateContextualFragment\b/],
    ["DOMParser", /\bDOMParser\b/],
    ["srcdoc", /\.srcdoc\b/],
    ["javascript: URLs", /javascript:/i],
    ["string event handlers", /\bon(?:abort|blur|cancel|change|click|close|contextmenu|dblclick|drag\w*|drop|error|focus\w*|input|invalid|key\w+|load\w*|mouse\w+|paste|pointer\w+|reset|scroll|select|submit|toggle|touch\w+|wheel)\s*:\s*["'`]/i],
    ["direct href/src assignment (bypasses safeUrl)", /\.(?:href|src|action)\s*=(?!=)/],
  ]) assert.deepEqual(offenders(re), [], label);
});

test("no inline styles: no style attribute and no CSSOM style writes, so CSP style-src 'self' holds", () => {
  assert.deepEqual(offenders(/setAttribute\s*\(\s*["'`]style["'`]/i), []);
  assert.deepEqual(offenders(/\.style\b/), [], "colours and sizes come from classes and SVG attributes");
  assert.doesNotMatch(html, /\sstyle\s*=/i);
  assert.doesNotMatch(html, /<style[\s>]/i);
  assert.doesNotMatch(css, /url\s*\(|@import/i, "the stylesheet loads nothing");
});

test("index.html: one external module entry, no inline script or handlers, only same-origin assets", () => {
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert.equal(scripts.length, 1);
  assert.match(scripts[0][1], /\btype="module"/);
  assert.match(scripts[0][1], /\bsrc="\/app\.js"/);
  assert.equal(scripts[0][2].trim(), "", "no inline script body");
  assert.doesNotMatch(html, /<[^>]+\son[a-z]+\s*=/i, "no on* attributes");
  for (const [, attr, url] of html.matchAll(/\s(src|href)="([^"]*)"/gi)) {
    const ok = /^\/(?![/\\])/.test(url) || url.startsWith("#") || (attr === "href" && url.startsWith("data:image/svg+xml,"));
    assert.ok(ok, `${attr}="${url.slice(0, 40)}" must be same-origin`);
  }
  assert.match(html, /<link rel="icon" href="data:image\/svg\+xml,/, "the only data: URL is the favicon");
});

test("every module app.js imports exists and is preloaded; no unreachable module ships", () => {
  const seen = new Set();
  const walk = (name) => {
    if (seen.has(name)) return;
    assert.ok(JS.includes(name), `${name} exists`);
    seen.add(name);
    for (const [, dep] of source[name].matchAll(/from\s+"\.\/([\w-]+\.js)"/g)) walk(dep);
  };
  walk("app.js");
  assert.deepEqual([...seen].sort(), JS, "every shipped module is reachable from app.js");
  const preloaded = [...html.matchAll(/<link rel="modulepreload" href="\/([\w-]+\.js)">/g)].map((m) => m[1]).sort();
  assert.deepEqual(preloaded, JS.filter((n) => n !== "app.js"));
});

test("only the theme preference is stored in the browser, and nothing is logged", () => {
  assert.deepEqual(offenders(/\bsessionStorage\b|\bindexedDB\b|\bdocument\s*\.\s*cookie\b|\bcaches\s*\.|\bserviceWorker\b/), []);
  for (const name of JS) {
    const all = (source[name].match(/\blocalStorage\b/g) ?? []).length;
    const theme = (source[name].match(/\blocalStorage\.(?:getItem|setItem|removeItem)\("kd-theme"/g) ?? []).length;
    assert.equal(all, theme, `${name}: localStorage is used for "kd-theme" only`);
  }
  assert.deepEqual(offenders(/\bconsole\s*\.\s*[a-z]+\s*\(/), [], "no console logging");
});

test("network access goes through api.js only; secrets are fetched by secret.js only; nothing polls", () => {
  assert.deepEqual(offenders(/\bfetch\s*\(/), ["api.js"]);
  assert.deepEqual(offenders(/\bXMLHttpRequest\b|\bsendBeacon\b|\bWebSocket\b|\bEventSource\b/), []);
  assert.match(source["api.js"], /credentials:\s*"same-origin"/);
  assert.deepEqual(offenders(/\bfetchSecret\b/), ["api.js", "secret.js"]);
  assert.deepEqual(offenders(/\bnavigator\.clipboard\b/), ["dom.js"]);
  assert.deepEqual(offenders(/\bsetInterval\s*\(/), ["secret.js"], "the only interval is the reveal countdown");
});

test("URLs never carry data: views navigate to fixed routes and do not touch location", () => {
  assert.deepEqual(offenders(/\blocation\s*\./, JS.filter((n) => n !== "app.js")), []);
  for (const name of JS) {
    for (const [call] of source[name].matchAll(/ctx\.go\([^)]*\)/g)) assert.match(call, /^ctx\.go\("#\/[a-z/]+"\)$/, `${name}: ${call}`);
  }
});

test("views insert children only through dom.js helpers, which skip null and flatten arrays", () => {
  // Native append/replaceChildren print "null" for a missing optional child and join arrays into text.
  const native = /\.(?:append|prepend|replaceChildren)\(/;
  assert.deepEqual(offenders(native, JS.filter((n) => n !== "dom.js")), []);
});

test("every module stays within the charter's file-size budget", () => {
  for (const name of JS) {
    const lines = source[name].split(/\r?\n/).length;
    assert.ok(lines <= charter.quality.maxFileLines, `${name} has ${lines} lines`);
  }
});

// ── dom.js: the only element builder ───────────────────────────────────────

function fakeDocument() {
  const make = (tag) => ({
    nodeType: 1, tagName: tag, attributes: {}, children: [], listeners: {},
    setAttribute(k, v) { this.attributes[k] = String(v); },
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; },
    addEventListener(type, fn) { this.listeners[type] = fn; },
  });
  return { createElement: make, createElementNS: (_ns, tag) => make(tag), createTextNode: (data) => ({ nodeType: 3, data }) };
}

test("el() writes text as text nodes and refuses style, HTML properties, string handlers and foreign URLs", () => {
  globalThis.document = fakeDocument();
  try {
    const payload = "<img src=x onerror=alert(1)>";
    const node = dom.el("div", { class: ["a", null, "b"] }, payload);
    assert.deepEqual(node.children, [{ nodeType: 3, data: payload }]);
    assert.equal(node.attributes.class, "a b");
    for (const attrs of [{ style: "color:red" }, { STYLE: "x" }, { innerHTML: "<b>" }, { outerHTML: "<b>" }, { srcdoc: "<b>" }, { onclick: "alert(1)" }]) {
      assert.throws(() => dom.el("div", attrs), Error, JSON.stringify(attrs));
    }
    for (const href of ["javascript:alert(1)", "https://evil.example/", "//evil.example/x", "/\\evil.example", "data:text/html,x"]) {
      assert.throws(() => dom.el("a", { href }), /same-origin/, href);
    }
    for (const href of ["#/export", "/.auth/logout", "blob:https://console.example/5f0c"]) assert.equal(dom.el("a", { href }).attributes.href, href);
    const handler = () => {};
    assert.equal(dom.el("button", { onclick: handler }).listeners.click, handler);
    const box = dom.el("div", {}, "old");
    dom.setChildren(box, null, ["a", [undefined, "b"]], false, dom.el("span"));
    assert.deepEqual(box.children.map((c) => c.data ?? c.tagName), ["a", "b", "span"], "no 'null' text, arrays flattened");
    dom.addChildren(box, null, ["c"]);
    assert.equal(box.children.length, 4);
    assert.deepEqual(dom.emailText("pat.o-brien@contoso.com").map((c) => c.data ?? c.tagName ?? c), ["pat.o-brien", "wbr", "@contoso.com"]);
  } finally {
    delete globalThis.document;
  }
});

// ── api.js: requests, errors and the read cache ────────────────────────────

function stubFetch(responder) {
  const calls = [];
  globalThis.fetch = async (path, init) => {
    calls.push({ path, init });
    return responder(path, init);
  };
  return calls;
}
const reply = (status, body, extra = {}) => ({ ok: status >= 200 && status < 300, status, type: "basic", text: async () => (typeof body === "string" ? body : JSON.stringify(body)), ...extra });

test("state changes are same-origin JSON POSTs with a body, even an empty one; reads send no body", async () => {
  const calls = stubFetch(() => reply(200, { ok: true }));
  try {
    await api.post("/api/keys/jwt-abc/revoke");
    await api.post("/api/signing/rotate", { confirm: "ROTATE" });
    await api.get("/api/me");
    await api.request("POST", "/api/sweep");
    const [revoke, rotate, me, sweep] = calls.map((c) => c.init);
    assert.equal(sweep.body, "{}", "even a direct request() sends a JSON body");
    assert.equal(revoke.method, "POST");
    assert.equal(revoke.headers["Content-Type"], "application/json");
    assert.equal(revoke.body, "{}");
    assert.equal(revoke.credentials, "same-origin");
    assert.equal(revoke.redirect, "manual", "a sign-in redirect is never followed");
    assert.equal(rotate.body, '{"confirm":"ROTATE"}');
    assert.equal(me.method, "GET");
    assert.equal(me.body, undefined);
    assert.equal(me.headers["Content-Type"], undefined);
    await assert.rejects(api.get("https://evil.example/api/me"), /same-origin/);
    await assert.rejects(api.post("//evil.example/api/jwt", {}), /same-origin/);
    assert.equal(calls.length, 4, "foreign URLs are refused before any request");
    assert.equal(api.keyPath("a/b?c", "rotate"), "/api/keys/a%2Fb%3Fc/rotate");
    assert.equal(api.apiPath("/api/usage", { kind: "jwt", days: 7, skip: "" }), "/api/usage?kind=jwt&days=7");
  } finally {
    delete globalThis.fetch;
  }
});

test("errors carry the server's message and status; 401 and sign-in redirects mean signed out", async () => {
  const responses = [
    reply(400, { error: "Owner must be the user's sign-in name." }),
    reply(401, { error: "Sign in first." }),
    reply(0, "", { ok: false, type: "opaqueredirect" }),
    reply(500, "<html>oops</html>"),
  ];
  stubFetch(() => responses.shift());
  try {
    await assert.rejects(api.post("/api/jwt", {}), (e) => e instanceof api.ApiError && e.status === 400 && /sign-in name/.test(e.message));
    await assert.rejects(api.get("/api/me"), (e) => e.status === 401 && e.signedOut);
    await assert.rejects(api.get("/api/me"), (e) => e.status === 401 && e.signedOut);
    await assert.rejects(api.get("/api/keys?kind=jwt"), (e) => e.status === 500 && !/oops/.test(e.message));
    globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
    await assert.rejects(api.get("/api/me"), (e) => e.status === 0);
  } finally {
    delete globalThis.fetch;
  }
});

test("key values are never cached; lists and usage are, until invalidated; failures are not", async () => {
  const calls = stubFetch((path) => reply(200, path.startsWith("/api/keys/") ? { value: "secret" } : { keys: [] }));
  try {
    await api.fetchSecret("jwt-abc");
    await api.fetchSecret("jwt-abc");
    assert.equal(calls.length, 2, "each reveal is a fresh request");
    assert.throws(() => api.cachedGet("/api/keys/jwt-abc"), /Never cached/);
    assert.throws(() => api.cachedGet("/api/signing"), /Never cached/);
    await api.cachedGet("/api/keys?kind=jwt&status=active");
    await api.cachedGet("/api/keys?kind=jwt&status=active");
    assert.equal(calls.length, 3);
    await api.cachedGet("/api/keys?kind=jwt&status=active", { fresh: true });
    assert.equal(calls.length, 4);
    api.invalidate("/api/keys?kind=jwt");
    await api.cachedGet("/api/keys?kind=jwt&status=active");
    assert.equal(calls.length, 5);
    globalThis.fetch = async () => reply(503, { error: "busy" });
    await assert.rejects(api.cachedGet("/api/usage?kind=jwt&days=7"));
    const after = stubFetch(() => reply(200, { total: {} }));
    await api.cachedGet("/api/usage?kind=jwt&days=7");
    assert.equal(after.length, 1, "the failed read was not remembered");
  } finally {
    api.invalidate();
    delete globalThis.fetch;
  }
});

// ── lib.js: CSV ─────────────────────────────────────────────────────────────

test("parseCsv handles quotes, doubled quotes, embedded delimiters and line breaks, CRLF/CR and a BOM", () => {
  const text = '\uFEFFowner,subject\r\n"a@contoso.com","team ""one"", A"\r\nb@contoso.com,"two\nlines"\rc@contoso.com,three\n';
  assert.deepEqual(lib.parseCsv(text), [
    { line: 1, fields: ["owner", "subject"] },
    { line: 2, fields: ["a@contoso.com", 'team "one", A'] },
    { line: 3, fields: ["b@contoso.com", "two\nlines"] },
    { line: 5, fields: ["c@contoso.com", "three"] },
  ]);
  assert.deepEqual(lib.parseCsv("x;y\n1;2").map((r) => r.fields), [["x", "y"], ["1", "2"]], "semicolon files");
  assert.deepEqual(lib.parseCsv("x\ty").map((r) => r.fields), [["x", "y"]], "tab files");
  assert.deepEqual(lib.parseCsv('=cmd|"/c calc"!A0,${process.exit()}').map((r) => r.fields), [['=cmd|"/c calc"!A0', "${process.exit()}"]], "kept as text");
  assert.throws(() => lib.parseCsv('a,b\nc,"never closed\nd'), (e) => e instanceof lib.CsvError && /Line 2/.test(e.message));
  assert.deepEqual(lib.parseCsv(""), []);
});

test("bulk rows: header detection, column order, blank rows, normalisation, checks and duplicates", () => {
  const { header, entries } = lib.entriesFromCsv(lib.parseCsv("Subject,Email,extra\nteam-1, Alex@Contoso.com ,x\n\n,\nteam-1,alex@contoso.com\nteam-2,not-an-email\nbad subject!,sam@contoso.com"), "jwt");
  assert.equal(header, true);
  const rows = lib.validateEntries(entries, "jwt");
  assert.deepEqual(rows.map((r) => [r.line, r.owner, r.subject]), [[2, "alex@contoso.com", "team-1"], [5, "alex@contoso.com", "team-1"], [6, "not-an-email", "team-2"], [7, "sam@contoso.com", "bad subject!"]]);
  assert.deepEqual(rows[0].errors, []);
  assert.match(rows[1].errors.join(), /Duplicate of line 2/);
  assert.match(rows[2].errors.join(), /email/i);
  assert.match(rows[3].errors.join(), /Subject/);

  const products = lib.validateEntries(lib.entriesFromCsv(lib.parseCsv("a@contoso.com,ok-name\nb@contoso.com,ok-name\nc@contoso.com,Upper\nd@contoso.com,x\ne@contoso.com,-lead\nf@contoso.com," + "a".repeat(40) + "\ng@contoso.com," + "a".repeat(41)), "product").entries, "product");
  assert.equal(lib.entriesFromCsv(lib.parseCsv("a@contoso.com,ok-name"), "product").header, false);
  assert.deepEqual(products.map((r) => r.errors.length > 0), [false, true, true, true, true, false, true]);
  assert.match(products[1].errors.join(), /Duplicate of line 1/, "a product name is unique whoever owns it");
  assert.deepEqual(lib.chunk(Array.from({ length: 120 }, (_, i) => i)).map((c) => c.length), [50, 50, 20]);
  assert.equal(lib.toCsv([["owner", "subject"], ["a@contoso.com", 'x,"y"']]), 'owner,subject\r\na@contoso.com,"x,""y"""');
});

// ── lib.js: issue validation ───────────────────────────────────────────────

test("model choice is explicit: One means exactly one, Several means at least two", () => {
  assert.ok(lib.checkModelChoice("one", []));
  assert.equal(lib.checkModelChoice("one", ["flash"]), null);
  assert.ok(lib.checkModelChoice("one", ["flash", "pro"]));
  assert.ok(lib.checkModelChoice("several", ["flash"]));
  assert.ok(lib.checkModelChoice("several", ["flash", "flash"]), "duplicates do not count twice");
  assert.equal(lib.checkModelChoice("several", ["flash", "pro"]), null);
  assert.ok(lib.checkModelChoice(undefined, ["flash"]));
});

test("hackathon issue requests mirror the server's limits and send exactly the contract's fields", () => {
  const good = { owner: " Alex@Contoso.com ", subject: "team-1", label: "  Workshop A ", budget: "100000", hours: "48", mode: "one", models: ["flash"] };
  const ok = lib.validateIssue("jwt", good);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.body, { owner: "alex@contoso.com", subject: "team-1", models: ["flash"], budget: 100000, hours: 48, label: "Workshop A" });
  assert.equal("label" in lib.validateIssue("jwt", { ...good, label: "  " }).body, false);
  const bad = (patch) => Object.keys(lib.validateIssue("jwt", { ...good, ...patch }).errors);
  assert.deepEqual(bad({ budget: "0" }), ["budget"]);
  assert.deepEqual(bad({ budget: "100000001" }), ["budget"]);
  assert.deepEqual(bad({ budget: "1.5" }), ["budget"]);
  assert.deepEqual(bad({ budget: "100000000", hours: "2160" }), []);
  assert.deepEqual(bad({ hours: "0" }), ["hours"]);
  assert.deepEqual(bad({ hours: "2160.5" }), ["hours"]);
  assert.deepEqual(bad({ hours: "0.5" }), []);
  assert.deepEqual(bad({ label: "x".repeat(81) }), ["label"]);
  assert.deepEqual(bad({ owner: "alex", subject: "a b", mode: "several" }).sort(), ["models", "owner", "subject"]);
});

test("product issue requests grant deployments and omit optional fields left blank", () => {
  const good = { owner: "sam@contoso.com", name: "sam-ci", monthlyTokens: "1000000", rotateDays: "", expiresDays: "", mode: "several", models: ["deepseek-v4-flash", "claude-haiku-4-5"] };
  assert.deepEqual(lib.validateIssue("product", good).body, { owner: "sam@contoso.com", name: "sam-ci", models: ["deepseek-v4-flash", "claude-haiku-4-5"], monthlyTokens: 1000000 });
  assert.deepEqual(lib.validateIssue("product", { ...good, rotateDays: "30", expiresDays: "3650" }).body.rotateDays, 30);
  const bad = (patch) => Object.keys(lib.validateIssue("product", { ...good, ...patch }).errors);
  assert.deepEqual(bad({ rotateDays: "0" }), ["rotateDays"]);
  assert.deepEqual(bad({ rotateDays: "91" }), ["rotateDays"]);
  assert.deepEqual(bad({ expiresDays: "3651" }), ["expiresDays"]);
  assert.deepEqual(bad({ monthlyTokens: "" }), ["monthlyTokens"]);
  assert.deepEqual(bad({ name: "Sam" }), ["name"]);
  assert.deepEqual(lib.validateSettings("product", good).body.models.length, 2, "bulk settings share the same checks");
});

test("aliases, recipients and passphrases are checked like the server checks them", () => {
  assert.equal(lib.checkAlias("haiku-4-5", "claude"), null);
  assert.match(lib.checkAlias("sonnet", "claude"), /Claude Code/);
  assert.equal(lib.checkAlias("sonnet", "openai"), null);
  assert.ok(lib.checkAlias("Bad Alias", "openai"));
  assert.ok(lib.checkAlias("a;b=c", "openai"), "the model map's separators are refused");
  assert.equal(lib.checkPassphrase(""), null, "blank: the console generates one");
  assert.ok(lib.checkPassphrase("x".repeat(15)));
  assert.equal(lib.checkPassphrase("x".repeat(16)), null);
  assert.ok(lib.checkRecipient(" "));
  assert.ok(lib.checkRecipient("x".repeat(121)));
});

test("model options: hackathon keys list pinned aliases; product keys list routable deployments", () => {
  const config = {
    models: { openai: ["flash"], claude: ["haiku-4-5"] },
    deployments: [{ deployment: "deepseek-v4-flash", model: "DeepSeek-V4-Flash", version: "1", route: "openai" }, { deployment: "odd", route: null }],
  };
  assert.deepEqual(lib.modelOptions("jwt", config).map((o) => [o.value, o.route]), [["flash", "openai"], ["haiku-4-5", "claude"]]);
  assert.deepEqual(lib.modelOptions("product", config), [{ value: "deepseek-v4-flash", route: "openai", label: "deepseek-v4-flash", detail: "DeepSeek-V4-Flash 1" }]);
  assert.equal(lib.routeOf("jwt", config, "haiku-4-5"), "claude");
  assert.equal(lib.routeOf("product", config, "gone"), null);
});

// ── lib.js: formatting, chart maths and key lists ──────────────────────────

test("numbers and periods format for people", () => {
  assert.equal(lib.fmtInt(1234567, "en-US"), "1,234,567");
  assert.equal(lib.fmtCompact(1234, "en-US"), "1.2K");
  assert.equal(lib.fmtCompact(1_500_000, "en-US"), "1.5M");
  assert.equal(lib.fmtCompact(999, "en-US"), "999");
  assert.equal(lib.fmtCompact(null, "en-US"), "—");
  assert.equal(lib.fmtPercent(0.25, "en-US"), "25%");
  assert.equal(lib.fmtBucket(Date.UTC(2026, 9, 21), lib.DAY, { locale: "en-US" }), "Oct 21", "days are UTC days");
  assert.equal(lib.fmtRelative(Date.now() + 3 * lib.DAY, Date.now(), "en-US"), "in 3 days");
});

test("niceTicks covers the data with round steps; integer data gets whole-number steps", () => {
  assert.deepEqual(lib.niceTicks(0, 0, 4, { integer: true }), [0, 1], "an all-zero series still gets an axis");
  assert.deepEqual(lib.niceTicks(0, 0), [0, 0.2, 0.4, 0.6, 0.8, 1]);
  assert.deepEqual(lib.niceTicks(0, 95), [0, 20, 40, 60, 80, 100]);
  assert.deepEqual(lib.niceTicks(0, 3, 4, { integer: true }), [0, 1, 2, 3]);
  const big = lib.niceTicks(0, 1_234_567);
  assert.ok(big.at(-1) >= 1_234_567 && big.length <= 6);
  assert.ok(big.every((t, i) => i === 0 || t - big[i - 1] === big[1] - big[0]));
  const y = lib.scaleLinear(0, 100, 200, 0);
  assert.equal(y(25), 150);
  assert.deepEqual(lib.labelIndices(30, 6), [4, 9, 14, 19, 24, 29]);
  assert.deepEqual(lib.labelIndices(3, 10), [0, 1, 2]);
});

test("alignSeries fills missing buckets with zero and puts several series on one grid", () => {
  const now = Date.UTC(2026, 9, 22, 15, 30);
  const day = (d) => new Date(Date.UTC(2026, 9, d)).toISOString();
  const a = [{ t: day(20), tokens: 100 }, { t: day(20), tokens: 5 }, { t: day(22), tokens: 7 }, { t: "garbage", tokens: 1 }];
  const b = [{ t: day(18), tokens: 3 }];
  const { step, times, values } = lib.alignSeries([a, b], { days: 7, now });
  assert.equal(step, lib.DAY);
  assert.equal(times.length, 7);
  assert.equal(times.at(-1), Date.UTC(2026, 9, 22));
  assert.deepEqual(values[0], [0, 0, 0, 0, 105, 0, 7]);
  assert.deepEqual(values[1], [0, 0, 3, 0, 0, 0, 0]);
  const hourly = lib.alignSeries([[{ t: new Date(now).toISOString(), tokens: 9 }]], { days: 1, now });
  assert.equal(hourly.step, lib.HOUR);
  assert.equal(hourly.times.length, 24);
  assert.equal(hourly.values[0].at(-1), 9);
  const early = lib.alignSeries([[{ t: day(1), tokens: 1 }]], { days: 7, now });
  assert.equal(early.times[0], Date.UTC(2026, 9, 1), "data before the window widens it rather than vanishing");
  assert.equal(lib.alignSeries([[]], { days: 7, from: day(25), to: day(20) }).times.length, 1);
});

test("key lists: status, archive deletion date, search, usage join and sorting", () => {
  const now = Date.UTC(2026, 9, 22);
  assert.equal(lib.keyStatus({ status: "suspended" }, now), "suspended");
  assert.equal(lib.keyStatus({ expires: "2026-10-01T00:00:00Z" }, now), "expired");
  assert.equal(lib.keyStatus({ revoked: "true", expires: "2027-01-01T00:00:00Z" }, now), "revoked");
  assert.equal(lib.keyStatus({ archived: true }, now), "archived");
  assert.equal(lib.isArchived({ status: "revoked", archived: true }), true, "the server lists revoked keys in the archive");
  assert.equal(lib.isArchived({ status: "expired", archived: true }), true);
  assert.equal(lib.isArchived({ status: "suspended", archived: false }), false);
  assert.equal(lib.isArchived({ status: "archived" }), true);
  assert.equal(lib.deleteDate({ archivedAt: "2026-10-01T00:00:00.000Z" }), "2026-10-31T00:00:00.000Z");
  assert.equal(lib.deleteDate({ archivedAt: "2026-10-01T00:00:00Z", deleteAfter: "2026-11-05T00:00:00.000Z" }), "2026-11-05T00:00:00.000Z");
  const keys = [
    { name: "jwt-b", owner: "sam@contoso.com", subject: "team-2", models: ["flash"] },
    { name: "jwt-a", owner: "alex@contoso.com", subject: "team-1", label: "Workshop", models: ["haiku-4-5", "flash"] },
    { name: "jwt-c", owner: "alex@contoso.com", subject: "team-3", models: [] },
  ];
  assert.deepEqual(keys.filter((k) => lib.matchesQuery(k, "ALEX haiku")).map((k) => k.name), ["jwt-a"]);
  assert.deepEqual(keys.filter((k) => lib.matchesQuery(k, "workshop")).map((k) => k.name), ["jwt-a"]);
  const rows = lib.withUsage(keys, [{ name: "jwt-b", tokens: 50 }, { name: "jwt-a", tokens: 900 }]);
  assert.equal(rows[2].usage, null);
  assert.deepEqual(lib.sortKeys(rows, "usage", "desc").map((k) => k.name), ["jwt-a", "jwt-b", "jwt-c"]);
  assert.deepEqual(lib.sortKeys(rows, "key").map((k) => k.name), ["jwt-a", "jwt-b", "jwt-c"]);
  assert.deepEqual(lib.sortKeys(rows, "owner", "desc").map((k) => k.name), ["jwt-b", "jwt-a", "jwt-c"], "ties break on name");
  assert.equal(lib.keyTitle({ name: "jwt-a", subject: "team-1", label: "Workshop" }), "team-1", "a shared label never hides the subject");
  assert.equal(lib.keyTitle({ kind: "product", name: "poc-key-alex-laptop", label: "Pilot" }), "alex-laptop");
  assert.deepEqual(lib.mergeByModel([[{ model: "flash", tokens: 5 }], [{ model: "flash", tokens: 2 }, { model: "pro", tokens: 9 }]]), [{ model: "pro", tokens: 9 }, { model: "flash", tokens: 7 }]);
  const top = lib.topWithOther([1, 2, 3, 4].map((v) => ({ label: `m${v}`, value: v })), 3);
  assert.deepEqual(top.map((t) => [t.label, t.value]), [["m4", 4], ["m3", 3], ["Other", 3]]);
});

// ── Contrast: WCAG AA in both themes, from the stylesheet's own tokens ─────

const tokens = Object.fromEntries([...css.matchAll(/--([\w-]+):\s*light-dark\((#[0-9a-f]{6}),\s*(#[0-9a-f]{6})\)/gi)].map((m) => [m[1], [m[2], m[3]]]));
const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test("text, badges and chart marks meet WCAG AA contrast in the light and the dark theme", () => {
  const TEXT = 4.5;
  const MARK = 3;
  const pairs = [
    ...["bg", "surface", "surface-2", "surface-3", "surface-raised", "input-bg", "row-hover", "selected-bg"].map((bg) => ["ink", bg, TEXT]),
    ...["bg", "surface", "surface-2", "surface-3", "row-hover", "selected-bg"].map((bg) => ["ink-muted", bg, TEXT]),
    ...["bg", "surface", "surface-2", "selected-bg"].map((bg) => ["link", bg, TEXT]),
    ["danger", "surface", TEXT], ["danger", "bad-row", TEXT], ["ok", "surface", TEXT], ["grey-fg", "surface", TEXT],
    ["on-primary", "primary", TEXT], ["on-primary", "primary-hover", TEXT], ["on-danger", "danger", TEXT], ["on-warn", "warn", TEXT],
    ["ok-fg", "ok-bg", TEXT], ["warn-fg", "warn-bg", TEXT], ["bad-fg", "bad-bg", TEXT], ["grey-fg", "grey-bg", TEXT],
    ["jwt-fg", "jwt-bg", TEXT], ["product-fg", "product-bg", TEXT],
    ["topbar-fg", "topbar-bg", TEXT], ["topbar-muted", "topbar-bg", TEXT], ["topbar-fg", "topbar-chip", TEXT], ["topbar-fg", "topbar-admin", TEXT],
    ...["kind-jwt", "kind-product", "cat-1", "cat-2", "cat-3", "cat-4", "cat-5", "cat-6", "cat-other", "border-strong", "primary", "danger"].map((fg) => [fg, "surface", MARK]),
    ...["bg", "surface", "surface-2", "selected-bg", "input-bg"].map((bg) => ["focus", bg, MARK]),
    ["border-strong", "input-bg", MARK], ["kind-jwt", "bg", MARK], ["kind-product", "bg", MARK],
  ];
  const failures = [];
  for (const [fg, bg, min] of pairs) {
    assert.ok(tokens[fg] && tokens[bg], `--${fg} and --${bg} are light-dark() tokens`);
    ["light", "dark"].forEach((theme, i) => {
      const ratio = contrast(tokens[fg][i], tokens[bg][i]);
      if (ratio < min) failures.push(`${theme}: --${fg} on --${bg} is ${ratio.toFixed(2)}:1, needs ${min}:1`);
    });
  }
  assert.deepEqual(failures, []);
  assert.notEqual(tokens["kind-jwt"][0], tokens["kind-product"][0], "the two kinds never share a colour");
});
