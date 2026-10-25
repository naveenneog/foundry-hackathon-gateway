import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (p) => readFileSync(join(root, p), "utf8");

/** Every relative link and image in a markdown file must point at a file in the repo. */
function brokenLinks(file) {
  const text = read(file).replace(/```[\s\S]*?```/g, "");
  const out = [];
  for (const m of text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const target = m[1].split("#")[0];
    if (!target || /^[a-z]+:/i.test(target)) continue;
    if (!existsSync(normalize(join(root, dirname(file), target)))) out.push(m[1]);
  }
  return out;
}

test("README and the install guide have no broken links or images", () => {
  assert.deepEqual(brokenLinks("README.md"), []);
  assert.deepEqual(brokenLinks("docs/INSTALL.md"), []);
});

test("README leads with liteAPIM: architecture, a local try, install steps and screenshots", () => {
  const md = read("README.md");
  const dash = md.indexOf("## liteAPIM");
  assert.ok(dash > 0 && dash < md.indexOf("## What a participant gets"), "dashboard section comes first");
  for (const s of ["docs/images/architecture-key-dashboard.png", "npm run dashboard:demo", "docs/INSTALL.md",
    "scripts/Deploy-Console.ps1", "Deploy-Poc.ps1", "-Step Deploy", "admin.ps1", "docs/CONSOLE.md"]) {
    assert.ok(md.includes(s), s);
  }
  assert.ok((md.match(/docs\/images\/console\/console-[a-z-]+\.png/g) ?? []).length >= 6, "console screenshots");
  // The illustration shows recipients signing in to Entra; this design does not. Say so beside it.
  assert.match(md, /recipients \*\*do not\*\* sign in to Entra ID/);
});

test("the install guide covers every step in order, with the text diagram and the Entra note", () => {
  const md = read("docs/INSTALL.md");
  const steps = ["## 0. Try it locally", "## 1. Network, Foundry", "## 2. Gateway", "## 3. Product routes and Key Vault",
    "## 4. liteAPIM", "## 5. First sign-in", "## 6. Issue and use a key", "## Troubleshooting", "## Remove"];
  const at = steps.map((s) => md.indexOf(s));
  assert.ok(at.every((i) => i > 0), `all steps present: ${steps.filter((_, i) => at[i] < 0)}`);
  assert.deepEqual([...at].sort((a, b) => a - b), at, "in order");
  assert.match(md, /```mermaid\r?\nflowchart/);
  assert.match(md, /In this design they do not/);
  assert.match(md, /ANTHROPIC_AUTH_TOKEN/);
  assert.match(md, /ANTHROPIC_API_KEY/);
});

test("install guide separates setup paths, defines PowerShell inputs, and gives validation checkpoints", () => {
  const md = read("docs/INSTALL.md");
  assert.match(md, /Choose your starting point/);
  assert.match(md, /An existing API Management gateway/);
  assert.match(md, /new test environment/i);
  assert.match(md, /Azure deployment: select your subscription and starting path/);
  assert.match(md, /properties\.modelProviderData/);
  assert.match(md, /Set-Content -Path \.\\params\.json/);
  assert.match(md, /What success looks like/);
  assert.match(md, /Verification checklist/);
  const powershellBlocks = [...md.matchAll(/```powershell\r?\n([\s\S]*?)```/g)].map((m) => m[1]);
  assert.ok(powershellBlocks.length > 0, "contains PowerShell commands");
  for (const block of powershellBlocks) {
    assert.doesNotMatch(block, /<[a-z][a-z0-9 _-]*>/i, "PowerShell blocks use defined variables, not shell-invalid angle placeholders");
  }
});

test("package.json runs the demo", () => {
  assert.equal(JSON.parse(read("package.json")).scripts["dashboard:demo"], "node scripts/dashboard-demo.mjs");
});

// P60: the UI is called liteAPIM. File names, the branch, roles and resource names keep their old
// words; the prose does not.
const GUIDES = ["README.md", "docs/CONSOLE.md", "docs/INSTALL.md"];
const STALE = /Key Dashboard|Key Console|Foundry Gateway|\b[Tt]he (?:[Dd]ashboard|[Cc]onsole)\b(?!\.\w)/;

/** Lines naming the UI by an old name, or "the dashboard" / "the console" where liteAPIM is meant. */
const staleLines = (md) => md.split("\n").filter((line) => STALE.test(line));

test("the guides say liteAPIM (the admin key dashboard) at first, then liteAPIM, and never an old name (P60)", () => {
  for (const file of GUIDES) {
    const md = read(file);
    const first = md.indexOf("liteAPIM");
    assert.ok(first >= 0, `${file} names liteAPIM`);
    assert.match(md.slice(first, first + 50), /^liteAPIM(?:\*\*)? \(the admin key dashboard[),]/, `${file}: the first mention says what it is`);
    assert.deepEqual(staleLines(md), [], `${file}: old names, or "the dashboard" for liteAPIM`);
    assert.doesNotMatch(md.replace(/\]\([^)]*\)/g, "]()").replace(/liteAPIM/g, ""), /lite ?apim/i, `${file}: one spelling (link targets aside: GitHub lowercases anchors)`);
  }
  assert.match(read("docs/CONSOLE.md"), /"liteAPIM is for administrators\. Ask an admin for your key\."/, "the UI's words, quoted exactly");
});

test("the stale-name check finds old names and \"the dashboard\", not technical names", () => {
  assert.equal(staleLines("# Key Dashboard\nThe dashboard runs here.\nfrom the console\n").length, 3);
  assert.deepEqual(staleLines("`Console.Admin`, the Console.Admin role, `release/key-dashboard`, dashboard:demo, no dashboard access, hackgw-key-console\n"), []);
});

/** GitHub's heading anchors: lowercased, punctuation dropped, spaces as hyphens, repeats numbered. */
function anchors(file) {
  const slug = (h) => h.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[`*]/g, "").trim().toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, "").replace(/ /g, "-");
  const seen = new Map();
  const out = new Set();
  for (const m of read(file).replace(/```[\s\S]*?```/g, "").matchAll(/^#{1,6} +(.+?) *#*$/gm)) {
    const s = slug(m[1]);
    const n = seen.get(s) ?? 0;
    seen.set(s, n + 1);
    out.add(n ? `${s}-${n}` : s);
  }
  return out;
}

test("links to a heading in README, CONSOLE.md or INSTALL.md land on one, after the renames (P60)", () => {
  assert.ok(anchors("README.md").has("liteapim") && anchors("docs/INSTALL.md").has("4-liteapim"), "renamed headings");
  const broken = [];
  for (const file of GUIDES) {
    for (const m of read(file).replace(/```[\s\S]*?```/g, "").matchAll(/\]\(([^)\s]*)#([^)\s]+)\)/g)) {
      const target = m[1] ? normalize(join(dirname(file), m[1])).replace(/\\/g, "/") : file;
      if (/^[a-z]+:/i.test(m[1]) || !GUIDES.includes(target)) continue;
      if (!anchors(target).has(m[2])) broken.push(`${file} → ${target}#${m[2]}`);
    }
  }
  assert.deepEqual(broken, []);
  assert.equal(anchors("README.md").has("key-dashboard"), false, "the old anchor is gone, so a link to it would be caught");
});
