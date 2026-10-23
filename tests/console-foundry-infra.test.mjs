import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const read = (p) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const deploy = read("scripts/Deploy-Console.ps1");
const connectPath = "scripts/Connect-Foundry.ps1";
const sub = "11111111-1111-1111-1111-111111111111";
const principal = "22222222-2222-2222-2222-222222222222";
const account = `/subscriptions/${sub}/resourceGroups/rg-models/providers/Microsoft.CognitiveServices/accounts/models`;
const q = (s) => `'${s.replaceAll("'", "''")}'`;
const run = (s) => spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", s], { encoding: "utf8" });
const extract = (path) => `
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(${q(resolve(path))}, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
$ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false) |
  ForEach-Object { . ([scriptblock]::Create($_.Extent.Text)) }
`;

test("P56 infrastructure: parser accepts both operator scripts", () => {
  assert.ok(existsSync(connectPath), "inference permission helper exists");
  const r = run(extract("scripts/Deploy-Console.ps1") + extract(connectPath));
  assert.equal(r.status, 0, r.stderr);
});

test("P56 discovery grants only two metadata actions to the deployed dashboard", () => {
  assert.match(deploy, /Microsoft\.CognitiveServices\/accounts\/read/);
  assert.match(deploy, /Microsoft\.CognitiveServices\/accounts\/deployments\/read/);
  assert.match(deploy, /DataActions\s*=\s*@\(\)/);
  assert.match(deploy, /AssignableScopes\s*=\s*@\(\$scope\)/);
  assert.match(deploy, /Grant-FoundryDiscovery\s+\$deploy\.principalId\.value/);
  assert.doesNotMatch(deploy, /Actions\s*=\s*@\([^)]*roleAssignments\/write|role assignment create[^\n]*--role\s+(Reader|Contributor)/i);
  assert.match(deploy, /role definition list/);
  assert.match(deploy, /role definition create[\s\S]*--role-definition/);
  assert.match(deploy, /discovery permission ready/i);
});

test("P56 build context contains the complete shared routing policies on both hosting paths", () => {
  for (const p of ["infra/policy.xml", "infra/policy-claude.xml",
    "poc/products-keyvault/infra/api-openai-policy.xml", "poc/products-keyvault/infra/api-claude-policy.xml"]) {
    assert.ok(deploy.includes(p), p);
  }
  const docker = read("infra/console.Dockerfile");
  assert.match(docker, /^COPY infra \.\/infra$/m);
  assert.match(docker, /^COPY poc\/products-keyvault\/infra \.\/poc\/products-keyvault\/infra$/m);
});

test("P56 shared deployment context copies exactly the routing templates without unrelated infra", () => {
  const r = run(`
${extract("scripts/Deploy-Console.ps1")}
$ErrorActionPreference = 'Stop'
$root = ${q(resolve("."))}
$suffix = [guid]::NewGuid().ToString()
$dir = $null
try {
  $dir = New-AppContext 'p56-test-context'
  $actual = @((Get-ChildItem (Join-Path $dir 'infra') -File).Name | Sort-Object)
  if (Compare-Object $actual @('policy-claude.xml', 'policy.xml')) { throw 'Unexpected gateway templates' }
  $actual = @((Get-ChildItem (Join-Path $dir 'poc/products-keyvault/infra') -File).Name | Sort-Object)
  if (Compare-Object $actual @('api-claude-policy.xml', 'api-openai-policy.xml', 'product-policy.xml')) { throw 'Unexpected product templates' }
  foreach ($path in 'infra/policy.xml', 'infra/policy-claude.xml', 'poc/products-keyvault/infra/api-openai-policy.xml',
    'poc/products-keyvault/infra/api-claude-policy.xml', 'poc/products-keyvault/infra/product-policy.xml') {
    if ((Get-FileHash (Join-Path $dir $path)).Hash -ne (Get-FileHash (Join-Path $root $path)).Hash) { throw 'Changed policy template' }
  }
} finally { if ($dir) { Remove-Item $dir -Recurse -Force } }
`);
  assert.equal(r.status, 0, r.stderr);
});

