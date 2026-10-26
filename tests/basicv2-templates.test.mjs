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

// --- liteAPIM templates: Foundry elsewhere, names, gateway VNet --------------------------------

const consoleBicep = () => read("infra/console.bicep");
const appsvcBicep = () => read("infra/console-appservice.bicep");
const readerModulePath = "infra/console-foundry-reader.bicep";

const consoleFoundryContract = (b, principal) => {
  assert.match(b, /^param foundryResourceGroup string = resourceGroup\(\)\.name$/m);
  assert.match(b, /^var foundryInThisGroup = foundryResourceGroup =~ resourceGroup\(\)\.name$/m);
  assert.match(b, /^resource foundry 'Microsoft\.CognitiveServices\/accounts@[^']+' existing = \{\n\s+name: foundryAccountName\n\s+scope: resourceGroup\(foundryResourceGroup\)\n\}/m);
  assert.match(b, /^resource foundryInGroup 'Microsoft\.CognitiveServices\/accounts@[^']+' existing = if \(foundryInThisGroup\) \{\n\s+name: foundryAccountName\n\}/m);
  assert.match(b, new RegExp(`'Microsoft\\.Authorization/roleAssignments@[^']+' = if \\(foundryInThisGroup\\) \\{\\n\\s+scope: foundryInGroup\\n\\s+name: guid\\(foundry\\.id, ${principal}\\.id, roles\\.reader\\)`));
  assert.match(b, new RegExp(`module \\w+ 'console-foundry-reader\\.bicep' = if \\(!foundryInThisGroup\\) \\{\\n\\s+name: [^\\n]+\\n\\s+scope: resourceGroup\\(foundryResourceGroup\\)\\n\\s+params: \\{\\n\\s+foundryAccountName: foundryAccountName\\n\\s+principalId: ${principal}\\.identity\\.principalId\\n\\s+principalResourceId: ${principal}\\.id\\n`));
};

test("P63 liteAPIM templates keep the same-group Reader assignment and use a module for a Foundry elsewhere", () => {
  consoleFoundryContract(consoleBicep(), "app");
  consoleFoundryContract(appsvcBicep(), "web");
  assert.ok(existsSync(readerModulePath), "reader module exists");
  const m = read(readerModulePath);
  assert.match(m, /^resource foundry 'Microsoft\.CognitiveServices\/accounts@[^']+' existing = \{\n\s+name: foundryAccountName\n\}/m);
  assert.match(m, /scope: foundry\n\s+name: guid\(foundry\.id, principalResourceId, reader\)/);
  assert.match(m, /^var reader = 'acdd72a7-3385-48ef-bd42-f606fba81ae7'$/m);
  assert.match(m, /principalType: 'ServicePrincipal'/);
  assert.equal((m.match(/roleAssignments@/g) ?? []).length, 1, "one assignment, Reader only");
});

test("P63 Foundry contract detector rejects a lost same-group assignment, a renamed assignment or an unscoped module", () => {
  const b = consoleBicep();
  for (const bad of [
    b.replace("= if (foundryInThisGroup) {\n  scope: foundryInGroup", "= {\n  scope: foundryInGroup"),
    b.replace("name: guid(foundry.id, app.id, roles.reader)", "name: guid(foundry.id, app.name, roles.reader)"),
    b.replace(/(module \w+ 'console-foundry-reader\.bicep' = if \(!foundryInThisGroup\) \{\n\s+name: [^\n]+\n)\s+scope: resourceGroup\(foundryResourceGroup\)\n/, "$1"),
  ]) assert.throws(() => consoleFoundryContract(bad, "app"));
});

test("P63 Container Apps environment and job names fit 32 characters; shorter names are unchanged", () => {
  const b = consoleBicep();
  assert.match(b, /name: take\('cae-\$\{appName\}', 32\)/);
  assert.match(b, /name: take\('job-\$\{appName\}', 32\)/);
});

test("P63 the gateway VNet name can be empty for a liteAPIM-only network, and defaults to the VNet", () => {
  const b = consoleBicep();
  assert.match(b, /^param gatewayVnetName string = vnetName$/m);
  assert.match(b, /\{ name: 'GATEWAY_VNET_NAME', value: gatewayVnetName \}/);
});

const az = spawnSync("az", ["bicep", "version"], { encoding: "utf8", shell: process.platform === "win32" });
test("P63 the changed and new templates compile", { skip: az.status !== 0 && "Azure CLI Bicep not found" }, () => {
  for (const f of ["infra/console.bicep", "infra/console-appservice.bicep", "infra/console-network.bicep",
    readerModulePath, "poc/products-keyvault/infra/poc.bicep"]) {
    const r = spawnSync("az", ["bicep", "build", "--file", resolve(f), "--stdout"], { encoding: "utf8", shell: process.platform === "win32", maxBuffer: 1 << 26 });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /\bError BCP/, f);
  }
});

// --- liteAPIM-only network (-CreateNetwork) ----------------------------------------------------

const networkPath = "infra/console-network.bicep";
const networkContract = (n) => {
  assert.match(n, /^param addressPrefix string = '10\.65\.0\.0\/24'$/m);
  assert.match(n, /^resource vnet 'Microsoft\.Network\/virtualNetworks@[^']+' = \{/m);
  assert.match(n, /name: 'snet-console'\n\s+properties: \{\n\s+addressPrefix: cidrSubnet\(addressPrefix, 27, 0\)\n\s+delegations: \[\n\s+\{ name: 'containerapps', properties: \{ serviceName: 'Microsoft\.App\/environments' \} \}/);
  assert.match(n, /name: 'snet-pe'\n\s+properties: \{\n\s+addressPrefix: cidrSubnet\(addressPrefix, 28, 2\)/);
  assert.match(n, /^resource vault 'Microsoft\.KeyVault\/vaults@[^']+' existing = \{/m);
  assert.match(n, /privateLinkServiceId: vault\.id\n\s+groupIds: \[ 'vault' \]/);
  assert.match(n, /^resource newZone 'Microsoft\.Network\/privateDnsZones@[^']+' = if \(createVaultZone\) \{\n\s+name: 'privatelink\.vaultcore\.azure\.net'/m);
  assert.match(n, /registrationEnabled: false/);
  assert.match(n, /privateDnsZoneId: zone\.id/);
  assert.doesNotMatch(n, /Microsoft\.Compute|natGateways|publicIPAddresses|publicNetworkAccess|networkAcls|Microsoft\.KeyVault\/vaults@[^']+' = /);
};

test("P63 network template creates only the VNet, two subnets, the vault endpoint and its DNS", () => {
  assert.ok(existsSync(networkPath));
  networkContract(read(networkPath));
});

test("P63 network contract detector rejects a VM, a NAT, a public vault, a missing delegation or a forced zone", () => {
  const n = read(networkPath);
  for (const bad of [
    `${n}\nresource vm 'Microsoft.Compute/virtualMachines@2024-07-01' = {}`,
    `${n}\nresource nat 'Microsoft.Network/natGateways@2024-05-01' = {}`,
    `${n}\n// publicNetworkAccess: 'Enabled'`,
    n.replace("serviceName: 'Microsoft.App/environments'", "serviceName: 'Microsoft.Web/serverFarms'"),
    n.replace("= if (createVaultZone) {", "= {"),
    n.replace("'10.65.0.0/24'", "'10.61.0.0/24'"),
  ]) assert.throws(() => networkContract(bad));
});

