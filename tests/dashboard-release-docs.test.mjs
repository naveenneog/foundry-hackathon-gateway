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

test("README leads with the Key Dashboard: architecture, a local try, install steps and screenshots", () => {
  const md = read("README.md");
  const dash = md.indexOf("## Key Dashboard");
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
    "## 4. Dashboard", "## 5. First sign-in", "## 6. Issue and use a key", "## Troubleshooting", "## Remove"];
  const at = steps.map((s) => md.indexOf(s));
  assert.ok(at.every((i) => i > 0), `all steps present: ${steps.filter((_, i) => at[i] < 0)}`);
  assert.deepEqual([...at].sort((a, b) => a - b), at, "in order");
  assert.match(md, /```mermaid\r?\nflowchart/);
  assert.match(md, /In this design they do not/);
  assert.match(md, /ANTHROPIC_AUTH_TOKEN/);
  assert.match(md, /ANTHROPIC_API_KEY/);
});

test("package.json runs the demo", () => {
  assert.equal(JSON.parse(read("package.json")).scripts["dashboard:demo"], "node scripts/dashboard-demo.mjs");
});