for (const path of ["scripts/Deploy-Console.ps1", connectPath]) {
  test(`P56 ${path}: unsafe CLI arguments fail before any az invocation`, () => {
    assert.ok(existsSync(path));
    for (const value of ["sub&(Write-Output INJECTION_MARKER)", "sub|whoami", "sub%PATH%", 'sub"bad', "sub`bad", "sub\nbad"]) {
      const params = path === connectPath
        ? `-Subscription ${q(value)} -ResourceGroup rg-apim -ApimName apim -FoundryAccountId ${q(account)}`
        : `-Subscription ${q(value)} -ResourceGroup rg-apim`;
      const r = run(`
function az { Write-Output 'AZ_CALLED'; throw 'UNEXPECTED_AZ' }
try { & ${q(resolve(path))} ${params}; throw 'ACCEPTED_INVALID' } catch { Write-Output $_.Exception.Message }
`);
      assert.equal(r.status, 0, r.stderr);
      assert.doesNotMatch(r.stdout, /AZ_CALLED|UNEXPECTED_AZ|ACCEPTED_INVALID|^INJECTION_MARKER$/m, value);
      assert.match(r.stdout, /unsafe|invalid|metacharacter/i);
    }
  });

  test(`P56 ${path}: command boundary rejects unsafe arguments from discovered metadata too`, () => {
    assert.ok(existsSync(path));
    const r = run(`
${extract(path)}
$ErrorActionPreference = 'Stop'
function az { throw 'UNEXPECTED_AZ' }
foreach ($value in 'safe&(Write-Output INJECTION_MARKER)', 'safe|whoami', 'safe%PATH%', 'safe"bad', 'safe^bad', "safe\`nbad") {
  try { Invoke-Az resource show --ids $value --subscription '${sub}'; throw 'ACCEPTED_INVALID' } catch {
    if ($_.Exception.Message -notmatch '^Unsafe Azure CLI argument') { throw }
  }
}
Write-Output 'BOUNDARY_SAFE'
`);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /BOUNDARY_SAFE/);
    assert.doesNotMatch(r.stdout, /^INJECTION_MARKER$/m);
  });
}

const connect = (changes = {}, options = {}) => {
  const params = { Subscription: sub, ResourceGroup: "rg-apim", ApimName: "apim", FoundryAccountId: account, ...changes };
  return run(`
$global:calls = @()
$global:grants = @()
function az {
  $global:calls += ,@($args)
  $global:LASTEXITCODE = 0
  if ($args[0] -eq 'account') { return '{"id":"${sub}"}' }
  if ($args[0] -eq 'resource') {
    return '${JSON.stringify({ id: account, kind: options.kind ?? "AIServices", properties: { endpoint: "https://models.cognitiveservices.azure.com/" } })}'
  }
  if ($args[0] -eq 'apim') { return '${JSON.stringify({ identity: { principalId: options.principal ?? principal } })}' }
  if ($args[0] -eq 'role' -and $args[1] -eq 'definition') {
    return '${JSON.stringify([{ name: options.badRole ? principal : options.kind === "OpenAI" ? "5e0bd9bd-7b93-4f28-af87-19fc36ad61bd" : "a97b65f3-24c7-4388-baec-2e87135dc908", roleType: "BuiltInRole" }])}'
  }
  if ($args[0] -eq 'role' -and $args[1] -eq 'assignment' -and $args[2] -eq 'list') {
    return '${JSON.stringify(options.existing ? [{ principalId: principal, scope: account,
      roleDefinitionId: `/subscriptions/${sub}/providers/Microsoft.Authorization/roleDefinitions/a97b65f3-24c7-4388-baec-2e87135dc908` }] : [])}'
  }
  if ($args[0] -eq 'role' -and $args[1] -eq 'assignment' -and $args[2] -eq 'create') {
    $global:grants += ,@($args)
    ${options.deny ? "$global:LASTEXITCODE = 1; return 'DENIED'" : "return '{}'"}
  } else { throw 'Unexpected az command' }
}
try {
  & ${q(resolve(connectPath))} ${Object.entries(params).map(([k, v]) => `-${k} ${q(v)}`).join(" ")}
  $outcome = 'ok'
} catch { $outcome = $_.Exception.Message }
Write-Output ('RESULT:' + (@{ outcome = $outcome; calls = @($global:calls); grants = @($global:grants) } | ConvertTo-Json -Depth 10 -Compress))
`);
};
const result = (r) => {
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.split(/\r?\n/).find((l) => l.startsWith("RESULT:")).slice(7));
};

test("P56 inference helper rejects malformed ARM ids before Azure, and subscription mismatches before grants", () => {
  assert.ok(existsSync(connectPath));
  for (const id of ["", "https://models.example", `${account}/deployments/model`, `${account}?foo`, account.replace("/accounts/", "/deployments/"), `${account}&(Write-Output INJECTION_MARKER)`]) {
    const r = result(connect({ FoundryAccountId: id }));
    assert.notEqual(r.outcome, "ok", id);
    assert.deepEqual(r.calls, [], id);
  }
  const wrong = result(connect({ FoundryAccountId: account.replace(sub, principal) }));
  assert.notEqual(wrong.outcome, "ok");
  assert.equal(wrong.calls.length, 1, "only subscription resolution permitted");
  assert.deepEqual(wrong.grants, []);
});

test("P56 inference helper grants the APIM identity only at the selected account, including OpenAI", () => {
  assert.ok(existsSync(connectPath));
  for (const kind of ["AIServices", "OpenAI"]) {
    const r = connect({}, { kind });
    const got = result(r);
    assert.equal(got.outcome, "ok");
    assert.equal(got.grants.length, 1);
    const args = got.grants[0];
    assert.equal(args[args.indexOf("--scope") + 1], account);
    assert.equal(args[args.indexOf("--assignee-object-id") + 1], principal);
    assert.equal(args[args.indexOf("--role") + 1], kind === "AIServices"
      ? "a97b65f3-24c7-4388-baec-2e87135dc908" : "5e0bd9bd-7b93-4f28-af87-19fc36ad61bd");
    for (const call of got.calls) assert.ok(call.includes("--subscription"), call.join(" "));
    assert.match(r.stdout, /private networking.*DNS/i);
    assert.match(r.stdout, /return.*UI.*Test/i);
    assert.doesNotMatch(r.stdout.split("RESULT:")[0], new RegExp(principal));
  }
});

