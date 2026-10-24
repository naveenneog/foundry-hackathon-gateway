// P60: the UI is called liteAPIM. The brand, the title and every user-facing product name say
// so; the old names ("Key Dashboard", "Key Console", "Foundry Gateway") are gone from the browser
// modules, the HTML and the messages the server and the demo print. Code comments and the Azure
// display names the console gives API Management resources keep the old wording on purpose.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const SRC = new URL("../src/console/", import.meta.url);
const PUBLIC = new URL("public/", SRC);
const read = (url) => readFileSync(url, "utf8");
const OLD = /Key Dashboard|Key Console|Foundry Gateway/;
/** The app naming itself in a sentence ("The dashboard cannot read…", "this console"): it says liteAPIM. */
const SELF = /\b(?:[Tt]he|[Tt]his) (?:dashboard|console)\b/;

const stripJs = (code) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
const stripHtml = (html) => html.replace(/<!--[\s\S]*?-->/g, "");

/** Names on API Management resources, not in the UI: renaming them would rename products and APIs in Azure. */
const AZURE_NAMES = [
  ["connections.mjs", "displayName: `Key Dashboard: ${account.name} ${type}`"],
  ["packs.mjs", "displayName: `Key Dashboard [${id}] ${connection?.name ?? \"\"}: ${models.join(\", \")}`"],
  ["packs.mjs", "description: `Created by the Key Dashboard. Models:"],
];

/** Lines that show a user an old product name, or the app calling itself "the dashboard" or "this console", as file:line. */
function oldNames(sources) {
  const out = [];
  for (const [file, text] of Object.entries(sources)) {
    let code = file.endsWith(".html") ? stripHtml(text) : stripJs(text);
    for (const [owner, allowed] of AZURE_NAMES) if (owner === file) code = code.replace(allowed, "");
    code.split("\n").forEach((line, i) => { if (OLD.test(line) || SELF.test(line)) out.push(`${file}:${i + 1}: ${line.trim()}`); });
  }
  return out;
}

const sources = () => ({
  ...Object.fromEntries(readdirSync(PUBLIC).filter((n) => /\.(?:js|html)$/.test(n)).map((n) => [`public/${n}`, read(new URL(n, PUBLIC))])),
  ...Object.fromEntries(readdirSync(SRC).filter((n) => n.endsWith(".mjs")).map((n) => [n, read(new URL(n, SRC))])),
  "dashboard-demo.mjs": read(new URL("../scripts/dashboard-demo.mjs", import.meta.url)),
});

test("the brand and the title read liteAPIM, in that casing", () => {
  const html = read(new URL("index.html", PUBLIC));
  const app = read(new URL("app.js", PUBLIC));
  assert.match(html, /<title>liteAPIM<\/title>/);
  const brand = /<a class="brand" href="#\/overview">([\s\S]*?)<\/a>/.exec(html)?.[1] ?? "";
  assert.match(brand, /<svg class="brand-mark"[^>]*aria-hidden="true"/, "the mark is decoration; the link is named by its text");
  assert.equal(brand.replace(/<svg[\s\S]*?<\/svg>/, "").replace(/<[^>]+>/g, "").trim(), "liteAPIM", "the brand link's text is the name alone");
  assert.match(app, /document\.title = `\$\{sub \? `\$\{SUB_TITLES\[sub\]\} · ` : ""\}\$\{r\.label\} · liteAPIM`;/);
  assert.match(app, /gate\("Sign in to liteAPIM", /);
  assert.match(app, /"liteAPIM failed to start\."/);
  assert.match(html, /<noscript><p class="noscript">liteAPIM needs JavaScript\.<\/p><\/noscript>/);
  assert.match(read(new URL("help.js", PUBLIC)), /"liteAPIM \(the admin key dashboard\): from a Foundry account to keys in people's hands/);
  assert.match(sources()["dashboard-demo.mjs"], /console\.log\(`liteAPIM demo \(sample data, no Azure\): \$\{url\}/);
  const all = Object.values(sources()).join("\n");
  assert.doesNotMatch(all.replace(/liteAPIM/g, ""), /lite ?apim/i, "no other spelling of the name");
});

test("no user-facing old product name, and no \"the dashboard\" or \"this console\", is left in the browser modules, the HTML, server messages or the demo", () => {
  assert.deepEqual(oldNames(sources()), []);
});

test("the old-name scan catches a name in a string, markup or a server message, and ignores comments", () => {
  const base = sources();
  const caught = (file, find, replace) => {
    assert.ok(base[file].includes(find), `${file} contains ${find}`);
    return oldNames({ ...base, [file]: base[file].replace(find, replace) });
  };
  assert.match(caught("public/app.js", "\"liteAPIM failed to start.\"", "\"The Key Dashboard failed to start.\"").join(), /public\/app\.js/);
  assert.match(caught("public/index.html", "<title>liteAPIM</title>", "<title>Foundry Gateway</title>").join(), /public\/index\.html/);
  assert.match(caught("public/help.js", "\"liteAPIM (the admin key dashboard)", "\"Key Console").join(), /public\/help\.js/);
  assert.match(caught("service-usage.mjs", "const NO_SOURCE = \"Usage is not configured", "const NO_SOURCE = \"The Key Dashboard: usage is not configured").join(), /service-usage\.mjs/);
  assert.match(caught("packs.mjs", "${monthlyTokens} tokens per key each calendar month (UTC).", "Key Dashboard tokens.").join(), /packs\.mjs/,
    "only the listed Azure names are allowed, not the whole file");
  assert.match(caught("public/api.js", "\"liteAPIM could not reach the server.", "\"The dashboard could not reach the server.").join(), /public\/api\.js/);
  assert.match(caught("public/views-admin.js", "obtained from liteAPIM rather", "obtained from this console rather").join(), /public\/views-admin\.js/);
  assert.deepEqual(oldNames({ "public/x.js": "hint(\"this person does not get dashboard access.\");" }), [], "a description of access is not the app's name");
  assert.deepEqual(caught("public/app.js", "// liteAPIM — entry point", "// Key Dashboard — entry point"), [], "a comment is not user-facing");
  assert.deepEqual(caught("public/index.html", "<head>", "<head><!-- Key Dashboard -->"), []);
});
