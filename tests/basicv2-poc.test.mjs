// P63: liteAPIM on an existing Basic v2 API Management with no VNet, and a Foundry in another
// resource group (ADR-0021, UNKNOWNS U55-U60).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const read = (p) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const q = (s) => `'${String(s).replaceAll("'", "''")}'`;
const run = (s) => spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", s], { encoding: "utf8" });
const pwsh = run("$PSVersionTable.PSVersion.Major").status === 0;
const extract = (path) => `
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(${q(resolve(path))}, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
$ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false) |
  ForEach-Object { . ([scriptblock]::Create($_.Extent.Text)) }
`;
const sub = "11111111-1111-1111-1111-111111111111";
const resultOf = (r) => {
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const line = r.stdout.split(/\r?\n/).find((l) => l.startsWith("RESULT:"));
  assert.ok(line, r.stdout + r.stderr);
  return JSON.parse(line.slice(7));
};

// --- Product routes and vault: Foundry in another resource group -------------------------------

const pocBicep = () => read("poc/products-keyvault/infra/poc.bicep");

const pocFoundryContract = (b) => {
  assert.match(b, /^param foundryResourceGroup string = resourceGroup\(\)\.name$/m);
  assert.match(b, /^resource foundry 'Microsoft\.CognitiveServices\/accounts@[^']+' existing = \{\n\s+name: foundryAccountName\n\s+scope: resourceGroup\(foundryResourceGroup\)\n\}/m);
};

test("P63 poc.bicep reads the Foundry from its own resource group, defaulting to the instance's", () => {
  pocFoundryContract(pocBicep());
});

test("P63 poc.bicep contract detector rejects a Foundry pinned to the instance's resource group", () => {
  const b = pocBicep();
  assert.throws(() => pocFoundryContract(b.replace("  scope: resourceGroup(foundryResourceGroup)\n", "")));
  assert.throws(() => pocFoundryContract(b.replace("param foundryResourceGroup string = resourceGroup().name", "param foundryResourceGroup string")));
});

const fakeToken = () => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ oid: "33333333-3333-3333-3333-333333333333", idtyp: "user" })}.sig`;
};
const deployPoc = (extra) => run(`
$global:calls = @()
function az {
  $global:calls += ,@($args)
  $global:LASTEXITCODE = 0
  if ($args[0] -eq 'account') { return '${fakeToken()}' }
  if ($args[0] -eq 'deployment') {
    return '{"vaultName":{"value":"kv-poc-x"},"claudeBaseUrl":{"value":"u"},"openaiBaseUrl":{"value":"u"},"probeUrl":{"value":"u"}}'
  }
  throw 'Unexpected az command'
}
try { & ${q(resolve("poc/products-keyvault/scripts/Deploy-Poc.ps1"))} -Subscription '${sub}' -ResourceGroup 'rg-Gateway' -ApimName apim-x -FoundryAccountName ai-x ${extra} 6>$null | Out-Null; $outcome = 'ok' }
catch { $outcome = $_.Exception.Message }
$deploy = @($global:calls | Where-Object { $_[0] -eq 'deployment' })
$parameters = if ($deploy.Count) { $a = $deploy[0]; $i = [array]::IndexOf($a, '--parameters'); @($a[($i + 1)..($a.Count - 1)] | Where-Object { $_ -match '=' }) } else { @() }
Write-Output ('RESULT:' + (@{ outcome = $outcome; deployments = $deploy.Count; parameters = @($parameters) } | ConvertTo-Json -Depth 5 -Compress))
`);

test("P63 Deploy-Poc.ps1 passes the Foundry's resource group only when it differs from the instance's", { skip: !pwsh && "PowerShell 7 not found" }, () => {
  const same = ["apimName=apim-x", "foundryAccountName=ai-x", "operatorObjectId=33333333-3333-3333-3333-333333333333", "operatorPrincipalType=User"];
  let r = resultOf(deployPoc(""));
  assert.equal(r.outcome, "ok");
  assert.deepEqual(r.parameters, same, "same-group parameters are unchanged");
  r = resultOf(deployPoc("-FoundryResourceGroup RG-GATEWAY"));
  assert.deepEqual(r.parameters, same, "the instance's own group, in any case, is not passed");
  r = resultOf(deployPoc("-FoundryResourceGroup rg-contosohub"));
  assert.deepEqual(r.parameters, [...same, "foundryResourceGroup=rg-contosohub"]);
  r = resultOf(deployPoc("-FoundryResourceGroup 'rg&calc'"));
  assert.notEqual(r.outcome, "ok");
  assert.equal(r.deployments, 0, "an unsafe resource group is refused before any deployment");
});

