import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { poc, read, root } from "./poc-products-keyvault.harness.mjs";

/**
 * P43: the Azure portal steps (PORTAL.md) and the architecture document (ARCHITECTURE.md) for the
 * products proof of concept. Neither runs, so these tests hold them to the code: every name,
 * path, header, role and pack value they give is compared with infra/poc.bicep, the policies and
 * the key scripts, and every link and ledger reference has to resolve.
 */

const doc = (name) => read(name).replace(/\r\n/g, "\n");
const bicep = () => read("infra", "poc.bicep");
const routes = () => [...bicep().matchAll(/id: '(poc-[a-z]+)'\s+keyHeader: '([^']+)'\s+path: '([^']+)'\s+displayName: '([^']+)'/g)]
  .map((m) => ({ id: m[1], header: m[2], path: m[3], displayName: m[4] }));
const operations = () => [...bicep().matchAll(/route: '(poc-[a-z]+)'\s+op: '([^']+)'\s+method: '([A-Z]+)'\s+url: '([^']+)'/g)]
  .map((m) => ({ route: m[1], op: m[2], method: m[3], url: m[4] }));
const quoted = (list) => [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]);
const packs = () => [...bicep().matchAll(/id: '(poc-[a-z-]+-pack)'\s+displayName: '([^']+)'\s+routes: \[([^\]]*)\]\s+models: \[([^\]]*)\]\s+keyTokens: (\d+)\s+poolTokens: (\d+)\s+tpm: (\d+)/g)]
  .map((m) => ({ id: m[1], displayName: m[2], routes: quoted(m[3]), models: quoted(m[4]), keyTokens: m[5], poolTokens: m[6], tpm: m[7] }));
// Table rows as cells, with backticks dropped and an escaped pipe kept inside its cell. A table
// inside a list item is indented.
const rows = (text) => text.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("|"))
  .map((l) => l.replace(/`/g, "").split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim().replace(/\\\|/g, "|")));
// Prose as rendered: a phrase may wrap across lines.
const flat = (text) => text.replace(/\s+/g, " ");
const rowWith = (text, ...cells) => rows(text).find((r) => cells.every((c) => r.includes(c)));
const sections = (text) => {
  const out = {};
  let name = "";
  for (const line of text.split("\n")) {
    const h = line.match(/^#{2,3} (.+)$/);
    if (h) name = h[1].trim();
    else if (name) out[name] = `${out[name] || ""}${line}\n`;
  }
  return out;
};
const headings = (text) => text.split("\n").filter((l) => /^#{2,3} /.test(l)).map((l) => l.replace(/^#+ /, "").trim());

// Shared checks for both documents: links resolve, ledger references exist, nothing secret.
const sharedChecks = (name) => {
  test(`${name}: relative links resolve, and every UNKNOWNS and roadmap reference exists`, () => {
    const text = doc(name);
    const links = [...text.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]).filter((l) => !/^(https?:|#|mailto:)/.test(l)).map((l) => l.split("#")[0]);
    assert.ok(links.length >= 5, `expected links to the templates and scripts, found ${links.length}`);
    for (const l of links) assert.ok(existsSync(join(poc, l)), `${l} does not exist`);
    const register = readFileSync(join(root, "docs", "UNKNOWNS.md"), "utf8");
    for (const u of new Set([...text.matchAll(/\bU(\d+)\b/g)].map((m) => m[1]))) {
      assert.match(register, new RegExp(`^\\| U${u} \\|`, "m"), `U${u} is not in the unknowns register`);
    }
    const roadmap = readFileSync(join(root, "docs", "ROADMAP.md"), "utf8");
    for (const p of new Set([...text.matchAll(/\bP(\d+)\b/g)].map((m) => m[1]))) {
      assert.match(roadmap, new RegExp(`\\*\\*P${p}\\*\\*`), `P${p} is not in the roadmap`);
    }
  });

  test(`${name}: no key, no GUID, no real instance`, () => {
    const text = doc(name);
    assert.doesNotMatch(text, /\b[0-9a-f]{32}\b/i, "something shaped like a subscription key");
    assert.doesNotMatch(text, /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i, "a GUID");
    for (const m of text.matchAll(/https:\/\/([^/\s)`"']+)\.(azure-api\.net|vault\.azure\.net|services\.ai\.azure\.com|openai\.azure\.com)/g)) {
      assert.match(m[1], /^<[^>]+>$/, `${m[0]} is not a placeholder`);
    }
  });

  test(`${name}: linked from the proof of concept's README and SETUP.md`, () => {
    assert.ok(existsSync(join(poc, name)), `${name} is missing`);
    assert.match(read("README.md"), new RegExp(`\\]\\(${name.replace(".", "\\.")}\\)`));
    assert.match(read("SETUP.md"), new RegExp(`\\]\\(${name.replace(".", "\\.")}\\)`));
  });
};

