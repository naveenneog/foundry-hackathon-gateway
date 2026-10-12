import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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

  test("the vault holding every key is private unless a deployment asks otherwise", () => {
    // A redeploy must not reopen a vault that something outside this template closed.
    const b = bicep();
    assert.doesNotMatch(b, /publicNetworkAccess: 'Enabled'/);
    assert.match(b, /param vaultPublicNetworkAccess string = 'Disabled'/);
    assert.match(b, /defaultAction: 'Deny'/);
  });
});

describe("P37 runner", () => {
  // The vault in the test subscription has public network access turned off by a control
  // outside this project, so the key scripts run inside the virtual network.
  const bicep = () => read("infra", "runner.bicep");

  test("the runner has no inbound path from the internet: no public IP on its NIC and no NSG allow rules", () => {
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
const runKeys = ({ responses, call, tokenLifetime = 3600 }) => {
  const script = `
$ErrorActionPreference = 'Stop'
. ${q(join(poc, "scripts", "PocKeys.ps1"))}
. ${q(join(poc, "scripts", "PocMeasure.ps1"))}
$global:TokenFetches = 0
function az {
    $line = @($args) -join ' '; $global:LASTEXITCODE = 0
    if ($line -like 'account show*') { return 'sub-123' }
    if ($line -like 'account get-access-token*') {
        $global:TokenFetches++
        return (@{ accessToken = 'TOKEN'; expires_on = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() + ${tokenLifetime} } | ConvertTo-Json -Compress)
    }
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
  test("a token is reused until five minutes before it expires, not for a fixed time", () => {
    // Azure CLI hands out cached tokens close to their expiry; a fixed 30-minute reuse ran past it.
    const call = "$null = Invoke-PocApim -Context $ctx -Method GET -Path '/products'; $null = Invoke-PocApim -Context $ctx -Method GET -Path '/products'; \"FETCHES $global:TokenFetches\"";
    const responses = [{ method: "GET", match: "/products", body: { value: [] } }];
    const near = runKeys({ responses, call, tokenLifetime: 120 });
    assert.equal(near.failed, "", near.failed);
    assert.match(near.own, /FETCHES 2/, "a token two minutes from expiry was reused");
    const far = runKeys({ responses, call, tokenLifetime: 3600 });
    assert.match(far.own, /FETCHES 1/, "a fresh token was fetched again");
  });

  test("a key record carries the secret version, which is not secret, for the helper's log", () => {
    const r = runKeys({
      responses: [{ method: "GET", match: `${KV}\\?`, body: { value: "KEY-P-1", id: "https://kv-x.vault.azure.net/secrets/poc-key-alice/0a1b2c3d", tags: { slot: "primary" } } }],
      call: "$k = Get-PocKeyRecord -Context $ctx -Name 'alice'; \"VERSION $($k.Version) SLOT $($k.Slot)\"",
    });
    assert.equal(r.failed, "", r.failed);
    assert.match(r.own, /VERSION 0a1b2c3d SLOT primary/);
  });
});

describe("P37 measurement", { skip: !pwsh && "PowerShell 7 not found" }, () => {
  test("a time is measured from the change, not from when polling starts", () => {
    const r = runKeys({ responses: [], call: "\"T $(Measure-PocUntil { $true } -Since ([datetime]::UtcNow.AddSeconds(-3)) -Consecutive 1 -IntervalMs 0)\"" });
    assert.equal(r.failed, "", r.failed);
    assert.ok(Number(r.own.match(/T ([\d.]+)/)[1]) >= 3, r.own);
  });

  test("one passing check followed by a failing one does not count; the time is the start of the run that holds", () => {
    const r = runKeys({
      responses: [],
      call: "$global:seq = [System.Collections.Generic.Queue[bool]]::new([bool[]]@($true, $false, $true, $true, $true)); $global:n = 0; $t = Measure-PocUntil { $global:n++; $global:seq.Dequeue() } -Consecutive 3 -IntervalMs 100; \"T $t N $global:n\"",
    });
    assert.equal(r.failed, "", r.failed);
    const [, t, n] = r.own.match(/T ([\d.-]+) N (\d+)/);
    assert.equal(Number(n), 5);
    assert.ok(Number(t) >= 0.1, `timed from the first, abandoned pass: ${t}`);
  });

  test("a condition that never holds returns -1", () => {
    const r = runKeys({ responses: [], call: "\"T $(Measure-PocUntil { $false } -TimeoutSec 1 -IntervalMs 100)\"" });
    assert.match(r.own, /T -1/);
  });

  test("a session counts as refreshed only if it read the old key first and the new key after the refusal", () => {
    // Log lines from Get-PocKey.ps1 -LogPath: "<UTC> <secret version>".
    const at = (s) => new Date(Date.UTC(2026, 9, 11, 12, 0, s)).toISOString();
    const check = (lines) => {
      const r = runKeys({
        responses: [],
        call: `$v = Test-PocSessionRefresh -Lines @(${lines.map(q).join(", ")}) -SessionStartUtc ([datetime]'${at(0)}').ToUniversalTime() -OldVersion 'v0' -NewVersion 'v2' -RefusedFromUtc ([datetime]'${at(20)}').ToUniversalTime(); "PASS $($v.Pass) $($v.Detail)"`,
      });
      assert.equal(r.failed, "", r.failed);
      return /PASS True/.test(r.own);
    };
    assert.equal(check([`${at(1)} v0`, `${at(30)} v2`]), true, "a real refresh was rejected");
    assert.equal(check([`${at(1)} v1`, `${at(30)} v2`]), false, "the session started on a key the rotations never refused");
    assert.equal(check([`${at(1)} v0`, `${at(10)} v2`]), false, "the new key was read before the old one was refused");
    assert.equal(check([`${at(1)} v0`]), false, "no second read");
  });

  test("the runner refuses names that would reach its root shell unquoted, before any Azure call", () => {
    const script = join(poc, "scripts", "Invoke-PocRunner.ps1");
    for (const [param, value] of [["ApimName", "apim;reboot"], ["VaultName", "kv$(id)"], ["ResourceGroup", "rg'x"]]) {
      const args = { Subscription: "s", ResourceGroup: "rg-x", ApimName: "apim-x", VaultName: "kv-x", [param]: value };
      const r = spawnSync(pwsh, ["-NoProfile", "-NonInteractive", "-File", script, "-Step", "Fetch", ...Object.entries(args).flatMap(([k, v]) => [`-${k}`, v])], { encoding: "utf8" });
      assert.notEqual(r.status, 0, `${param}=${value} accepted`);
      assert.match(`${r.stdout}${r.stderr}`, new RegExp(param), `${param}=${value} not refused by validation`);
    }
  });
});

describe("P38 operator actions", { skip: !pwsh && "PowerShell 7 not found" }, () => {
  const scope = (p) => `/subscriptions/s/resourceGroups/rg-x/providers/Microsoft.ApiManagement/service/apim-x${p}`;
  const pages = [
    {
      method: "GET",
      match: "/service/apim-x/subscriptions\\?api-version",
      body: {
        value: [
          { name: "poc-alice", properties: { scope: scope("/products/poc-claude-pack"), state: "active", expirationDate: "2026-11-10T00:00:00Z" } },
          { name: "master", properties: { scope: scope("/"), state: "active", expirationDate: null } },
          { name: "team-x", properties: { scope: scope("/products/starter"), state: "active", expirationDate: null } },
        ],
        nextLink: "https://management.azure.com/next-page-2",
      },
    },
    { method: "GET", match: "next-page-2", body: { value: [{ name: "poc-bob", properties: { scope: scope("/products/poc-deepseek-pack"), state: "suspended", expirationDate: null } }] } },
  ];

  test("the key list shows proof-of-concept keys with product, state and expiry, across pages, and fetches no key", () => {
    const r = runKeys({ responses: pages, call: "Get-PocKeyList -Context $ctx | ForEach-Object { \"ROW $($_.Name)|$($_.Product)|$($_.State)|$($_.Expires)\" }" });
    assert.equal(r.failed, "", r.failed);
    const rows = [...r.own.matchAll(/ROW (.*)/g)].map((m) => m[1].trim());
    assert.deepEqual(rows, ["poc-alice|poc-claude-pack|active|2026-11-10", "poc-bob|poc-deepseek-pack|suspended|"]);
    assert.ok(r.calls.every((c) => c.method === "GET" && !/listSecrets/.test(c.uri)), "the list fetched a key");
  });

  test("suspending and resuming one key changes only its state", () => {
    const r = runKeys({
      responses: [{ method: "PATCH", match: "/subscriptions/poc-alice\\?", body: {} }],
      call: "Set-PocKeyState -Context $ctx -Name 'alice' -State suspended; Set-PocKeyState -Context $ctx -Name 'alice' -State active",
    });
    assert.equal(r.failed, "", r.failed);
    assert.deepEqual(r.calls.map((c) => [c.method, c.body.properties, c.ifMatch]), [
      ["PATCH", { state: "suspended" }, "*"],
      ["PATCH", { state: "active" }, "*"],
    ]);
    const bad = runKeys({ responses: [], call: "Set-PocKeyState -Context $ctx -Name 'alice' -State deleted" });
    assert.notEqual(bad.failed, "", "an unknown state was accepted");
    assert.equal(bad.calls.length, 0);
  });

  test("listing, suspending and resuming need no vault; issuing and rotating say they do, before any call", () => {
    const cli = q(join(poc, "scripts", "Invoke-PocKey.ps1"));
    const target = "-Subscription s -ResourceGroup rg-x -ApimName apim-x";
    const list = runKeys({ responses: pages, call: `& ${cli} -Action List ${target}` });
    assert.equal(list.failed, "", list.failed);
    assert.match(list.own, /poc-alice/);
    for (const action of ["New", "Rotate"]) {
      const r = runKeys({ responses: [], call: `& ${cli} -Action ${action} -Name alice -Product poc-claude-pack ${target}` });
      assert.match(r.failed, /VaultName/, `${action} without a vault: ${r.failed}`);
      assert.equal(r.calls.length, 0);
    }
  });

  test("the runner's key step refuses names and products that are not plain ids, before any Azure call", () => {
    const script = join(poc, "scripts", "Invoke-PocRunner.ps1");
    for (const [param, value] of [["KeyName", "alice;reboot"], ["KeyName", "Alice"], ["KeyProduct", "starter"], ["KeyProduct", "poc-x$(id)"]]) {
      const args = { Subscription: "s", ResourceGroup: "rg-x", ApimName: "apim-x", VaultName: "kv-x", KeyAction: "New", KeyName: "alice", KeyProduct: "poc-claude-pack", [param]: value };
      const r = spawnSync(pwsh, ["-NoProfile", "-NonInteractive", "-File", script, "-Step", "Key", ...Object.entries(args).flatMap(([k, v]) => [`-${k}`, v])], { encoding: "utf8" });
      assert.notEqual(r.status, 0, `${param}=${value} accepted`);
      assert.match(`${r.stdout}${r.stderr}`, new RegExp(param), `${param}=${value} not refused by validation`);
    }
  });
});

describe("P38 client examples", () => {
  const dir = join(poc, "examples");
  const files = () => readdirSync(dir).filter((f) => !f.startsWith("."));
  const needsPwsh = { skip: !pwsh && "PowerShell 7 not found" };
  // -Plan prints every check from the loop that runs them, and stops before any Azure call or
  // installation; the tests run under a signed-out Azure CLI profile, so a call would fail.
  const plan = () => {
    const r = spawnSync(pwsh, ["-NoProfile", "-NonInteractive", "-File", join(poc, "scripts", "Test-PocClients.ps1"),
      "-Subscription", "s", "-ResourceGroup", "rg-x", "-ApimName", "apim-x", "-Plan"], { encoding: "utf8" });
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    const checks = [...r.stdout.matchAll(/^PLAN (\{.*\})\s*$/gm)].map((m) => JSON.parse(m[1]));
    return { checks, workDir: (r.stdout.match(/^WORKDIR (.+?)\s*$/m) || [])[1] };
  };
  const decide = (rows) => {
    const script = `. ${q(join(poc, "scripts", "PocMeasure.ps1"))}\n` + rows.map((x) =>
      `Test-PocClientResult -ExitCode ${x.exit} -Output ${q(x.output)} -Expect ${q(x.expect)}${x.refusal ? ` -Refusal ${q(x.refusal)}` : ""}`).join("\n");
    const r = spawnSync(pwsh, ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim().split(/\r?\n/).map((l) => l.trim() === "True");
  };
  const refused401 = "Failed to authenticate. API Error: 401 Access denied due to invalid subscription key. Make sure to provide a valid key for an active subscription.";

  test("every example, and the Claude Code settings example, is a check Test-PocClients.ps1 runs", needsPwsh, () => {
    const { checks } = plan();
    const expected = [...files().map((f) => `examples/${f}`), "claude-code/settings.example.json"].sort();
    assert.ok(expected.length >= 8, `expected the client examples, found ${expected.length}`);
    assert.deepEqual([...new Set(checks.map((c) => c.example).filter(Boolean))].sort(), expected);
    assert.ok(checks.some((c) => c.pack === "wrong" && c.refusal), "no control with a wrong key");
  });

  test("a check passes only on an answer, and a control only on the gateway's refusal of its key", needsPwsh, () => {
    const { checks } = plan();
    for (const c of checks.filter((x) => !x.refusal)) {
      assert.deepEqual(decide([
        { exit: 0, output: "None", expect: c.expect },
        { exit: 0, output: "null", expect: c.expect },
        { exit: 0, output: "", expect: c.expect },
      ]), [false, false, false], `${c.name}: an empty answer passes`);
    }
    const control = checks.find((x) => x.refusal);
    assert.deepEqual(decide([
      { exit: 1, output: refused401, expect: control.expect, refusal: control.refusal },
      { exit: 1, output: "API Error: 429 Too many requests", expect: control.expect, refusal: control.refusal },
      { exit: 1, output: "getaddrinfo ENOTFOUND apim-x.azure-api.net", expect: control.expect, refusal: control.refusal },
      { exit: 0, output: "OK", expect: control.expect, refusal: control.refusal },
    ]), [true, false, false, false]);
    assert.deepEqual(decide([
      { exit: 0, output: "OK", expect: "\\bOK\\b" },
      { exit: 1, output: "OK", expect: "\\bOK\\b" },
    ]), [true, false]);
  });

  test("the work folder is the user's own by default, not a shared temporary folder", needsPwsh, () => {
    const { workDir } = plan();
    const base = spawnSync(pwsh, ["-NoProfile", "-Command", "[Environment]::GetFolderPath('LocalApplicationData')"], { encoding: "utf8" }).stdout.trim();
    assert.ok(base, "no per-user data folder on this machine");
    assert.equal(workDir, join(base, "poc-clients"));
  });

  test("every environment variable a check sets or clears is saved first and restored at the end", () => {
    const code = (text) => text.replace(/<#[\s\S]*?#>/g, "").split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join("\n");
    const harness = code(read("scripts", "Test-PocClients.ps1"));
    const dotSourced = files().filter((f) => f.endsWith(".ps1")).map((f) => code(readFileSync(join(dir, f), "utf8")));
    const touched = (harness.match(/^\$touched = (.+)$/m) || [])[1];
    assert.ok(touched, "no $touched list");
    const listed = [...touched.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
    const used = new Set([harness, ...dotSourced].flatMap((t) => [...t.matchAll(/\benv:([A-Z_]+)\b/g)].map((m) => m[1])));
    assert.deepEqual([...used].filter((v) => !listed.includes(v)), [], "set or cleared without being saved");
    assert.match(harness, /foreach \(\$v in \$touched\) \{ \$saved\[\$v\] = \[Environment\]::GetEnvironmentVariable\(\$v\) \}\s*\ntry \{/);
    assert.match(harness, /\} finally \{[\s\S]*foreach \(\$v in \$touched\) \{ \[Environment\]::SetEnvironmentVariable\(\$v, \$saved\[\$v\]\) \}/);
    for (const v of ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "ANTHROPIC_AUTH_TOKEN"]) {
      assert.ok(listed.includes(v), `${v} outranks the key under test and is not cleared`);
    }
  });

  test("the guide's curl lines send what the harness sends, from the same folder", () => {
    const parts = (line) => ({
      path: (line.match(/\/poc\/[^"'\s]+/) || [])[0],
      headers: [...line.matchAll(/-H\s+["']([^:"']+):/g)].map((m) => m[1].toLowerCase()).sort(),
      data: (line.match(/-d\s+["']?@([^"'\s]+)/) || [])[1],
    });
    const shown = read("SETUP.md").split(/\r?\n/).filter((l) => /^curl /.test(l)).map(parts);
    const run = read("scripts", "Test-PocClients.ps1").split(/\r?\n/).filter((l) => /& \$curl /.test(l)).map(parts);
    assert.ok(shown.length >= 3, `expected the probe and one curl line per route in the guide, found ${shown.length}`);
    assert.deepEqual(shown.sort((a, b) => a.path.localeCompare(b.path)), run.sort((a, b) => a.path.localeCompare(b.path)));
    for (const s of shown.filter((x) => x.data)) assert.ok(existsSync(join(poc, s.data)), `${s.data} does not exist relative to poc/products-keyvault/`);
    assert.match(read("scripts", "Test-PocClients.ps1"), /Push-Location \$poc\s*\r?\n\s*try \{\s*\r?\n\s*foreach \(\$c in \$checks\) \{/, "the checks do not run from poc/products-keyvault/");
  });

  test("no example holds a key: each reads it from POC_KEY", () => {
    for (const f of files()) {
      const text = readFileSync(join(dir, f), "utf8");
      assert.doesNotMatch(text, /\b[0-9a-f]{32}\b/, `${f} holds something shaped like a subscription key`);
      if (/\.(py|mjs|ps1)$/.test(f)) assert.match(text, /POC_KEY/, `${f} does not read POC_KEY`);
    }
  });

  test("the JSON examples parse, and opencode sends the key in the header each route reads", () => {
    for (const f of files().filter((x) => x.endsWith(".json"))) JSON.parse(readFileSync(join(dir, f), "utf8"));
    const oc = JSON.parse(readFileSync(join(dir, "opencode.json"), "utf8")).provider;
    const openai = Object.values(oc).find((p) => p.npm === "@ai-sdk/openai-compatible");
    const claude = Object.values(oc).find((p) => p.npm === "@ai-sdk/anthropic");
    assert.equal(openai.options.headers["api-key"], "{env:POC_KEY}");
    assert.match(openai.options.baseURL, /\/poc\/v1$/);
    assert.equal(claude.options.apiKey, "{env:POC_KEY}");
    assert.match(claude.options.baseURL, /\/poc\/claude\/v1$/);
  });

  test("both Claude Code examples strip pre-release anthropic-beta values", () => {
    // Foundry refuses some of them with a 400 (UNKNOWNS U17, update of 2026-10-12).
    const settings = JSON.parse(read("claude-code", "settings.example.json"));
    assert.equal(settings.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS, "1");
    assert.match(read("examples", "claude-code-env.ps1"), /^\$env:CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1'$/m);
  });
});

describe("P38 setup guide", () => {
  const guide = () => read("SETUP.md").replace(/\r\n/g, "\n");
  const validSet = (script, param) => {
    const m = read("scripts", script).match(new RegExp(`ValidateSet\\(([^)]*)\\)\\]\\[string\\]\\$${param}\\b`));
    assert.ok(m, `${script} has no ValidateSet for -${param}`);
    return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  };

  test("the guide exists and the proof of concept's README links it", () => {
    assert.ok(existsSync(join(poc, "SETUP.md")), "SETUP.md is missing");
    assert.match(read("README.md"), /\]\(SETUP\.md\)/);
  });

  test("the guide covers setup, every key action, every client, errors and removal", () => {
    const have = guide().split("\n").filter((l) => /^#{2,3} /.test(l)).map((l) => l.replace(/^#+ /, "").trim());
    const want = ["Requirements", "Set up", "Issue a key", "Hand a key over", "Rotate a key", "Expire a key",
      "Suspend and resume a key", "List keys", "Monitor", "Connect a client", "Claude Code", "Anthropic SDK",
      "OpenAI SDK", "opencode", "curl", "Errors", "Remove", "Sources"];
    assert.deepEqual(want.filter((h) => !have.includes(h)), []);
  });

  test("each client example appears in the guide exactly as Test-PocClients.ps1 runs it", () => {
    const shown = [...guide().matchAll(/<!-- file: (\S+) -->\n```[a-z]*\n([\s\S]*?)\n```/g)];
    const expected = readdirSync(join(poc, "examples")).filter((f) => !f.startsWith(".")).map((f) => `examples/${f}`);
    expected.push("claude-code/settings.example.json");
    assert.deepEqual(shown.map((m) => m[1]).sort(), expected.sort());
    for (const [, file, body] of shown) {
      const actual = read(...file.split("/")).replace(/\r\n/g, "\n").replace(/\n$/, "");
      assert.equal(body, actual, `the guide's copy of ${file} differs from the file`);
    }
  });

  test("every key action and runner step the guide uses exists, and every key action is shown", () => {
    const text = guide();
    const actions = [...text.matchAll(/Invoke-PocKey\.ps1\b[^\n]*?-Action (\w+)/g)].map((m) => m[1]);
    const onRunner = [...text.matchAll(/-KeyAction (\w+)/g)].map((m) => m[1]);
    const steps = [...text.matchAll(/Invoke-PocRunner\.ps1\b[^\n]*?-Step (\w+)/g)].map((m) => m[1]);
    const valid = validSet("Invoke-PocKey.ps1", "Action");
    assert.deepEqual([...actions, ...onRunner].filter((a) => !valid.includes(a)), []);
    assert.deepEqual(valid.filter((a) => !actions.includes(a)), [], "key actions the guide does not show");
    assert.deepEqual(steps.filter((s) => !validSet("Invoke-PocRunner.ps1", "Step").includes(s)), []);
    assert.ok(steps.includes("Key") && onRunner.length > 0, "the guide does not show key actions on the runner");
  });

  test("every relative link in the guide resolves to a file", () => {
    const links = [...guide().matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1])
      .filter((l) => !/^(https?:|#|mailto:)/.test(l)).map((l) => l.split("#")[0]);
    assert.ok(links.length >= 5, `expected links to the scripts and examples, found ${links.length}`);
    for (const l of links) assert.ok(existsSync(join(poc, l)), `${l} does not exist`);
  });

  test("the guide holds no key and names no real instance", () => {
    const text = guide();
    assert.doesNotMatch(text, /\b[0-9a-f]{32}\b/i, "something shaped like a subscription key");
    assert.doesNotMatch(text, /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i, "a GUID");
    for (const m of text.matchAll(/https:\/\/([^/\s)`"']+)\.azure-api\.net/g)) {
      assert.match(m[1], /^<[^>]+>$/, `${m[0]} is not a placeholder`);
    }
  });
});