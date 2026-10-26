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

// --- Deploy-Console.ps1 ------------------------------------------------------------------------

const deployPath = "scripts/Deploy-Console.ps1";
const deploy = () => read(deployPath);
const fns = () => extract(deployPath) + `\n$ErrorActionPreference = 'Stop'\n$script:Subscription = '${sub}'\n$script:subscriptionId = '${sub}'\n$script:ResourceGroup = 'rg-hackathon-gateway'\n`;
const outcome = (body) => `try { ${body}; $o = 'ok' } catch { $o = 'ERR ' + $_.Exception.Message }`;

test("P63 the new installer switches are declared and pass the Azure CLI argument check", () => {
  const d = deploy();
  for (const p of [/\[string\]\$FoundryResourceGroup = ''/, /\[string\]\$FoundryAccountName = ''/, /\[switch\]\$CreateNetwork/,
    /\[string\]\$NetworkPrefix = '10\.65\.0\.0\/24'/, /\[switch\]\$TakeOverRegistration/]) assert.match(d, p);
  assert.match(d, /Assert-SafeAzArguments \(@\(\$Subscription, \$ResourceGroup, \$AllowedIp, \$AppRegistrationName, \$SubnetPrefix, \$AppServiceSku, \$FoundryResourceGroup, \$FoundryAccountName, \$NetworkPrefix\) \+ \$Admins\)/);
});

test("P63 registration guard refuses another app's redirect URI unless taking over is explicit", { skip: !pwsh && "PowerShell 7 not found" }, () => {
  const other = "https://ca-console-rv6pom6njwpfm.greendune-95274158.eastus2.azurecontainerapps.io/.auth/login/aad/callback";
  const mine = "https://ca-console-hackgwfl4s7jvpxekno.x.eastus2.azurecontainerapps.io/.auth/login/aad/callback";
  const r = resultOf(run(`${fns()}
$res = [ordered]@{}
${outcome("Assert-RegistrationOwnership @() 'ca-console-hackgwfl4s7jvpxekno' 'reg' $false")}; $res.none = $o
${outcome(`Assert-RegistrationOwnership @('${mine}') 'ca-console-hackgwfl4s7jvpxekno' 'reg' $false`)}; $res.mine = $o
${outcome(`Assert-RegistrationOwnership @('${other}') 'ca-console-hackgwfl4s7jvpxekno' 'reg' $false`)}; $res.other = $o
${outcome(`Assert-RegistrationOwnership @('${mine}', '${other}') 'ca-console-hackgwfl4s7jvpxekno' 'reg' $false`)}; $res.both = $o
${outcome(`Assert-RegistrationOwnership @('${other}') 'ca-console-hackgwfl4s7jvpxekno' 'reg' $true 3>$null`)}; $res.takeover = $o
${outcome("Assert-RegistrationOwnership @('not a uri') 'ca-console-hackgwfl4s7jvpxekno' 'reg' $false")}; $res.bad = $o
${outcome(`Assert-RegistrationOwnership @('${mine.replace("ca-console-hackgwfl4s7jvpxekno", "ca-console-hackgwfl4s7jvpxekno2")}') 'ca-console-hackgwfl4s7jvpxekno' 'reg' $false`)}; $res.prefix = $o
Write-Output ('RESULT:' + ($res | ConvertTo-Json -Compress))`));
  assert.equal(r.none, "ok");
  assert.equal(r.mine, "ok");
  assert.match(r.other, /^ERR .*ca-console-rv6pom6njwpfm\..*-AppRegistrationName.*-TakeOverRegistration/);
  assert.match(r.both, /^ERR /);
  assert.equal(r.takeover, "ok");
  assert.match(r.bad, /^ERR /);
  assert.match(r.prefix, /^ERR /, "a host that only starts with the app name is another app");
});