describe("P43 portal steps", () => {
  sharedChecks("PORTAL.md");

  test("the steps cover what the template creates and every key operation", () => {
    const want = ["Prerequisites", "Routes", "Packs", "Key Vault", "Issue a key", "Hand a key over", "Rotate a key",
      "Expire a key", "Suspend and resume a key", "List keys", "Remove", "Sources"];
    assert.deepEqual(want.filter((h) => !headings(doc("PORTAL.md")).includes(h)), []);
  });

  test("each section cites Microsoft Learn, and each key operation names its script action", () => {
    const s = sections(doc("PORTAL.md"));
    for (const [name, body] of Object.entries(s)) {
      if (name === "Sources") continue;
      assert.match(body, /https:\/\/learn\.microsoft\.com\//, `${name} cites no Microsoft Learn page`);
    }
    for (const [section, actions] of [["Issue a key", ["New"]], ["Hand a key over", ["Grant", "Revoke"]], ["Rotate a key", ["Rotate"]],
      ["Expire a key", ["SetExpiry", "SuspendExpired"]], ["Suspend and resume a key", ["Suspend", "Resume"]], ["List keys", ["List"]]]) {
      for (const a of actions) assert.match(s[section] || "", new RegExp(`-Action ${a}\\b`), `${section} does not name -Action ${a}`);
    }
  });

  test("each route's name, path and key header are the template's, with the query parameter and every operation", () => {
    const text = doc("PORTAL.md");
    const rs = routes();
    assert.equal(rs.length, 3, "the template's routes were not found");
    for (const r of rs) assert.ok(rowWith(text, r.id, r.displayName, r.path, r.header), `no row with ${r.id}, ${r.path} and ${r.header}`);
    assert.match(text, /`subscription-key`/);
    const ops = operations();
    assert.equal(ops.length, 4, "the template's operations were not found");
    for (const o of ops) assert.ok(rowWith(text, o.route, o.op, o.method, o.url), `no row for ${o.method} ${o.url} on ${o.route}`);
    for (const f of ["api-claude-policy.xml", "api-openai-policy.xml", "api-probe-policy.xml", "product-policy.xml"]) {
      assert.match(text, new RegExp(`\\]\\(infra/${f.replace(".", "\\.")}\\)`), `no link to infra/${f}`);
    }
  });

  test("each pack's routes and placeholder values are the template's, and every placeholder is filled", () => {
    const text = doc("PORTAL.md");
    const ps = packs();
    assert.equal(ps.length, 3, "the template's packs were not found");
    for (const p of ps) {
      const apis = [...p.routes, "poc-probe"].join(", ");
      assert.ok(rowWith(text, p.id, p.displayName, apis, p.models.join("|"), p.keyTokens, p.poolTokens, p.tpm),
        `no row for ${p.id} with APIs "${apis}", models ${p.models.join("|")}, ${p.keyTokens}, ${p.poolTokens}, ${p.tpm}`);
    }
    const placeholders = [...new Set([...read("infra", "product-policy.xml").replace(/<!--[\s\S]*?-->/g, "").matchAll(/__[A-Z_]+__/g)].map((m) => m[0]))].sort();
    assert.deepEqual(placeholders, ["__KEY_TOKENS__", "__MODELS__", "__POOL_TOKENS__", "__TPM__"], "the policy's placeholders changed");
    const header = rows(text).find((r) => r.includes("__MODELS__")) || [];
    assert.deepEqual(placeholders.filter((x) => !header.includes(x)), [], "placeholders the table does not fill");
  });

  test("the vault, secret and role settings are the template's and the scripts'", () => {
    const text = flat(doc("PORTAL.md"));
    assert.match(bicep(), /enableRbacAuthorization: true/);
    assert.match(text, /Azure role-based access control/);
    assert.match(bicep(), /softDeleteRetentionInDays: 7/);
    assert.match(text, /\b7 days\b/);
    const keys = read("scripts", "PocKeys.ps1");
    const contentType = (keys.match(/contentType = '([^']+)'/) || [])[1];
    assert.ok(contentType && text.includes(contentType), `the content type ${contentType} is not given`);
    for (const tag of ["slot", "subscription", "product"]) {
      assert.match(keys, new RegExp(`${tag} = `), `PocKeys.ps1 no longer sets the ${tag} tag`);
      assert.match(text, new RegExp(`\`${tag}\``), `the ${tag} tag is not given`);
    }
    assert.match(text, /`poc-key-<name>`/);
    for (const role of ["Key Vault Secrets Officer", "Key Vault Secrets User", "Cognitive Services User"]) assert.match(text, new RegExp(role));
  });
});

describe("P43 architecture", () => {
  sharedChecks("ARCHITECTURE.md");

  test("the document covers components, identities, network, the request flow, each key flow and the decisions", () => {
    const want = ["Components", "Identities and roles", "Network paths", "Request flow", "Key lifecycle", "Issue", "Hand over",
      "Rotate", "Expire", "Suspend and resume", "Revoke", "Remove", "Design decisions", "Measured behaviour", "Limits", "Sources"];
    assert.deepEqual(want.filter((h) => !headings(doc("ARCHITECTURE.md")).includes(h)), []);
  });

  test("the names, headers, audience and counter it describes are the code's", () => {
    const text = doc("ARCHITECTURE.md");
    for (const r of routes()) assert.ok(rowWith(text, r.id, r.path, r.header), `no row with ${r.id}, ${r.path} and ${r.header}`);
    for (const p of packs()) assert.match(text, new RegExp(`\`${p.id}\``), `${p.id} is not named`);
    const audience = (read("infra", "api-claude-policy.xml").match(/resource="([^"]+)"/) || [])[1];
    assert.equal((read("infra", "api-openai-policy.xml").match(/resource="([^"]+)"/) || [])[1], audience);
    assert.ok(audience && text.includes(audience), `the managed-identity audience ${audience} is not given`);
    const stated = [...flat(text).matchAll(/(?:audience|token for) `(https:\/\/[^`]+)`/g)].map((m) => m[1]);
    assert.ok(stated.length >= 1, "no audience is stated");
    assert.deepEqual([...new Set(stated)], [audience], "an audience other than the policies' is stated");
    const policy = read("infra", "product-policy.xml");
    assert.match(policy, /counter-key="@\(context\.Subscription\.Id\)"/);
    assert.match(text, /context\.Subscription\.Id/);
    for (const header of [...policy.matchAll(/header-name="([^"]+)"/g)].map((m) => m[1])) assert.ok(text.includes(header), `${header} is not named`);
    for (const role of ["Key Vault Secrets Officer", "Key Vault Secrets User", "Cognitive Services User", "API Management Service Contributor"]) {
      assert.match(flat(text), new RegExp(role), `${role} is not named`);
    }
  });
});
