import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * P37, the proof of concept on branch poc/apim-products-keyvault: API Management products for
 * long-lived keys, with the keys held in Key Vault. These tests pin what the live run relies on:
 * the policies, the template, and the key scripts driven with Azure replaced by stubs. The live
 * measurements are in poc/products-keyvault/README.md.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const poc = join(root, "poc", "products-keyvault");
const read = (...p) => readFileSync(join(poc, ...p), "utf8");
const inboundOf = (xml) =>
  xml.slice(xml.indexOf("<inbound>"), xml.indexOf("</inbound>")).replace(/<!--[\s\S]*?-->/g, "");

describe("P37 policies", () => {
  test("a product's budget is counted per subscription, by the month, and reported", () => {
    const xml = read("infra", "product-policy.xml");
    const limits = [...xml.matchAll(/<llm-token-limit\b[\s\S]*?\/>/g)].map((m) => m[0]);
    const perKey = limits.find((l) => l.includes('counter-key="@(context.Subscription.Id)"'));
    assert.ok(perKey, "no llm-token-limit keyed on context.Subscription.Id");
    assert.match(perKey, /token-quota="__KEY_TOKENS__"/);
    assert.match(perKey, /token-quota-period="Monthly"/);
    assert.match(perKey, /remaining-quota-tokens-header-name="x-budget-remaining"/);

    const pool = limits.find((l) => l.includes('counter-key="@("pool-" + context.Product.Id)"'));
    assert.ok(pool, "no product-wide pool keyed on context.Product.Id");
    assert.match(pool, /token-quota="__POOL_TOKENS__"/);
    assert.match(pool, /token-quota-period="Monthly"/);
  });

  test("a model outside the product's pack is refused before any tokens are counted", () => {
    const xml = read("infra", "product-policy.xml");
    const refusal = xml.indexOf("model_not_allowed");
    const firstLimit = xml.indexOf("<llm-token-limit");
    assert.ok(refusal > 0, "no model_not_allowed refusal");
    assert.ok(firstLimit > refusal, "the token limits run before the model check");
    assert.match(xml, /__MODELS__/, "the pack's model list is not a template parameter");
  });

  for (const route of ["claude", "openai"]) {
    test(`the ${route} route runs product policies first, then refuses a key that has no product`, () => {
      // An all-access, all-APIs or API-scoped key skips every product policy, budgets included.
      const inbound = inboundOf(read("infra", `api-${route}-policy.xml`));
      assert.match(inbound, /^<inbound>\s*<base \/>/, "inbound does not start with <base />");
      const guard = inbound.indexOf("context.Product == null");
      const identity = inbound.indexOf("<authentication-managed-identity");
      assert.ok(guard > 0, "no refusal for a key without a product");
      assert.ok(identity > guard, "the backend credential is fetched before the product check");
      assert.match(inbound, /<authentication-managed-identity[^>]*resource="https:\/\/ai\.azure\.com"/);
      for (const header of ["x-api-key", "api-key"]) {
        assert.ok(inbound.includes(`<set-header name="${header}" exists-action="delete" />`), `${header} reaches Foundry`);
      }
    });
  }

  test("the probe reports the policy context without a backend call and without any key", () => {
    const xml = read("infra", "api-probe-policy.xml");
    assert.match(inboundOf(xml), /<return-response>/);
    assert.match(xml, /context\.Subscription\.EndDate/);
    assert.match(xml, /context\.Product/);
    assert.doesNotMatch(xml, /Subscription\.(Key|PrimaryKey|SecondaryKey)\b/, "the probe can echo a key");
  });
});

