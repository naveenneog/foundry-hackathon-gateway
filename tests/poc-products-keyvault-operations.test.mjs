import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { poc, pwsh, q, runKeys, runScript } from "./poc-products-keyvault.harness.mjs";

/**
 * P38, the proof of concept on branch poc/apim-products-keyvault: the operator actions the setup
 * guide names (list, suspend, resume, grant, removal, the runner's key step), with Azure replaced
 * by stubs.
 */

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

  test("an expiry is stored on the key's subscription as a UTC date, with no vault call", () => {
    const cli = q(join(poc, "scripts", "Invoke-PocKey.ps1"));
    const r = runKeys({
      responses: [{ method: "PATCH", match: "/subscriptions/poc-alice\\?", body: {} }],
      call: `& ${cli} -Action SetExpiry -Name alice -ExpiresUtc 2027-01-31 -Subscription s -ResourceGroup rg-x -ApimName apim-x`,
    });
    assert.equal(r.failed, "", r.failed);
    assert.deepEqual(r.calls.map((c) => [c.method, c.ifMatch]), [["PATCH", "*"]]);
    assert.match(r.calls[0].body.properties.expirationDate, /^2027-01-31T00:00:00(\.0+)?Z$/);
    assert.match(r.own, /expires on 2027-01-31/);
  });

  test("listing, suspending and resuming need no vault; issuing and rotating say they do, before any call", () => {
    const cli = q(join(poc, "scripts", "Invoke-PocKey.ps1"));
    const target = "-Subscription s -ResourceGroup rg-x -ApimName apim-x";
    const list = runKeys({ responses: pages, call: `& ${cli} -Action List ${target}` });
    assert.equal(list.failed, "", list.failed);
    assert.match(list.own, /poc-alice/);
    const patch = [{ method: "PATCH", match: "/subscriptions/poc-alice\\?", body: {} }];
    for (const action of ["Suspend", "Resume"]) {
      const r = runKeys({ responses: patch, call: `& ${cli} -Action ${action} -Name alice ${target}` });
      assert.equal(r.failed, "", `${action}: ${r.failed}`);
      assert.deepEqual(r.calls.map((c) => [c.method, c.body.properties.state]), [["PATCH", action === "Suspend" ? "suspended" : "active"]]);
      assert.ok(r.calls.every((c) => !/vault\.azure\.net/.test(c.uri)), `${action} called the vault`);
    }
    for (const action of ["New", "Rotate"]) {
      const r = runKeys({ responses: [], call: `& ${cli} -Action ${action} -Name alice -Product poc-claude-pack ${target}` });
      assert.match(r.failed, /VaultName/, `${action} without a vault: ${r.failed}`);
      assert.equal(r.calls.length, 0);
    }
  });

  test("the runner's key step refuses names, products and dates that are not plain, before any Azure call", () => {
    const script = join(poc, "scripts", "Invoke-PocRunner.ps1");
    for (const [param, value] of [["KeyName", "alice;reboot"], ["KeyName", "Alice"], ["KeyProduct", "starter"], ["KeyProduct", "poc-x$(id)"],
      ["KeyExpiresOn", "2027-01-31'; reboot; '"], ["KeyExpiresOn", "tomorrow"]]) {
      const args = { Subscription: "s", ResourceGroup: "rg-x", ApimName: "apim-x", VaultName: "kv-x", KeyAction: "New", KeyName: "alice", KeyProduct: "poc-claude-pack", [param]: value };
      const r = spawnSync(pwsh, ["-NoProfile", "-NonInteractive", "-File", script, "-Step", "Key", ...Object.entries(args).flatMap(([k, v]) => [`-${k}`, v])], { encoding: "utf8" });
      assert.notEqual(r.status, 0, `${param}=${value} accepted`);
      assert.match(`${r.stdout}${r.stderr}`, new RegExp(param), `${param}=${value} not refused by validation`);
    }
  });

  // Run Command reports success whenever it ran the script, whatever the script's exit code.
  const runCommand = (stdout) => JSON.stringify({ value: [{ message: `Enable succeeded: \n[stdout]\n${stdout}\n\n[stderr]\n` }] });
  const runner = (stdout, step = "Fetch") => runScript({
    file: join(poc, "scripts", "Invoke-PocRunner.ps1"),
    args: `-Step ${step} -Subscription s -ResourceGroup rg-x -ApimName apim-x -VaultName kv-x`,
    az: [{ match: "^vm run-command invoke", out: runCommand(stdout), exit: 0 }],
  });

  test("a runner step fails when its script fails on the VM, and says so", () => {
    const ok = runner("PASS one\nPOC_EXIT 0");
    assert.equal(ok.failed, "", ok.failed);
    assert.match(ok.own, /PASS one/);
    assert.doesNotMatch(ok.own, /POC_EXIT/);
    const bad = runner("Invoke-PocKey.ps1: 404 Not Found\nPOC_EXIT 1", "Key");
    assert.match(bad.failed, /exit code 1/);
    assert.match(bad.own, /404 Not Found/, "the VM's output is not shown on failure");
    const none = runner("cut off before the end");
    assert.match(none.failed, /no exit status/);
    assert.equal(ok.scripts.length, 1);
    assert.match(ok.scripts[0], /\necho "POC_EXIT \$\?"\n?$/, "the script sent does not report its exit status last");
  });
});

