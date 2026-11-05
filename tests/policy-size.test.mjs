import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8");
const POLICY_LIMIT = 16 * 1024;
const POLICIES = [["infra/policy.xml", "infra/policy.min.xml"], ["infra/policy-claude.xml", "infra/policy-claude.min.xml"]];

// API Management v2 refuses an API policy document over 16 KiB ("Policy size exceeds allowed
// limit of 16 KB"; measured 2026-10-23 and again by an admin.ps1 deployment on 2026-11-05).
test("main.bicep deploys the compacted gateway policies, never the commented sources", () => {
  const bicep = read("infra/main.bicep");
  assert.match(bicep, /loadTextContent\('policy\.min\.xml'\)/);
  assert.match(bicep, /loadTextContent\('policy-claude\.min\.xml'\)/);
  assert.doesNotMatch(bicep, /loadTextContent\('policy(?:-claude)?\.xml'\)/);
});

test("each compacted policy is the compaction of its source and fits API Management's 16 KiB limit", async () => {
  const { compactPolicy } = await import("../src/policy-compact.mjs");
  for (const [source, compacted] of POLICIES) {
    const min = read(compacted);
    assert.equal(min, compactPolicy(read(source)), `${compacted} is stale: run node scripts/compact-policies.mjs`);
    assert.ok(Buffer.byteLength(min) <= POLICY_LIMIT, `${compacted} is ${Buffer.byteLength(min)} bytes`);
  }
});

test("compaction removes comments and indentation only", async () => {
  const { compactPolicy } = await import("../src/policy-compact.mjs");
  const xml = '<policies>\r\n  <!-- a\r\n  note -->\r\n  <inbound>\r\n    <set-variable name="x" value="@{\r\n      // why\r\n      return 1;\r\n    }" />\r\n  </inbound>\r\n</policies>\r\n';
  assert.equal(compactPolicy(xml), '<policies>\n<inbound>\n<set-variable name="x" value="@{\nreturn 1;\n}" />\n</inbound>\n</policies>');
  // Every element and attribute of the real sources survives, apart from the comments compaction
  // removes: XML comments and whole-line // comments inside policy expressions.
  for (const [source] of POLICIES) {
    const tags = (s) => (s.replace(/<!--[\s\S]*?-->/g, "").replace(/^[ \t]*\/\/[^\r\n]*$/gm, "")
      .match(/<[a-z][\w-]*(?:\s[^<>]*?)?\/?>/g) ?? []).map((t) => t.replace(/\s+/g, " "));
    assert.deepEqual(tags(compactPolicy(read(source))), tags(read(source)), `${source}: elements changed`);
  }
});

test("compaction refuses a policy still over the limit", async () => {
  const { compactPolicy } = await import("../src/policy-compact.mjs");
  assert.throws(() => compactPolicy(`<policies>${"<base />".repeat(3000)}</policies>`), /16 KiB/);
});

test("every policy file a Bicep template deploys fits API Management's 16 KiB limit", () => {
  const templates = ["infra/main.bicep", "poc/products-keyvault/infra/poc.bicep"];
  const loaded = [];
  for (const t of templates) {
    for (const m of read(t).matchAll(/loadTextContent\('([^']+\.xml)'\)/g)) {
      const file = new URL(m[1], new URL(t, root));
      loaded.push(m[1]);
      const bytes = readFileSync(file).length;
      assert.ok(bytes <= POLICY_LIMIT, `${t} deploys ${m[1]}: ${bytes} bytes`);
    }
  }
  assert.ok(loaded.length >= 6, `found the deployed policies: ${loaded}`);
});