describe("P37 template", () => {
  const bicep = () => read("infra", "poc.bicep");

  test("the API Management instance is referenced, never created or reconfigured", () => {
    const b = bicep();
    assert.match(b, /resource apim 'Microsoft\.ApiManagement\/service@[^']+' existing = \{/);
    assert.doesNotMatch(b, /'Microsoft\.ApiManagement\/service@[^']+' = /);
  });

  test("every API and product it creates is named poc-", () => {
    const ids = [...bicep().matchAll(/\bid: '([^']+)'/g)].map((m) => m[1]);
    assert.ok(ids.length >= 6, `expected the routes and products, found ${ids.length} ids`);
    assert.deepEqual(ids.filter((id) => !id.startsWith("poc-")), []);
  });

  test("each route requires a subscription key, in the header its client sends", () => {
    const b = bicep();
    assert.match(b, /subscriptionRequired: true/);
    assert.doesNotMatch(b, /subscriptionRequired: false/);
    assert.match(b, /id: 'poc-claude'[^}]*keyHeader: 'x-api-key'/);
    assert.match(b, /id: 'poc-openai'[^}]*keyHeader: 'api-key'/);
  });

  test("the vault is authorised by Azure RBAC, not access policies", () => {
    const b = bicep();
    assert.match(b, /enableRbacAuthorization: true/);
    assert.doesNotMatch(b, /accessPolicies: \[\s*\{/);
  });
});