describe("P38 removal", { skip: !pwsh && "PowerShell 7 not found" }, () => {
  const file = join(poc, "scripts", "Remove-Poc.ps1");
  const vaultId = "/subscriptions/00000000-0000-0000-0000-000000000123/resourceGroups/rg-x/providers/Microsoft.KeyVault/vaults/kv-x";
  const apimId = "/subscriptions/00000000-0000-0000-0000-000000000123/resourceGroups/rg-x/providers/Microsoft.ApiManagement/service/apim-x";
  const subs = (scope) => `/subscriptions/00000000-0000-0000-0000-000000000123/resourceGroups/rg-x/providers/Microsoft.ApiManagement/service/apim-x${scope}`;
  const apim = [
    { method: "DELETE", match: "/products/poc-(claude|deepseek|tiny)-pack\\?deleteSubscriptions=true&api-version", body: {} },
    { method: "DELETE", match: "/apis/poc-(claude|openai|probe)\\?api-version", body: {} },
    {
      method: "GET", match: "/service/apim-x/subscriptions\\?api-version",
      body: { value: [
        { name: "poc-client-claude-1", properties: { scope: subs("/apis/poc-claude") } },
        { name: "master", properties: { scope: subs("/") } },
        { name: "team-x", properties: { scope: subs("/products/starter") } },
      ], nextLink: "https://management.azure.com/next-page-2" },
    },
    { method: "GET", match: "next-page-2", body: { value: [{ name: "poc-old", properties: { scope: subs("/products/poc-claude-pack") } }] } },
    { method: "DELETE", match: "/subscriptions/poc-(client-claude-1|old)\\?api-version", body: {} },
  ];
  // Role assignments are listed at the resource group: without a filter the list holds those
  // below it too, measured 2026-10-12 (a grant on one secret was in it).
  const RG_ROLES = "/resourceGroups/rg-x/providers/Microsoft\\.Authorization/roleAssignments\\?api-version=2022-04-01$";
  const noGrants = { method: "GET", match: RG_ROLES, body: { value: [] } };
  const vault = [{ match: "^keyvault show --name kv-x", out: vaultId, exit: 0 }];
  const run = ({ az = [], responses = [noGrants, ...apim], runner = false, vaultAz = vault } = {}) => runScript({
    file, responses, az: [...az, ...vaultAz],
    args: `-Subscription s -ResourceGroup rg-x -ApimName apim-x -VaultName kv-x -PurgeVault${runner ? " -Runner" : ""}`,
  });

  test("removal deletes the packs with their keys, the routes, leftover poc- keys and the vault, and nothing else", () => {
    const r = run();
    assert.equal(r.exit, 0, r.own);
    const deleted = r.http.filter((h) => h.startsWith("DELETE")).map((h) => h.replace(/^DELETE https:\/\/management\.azure\.com\/subscriptions\/[^/]+\/resourceGroups\/rg-x\/providers\/Microsoft\.ApiManagement\/service\/apim-x/, "").replace(/[?&]api-version=[^&]*/, ""));
    assert.deepEqual(deleted.sort(), [
      "/apis/poc-claude", "/apis/poc-openai", "/apis/poc-probe",
      "/products/poc-claude-pack?deleteSubscriptions=true", "/products/poc-deepseek-pack?deleteSubscriptions=true", "/products/poc-tiny-pack?deleteSubscriptions=true",
      "/subscriptions/poc-client-claude-1", "/subscriptions/poc-old",
    ].sort());
    assert.ok(r.az.some((a) => a.startsWith(`role assignment delete --scope ${vaultId} --role Key Vault Secrets Officer`)), r.az.join("\n"));
    assert.ok(r.az.some((a) => a.startsWith("keyvault delete --name kv-x")));
    assert.ok(r.az.some((a) => a.startsWith("keyvault purge --name kv-x")));
    assert.ok(!r.az.some((a) => /^(vm|network) /.test(a)), "touched the runner without -Runner");
    assert.doesNotMatch(r.own, /Left behind/);
  });

  test("a step that fails is reported, the others still run, and the exit code is 1", () => {
    const r = run({ az: [{ match: "^keyvault delete", out: "ERROR: (Forbidden) The client does not have authorization", exit: 1 }] });
    assert.equal(r.exit, 1, r.own);
    assert.match(r.own, /Could not remove vault kv-x[^\n]*Forbidden/);
    assert.match(r.own, /Left behind: vault kv-x/);
    assert.ok(r.az.some((a) => a.startsWith("keyvault purge --name kv-x")), "the steps after the failure did not run");
  });

  test("something already gone is not a failure", () => {
    const gone = [noGrants, { method: "DELETE", match: "/products/poc-tiny-pack\\?", error: '{"error":{"code":"ResourceNotFound","message":"not found"}}' }, ...apim];
    const r = run({ responses: gone });
    assert.equal(r.exit, 0, r.own);
    assert.match(r.own, /product poc-tiny-pack and its keys was not there/);
  });

  test("with -Runner it removes the runner's roles and resources, and keeps a DNS zone that still has other records", () => {
    const runnerAz = [
      { match: "^vm show .*identity\\.principalId", out: "pid-1", exit: 0 },
      { match: "^apim show", out: apimId, exit: 0 },
    ];
    const kept = run({ runner: true, az: [...runnerAz, { match: "^network private-dns record-set a list", out: "other-app", exit: 0 }] });
    assert.equal(kept.exit, 0, kept.own);
    for (const want of [
      `role assignment delete --assignee-object-id pid-1 --scope ${apimId}`,
      `role assignment delete --assignee-object-id pid-1 --scope ${vaultId}`,
      "vm delete -g rg-x -n vm-poc-runner", "network vnet subnet delete -g rg-x --vnet-name vnet-hackgw-pe -n snet-poc-runner",
      "network nat gateway delete -g rg-x -n nat-poc-runner", "network public-ip delete -g rg-x -n pip-poc-runner-nat",
      "network nsg delete -g rg-x -n nsg-poc-runner", "network private-endpoint delete -g rg-x -n pe-kv-x",
    ]) assert.ok(kept.az.some((a) => a.startsWith(want)), `missing: ${want}\n${kept.az.join("\n")}`);
    assert.ok(!kept.az.some((a) => /private-dns (zone|link vnet) delete/.test(a)), "deleted a zone that still had records");
    assert.match(kept.own, /Kept the privatelink\.vaultcore\.azure\.net zone/);
    const empty = run({ runner: true, az: [...runnerAz, { match: "^network private-dns record-set a list", out: "", exit: 0 }] });
    assert.ok(empty.az.some((a) => a.startsWith("network private-dns link vnet delete -g rg-x -z privatelink.vaultcore.azure.net")));
    assert.ok(empty.az.some((a) => a.startsWith("network private-dns zone delete -g rg-x -n privatelink.vaultcore.azure.net")));
  });

  // Role assignments the resource group's list holds: two on this vault's key secrets, and three
  // that removal leaves alone.
  const ra = (name, scope) => ({ id: `${scope}/providers/Microsoft.Authorization/roleAssignments/${name}`, properties: { scope, principalId: `p-${name}` } });
  const listed = { method: "GET", match: RG_ROLES, body: { value: [
    ra("g1", `${vaultId}/secrets/poc-key-alice`),
    ra("g2", `${vaultId}/secrets/poc-key-bob`),
    ra("other-vault", vaultId.replace("kv-x", "kv-other") + "/secrets/poc-key-alice"),
    ra("other-secret", `${vaultId}/secrets/not-a-key`),
    ra("vault-officer", vaultId),
  ] } };
  const deleteGrant = (name, error) => ({ method: "DELETE", match: `/roleAssignments/${name}\\?api-version=2022-04-01$`, ...(error ? { error } : { body: {} }) });

  test("role assignments on this vault's key secrets are removed before the vault, and other roles stay", () => {
    const r = run({ responses: [listed, deleteGrant("g1"), deleteGrant("g2"), ...apim] });
    assert.equal(r.exit, 0, r.own);
    const deleted = r.http.filter((h) => /^DELETE .*\/roleAssignments\//.test(h)).map((h) => h.split("?")[0].split("/").pop());
    assert.deepEqual(deleted.sort(), ["g1", "g2"]);
    const lastGrant = Math.max(...r.order.map((o, i) => (/^HTTP DELETE .*\/roleAssignments\//.test(o) ? i : -1)));
    const vaultGone = r.order.findIndex((o) => o.startsWith("AZ keyvault delete"));
    assert.ok(vaultGone > lastGrant, "the vault was deleted before the access to its secrets");
    assert.ok(!r.az.some((a) => a.startsWith("role assignment list")), "listed role assignments across the subscription");
  });

  test("when a role assignment on a key secret cannot be listed or removed, the vault is kept and the run fails", () => {
    const denied = '{"error":{"code":"AuthorizationFailed","message":"no roleAssignments/read"}}';
    for (const [why, responses] of [
      ["the list failed", [{ method: "GET", match: RG_ROLES, error: denied }, ...apim]],
      ["a delete failed", [listed, deleteGrant("g1"), deleteGrant("g2", denied), ...apim]],
    ]) {
      const r = run({ responses });
      assert.equal(r.exit, 1, `${why}: ${r.own}`);
      assert.ok(!r.az.some((a) => /^keyvault (delete|purge)/.test(a)), `${why}: the vault was deleted`);
      assert.match(r.own, /Kept vault kv-x/, why);
      assert.match(r.own, /Left behind: /, why);
    }
  });

  test("a run after the vault is gone still removes the role assignments on its key secrets", () => {
    const r = run({ responses: [listed, deleteGrant("g1"), deleteGrant("g2"), ...apim], vaultAz: [{ match: "^keyvault show --name kv-x", out: "", exit: 3 }] });
    assert.equal(r.exit, 0, r.own);
    assert.deepEqual(r.http.filter((h) => /^DELETE .*\/roleAssignments\//.test(h)).map((h) => h.split("?")[0].split("/").pop()).sort(), ["g1", "g2"]);
    assert.match(r.own, /Vault kv-x was not there/);
  });
});

describe("P38 handover", { skip: !pwsh && "PowerShell 7 not found" }, () => {
  const OID = "11111111-2222-3333-4444-555555555555";
  const SECRET_SCOPE = "https://management\\.azure\\.com/subscriptions/sub-123/resourceGroups/rg-x/providers/Microsoft\\.KeyVault/vaults/kv-x/secrets/poc-key-alice/providers/Microsoft\\.Authorization/roleAssignments/";
  const grant = (extra = "") => `Grant-PocKeyAccess -Context $ctx -Name 'alice' -ObjectId '${OID}'${extra}`;

  test("a grant is Key Vault Secrets User on the one secret, by object id, with no vault or directory call", () => {
    const r = runKeys({ responses: [{ method: "PUT", match: SECRET_SCOPE, body: {} }], call: grant() });
    assert.equal(r.failed, "", r.failed);
    assert.equal(r.calls.length, 1);
    const [c] = r.calls;
    assert.match(c.uri, new RegExp(`^${SECRET_SCOPE}[0-9a-f-]{36}\\?api-version=2022-04-01$`));
    assert.deepEqual(c.body.properties, {
      roleDefinitionId: "/subscriptions/sub-123/providers/Microsoft.Authorization/roleDefinitions/4633458b-17de-408a-b874-0445c86b69e6",
      principalId: OID,
      principalType: "User",
    });
    const sp = runKeys({ responses: [{ method: "PUT", match: SECRET_SCOPE, body: {} }], call: grant(" -PrincipalType ServicePrincipal") });
    assert.equal(sp.calls[0].body.properties.principalType, "ServicePrincipal");
  });

  test("granting an identity that already has the role is not an error; any other refusal is", () => {
    const exists = '{"error":{"code":"RoleAssignmentExists","message":"The role assignment already exists."}}';
    const again = runKeys({ responses: [{ method: "PUT", match: SECRET_SCOPE, error: exists }], call: grant() });
    assert.equal(again.failed, "", again.failed);
    assert.match(again.own, /already/);
    const denied = '{"error":{"code":"AuthorizationFailed","message":"no roleAssignments/write"}}';
    const no = runKeys({ responses: [{ method: "PUT", match: SECRET_SCOPE, error: denied }], call: grant() });
    assert.match(no.failed, /AuthorizationFailed/);
  });

  test("an object id, principal type or name that is not plain is refused before any call", () => {
    for (const call of [
      "Grant-PocKeyAccess -Context $ctx -Name 'alice' -ObjectId ''",
      "Grant-PocKeyAccess -Context $ctx -Name 'alice' -ObjectId 'alice@example.com'",
      `Grant-PocKeyAccess -Context $ctx -Name 'alice' -ObjectId '${OID}/../x'`,
      `Grant-PocKeyAccess -Context $ctx -Name '' -ObjectId '${OID}'`,
      `Grant-PocKeyAccess -Context $ctx -Name 'alice/../../x' -ObjectId '${OID}'`,
      `Grant-PocKeyAccess -Context $ctx -Name 'alice' -ObjectId '${OID}' -PrincipalType Everyone`,
    ]) {
      const r = runKeys({ responses: [], call });
      assert.notEqual(r.failed, "", `accepted: ${call}`);
      assert.equal(r.calls.length, 0, `called Azure for: ${call}`);
    }
  });

  test("the command line grants with -ObjectId, and needs -VaultName before any call", () => {
    const cli = q(join(poc, "scripts", "Invoke-PocKey.ps1"));
    const target = "-Subscription s -ResourceGroup rg-x -ApimName apim-x";
    const ok = runKeys({ responses: [{ method: "PUT", match: SECRET_SCOPE, body: {} }], call: `& ${cli} -Action Grant -Name alice -ObjectId ${OID} ${target} -VaultName kv-x` });
    assert.equal(ok.failed, "", ok.failed);
    assert.equal(ok.calls.length, 1);
    const none = runKeys({ responses: [], call: `& ${cli} -Action Grant -Name alice -ObjectId ${OID} ${target}` });
    assert.match(none.failed, /VaultName/);
    assert.equal(none.calls.length, 0);
  });

  // Role assignments that apply to the secret: the grant to remove, and three that stay.
  const secretPath = "/subscriptions/sub-123/resourceGroups/rg-x/providers/Microsoft.KeyVault/vaults/kv-x/secrets/poc-key-alice";
  const role = (id) => `/subscriptions/sub-123/providers/Microsoft.Authorization/roleDefinitions/${id}`;
  const assignment = (name, scope, principalId, roleId) => ({
    id: `${scope}/providers/Microsoft.Authorization/roleAssignments/${name}`,
    properties: { scope, principalId, roleDefinitionId: role(roleId) },
  });
  const applying = {
    method: "GET", match: `^${SECRET_SCOPE.slice(0, -1)}\\?api-version=2022-04-01$`,
    body: { value: [
      assignment("grant-a", secretPath, OID, "4633458b-17de-408a-b874-0445c86b69e6"),
      assignment("other-b", secretPath, "99999999-2222-3333-4444-555555555555", "4633458b-17de-408a-b874-0445c86b69e6"),
      assignment("above-c", "/subscriptions/sub-123", OID, "acdd72a7-3385-48ef-bd42-f606fba81ae7"),
      assignment("officer-d", secretPath, OID, "b86a8fe4-44ce-4948-aee5-eccb2c155cd7"),
      // The same identity and role on the whole vault: not Grant's, so it stays.
      assignment("vault-e", secretPath.replace(/\/secrets\/.*$/, ""), OID, "4633458b-17de-408a-b874-0445c86b69e6"),
    ] },
  };

  test("a revoke removes that identity's Key Vault Secrets User role on that secret, and nothing else", () => {
    const r = runKeys({ responses: [applying, { method: "DELETE", match: "/roleAssignments/grant-a\\?api-version=2022-04-01$", body: {} }],
      call: `Revoke-PocKeyAccess -Context $ctx -Name 'alice' -ObjectId '${OID}'` });
    assert.equal(r.failed, "", r.failed);
    assert.deepEqual(r.calls.map((c) => c.method), ["GET", "DELETE"]);
    assert.match(r.calls[1].uri, new RegExp(`^https://management\\.azure\\.com${secretPath.replace(/\./g, "\\.")}/providers/Microsoft\\.Authorization/roleAssignments/grant-a\\?`));
    assert.match(r.own, /key itself is unchanged/);
  });

  test("revoking an identity that has no such role changes nothing and is not an error; bad input is refused first", () => {
    const r = runKeys({ responses: [applying], call: "Revoke-PocKeyAccess -Context $ctx -Name 'alice' -ObjectId '99999999-0000-0000-0000-000000000000'" });
    assert.equal(r.failed, "", r.failed);
    assert.deepEqual(r.calls.map((c) => c.method), ["GET"]);
    assert.match(r.own, /had no read access/);
    for (const call of [`Revoke-PocKeyAccess -Context $ctx -Name 'alice' -ObjectId ''`, `Revoke-PocKeyAccess -Context $ctx -Name '../x' -ObjectId '${OID}'`]) {
      const bad = runKeys({ responses: [applying], call });
      assert.notEqual(bad.failed, "", `accepted: ${call}`);
      assert.equal(bad.calls.length, 0, `called Azure for: ${call}`);
    }
  });

  test("the command line revokes with -ObjectId, and needs -VaultName before any call", () => {
    const cli = q(join(poc, "scripts", "Invoke-PocKey.ps1"));
    const target = "-Subscription s -ResourceGroup rg-x -ApimName apim-x";
    const ok = runKeys({ responses: [applying, { method: "DELETE", match: "/roleAssignments/grant-a\\?", body: {} }], call: `& ${cli} -Action Revoke -Name alice -ObjectId ${OID} ${target} -VaultName kv-x` });
    assert.equal(ok.failed, "", ok.failed);
    assert.deepEqual(ok.calls.map((c) => c.method), ["GET", "DELETE"]);
    const none = runKeys({ responses: [], call: `& ${cli} -Action Revoke -Name alice -ObjectId ${OID} ${target}` });
    assert.match(none.failed, /VaultName/);
    assert.equal(none.calls.length, 0);
  });
});