test("P63 the registration guard runs before any Entra change and again right before the redirect URI is replaced", () => {
  const d = deploy();
  const guard = d.indexOf("Assert-RegistrationOwnership @($app.web.redirectUris)");
  assert.ok(guard > 0, "guard on the existing registration");
  for (const change of ["Invoke-Az ad sp create", "Invoke-Az ad sp update", "Grant-ConsoleRole $me.id", "Invoke-Az deployment group create"]) {
    assert.ok(d.indexOf(change) > guard, `guard before ${change}`);
  }
  const update = d.indexOf("Invoke-Az ad app update --id $app.appId --web-redirect-uris");
  const recheck = d.lastIndexOf("Assert-RegistrationOwnership", update);
  assert.ok(recheck > guard && recheck < update, "re-checked right before the update");
  assert.ok(!/Assert-RegistrationOwnership[^\n]*\n[^\n]*Invoke-Az deployment/.test(d.slice(recheck, update)), "nothing deploys between check and update");
});

test("P63 network choice: refuse with no VNet unless -CreateNetwork, reuse liteAPIM's own VNet, never add one beside a gateway VNet", { skip: !pwsh && "PowerShell 7 not found" }, () => {
  const r = resultOf(run(`${fns()}
$res = [ordered]@{}
$cases = [ordered]@{
  none = @(@(), $false); noneCreate = @(@(), $true); gateway = @(@('vnet-hackgw-pe'), $false); gatewayCreate = @(@('vnet-hackgw-pe'), $true)
  own = @(@('vnet-liteapim-sfx'), $false); ownCreate = @(@('vnet-liteapim-sfx'), $true)
}
foreach ($k in $cases.Keys) {
  try { $n = Resolve-ConsoleNetwork $cases[$k][0] 'sfx' $cases[$k][1]; $res[$k] = @{ name = $n.name; deploy = $n.deploy; gatewayVnet = $n.gatewayVnet } }
  catch { $res[$k] = 'ERR ' + $_.Exception.Message }
}
Write-Output ('RESULT:' + ($res | ConvertTo-Json -Compress -Depth 4))`));
  assert.match(r.none, /^ERR .*no virtual network.*-CreateNetwork/i);
  assert.deepEqual(r.noneCreate, { name: "vnet-liteapim-sfx", deploy: true, gatewayVnet: "" });
  assert.deepEqual(r.gateway, { name: "vnet-hackgw-pe", deploy: false, gatewayVnet: "vnet-hackgw-pe" });
  assert.match(r.gatewayCreate, /^ERR .*vnet-hackgw-pe/);
  assert.deepEqual(r.own, { name: "vnet-liteapim-sfx", deploy: false, gatewayVnet: "" });
  assert.deepEqual(r.ownCreate, { name: "vnet-liteapim-sfx", deploy: true, gatewayVnet: "" });
});

test("P63 the network prefix must be private IPv4, aligned, /16 to /26, and clear of the Standard v2 gateway's 10.61.0.0/16", { skip: !pwsh && "PowerShell 7 not found" }, () => {
  const values = ["10.65.0.0/24", "10.65.0.0/26", "192.168.10.0/24", "10.61.4.0/24", "10.0.0.0/8", "10.65.0.0/27", "10.65.0.1/24", "abc", "2001:db8::/64", "10.65.0.0", "8.8.8.0/24"];
  const r = resultOf(run(`${fns()}
$res = [ordered]@{}
foreach ($v in ${values.map(q).join(", ")}) { ${outcome("Assert-NetworkPrefix $v")}; $res[$v] = $o }
Write-Output ('RESULT:' + ($res | ConvertTo-Json -Compress))`));
  for (const ok of values.slice(0, 3)) assert.equal(r[ok], "ok", ok);
  for (const bad of values.slice(3)) assert.match(r[bad], /^ERR /, bad);
  assert.match(r["10.61.4.0/24"], /10\.61\.0\.0\/16/);
});

test("P63 the billable resources -CreateNetwork adds are listed, with no VM or NAT gateway", { skip: !pwsh && "PowerShell 7 not found" }, () => {
  const r = resultOf(run(`${fns()}
$res = @{ created = @(Get-LiteNetworkBillables 'vnet-liteapim-sfx' 'kv-poc-x' $true); reused = @(Get-LiteNetworkBillables 'vnet-liteapim-sfx' 'kv-poc-x' $false) }
Write-Output ('RESULT:' + ($res | ConvertTo-Json -Compress))`));
  assert.ok(r.created.some((l) => /private endpoint pe-kv-poc-x/i.test(l)));
  assert.ok(r.created.some((l) => /private DNS zone privatelink\.vaultcore\.azure\.net/i.test(l)));
  assert.ok(!r.reused.some((l) => /private DNS zone/i.test(l)), "a reused zone is not a new charge");
  assert.ok(r.created.some((l) => /vnet-liteapim-sfx.*no charge/i.test(l)));
  assert.ok(![...r.created, ...r.reused].some((l) => /virtual machine|NAT/i.test(l)));
});

