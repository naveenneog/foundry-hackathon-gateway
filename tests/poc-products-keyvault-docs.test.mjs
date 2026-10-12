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

// Working copies may have CRLF line endings (core.autocrlf); every file is read with LF.
const lf = (...p) => read(...p).replace(/\r\n/g, "\n");
const doc = (name) => lf(name);
const flat = (text) => text.replace(/\s+/g, " ");
const bicep = () => lf("infra", "poc.bicep");
const runnerBicep = () => lf("infra", "runner.bicep");
const keysPs = () => lf("scripts", "PocKeys.ps1");
const cliPs = () => lf("scripts", "Invoke-PocKey.ps1");
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
// Each role assignment in runner.bicep: the role's name and the resource it is scoped to.
const runnerAssignments = () => [...runnerBicep().matchAll(/^resource \w+ 'Microsoft\.Authorization\/roleAssignments@[^']+' = \{\n[^\n]*\n\s+scope: (\w+)\n[\s\S]*?roleDefinitions', (\w+)\)/gm)]
  .map((m) => ({ scope: m[1], role: roleName((runnerBicep().match(new RegExp(`^var ${m[2]} = '([^']+)'`, "m")) || [])[1]) }));
// The subscription actions a script calls on API Management, in the words the documents use.
const subscriptionVerbs = (script) => {
  const text = lf("scripts", script);
  const calls = [...text.matchAll(/Invoke-PocApim -Context \$\w+ -Method (\w+) -Path ("[^"]*"|'[^']*'|\$[\w.]+)/g)].map((m) => ({ method: m[1], path: m[2] }))
    .concat([...text.matchAll(/Remove-PocItem "(\/subscriptions\/[^"]*)"/g)].map((m) => ({ method: "DELETE", path: m[1] })));
  const verbs = calls.filter((c) => /^["']?\/subscriptions\b|^\$page\.nextLink$/.test(c.path)).map(({ method, path }) => {
    if (/\/listSecrets\b/.test(path)) return "list keys";
    if (/regenerate/i.test(path)) return "regenerate";
    return { GET: "read", PUT: "create", PATCH: "update", DELETE: "delete" }[method] || `${method} ${path}`;
  });
  return [...new Set(verbs)];
};
// A claim that a client's key does not get past the gateway, read clause by clause: a clause whose
// subject is a key, saying it never or does not move on to Foundry, the backend or past the
// gateway, that no key does, or that it stays inside the gateway. A clause about a key in a header,
// and not the query parameter, is true: the route policies remove both key headers.
const MOVES = String.raw`(?:leaves?|reach(?:es)?|pass(?:es|ed)?|forward(?:s|ed)?|sen[dt]s?|goes|go|travels?|gets?|makes it)`;
const PLACE = String.raw`\b(?:Foundry|backend|the gateway|API Management|models?)\b`;
const KEY_FIRST = /^(?:(?:the|a|an|each|every|any|no|its|their|this)\s+)?(?:(?:client|user|developer|caller|subscription)(?:['’]s)?\s+|valid\s+)*keys?\b/i;
const clauses = (text) => flat(text)
  .split(/[.;:!?](?=\s|$)|,\s+(?:and|but|so|while|whereas)\s+|\s+[—–]\s+|\|/)
  .map((c) => c.replace(/^[^\p{L}\p{N}]+/u, "").trim()).filter(Boolean);
const keyStopsClaim = (clause) => {
  if (!KEY_FIRST.test(clause)) return false;
  if (/\bheaders?\b/i.test(clause) && !/\bquery\b/i.test(clause)) return false;
  return new RegExp(String.raw`(?:\bnever\b|\bnot\b|n['’]t\b)(?:\s+\w+){0,3}?\s+${MOVES}\b.*?${PLACE}`, "i").test(clause)
    || (/^no\b/i.test(clause) && new RegExp(String.raw`\b${MOVES}\b.*?${PLACE}`, "i").test(clause))
    || /\b(?:stays?|remains?|kept)\b(?:\s+\w+){0,2}?\s+(?:in|inside|within|at|behind)\s+(?:the\s+)?(?:gateway|API Management)\b/i.test(clause);
};
const paragraphs = (text) => text.split(/\n\s*\n/).map(flat);

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
    if (queryKeyReachesFoundry()) {
      assert.deepEqual(clauses(text).filter(keyStopsClaim), [], "a key in the query parameter reaches Foundry (P42)");
    }
  });

  test(`${name}: the Sources list holds every page the document cites, and only those, each with its date`, () => {
    const text = doc(name);
    const at = text.indexOf("\n## Sources");
    assert.ok(at > 0, "no Sources section");
    const urls = (s) => new Set([...s.matchAll(/\]\((https:\/\/[^)#\s]+)(?:#[^)\s]*)?\)/g)].map((m) => m[1]));
    const [cited, listed] = [urls(text.slice(0, at)), urls(text.slice(at))];
    assert.ok(cited.size >= 4, `expected pages to be cited, found ${cited.size}`);
    assert.deepEqual([...cited].filter((u) => !listed.has(u)), [], "cited, but not in Sources");
    assert.deepEqual([...listed].filter((u) => !cited.has(u)), [], "in Sources, but not cited");
    for (const line of text.slice(at).split("\n").filter((l) => /^- \[[^\]]+\]\(https:/.test(l))) {
      assert.match(line, /\((?:[^()]+, )?(?:api-version )?\d{4}-\d{2}-\d{2}\)$/, `a source with no date: ${line}`);
    }
  });

  test(`${name}: linked from the proof of concept's README and SETUP.md`, () => {
    assert.ok(existsSync(join(poc, name)), `${name} is missing`);
    assert.match(read("README.md"), new RegExp(`\\]\\(${name.replace(".", "\\.")}\\)`));
    assert.match(read("SETUP.md"), new RegExp(`\\]\\(${name.replace(".", "\\.")}\\)`));
  });
};

describe("P43 claim check", () => {
  test("it flags a key said to stop at the gateway, and passes true sentences about keys and requests", () => {
    const flagged = (s) => clauses(s).some(keyStopsClaim);
    for (const s of [
      "The client's key never leaves the gateway.",
      "A client's key is never forwarded to Foundry.",
      "A client's key does not travel to the backend.",
      "The client's key stays inside the gateway.",
      "Keys are not sent on to Foundry.",
      "No key reaches the backend.",
      "Both headers are removed, and the key never reaches Foundry.",
      "The key, in a header or the query parameter, never reaches Foundry.",
      "| Design | The key never leaves the gateway |",
    ]) assert.ok(flagged(s), `not flagged: ${s}`);
    for (const s of [
      "A request refused for its pack does not reach Foundry.",
      "A request without a valid key does not reach Foundry.",
      "Keys never go to disk.",
      "Keys stay in memory; names are validated before they reach a URL or a shell.",
      "Rotation never invalidates the key clients hold.",
      "No Foundry key exists in the design.",
      "The client's key is not a Foundry credential.",
      "A key in a header does not reach Foundry.",
      "A key sent in the `subscription-key` query parameter is passed on to Foundry.",
    ]) assert.ok(!flagged(s), `flagged: ${s}`);
  });
});

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
    for (const [script, setParams] of [["Invoke-PocKey.ps1", ["Action"]], ["Invoke-PocRunner.ps1", ["Step", "KeyAction"]]]) {
      const known = params(script);
      for (const line of doc("PORTAL.md").split("\n").filter((l) => l.includes(script))) {
        for (const [, p] of line.matchAll(/(?<![\w-])-(\w+)/g)) assert.ok(known.includes(p), `${script} has no parameter -${p}: ${line.trim()}`);
        for (const setParam of setParams) {
          for (const [, v] of line.matchAll(new RegExp(`(?<![\\w-])-${setParam} (\\w+)`, "g"))) assert.ok(validSet(script, setParam).includes(v), `${script} has no -${setParam} ${v}`);
        }
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
    // The template leaves approvalRequired unset; the deployed packs read false (measured 2026-10-12).
    assert.doesNotMatch(b, /approvalRequired:\s*true/, "the template requires approval, the steps turn it off");
    assert.match(text, /\*\*Requires approval\*\* off/);
  });

  test("the Foundry endpoints come from the account's Overview, as the template builds them", () => {
    const text = doc("PORTAL.md");
    assert.doesNotMatch(flat(text), /Keys and Endpoint/, "the endpoint is read on the page that also shows the account's keys");
    const row = tableWith(text, "Item", "Portal steps", "Source").find((r) => /Foundry endpoints/.test(r.Item));
    assert.ok(row, "no prerequisite for the Foundry endpoints");
    assert.match(row["Portal steps"], /\*\*Overview\*\*/, "the endpoint is not read on the account's Overview");
    assert.match(row.Source, /learn\.microsoft\.com\/azure\/ai-services\/multi-service-resource\b/);
    for (const u of [serviceUrl("claudeServiceUrl"), serviceUrl("openaiServiceUrl")]) assert.ok(u && row["Portal steps"].includes(u), `${u || "a service URL"} is not given`);
    assert.match(bicep(), /^var foundryEndpoints = foundry\.properties\.endpoints$/m);
    const branch = bicep().match(/var claudeServiceUrl = contains\(foundryEndpoints, '([^']+)'\)\s*\?\s*'\$\{foundryEndpoints\['([^']+)'\]\}([^']*)'/);
    if (branch) {
      assert.equal(branch[1], branch[2]);
      assert.ok(row["Portal steps"].includes(`${branch[1]} endpoint followed by ${branch[3]}`), `the template's ${branch[1]} branch is not described`);
    } else assert.doesNotMatch(row["Portal steps"], /AI Foundry API/, "a published-endpoint branch the template does not have");
  });

  test("the vault's private endpoint and the zone's link have the names runner.bicep gives them and Remove-Poc.ps1 removes", () => {
    const remover = lf("scripts", "Remove-Poc.ps1");
    const rb = runnerBicep();
    const fromBicep = (rb.match(/^resource \w+ 'Microsoft\.Network\/privateEndpoints@[^']+' = \{\n\s+name: '([^']+)'/m) || [])[1];
    const fromRemove = (remover.match(/az network private-endpoint delete [^\n]*-n "([^"]+)"/) || [])[1];
    assert.ok(fromBicep && fromRemove, "the private endpoint's name was not found");
    const name = fromBicep.replace("${vaultName}", "<vault-name>");
    assert.equal(fromRemove.replace("$VaultName", "<vault-name>"), name, "runner.bicep and Remove-Poc.ps1 name the endpoint differently");
    const linkBicep = (rb.match(/virtualNetworkLinks@[^\n]+\n\s+parent: vaultZone\n\s+name: '([^']+)'/) || [])[1];
    const linkRemove = (remover.match(/az network private-dns link vnet delete [^\n]*-n "([^"]+)"/) || [])[1];
    assert.ok(linkBicep && linkRemove, "the zone link's name was not found");
    const link = linkBicep.replace("${vnetName}", "<vnet-name>");
    assert.equal(linkRemove.replace("$VnetName", "<vnet-name>"), link, "runner.bicep and Remove-Poc.ps1 name the zone's link differently");
    const sec = sections(doc("PORTAL.md"));
    const create = steps(sec["Key Vault"] || "").map(flat).find((x) => x.includes("+ Create a private endpoint")) || "";
    const [whenNew, whenExisting] = create.split("For a vault that exists");
    for (const [label, part] of [["a new vault", whenNew], ["a vault that exists", whenExisting]]) {
      assert.ok((part || "").includes(`\`${name}\``), `the private endpoint for ${label} is not named ${name}`);
    }
    const remove = steps(sec.Remove || "").map(flat).find((x) => /private endpoint/.test(x)) || "";
    assert.ok(remove.includes(`\`${name}\``), `Remove does not name ${name}`);
    assert.match(remove, /virtual network link/, "Remove does not name the zone's link");
    const script = (flat(sec.Remove || "").match(/`Remove-Poc\.ps1 -Runner[^`]*`[\s\S]*?(?=\. It |$)/) || [""])[0];
    assert.match(script, /by the names `runner\.bicep` gives them/, "Remove-Poc.ps1's removal is not tied to runner.bicep's names");
    for (const n of [name, link]) assert.ok(script.includes(`\`${n}\``), `Remove-Poc.ps1's removal does not name ${n}`);
  });

  test("the runner's key step comes after the runner's setup steps, and its Deploy step creates the vault's endpoint", () => {
    const setup = sections(doc("SETUP.md"))["Vault access through the runner"] || "";
    const first = [...setup.matchAll(/-Step (\w+)/g)].map((m) => m[1]);
    assert.deepEqual(first, ["Deploy", "Setup", "Push"], "SETUP.md's runner steps changed");
    const paras = paragraphs(doc("PORTAL.md"));
    const command = /`[^`]*Invoke-PocRunner\.ps1[^`]*-Step Key\b[^`]*`/;
    const keyPara = paras.find((p) => command.test(p)) || "";
    assert.ok(keyPara, "no paragraph with the runner's key step");
    const before = keyPara.slice(0, keyPara.search(command));
    assert.match(before, /\]\(SETUP\.md#vault-access-through-the-runner\)/, "the runner's key step does not point to the runner's setup");
    assert.deepEqual([...before.matchAll(/`(\w+)`/g)].map((m) => m[1]).filter((s) => first.includes(s)), first, "the setup steps are not named, in order, before the key step");
    const runner = lf("scripts", "Invoke-PocRunner.ps1");
    assert.match(runner, /'Deploy' \{[\s\S]*?--template-file \(Join-Path \$poc 'infra' 'runner\.bicep'\)/, "the Deploy step does not deploy runner.bicep");
    const rb = runnerBicep();
    assert.match(rb, /privateDnsZones@[^\n]+\n\s+name: 'privatelink\.vaultcore\.azure\.net'/);
    assert.match(rb, /privateEndpoints\/privateDnsZoneGroups@[^\n]+\n\s+parent: vaultEndpoint/);
    assert.match(rb, /^resource vault 'Microsoft\.KeyVault\/vaults@[^']+' existing = \{\n\s+name: vaultName\n\}/m, "runner.bicep no longer finds the vault in its own resource group");
    const conn = (rb.match(/privateLinkServiceConnections: \[\n\s+\{\n\s+name: '([^']+)'/) || [])[1];
    const link = ((rb.match(/virtualNetworkLinks@[^\n]+\n\s+parent: vaultZone\n\s+name: '([^']+)'/) || [])[1] || "").replace("${vnetName}", "<vnet-name>");
    assert.ok(conn && link, "the endpoint's connection or the zone's link was not found");
    // Measured 2026-10-12 (U34): Azure refuses another connection on an existing endpoint and a
    // second link from the zone to the same virtual network, so Deploy cannot adopt step 1's.
    const u34 = /\[U34\]\(\.\.\/\.\.\/docs\/UNKNOWNS\.md\)/;
    const step1 = steps(sections(doc("PORTAL.md"))["Key Vault"] || "").map(flat).find((x) => x.includes("+ Create a private endpoint")) || "";
    assert.match(step1, /`privatelink\.vaultcore\.azure\.net` in the vault's resource group/, "step 1 does not put the zone where runner.bicep and Remove-Poc.ps1 look for it");
    for (const [what, re] of [["the runner", /\brunner\b/], ["its Deploy step", /`Deploy`/], ["U34", u34]]) assert.match(step1, re, `step 1 does not name ${what}`);
    const lead = (step1.match(/\*\*([^*]+)\*\*, below,/) || [])[1];
    assert.ok(lead, "step 1 does not point to the paragraph on the runner");
    const deployPara = paras.find((p) => p.startsWith(`**${lead}.**`)) || "";
    assert.ok(deployPara, `step 1 points to "${lead}", which is not a paragraph`);
    for (const [what, re] of [["Deploy", /`Deploy`/], ["U34", u34]]) assert.match(deployPara, re, `"${lead}" does not name ${what}`);
    for (const n of ["pe-<vault-name>", conn, link]) assert.ok(deployPara.includes(`\`${n}\``), `"${lead}" does not name ${n}`);
    assert.match(deployPara, /\(https:\/\/learn\.microsoft\.com\/rest\/api\/dns\/privatedns\/virtual-network-links\/delete\)/, "deleting step 1's zone link is not given");
    assert.match(deployPara, /\(https:\/\/learn\.microsoft\.com\/azure\/dns\/private-dns-overview\)/, "what the virtual network loses while the link is gone is not given");
  });

  test("the steps whose claims rest on one Learn page cite that page", () => {
    const sec = sections(doc("PORTAL.md"));
    const step = (section, marker) => steps(sec[section] || "").map(flat).find((x) => x.includes(marker)) || "";
    for (const [section, marker, pages] of [
      ["Key Vault", "+ Create a private endpoint", ["/azure/key-vault/general/private-link-service"]],
      ["Rotate a key", "Find the slot clients hold", ["/rest/api/keyvault/secrets/get-secret/get-secret"]],
      ["Remove", "The vault's private endpoint", ["/azure/private-link/private-endpoint-overview", "/azure/private-link/private-endpoint-dns-integration",
        "/rest/api/dns/privatedns/private-zones/delete", "/rest/api/dns/privatedns/virtual-network-links/delete"]],
    ]) {
      const s = step(section, marker);
      assert.ok(s, `${section}: no step with "${marker}"`);
      for (const p of pages) assert.ok(s.includes(`(https://learn.microsoft.com${p})`), `${section}, "${marker}": does not cite ${p}`);
    }
    assert.match(flat(step("Rotate a key", "Find the slot clients hold")), /\[U31\]/, "the portal view of a version's tags is not tied to U31");
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
    const assignments = runnerAssignments();
    assert.equal(assignments.length, 2, "the runner's role assignments were not found");
    const [roles, scopes] = [runner.Role, runner.Scope].map((c) => c.split(";").map((x) => x.trim()));
    assert.equal(roles.length, scopes.length, "the runner's roles and scopes do not pair up");
    assert.equal(roles.length, assignments.length, "a runner role the template does not assign");
    const SCOPE = { vault: /^Vault$/i, apim: /^instance$/i };
    for (const a of assignments) {
      const i = roles.indexOf(a.role);
      assert.ok(i >= 0, `the runner's ${a.role} is not given`);
      assert.match(scopes[i], SCOPE[a.scope] || /^$/, `the runner's ${a.role} is on ${a.scope}, the document says ${scopes[i]}`);
    }
  });

  test("the operator's custom role lists the subscription actions the scripts call", () => {
    const row = tableWith(doc("ARCHITECTURE.md"), "Identity", "Role", "Scope").find((r) => /custom role/.test(r.Role));
    assert.ok(row, "no operator row with a custom role");
    const listed = ((row.Role.match(/custom role with the subscription actions the scripts call \(([^)]*)\)/) || [])[1] || "").split(/,\s*/).filter(Boolean);
    const called = [...new Set([...subscriptionVerbs("PocKeys.ps1"), ...subscriptionVerbs("Remove-Poc.ps1")])];
    assert.deepEqual(called.filter((v) => !/^(read|create|update|delete|list keys|regenerate)$/.test(v)), [], "a call with no verb");
    assert.deepEqual([...listed].sort(), [...called].sort(), "the custom role's actions are not the scripts'");
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
