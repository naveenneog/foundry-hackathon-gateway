import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

const root = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8");
const SHOTS = ["keys", "issue-signed", "issue-product", "export", "signing"];

test("CONSOLE.md embeds every console screenshot, and each is a PNG", () => {
  const doc = read("docs/CONSOLE.md");
  for (const s of SHOTS) {
    const rel = `images/console/console-${s}.png`;
    assert.match(doc, new RegExp(`!\\[[^\\]]+\\]\\(${rel.replace(/[.]/g, "\\.")}\\)`), `embeds ${rel}`);
    const file = new URL(`docs/${rel}`, root);
    assert.ok(existsSync(file), `${rel} exists`);
    assert.deepEqual([...readFileSync(file).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], `${rel} is a PNG`);
  }
});

test("CONSOLE.md covers deploy, roles, consent, clients and opening a bundle", () => {
  const doc = read("docs/CONSOLE.md");
  for (const needle of [
    "scripts/Deploy-Console.ps1", "Console.Admin", "Console.User", "oauth2PermissionGrant",
    "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "x-api-key", "scripts/open-bundle.mjs",
    "BUNDLE_PASSPHRASE", "ADR-0013", "ADR-0014",
  ]) assert.ok(doc.includes(needle), `mentions ${needle}`);
});

test("CONSOLE.md publishes no identities: only example addresses, no GUIDs", () => {
  const doc = read("docs/CONSOLE.md");
  const emails = doc.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) ?? [];
  assert.deepEqual(emails.filter((e) => !/@contoso\.com$/.test(e)), []);
  assert.doesNotMatch(doc, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  assert.doesNotMatch(doc, /azurecontainerapps\.io|kv-poc-[a-z0-9]{6,}|apim-hackgw-pe-[a-z0-9]{6,}/);
});

test("README points to the console guide", () => {
  assert.match(read("README.md"), /\]\(docs\/CONSOLE\.md\)/);
});