const azMock = (body) => `
$global:calls = @()
function az {
  $global:calls += ,(@($args) -join ' ')
  $global:LASTEXITCODE = 0
  ${body}
  throw ('Unexpected az ' + (@($args) -join ' '))
}`;

test("P63 Foundry choice: named account in another group, discovery in a named group, or the instance's group", { skip: !pwsh && "PowerShell 7 not found" }, () => {
  const r = resultOf(run(`${fns()}
${azMock(`
  if ($args[0] -eq 'cognitiveservices' -and $args[2] -eq 'show') {
    if ($args -contains 'ai-openai') { return '{"name":"ai-openai","kind":"OpenAI"}' }
    return '{"name":"ai-contosohub","kind":"AIServices"}'
  }
  if ($args[0] -eq 'cognitiveservices' -and $args[2] -eq 'list') {
    if ($args -contains 'rg-empty') { return '[]' }
    return '[{"name":"speech","kind":"SpeechServices"},{"name":"ai-found","kind":"AIServices"}]'
  }`)}
$res = [ordered]@{}
foreach ($c in @(@('rg-contosohub', 'ai-contosohub'), @('', 'ai-contosohub'), @('rg-contosohub', ''), @('', ''), @('rg-empty', ''), @('rg-contosohub', 'ai-openai'))) {
  $global:calls = @()
  try { $f = Resolve-Foundry $c[0] $c[1]; $res["$($c[0])|$($c[1])"] = @{ name = $f.name; rg = $f.resourceGroup; call = $global:calls[0] } }
  catch { $res["$($c[0])|$($c[1])"] = 'ERR ' + $_.Exception.Message }
}
Write-Output ('RESULT:' + ($res | ConvertTo-Json -Compress -Depth 4))`));
  assert.equal(r["rg-contosohub|ai-contosohub"].rg, "rg-contosohub");
  assert.match(r["rg-contosohub|ai-contosohub"].call, /^cognitiveservices account show --subscription \S+ -g rg-contosohub -n ai-contosohub /);
  assert.equal(r["|ai-contosohub"].rg, "rg-hackathon-gateway");
  assert.deepEqual([r["rg-contosohub|"].name, r["rg-contosohub|"].rg], ["ai-found", "rg-contosohub"]);
  assert.deepEqual([r["|"].name, r["|"].rg], ["ai-found", "rg-hackathon-gateway"]);
  assert.match(r["rg-empty|"], /^ERR .*rg-empty.*-FoundryResourceGroup/);
  assert.match(r["rg-contosohub|ai-openai"], /^ERR .*AIServices/);
});

test("P63 usage reads the workspace of the component the gateway's logger writes to, not the first one listed", { skip: !pwsh && "PowerShell 7 not found" }, () => {
  const aum = `/subscriptions/${sub}/resourceGroups/rg-hackathon-gateway/providers/Microsoft.Insights/components/appi-aum`;
  const gw = `/subscriptions/${sub}/resourceGroups/rg-hackathon-gateway/providers/Microsoft.Insights/components/appi-gw`;
  const r = resultOf(run(`${fns()}
$script:components = '[]'; $script:logger = $null
${azMock(`
  if ($args[0] -eq 'resource' -and $args[1] -eq 'list') { return $script:components }
  if ($args[0] -eq 'rest') { if ($script:logger) { return $script:logger }; $global:LASTEXITCODE = 3; return 'ERROR: Not Found' }`)}
$res = [ordered]@{}
$script:components = '["${aum}","${gw}"]'; $script:logger = '"${gw}"'
${outcome("$res.c = Resolve-GatewayComponent 'apim-x'")}; $res.logger = $o
$script:logger = $null
${outcome("Resolve-GatewayComponent 'apim-x'")}; $res.ambiguous = $o
$script:components = '["${gw}"]'
${outcome("$res.single = Resolve-GatewayComponent 'apim-x'")}
$script:components = '["${aum}"]'; $script:logger = '"${gw}"'
${outcome("Resolve-GatewayComponent 'apim-x'")}; $res.elsewhere = $o
$script:components = '[]'; $script:logger = $null
${outcome("Resolve-GatewayComponent 'apim-x'")}; $res.none = $o
$rest = @($global:calls | Where-Object { $_ -like 'rest *' })[0]
$res.rest = $rest
Write-Output ('RESULT:' + ($res | ConvertTo-Json -Compress))`));
  assert.equal(r.c, gw);
  assert.match(r.ambiguous, /^ERR .*more than one/i);
  assert.equal(r.single, gw);
  assert.match(r.elsewhere, /^ERR /, "a logger component missing from the resource group is refused");
  assert.match(r.none, /^ERR .*No Application Insights/);
  assert.match(r.rest, /\/service\/apim-x\/loggers\/hackgw-appinsights\?api-version=2024-05-01/);
});