describe("P37 runner", () => {
  // The vault in the test subscription has public network access turned off by a control
  // outside this project, so the key scripts run inside the virtual network.
  const bicep = () => read("infra", "runner.bicep");

  test("the runner has no inbound path: no public IP on its NIC and no NSG allow rules", () => {
    const b = bicep();
    const nic = b.slice(b.indexOf("Microsoft.Network/networkInterfaces@"), b.indexOf("Microsoft.Compute/virtualMachines@"));
    assert.ok(nic.length > 0, "no network interface found");
    assert.doesNotMatch(nic, /publicIPAddress/);
    assert.match(b, /'Microsoft\.Network\/networkSecurityGroups@[^']+' = \{[^]*?securityRules: \[\]/);
    const publicIps = [...b.matchAll(/'Microsoft\.Network\/publicIPAddresses@/g)].length;
    assert.equal(publicIps, 1, "the only public IP should be the NAT gateway's");
    assert.match(b, /publicIpAddresses: \[\s*\{\s*id: natIp\.id/);
  });

  test("the vault is reached through a private endpoint and its privatelink DNS zone", () => {
    const b = bicep();
    assert.match(b, /groupIds: \[\s*'vault'\s*\]/);
    assert.match(b, /name: 'privatelink\.vaultcore\.azure\.net'/);
    assert.match(b, /virtualNetworkLinks@[^']+' = \{[^]*?virtualNetwork: \{\s*id: vnet\.id/);
  });

  test("the runner's identity is granted roles on the vault and the instance only", () => {
    const b = bicep();
    const scopes = [...b.matchAll(/'Microsoft\.Authorization\/roleAssignments@[^']+' = \{[^]*?scope: (\w+)/g)].map((m) => m[1]);
    assert.deepEqual(scopes.sort(), ["apim", "vault"]);
  });
});

const pwsh = (() => {
  for (const exe of ["pwsh", "powershell"]) {
    const r = spawnSync(exe, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], { encoding: "utf8" });
    if (r.status === 0 && Number(String(r.stdout).trim()) >= 7) return exe;
  }
  return null;
})();
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

/**
 * Run PocKeys.ps1 functions with `az` and Invoke-RestMethod stubbed. `responses` are matched in
 * order by method and a regex on the URI. Returns the script's own output and, separately, every
 * HTTP call it made, so a test can assert both on what was sent and on what was printed.
 */
const runKeys = ({ responses, call }) => {
  const script = `
$ErrorActionPreference = 'Stop'
. ${q(join(poc, "scripts", "PocKeys.ps1"))}
function az {
    $line = @($args) -join ' '; $global:LASTEXITCODE = 0
    if ($line -like 'account show*') { return 'sub-123' }
    if ($line -like 'account get-access-token*') { return 'TOKEN' }
    throw "unexpected az call: $line"
}
$global:Calls = [System.Collections.Generic.List[object]]::new()
$global:Responses = @(${q(JSON.stringify(responses))} | ConvertFrom-Json)
function Invoke-RestMethod {
    param($Method, $Uri, $Headers, $Body, $ContentType)
    $global:Calls.Add([pscustomobject]@{ method = "$Method"; uri = "$Uri"; body = $Body; auth = $Headers.Authorization; ifMatch = $Headers['If-Match'] })
    foreach ($r in $global:Responses) {
        if ("$Method" -eq $r.method -and "$Uri" -match $r.match) { return $r.body }
    }
    throw "unexpected call: $Method $Uri"
}
$failed = $null
try {
    $ctx = New-PocContext -Subscription 'sub-name' -ResourceGroup 'rg-x' -ApimName 'apim-x' -VaultName 'kv-x'
    ${call}
} catch { $failed = $_.Exception.Message }
"=== CALLS"
foreach ($c in $global:Calls) { $c | ConvertTo-Json -Compress -Depth 8 }
"=== FAILED $failed"
`;
  const r = spawnSync(pwsh, ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" });
  const [own = "", rest = ""] = String(r.stdout).split("=== CALLS");
  const [callText = "", failed = ""] = rest.split("=== FAILED");
  const calls = callText.split(/\r?\n/).filter((l) => l.trim().startsWith("{")).map((l) => JSON.parse(l));
  for (const c of calls) if (typeof c.body === "string" && c.body.trim().startsWith("{")) c.body = JSON.parse(c.body);
  return { ...r, own, calls, failed: failed.trim() };
};

const KV = "https://kv-x\\.vault\\.azure\\.net/secrets/poc-key-alice";
const SUB = "/service/apim-x/subscriptions/poc-alice";

describe("P37 key scripts", { skip: !pwsh && "PowerShell 7 not found" }, () => {
  test("a new key is created on its product and stored in the vault as the primary slot, unprinted", () => {
    const r = runKeys({
      responses: [
        { method: "PUT", match: `${SUB}\\?`, body: { name: "poc-alice", properties: { state: "active" } } },
        { method: "POST", match: `${SUB}/listSecrets`, body: { primaryKey: "KEY-P-1", secondaryKey: "KEY-S-1" } },
        { method: "PUT", match: `${KV}\\?`, body: { id: "https://kv-x.vault.azure.net/secrets/poc-key-alice/v1" } },
      ],
      call: "New-PocKey -Context $ctx -Name 'alice' -Product 'poc-claude-pack' | Out-Null",
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.failed, "", r.failed);
    const sub = r.calls.find((c) => c.method === "PUT" && c.uri.includes("/subscriptions/poc-alice?"));
    assert.equal(sub.body.properties.scope, "/products/poc-claude-pack");
    assert.equal(sub.body.properties.state, "active");
    const kv = r.calls.find((c) => c.method === "PUT" && c.uri.includes("vault.azure.net"));
    assert.equal(kv.body.value, "KEY-P-1");
    assert.deepEqual(
      { slot: kv.body.tags.slot, subscription: kv.body.tags.subscription, product: kv.body.tags.product },
      { slot: "primary", subscription: "poc-alice", product: "poc-claude-pack" }
    );
    assert.ok(r.calls.every((c) => c.auth === "Bearer TOKEN"), "a call went out without a token");
    assert.doesNotMatch(r.own, /KEY-[PS]-\d/, "a key was printed");
  });

  for (const [held, regenerate, other, fresh] of [
    ["primary", "regenerateSecondaryKey", "secondary", { primaryKey: "KEY-P-1", secondaryKey: "KEY-S-2" }],
    ["secondary", "regeneratePrimaryKey", "primary", { primaryKey: "KEY-P-3", secondaryKey: "KEY-S-2" }],
  ]) {
    test(`rotation from the ${held} slot regenerates only the ${other} key, which clients do not hold`, () => {
      const r = runKeys({
        responses: [
          { method: "GET", match: `${KV}\\?`, body: { value: "KEY-OLD", tags: { slot: held, subscription: "poc-alice", product: "poc-claude-pack" } } },
          { method: "POST", match: `${SUB}/${regenerate}`, body: null },
          { method: "POST", match: `${SUB}/listSecrets`, body: fresh },
          { method: "PUT", match: `${KV}\\?`, body: { id: "v2" } },
        ],
        call: "Invoke-PocKeyRotation -Context $ctx -Name 'alice' | Out-Null",
      });
      assert.equal(r.failed, "", r.failed);
      const regenerated = r.calls.filter((c) => /regenerate/.test(c.uri)).map((c) => c.uri.split("/").pop().split("?")[0]);
      assert.deepEqual(regenerated, [regenerate]);
      const kv = r.calls.find((c) => c.method === "PUT");
      assert.equal(kv.body.value, fresh[`${other}Key`]);
      assert.equal(kv.body.tags.slot, other);
      assert.equal(kv.body.tags.subscription, "poc-alice");
      assert.doesNotMatch(r.own, /KEY-/, "a key was printed");
    });
  }

  test("rotation stops, regenerating nothing, when the vault does not say which key clients hold", () => {
    // Guessing wrong would regenerate the key every client is using, cutting them all off.
    const r = runKeys({
      responses: [{ method: "GET", match: `${KV}\\?`, body: { value: "KEY-OLD", tags: { subscription: "poc-alice" } } }],
      call: "Invoke-PocKeyRotation -Context $ctx -Name 'alice' | Out-Null",
    });
    assert.match(r.failed, /slot/i);
    assert.equal(r.calls.filter((c) => c.method !== "GET").length, 0);
  });

  test("a name that is not a plain id is refused before any call", () => {
    for (const name of ["../x", "Alice", "a b", ""]) {
      const r = runKeys({ responses: [], call: `New-PocKey -Context $ctx -Name ${q(name)} -Product 'poc-claude-pack' | Out-Null` });
      assert.notEqual(r.failed, "", `accepted ${JSON.stringify(name)}`);
      assert.equal(r.calls.length, 0, `called Azure for ${JSON.stringify(name)}`);
    }
  });

  test("a path with its own query keeps it, and the api-version is added once", () => {
    const r = runKeys({
      responses: [{ method: "DELETE", match: "/products/poc-tiny-pack", body: null }],
      call: "$null = Invoke-PocApim -Context $ctx -Method DELETE -Path '/products/poc-tiny-pack?deleteSubscriptions=true' -IfMatch",
    });
    assert.equal(r.failed, "", r.failed);
    assert.match(r.calls[0].uri, /\/products\/poc-tiny-pack\?deleteSubscriptions=true&api-version=2024-05-01$/);
  });

  test("only active proof-of-concept keys past their expiry are suspended, across every page", () => {
    const scope = (p) => `/subscriptions/s/resourceGroups/rg-x/providers/Microsoft.ApiManagement/service/apim-x${p}`;
    const r = runKeys({
      responses: [
        {
          method: "GET",
          match: "/service/apim-x/subscriptions\\?api-version",
          body: {
            value: [
              { name: "poc-old", properties: { scope: scope("/products/poc-claude-pack"), state: "active", expirationDate: "2026-01-01T00:00:00Z" } },
              { name: "poc-new", properties: { scope: scope("/products/poc-claude-pack"), state: "active", expirationDate: "2099-01-01T00:00:00Z" } },
              { name: "poc-none", properties: { scope: scope("/products/poc-claude-pack"), state: "active", expirationDate: null } },
            ],
            nextLink: "https://management.azure.com/next-page-2",
          },
        },
        {
          method: "GET",
          match: "next-page-2",
          body: {
            value: [
              { name: "master", properties: { scope: scope("/"), state: "active", expirationDate: "2020-01-01T00:00:00Z" } },
              { name: "team-x", properties: { scope: scope("/products/starter"), state: "active", expirationDate: "2020-01-01T00:00:00Z" } },
              { name: "poc-gone", properties: { scope: scope("/products/poc-claude-pack"), state: "suspended", expirationDate: "2020-01-01T00:00:00Z" } },
            ],
          },
        },
        { method: "PATCH", match: "/subscriptions/poc-old\\?", body: {} },
      ],
      call: "Suspend-ExpiredPocKeys -Context $ctx -Now ([datetime]::new(2026, 10, 11, 0, 0, 0, [DateTimeKind]::Utc)) | Out-Null",
    });
    assert.equal(r.failed, "", r.failed);
    const patches = r.calls.filter((c) => c.method === "PATCH");
    assert.deepEqual(patches.map((c) => c.uri.split("/subscriptions/").pop().split("?")[0]), ["poc-old"]);
    assert.equal(patches[0].body.properties.state, "suspended");
    assert.equal(patches[0].ifMatch, "*");
  });
});