test("P56 inference helper is idempotent, fails closed on invalid identities/kinds/roles and reports denied grants", () => {
  assert.ok(existsSync(connectPath));
  assert.deepEqual(result(connect({}, { existing: true })).grants, []);
  for (const opts of [{ principal: "" }, { principal: "bad&(Write-Output INJECTION_MARKER)" }, { kind: "Other" }, { badRole: true }]) {
    const r = result(connect({}, opts));
    assert.notEqual(r.outcome, "ok");
    assert.deepEqual(r.grants, []);
  }
  const denied = connect({}, { deny: true });
  assert.notEqual(result(denied).outcome, "ok");
  assert.doesNotMatch(denied.stdout.split("RESULT:")[0], /role grant configured/i);
});

test("P56 discovery custom role safely reuses only the exact definition, never overwrites a collision", () => {
  const r = run(`
${extract("scripts/Deploy-Console.ps1")}
$ErrorActionPreference = 'Stop'
$root = ${q(resolve("."))}
$script:Subscription = '${sub}'
$script:creates = 0; $script:assignments = 0; $script:mode = 'new'; $script:role = $null
$script:bodyPath = ''
function az {
  $global:LASTEXITCODE = 0
  if ($args[0] -eq 'role' -and $args[1] -eq 'definition' -and $args[2] -eq 'list') {
    if ($script:mode -eq 'new') { return '[]' }
    return (ConvertTo-Json -InputObject @($script:role) -Depth 10 -Compress)
  }
  if ($args[0] -eq 'role' -and $args[1] -eq 'definition' -and $args[2] -eq 'create') {
    $script:creates++
    $script:bodyPath = $args[$args.IndexOf('--role-definition') + 1].TrimStart('@')
    $body = Get-Content $script:bodyPath -Raw | ConvertFrom-Json
    $script:role = @{ name = '${principal}'; roleName = $body.Name; roleType = 'CustomRole'
      permissions = @(@{ actions = $body.Actions; notActions = $body.NotActions
        dataActions = $body.DataActions; notDataActions = $body.NotDataActions })
      assignableScopes = $body.AssignableScopes }
    return ($script:role | ConvertTo-Json -Depth 10 -Compress)
  }
  if ($args[0] -eq 'role' -and $args[1] -eq 'assignment' -and $args[2] -eq 'list') { return '[]' }
  if ($args[0] -eq 'role' -and $args[1] -eq 'assignment' -and $args[2] -eq 'create') {
    if ($script:mode -eq 'denied') { $global:LASTEXITCODE = 1; return 'denied' }
    $script:assignments++; return '{}'
  }
  throw 'Unexpected az command'
}
Grant-FoundryDiscovery '${principal}' '${sub}'
if (Test-Path $script:bodyPath) { throw 'JSON body not cleaned up' }
$script:mode = 'reuse'; Grant-FoundryDiscovery '${principal}' '${sub}'
if ($script:creates -ne 1 -or $script:assignments -ne 2) { throw 'Role reuse failed' }
$script:mode = 'denied'
try { Grant-FoundryDiscovery '${principal}' '${sub}'; throw 'ACCEPTED_DENIED' } catch {
  if ($_.Exception.Message -notmatch 'operator.*subscription|subscription.*operator') { throw }
}
$script:mode = 'reuse'
foreach ($mutation in 'data', 'actions', 'scopes', 'duplicate') {
  $saved = $script:role | ConvertTo-Json -Depth 10
  switch ($mutation) {
    'data' { $script:role.Permissions[0].DataActions = @('*') }
    'actions' { $script:role.Permissions[0].Actions += 'Microsoft.Authorization/roleAssignments/write' }
    'scopes' { $script:role.AssignableScopes += '/subscriptions/${principal}' }
    'duplicate' { $script:role.Permissions += $script:role.Permissions[0] }
  }
  try { Grant-FoundryDiscovery '${principal}' '${sub}'; throw 'ACCEPTED_COLLISION' } catch {
    if ($_.Exception.Message -notmatch 'existing|collision|match') { throw }
  }
  $script:role = $saved | ConvertFrom-Json
}
if ($script:assignments -ne 2) { throw 'Unsafe grant' }
foreach ($invalid in '', 'bad', '${principal}&(Write-Output INJECTION_MARKER)') {
  try { Grant-FoundryDiscovery $invalid '${sub}'; throw 'ACCEPTED_INVALID_PRINCIPAL' } catch {
    if ($_.Exception.Message -notmatch '^Invalid dashboard') { throw }
  }
  try { Grant-FoundryDiscovery '${principal}' $invalid; throw 'ACCEPTED_INVALID_SCOPE' } catch {
    if ($_.Exception.Message -notmatch '^Invalid dashboard') { throw }
  }
}
Write-Output 'SAFE_REUSE'
`);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /SAFE_REUSE/);
});