test("P63 Standard v2 installs get exactly the old template parameters; Basic v2 adds only the Foundry group and an empty gateway VNet", { skip: !pwsh && "PowerShell 7 not found" }, () => {
  const r = resultOf(run(`${fns()}
$same = @(Get-ExtraConsoleParameters ([pscustomobject]@{ name = 'ai'; resourceGroup = 'RG-HACKATHON-GATEWAY' }) ([pscustomobject]@{ name = 'vnet-hackgw-pe'; deploy = $false; gatewayVnet = 'vnet-hackgw-pe' }))
$basic = @(Get-ExtraConsoleParameters ([pscustomobject]@{ name = 'ai'; resourceGroup = 'rg-contosohub' }) ([pscustomobject]@{ name = 'vnet-liteapim-x'; deploy = $true; gatewayVnet = '' }))
Write-Output ('RESULT:' + (@{ same = $same; basic = $basic } | ConvertTo-Json -Compress))`));
  assert.deepEqual(r.same ?? [], []);
  assert.deepEqual(r.basic, ["foundryResourceGroup=rg-contosohub", "gatewayVnetName="]);
  const d = deploy();
  assert.match(d, /\$common = @\("vnetName=\$vnet", "subnetPrefix=\$SubnetPrefix", "vaultName=\$vault", "apimName=\$\(\$apim\.name\)",\n\s+"foundryAccountName=\$\(\$foundry\.name\)", "workspaceName=\$workspace", "clientId=\$\(\$app\.appId\)",\n\s+"gatewayUrl=\$\(\$apim\.url\)", "allowedCidr=\$allowedCidr"\)\n\$common \+= @\(Get-ExtraConsoleParameters \$foundry \$network\)/);
});

test("P63 -CreateNetwork is refused on App Service before any Azure call", { skip: !pwsh && "PowerShell 7 not found" }, () => {
  const r = run(`
function az { Write-Output 'AZ_CALLED'; throw 'UNEXPECTED_AZ' }
try { & ${q(resolve(deployPath))} -Subscription '${sub}' -ResourceGroup rg-x -Hosting AppService -CreateNetwork; throw 'ACCEPTED' } catch { Write-Output $_.Exception.Message }`);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /AZ_CALLED|UNEXPECTED_AZ|ACCEPTED/);
  assert.match(r.stdout, /-CreateNetwork.*ContainerApps/);
});

test("P63 with -CreateNetwork the network is deployed before liteAPIM, and its subnet and empty gateway VNet are used", () => {
  const d = deploy();
  const net = d.indexOf("infra/console-network.bicep");
  const app = d.indexOf("'infra/console.bicep'");
  assert.ok(net > 0 && net < app, "network template before the app template");
  assert.match(d, /Get-LiteNetworkBillables \$network\.name \$vault \$createZone \| ForEach-Object \{ Write-Host "  billable: \$_" \}/);
  assert.match(d, /\$SubnetPrefix = \$netDeploy\.consoleSubnetPrefix\.value/);
  const refuse = d.indexOf("$network = Resolve-ConsoleNetwork");
  assert.ok(refuse > 0 && refuse < d.search(/Invoke-Az ad /), "the network decision is made before any Entra change");
  assert.ok(d.indexOf("Assert-NetworkPrefix $NetworkPrefix") < d.search(/Invoke-Az ad /));
});

