import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { poc, read, root } from "./poc-products-keyvault.harness.mjs";

/**
 * P43: the Azure portal steps (PORTAL.md) and the architecture document (ARCHITECTURE.md) for the
 * products proof of concept. Neither runs, so these tests hold them to the code: tables are read
 * by column, and every route, operation, pack value, role and scope, network setting, tag and
 * command they give is compared with infra/*.bicep, the policies and the key scripts. Every link,
 * anchor and ledger reference has to resolve, and every numbered portal step cites Microsoft Learn.
 */

const doc = (name) => read(name).replace(/\r\n/g, "\n");
const flat = (text) => text.replace(/\s+/g, " ");
const bicep = () => read("infra", "poc.bicep");
const runnerBicep = () => read("infra", "runner.bicep");
const keysPs = () => read("scripts", "PocKeys.ps1");
const cliPs = () => read("scripts", "Invoke-PocKey.ps1");
const quoted = (list) => [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]);

// The template's facts.
const routes = () => [...bicep().matchAll(/id: '(poc-[a-z]+)'\s+keyHeader: '([^']+)'\s+path: '([^']+)'\s+displayName: '([^']+)'\s+backend: '([^']*)'\s+policy: loadTextContent\('([^']+)'\)/g)]
  .map((m) => ({ id: m[1], header: m[2], path: m[3], displayName: m[4], backend: m[5], policy: m[6] }));
const operations = () => [...bicep().matchAll(/route: '(poc-[a-z]+)'\s+op: '([^']+)'\s+method: '([A-Z]+)'\s+url: '([^']+)'/g)]
  .map((m) => ({ route: m[1], op: m[2], method: m[3], url: m[4] }));
const packs = () => [...bicep().matchAll(/id: '(poc-[a-z-]+-pack)'\s+displayName: '([^']+)'\s+routes: \[([^\]]*)\]\s+models: \[([^\]]*)\]\s+keyTokens: (\d+)\s+poolTokens: (\d+)\s+tpm: (\d+)/g)]
  .map((m) => ({ id: m[1], displayName: m[2], routes: quoted(m[3]), models: quoted(m[4]), keyTokens: m[5], poolTokens: m[6], tpm: m[7] }));
const everyPackRoute = () => (bicep().match(/concat\(p\.routes, \['(poc-[a-z]+)'\]\)/) || [])[1];
// The template's service URLs with the account's subdomain as the placeholder the documents use.
const serviceUrl = (name) => ((bicep().match(new RegExp(`var ${name} = [\\s\\S]*?'(https://\\$\\{foundry\\.properties\\.customSubDomainName\\}[^']+)'`)) || [])[1] || "")
  .replace("${foundry.properties.customSubDomainName}", "<account>");

// Built-in role ids (Azure built-in roles reference); a role id the code uses must be one of these.
const ROLE = {
  "b86a8fe4-44ce-4948-aee5-eccb2c155cd7": "Key Vault Secrets Officer",
  "4633458b-17de-408a-b874-0445c86b69e6": "Key Vault Secrets User",
  "312a565d-c81f-4fd8-895a-4e21e48d571c": "API Management Service Contributor",
};
const roleName = (id) => {
  assert.ok(ROLE[id], `role id ${id} is not one the documents were written for`);
  return ROLE[id];
};
const operatorRole = () => {
  assert.match(bicep(), /resource operatorRole [^\n]*\{\s+name: [^\n]+\s+scope: vault\s+properties: \{\s+roleDefinitionId: [^\n]*keyVaultSecretsOfficer\)/, "the operator's role is no longer Secrets Officer on the vault");
  return roleName((bicep().match(/var keyVaultSecretsOfficer = '([^']+)'/) || [])[1]);
};
const developerRole = () => roleName((keysPs().match(/\$script:PocSecretsUserRole = '([^']+)'/) || [])[1]);
const runnerRoles = () => [...runnerBicep().matchAll(/^var \w+ = '([0-9a-f-]{36})'/gm)].map((m) => roleName(m[1]));

// Tables, read by column from the header row; a table inside a list item is indented.
const tables = (text) => {
  const out = [];
  let cur = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("|")) { cur = null; continue; }
    const cells = line.replace(/`/g, "").split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim().replace(/\\\|/g, "|"));
    if (!cur) { cur = { header: cells, rows: [] }; out.push(cur); continue; }
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
    cur.rows.push(Object.fromEntries(cur.header.map((h, i) => [h, cells[i] ?? ""])));
  }
  return out;
};
const tableWith = (text, ...columns) => {
  const t = tables(text).find((x) => columns.every((c) => x.header.includes(c)));
  assert.ok(t, `no table with the columns ${columns.join(", ")}`);
  return t.rows;
};
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
const slug = (h) => h.trim().toLowerCase().replace(/`/g, "").replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
// Numbered steps: an item and its indented continuation.
const steps = (body) => {
  const out = [];
  let cur = null;
  let blank = false;
  for (const line of body.split("\n")) {
    if (/^\d+\. /.test(line)) { cur = [line]; out.push(cur); blank = false; continue; }
    if (!cur) continue;
    if (line.trim() === "") { blank = true; continue; }
    if (blank && !/^\s/.test(line)) { cur = null; continue; }
    cur.push(line);
    blank = false;
  }
  return out.map((s) => s.join(" "));
};
// The query parameter stays readable to Foundry unless a route policy removes it (roadmap P42).
const queryKeyReachesFoundry = () => /query: 'subscription-key'/.test(bicep())
  && !["api-claude-policy.xml", "api-openai-policy.xml"].some((f) => /set-query-parameter name="subscription-key" exists-action="delete"/.test(read("infra", f)));

const sharedChecks = (name) => {
  test(`${name}: links and their anchors resolve, and every UNKNOWNS and roadmap reference exists`, () => {
    const text = doc(name);
    const links = [...text.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]).filter((l) => !/^(https?:|mailto:)/.test(l));
    assert.ok(links.length >= 5, `expected links to the templates and scripts, found ${links.length}`);
    for (const l of links) {
      const [file, anchor] = l.split("#");
      const target = file ? join(poc, file) : join(poc, name);
      assert.ok(existsSync(target), `${l} does not exist`);
      if (anchor) {
        const slugs = readFileSync(target, "utf8").split(/\r?\n/).filter((x) => /^#{1,6} /.test(x)).map((x) => slug(x.replace(/^#+ /, "")));
        assert.ok(slugs.includes(anchor), `${l}: no heading with the anchor #${anchor}`);
      }
    }
    const register = readFileSync(join(root, "docs", "UNKNOWNS.md"), "utf8");
    for (const u of new Set([...text.matchAll(/\bU(\d+)\b/g)].map((m) => m[1]))) {
      assert.match(register, new RegExp(`^\\| U${u} \\|`, "m"), `U${u} is not in the unknowns register`);
    }
    const roadmap = readFileSync(join(root, "docs", "ROADMAP.md"), "utf8");
    for (const p of new Set([...text.matchAll(/\bP(\d+)\b/g)].map((m) => m[1]))) {
      assert.match(roadmap, new RegExp(`\\*\\*P${p}\\*\\*`), `P${p} is not in the roadmap`);
    }
  });

  test(`${name}: no key, no GUID, no real instance, and no claim that the key never reaches Foundry while it can`, () => {
    const text = doc(name);
    assert.doesNotMatch(text, /\b[0-9a-f]{32}\b/i, "something shaped like a subscription key");
    assert.doesNotMatch(text.replace(/https:\/\/(learn|support)\.microsoft\.com\/[^\s)]+/g, ""), /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i, "a GUID outside a documentation URL");
    for (const m of text.matchAll(/https:\/\/([^/\s)`"']+)\.(azure-api\.net|vault\.azure\.net|services\.ai\.azure\.com|openai\.azure\.com)/g)) {
      assert.match(m[1], /^<[^>]+>$/, `${m[0]} is not a placeholder`);
    }
    if (queryKeyReachesFoundry()) assert.doesNotMatch(flat(text), /never (leaves|reaches|passes)/i, "a key in the query parameter reaches Foundry (P42)");
  });

  test(`${name}: linked from the proof of concept's README and SETUP.md`, () => {
    assert.ok(existsSync(join(poc, name)), `${name} is missing`);
    assert.match(read("README.md"), new RegExp(`\\]\\(${name.replace(".", "\\.")}\\)`));
    assert.match(read("SETUP.md"), new RegExp(`\\]\\(${name.replace(".", "\\.")}\\)`));
  });
};

describe("P43 portal steps", () => {
  sharedChecks("PORTAL.md");
  const s = () => sections(doc("PORTAL.md"));

  test("the steps cover what the template creates and every key operation", () => {
    const want = ["Prerequisites", "Routes", "Packs", "Key Vault", "Issue a key", "Hand a key over", "Rotate a key",
      "Expire a key", "Suspend and resume a key", "List keys", "Remove", "Sources"];
    assert.deepEqual(want.filter((h) => !headings(doc("PORTAL.md")).includes(h)), []);
  });

  test("every numbered step and every prerequisite cites Microsoft Learn", () => {
    for (const [name, body] of Object.entries(s())) {
      if (name === "Sources") continue;
      assert.match(body, /https:\/\/learn\.microsoft\.com\//, `${name} cites no Microsoft Learn page`);
      for (const step of steps(body)) assert.match(step, /https:\/\/learn\.microsoft\.com\//, `${name}: a step cites no Microsoft Learn page: ${step.slice(0, 80)}`);
    }
    for (const row of tableWith(doc("PORTAL.md"), "Item", "Portal steps", "Source")) {
      assert.match(`${row["Portal steps"]} ${row.Source}`, /learn\.microsoft\.com/, `prerequisite "${row.Item}" cites no Microsoft Learn page`);
    }
  });

  test("each key operation names its script action, and every script command is one the scripts accept", () => {
    const sec = s();
    for (const [section, actions] of [["Issue a key", ["New"]], ["Hand a key over", ["Grant", "Revoke"]], ["Rotate a key", ["Rotate"]],
      ["Expire a key", ["SetExpiry", "SuspendExpired"]], ["Suspend and resume a key", ["Suspend", "Resume"]], ["List keys", ["List"]]]) {
      for (const a of actions) assert.match(sec[section] || "", new RegExp(`-Action ${a}\\b`), `${section} does not name -Action ${a}`);
    }
    const params = (script) => {
      const block = read("scripts", script).match(/^param\(([\s\S]*?)^\)/m)[1];
      return [...block.matchAll(/\$(\w+)\b/g)].map((m) => m[1]);
    };
    const validSet = (script, p) => quoted(read("scripts", script).match(new RegExp(`ValidateSet\\(([^)]*)\\)\\]\\[string\\]\\$${p}\\b`))[1]);
    for (const [script, setParam] of [["Invoke-PocKey.ps1", "Action"], ["Invoke-PocRunner.ps1", "Step"]]) {
      const known = params(script);
      for (const line of doc("PORTAL.md").split("\n").filter((l) => l.includes(script))) {
        for (const [, p] of line.matchAll(/(?<![\w-])-(\w+)/g)) assert.ok(known.includes(p), `${script} has no parameter -${p}: ${line.trim()}`);
        for (const [, v] of line.matchAll(new RegExp(`-${setParam} (\\w+)`, "g"))) assert.ok(validSet(script, setParam).includes(v), `${script} has no -${setParam} ${v}`);
      }
    }
    assert.match(doc("PORTAL.md"), /^\$target = @\{ Subscription = /m, "PORTAL.md does not define $target");
    assert.match(doc("PORTAL.md"), /^\$vault = /m, "PORTAL.md does not define $vault");
  });

  test("the routes table is the template's, column by column, with every operation and the query parameter", () => {
    const text = doc("PORTAL.md");
    const rs = routes();
    assert.equal(rs.length, 3, "the template's routes were not found");
    const table = tableWith(text, "Name", "Display name", "API URL suffix", "Web service URL", "Subscription key header", "Policy");
    assert.equal(table.length, rs.length);
    const url = { claude: serviceUrl("claudeServiceUrl"), openai: serviceUrl("openaiServiceUrl") };
    assert.ok(url.claude && url.openai, "the template's service URLs were not found");
    for (const r of rs) {
      const row = table.find((x) => x.Name === r.id);
      assert.ok(row, `no row for ${r.id}`);
      assert.deepEqual([row["Display name"], row["API URL suffix"], row["Subscription key header"]], [r.displayName, r.path, r.header], r.id);
      assert.match(row.Policy, new RegExp(`\\]\\(infra/${r.policy.replace(".", "\\.")}\\)`), `${r.id}: the policy is not ${r.policy}`);
      if (r.backend) assert.equal(row["Web service URL"], url[r.backend], `${r.id}: the web service URL`);
      else assert.doesNotMatch(row["Web service URL"], /https:/, `${r.id} has no backend`);
    }
    const ops = operations();
    assert.equal(ops.length, 4, "the template's operations were not found");
    const opTable = tableWith(text, "API", "Operation", "Method", "URL");
    assert.equal(opTable.length, ops.length);
    for (const o of ops) {
      const row = opTable.find((x) => x.API === o.route && x.Operation === o.op);
      assert.ok(row, `no row for ${o.route} ${o.op}`);
      assert.deepEqual([row.Method, row.URL], [o.method, o.url], `${o.route} ${o.op}`);
    }
    assert.match(text, /`subscription-key`/);
  });

  test("the packs table is the template's, column by column, and fills every placeholder", () => {
    const ps = packs();
    assert.equal(ps.length, 3, "the template's packs were not found");
    const probe = everyPackRoute();
    assert.ok(probe, "the route every pack carries was not found");
    const placeholders = [...new Set([...read("infra", "product-policy.xml").replace(/<!--[\s\S]*?-->/g, "").matchAll(/__[A-Z_]+__/g)].map((m) => m[0]))].sort();
    assert.deepEqual(placeholders, ["__KEY_TOKENS__", "__MODELS__", "__POOL_TOKENS__", "__TPM__"], "the policy's placeholders changed");
    const table = tableWith(doc("PORTAL.md"), "Id", "Display name", "APIs", ...placeholders);
    assert.equal(table.length, ps.length);
    for (const p of ps) {
      const row = table.find((x) => x.Id === p.id);
      assert.ok(row, `no row for ${p.id}`);
      assert.deepEqual(
        [row["Display name"], row.APIs, row.__MODELS__, row.__KEY_TOKENS__, row.__POOL_TOKENS__, row.__TPM__],
        [p.displayName, [...p.routes, probe].join(", "), p.models.join("|"), p.keyTokens, p.poolTokens, p.tpm], p.id);
    }
  });

  test("the vault, network and product settings are the template's", () => {
    const text = flat(doc("PORTAL.md"));
    const b = bicep();
    assert.match(b, /enableRbacAuthorization: true/);
    assert.match(text, /Azure role-based access control/);
    assert.match(b, /softDeleteRetentionInDays: 7/);
    assert.match(text, /\b7 days\b/);
    assert.doesNotMatch(b, /enablePurgeProtection: true/);
    assert.match(text, /purge protection off/);
    assert.match(b, /param vaultPublicNetworkAccess string = 'Disabled'/);
    assert.match(text, /\*\*Disable public access\*\*/);
    assert.match(b, /defaultAction: 'Deny'\s+bypass: 'None'/);
    assert.match(text, /clear \*\*Allow trusted Microsoft services to bypass this firewall\*\*/, "no step turns off the trusted-services bypass");
    assert.match(text, /--bypass None --default-action Deny/);
    const subnet = (runnerBicep().match(/param privateEndpointSubnetName string = '([^']+)'/) || [])[1];
    assert.ok(subnet && text.includes(`\`${subnet}\``), `the private endpoint subnet ${subnet} is not given`);
    assert.match(b, /state: 'notPublished'/);
    assert.match(text, /\*\*State\*\* not published/);
    assert.match(b, /products@[^\n]+\n[\s\S]*?subscriptionRequired: true/);
    assert.match(text, /\*\*Requires subscription\*\* on/);
    assert.match(text, /\*\*Requires approval\*\* off/);
  });

  test("issuing and rotating write every tag and the content type the scripts write", () => {
    const keys = keysPs();
    const types = [...new Set([...keys.matchAll(/contentType = '([^']+)'/g)].map((m) => m[1]))];
    assert.equal(types.length, 1, `the scripts write ${types.length} content types`);
    const tags = [...new Set([...keys.matchAll(/tags\s+= @\{([^}]*)\}/g)].flatMap((m) => [...m[1].matchAll(/(\w+) = /g)].map((x) => x[1])))]
      .filter((t) => t !== "rotatedAt");
    assert.deepEqual(tags.sort(), ["product", "slot", "subscription"]);
    const sec = sections(doc("PORTAL.md"));
    // The step that writes the secret's version, in each flow.
    for (const [section, marker] of [["Issue a key", "+ Generate/Import"], ["Rotate a key", "next version"]]) {
      const step = steps(sec[section] || "").find((x) => x.includes(marker)) || "";
      assert.ok(step, `${section}: no step that writes the secret`);
      const body = flat(step);
      assert.ok(body.includes(types[0]), `${section} does not give the content type ${types[0]}`);
      for (const t of tags) assert.match(body, new RegExp(`\`${t}\` \\(`), `${section} does not give the ${t} tag with its value`);
    }
    assert.match(flat(sec["Issue a key"] || ""), /clipboard history/, "the clipboard history is not mentioned");
  });

  test("each role is the code's, on the code's scope", () => {
    const text = flat(doc("PORTAL.md"));
    assert.match(text, new RegExp(`The vault › \\*\\*Access control \\(IAM\\)\\*\\* › \\*\\*Add\\*\\* › \\*\\*Add role assignment\\*\\* › ${operatorRole()} › the operator`));
    assert.match(text, new RegExp(`The secret › \\*\\*Access control \\(IAM\\)\\*\\* › \\*\\*Add\\*\\* › \\*\\*Add role assignment\\*\\* › ${developerRole()} › the developer`));
    assert.doesNotMatch(text, new RegExp(`The vault › [^.]*${developerRole()}`), "a vault-wide read role for a developer");
  });

  test("with a private vault: what needs the private network, and every action that does not", () => {
    // Key actions whose function reads or writes the vault's data plane.
    const fnOf = Object.fromEntries([...cliPs().matchAll(/^\s+'(\w+)' \{[^\n]*?\b([A-Z][a-z]+-\w*Poc\w*)/gm)].map((m) => [m[1], m[2]]));
    const actions = quoted(cliPs().match(/ValidateSet\(([^)]*)\)\]\[string\]\$Action\b/)[1]);
    assert.deepEqual(Object.keys(fnOf).sort(), [...actions].sort(), "an action whose function was not found");
    const body = (fn) => (keysPs().match(new RegExp(`^function ${fn} \\{[\\s\\S]*?^\\}`, "m")) || [""])[0];
    const usesVault = (fn) => /Invoke-PocVault|Get-PocKeyRecord/.test(body(fn));
    const needPath = Object.keys(fnOf).filter((a) => usesVault(fnOf[a]));
    assert.deepEqual(needPath.sort(), ["New", "Rotate"], "the actions that need a path to the vault changed");
    const text = flat(doc("PORTAL.md"));
    const sentence = (text.match(/[^.]*need no path to the vault[^.]*\./) || [""])[0];
    for (const a of Object.keys(fnOf).filter((x) => !needPath.includes(x))) assert.match(sentence, new RegExp(`\`${a}\``), `${a} is missing from the actions that need no path to the vault`);
    assert.match(text, /Invoke-PocRunner\.ps1[^\n]*-Step Key/, "the runner's key step is not named");
    const sec = sections(doc("PORTAL.md"));
    const copy = (flat(sec["Hand a key over"] || "").match(/\*\*One-time copy\.\*\*[^*]*/) || [""])[0];
    assert.match(copy, /`slot`/, "the one-time copy does not say which key is current");
    assert.match(flat(sec.Remove || ""), /private endpoint/i);
    assert.match(flat(sec.Remove || ""), /privatelink\.vaultcore\.azure\.net/);
  });
});

describe("P43 architecture", () => {
  sharedChecks("ARCHITECTURE.md");

  test("the document covers components, identities, network, the request flow, each key flow and the decisions", () => {
    const want = ["Components", "Identities and roles", "Network paths", "Request flow", "Key lifecycle", "Issue", "Hand over",
      "Rotate", "Expire", "Suspend and resume", "Revoke", "Remove", "Design decisions", "Measured behaviour", "Limits", "Sources"];
    assert.deepEqual(want.filter((h) => !headings(doc("ARCHITECTURE.md")).includes(h)), []);
  });

  test("the routes, packs, audience, counter and headers it describes are the code's", () => {
    const text = doc("ARCHITECTURE.md");
    const rs = routes();
    assert.equal(rs.length, 3, "the template's routes were not found");
    const table = tableWith(text, "Route", "Path", "Key header");
    assert.equal(table.length, rs.length);
    for (const r of rs) {
      const row = table.find((x) => x.Route === r.id);
      assert.ok(row, `no row for ${r.id}`);
      assert.deepEqual([row.Path, row["Key header"]], [r.path, r.header], r.id);
    }
    const ps = packs();
    assert.equal(ps.length, 3, "the template's packs were not found");
    for (const p of ps) assert.match(text, new RegExp(`\`${p.id}\``), `${p.id} is not named`);
    const audience = (read("infra", "api-claude-policy.xml").match(/resource="([^"]+)"/) || [])[1];
    assert.equal((read("infra", "api-openai-policy.xml").match(/resource="([^"]+)"/) || [])[1], audience);
    const stated = [...flat(text).matchAll(/(?:audience|token for) `(https:\/\/[^`]+)`/g)].map((m) => m[1]);
    assert.ok(stated.length >= 1, "no audience is stated");
    assert.deepEqual([...new Set(stated)], [audience], "an audience other than the policies' is stated");
    const policy = read("infra", "product-policy.xml");
    assert.match(policy, /counter-key="@\(context\.Subscription\.Id\)"/);
    assert.match(text, /context\.Subscription\.Id/);
    const quota = (policy.match(/remaining-quota-tokens-header-name="([^"]+)"/) || [])[1];
    const perMinute = (policy.match(/remaining-tokens-header-name="([^"]+)"/) || [])[1];
    assert.ok(quota && perMinute, "the policy's header names were not found");
    assert.match(flat(text), new RegExp(`remaining budget in \`${quota}\``), `${quota} is not described as the remaining budget`);
    assert.match(flat(text), new RegExp(`per-minute count in \`${perMinute}\``), `${perMinute} is not described as the per-minute count`);
  });

  test("each identity's role and scope are the code's", () => {
    const rows = tableWith(doc("ARCHITECTURE.md"), "Identity", "Role", "Scope");
    const operator = rows.find((r) => /^Operator$/.test(r.Identity) && r.Role === operatorRole());
    assert.ok(operator, `no operator row with ${operatorRole()}`);
    assert.match(operator.Scope, /^Vault\b/);
    const developer = rows.find((r) => /^Developer$/.test(r.Identity));
    assert.ok(developer, "no developer row");
    assert.equal(developer.Role, developerRole());
    assert.match(developer.Scope, /^One secret\b/);
    const runner = rows.find((r) => /Runner/.test(r.Identity));
    assert.ok(runner, "no runner row");
    for (const role of runnerRoles()) assert.ok(runner.Role.includes(role), `the runner's ${role} is not given`);
    assert.match(runner.Scope, /Vault/i);
    assert.match(runner.Scope, /instance/i);
  });

  test("the network statements are the template's", () => {
    const text = flat(doc("ARCHITECTURE.md"));
    assert.match(bicep(), /param vaultPublicNetworkAccess string = 'Disabled'/);
    const vaultRow = tableWith(doc("ARCHITECTURE.md"), "Component", "What it is").find((r) => r.Component === "Key Vault");
    assert.ok(vaultRow, "no Key Vault row in the components table");
    assert.match(vaultRow["What it is"], /public network access Disabled/);
    assert.doesNotMatch(text, /public network access `Enabled`/);
    assert.match(bicep(), /bypass: 'None'/);
    assert.match(text, /trusted-services bypass[^.]*off|bypass: 'None'/, "the trusted-services bypass is not stated");
    if (queryKeyReachesFoundry()) assert.match(text, /query parameter[^.]*P42|P42[^.]*query parameter/, "the query-parameter key is not tied to P42");
    assert.match(text, /runner\.bicep/);
    assert.match(text, /Remove-Poc\.ps1 -Runner/, "the private endpoint's removal with the runner is not stated");
  });
});
