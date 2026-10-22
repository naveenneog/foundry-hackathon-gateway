#requires -Version 7
<#
.SYNOPSIS
  Deploy the Key Dashboard (P46, P53) next to an existing gateway and POC vault, on the hosting
  chosen at install.

.DESCRIPTION
  1. Ensures an Entra app registration "hackgw-key-console" with app roles Console.Admin and
     Console.User, ID-token sign-in, and "assignment required" so only assigned people can sign in.
  2. Assigns the signed-in operator Console.Admin, and any -Users Console.User, and records
     per-user sign-in consent where the tenant blocks user consent.
  3. Adds usage telemetry to the POC routes (infra/console-telemetry.bicep).
  4. Deploys ONE hosting path (ADR-0015):
     - ContainerApps (default): builds the image with ACR Tasks (registry admin user disabled) and
       deploys infra/console.bicep: a container app that scales to zero and a cron job for the
       automation.
     - AppService: deploys infra/console-appservice.bicep (a web app and a Function App on one
       plan), then zip-deploys the dashboard and the Function App package.
  5. Allows only -AllowedIp, points the redirect URI at the dashboard, and waits for /healthz.

  Prints names and URLs only; no ids, keys or tokens.

.EXAMPLE
  ./scripts/Deploy-Console.ps1 -Subscription <name-or-id> -ResourceGroup rg-hackgw-pe-test -AllowedIp 203.0.113.7
.EXAMPLE
  ./scripts/Deploy-Console.ps1 -Subscription <name-or-id> -ResourceGroup rg-x -AllowedIp 203.0.113.7 -Hosting AppService
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Subscription,
    [Parameter(Mandatory)][string]$ResourceGroup,
    [Parameter(Mandatory)][string]$AllowedIp,
    [ValidateSet('ContainerApps', 'AppService')][string]$Hosting = 'ContainerApps',
    [string]$AppRegistrationName = 'hackgw-key-console',
    [string[]]$Users = @(),
    [string]$SubnetPrefix = '',
    [string]$AppServiceSku = 'B1'
)$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent

$ip = $null
if (-not [System.Net.IPAddress]::TryParse($AllowedIp, [ref]$ip) -or $ip.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork -or
    $AllowedIp -notmatch '^\d{1,3}(\.\d{1,3}){3}$') {
    throw "-AllowedIp must be one IPv4 address, such as 203.0.113.7."
}
if (-not $SubnetPrefix) { $SubnetPrefix = if ($Hosting -eq 'AppService') { '10.61.6.0/27' } else { '10.61.5.0/27' } }

function Invoke-Az {
    $out = & az @args 2>&1
    if ($LASTEXITCODE -ne 0) { throw "az $($args[0..1] -join ' ') failed: $($out | Select-Object -Last 3 | Out-String)" }
    $text = ($out | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] }) -join "`n"
    if ($text.Trim()) { return $text | ConvertFrom-Json }
}

Write-Host "Discovering the gateway in $ResourceGroup..."
$apim = @(Invoke-Az apim list --subscription $Subscription -g $ResourceGroup --query '[].{name:name,url:gatewayUrl}' -o json)[0]
if (-not $apim) { throw "No API Management instance in $ResourceGroup." }
# Filter in PowerShell: az.cmd on Windows mangles quoted JMESPath filters.
$vault = @(Invoke-Az keyvault list --subscription $Subscription -g $ResourceGroup --query '[].name' -o json) |
    Where-Object { $_ -like 'kv-poc-*' } | Select-Object -First 1
if (-not $vault) { throw "No POC vault (kv-poc-*) in $ResourceGroup; deploy poc/products-keyvault first." }
$vnet = @(Invoke-Az network vnet list --subscription $Subscription -g $ResourceGroup --query '[].name' -o json)[0]
$foundry = @(Invoke-Az cognitiveservices account list --subscription $Subscription -g $ResourceGroup --query '[].{name:name,kind:kind}' -o json) |
    Where-Object { $_.kind -eq 'AIServices' } | Select-Object -First 1
if (-not $foundry) { throw "No Foundry (AIServices) account in $ResourceGroup." }
# The gateway's workspace is the one its Application Insights component writes to.
$component = @(Invoke-Az resource list --subscription $Subscription -g $ResourceGroup --resource-type Microsoft.Insights/components --query '[].id' -o json)[0]
if (-not $component) { throw "No Application Insights component in $ResourceGroup; usage needs the gateway's telemetry." }
$workspace = ((Invoke-Az resource show --ids $component --query properties.WorkspaceResourceId -o json) -split '/')[-1]
$suffix = ($apim.name -split '-')[-1]
$appName = if ($Hosting -eq 'AppService') { "app-keys-$suffix" } else { "ca-console-$suffix" }
$registry = "crconsole$suffix"
Write-Host "  APIM $($apim.name), vault $vault, Foundry $($foundry.name), workspace $workspace, network $vnet"
Write-Host "  hosting: $Hosting -> $appName, open to $AllowedIp only"

Write-Host "Ensuring app registration $AppRegistrationName..."
$app = @(Invoke-Az ad app list --display-name $AppRegistrationName --query '[0]' -o json)[0]
if (-not $app) {
    $rolesFile = New-TemporaryFile
    @(
        @{ allowedMemberTypes = @('User'); displayName = 'Console Admin'; value = 'Console.Admin'; isEnabled = $true; id = [guid]::NewGuid().ToString()
           description = 'Issue, revoke, rotate and export gateway keys; manage the signing secret.' },
        @{ allowedMemberTypes = @('User'); displayName = 'Console User'; value = 'Console.User'; isEnabled = $true; id = [guid]::NewGuid().ToString()
           description = 'See and reveal only the gateway keys issued to you.' }
    ) | ConvertTo-Json -Depth 4 | Set-Content $rolesFile -Encoding utf8
    try {
        $app = Invoke-Az ad app create --display-name $AppRegistrationName --sign-in-audience AzureADMyOrg `
            --enable-id-token-issuance true --app-roles "@$rolesFile" -o json
    } finally { Remove-Item $rolesFile -Force }
}
$sp = @(Invoke-Az ad sp list --spn $app.appId -o json)[0]
if (-not $sp) { $sp = Invoke-Az ad sp create --id $app.appId -o json }
$null = Invoke-Az ad sp update --id $app.appId --set appRoleAssignmentRequired=true

function Grant-ConsoleRole([string]$PrincipalId, [string]$RoleValue, [string]$Label) {
    $roleId = ($app.appRoles | Where-Object value -eq $RoleValue).id
    $existing = Invoke-Az rest --method GET --url "https://graph.microsoft.com/v1.0/servicePrincipals/$($sp.id)/appRoleAssignedTo" -o json
    if ($existing.value | Where-Object { $_.principalId -eq $PrincipalId -and $_.appRoleId -eq $roleId }) {
        Write-Host "  $Label already has $RoleValue"; return
    }
    $body = New-TemporaryFile
    @{ principalId = $PrincipalId; resourceId = $sp.id; appRoleId = $roleId } | ConvertTo-Json | Set-Content $body -Encoding utf8
    try {
        $null = Invoke-Az rest --method POST --url "https://graph.microsoft.com/v1.0/servicePrincipals/$($sp.id)/appRoleAssignedTo" `
            --headers 'Content-Type=application/json' --body "@$body"
    } finally { Remove-Item $body -Force }
    Write-Host "  granted $RoleValue to $Label"
}
$me = Invoke-Az ad signed-in-user show --query '{id:id,upn:userPrincipalName}' -o json
Grant-ConsoleRole $me.id 'Console.Admin' $me.upn
foreach ($u in $Users) { Grant-ConsoleRole (Invoke-Az ad user show --id $u --query id -o json) 'Console.User' $u }

# Sign-in needs Graph openid/profile/email. Where the tenant blocks user consent, a per-user grant
# lets assigned people sign in without a tenant-wide admin consent; if this is refused, ask a
# tenant admin to grant consent for the app instead.
$graphAppId = '00000003-0000-0000-c000-000000000000'
$null = Invoke-Az ad app permission add --id $app.appId --api $graphAppId --api-permissions `
    '37f7f235-527c-4136-accd-4a02d197296e=Scope' '14dad69e-099b-42c9-810b-d002981feec1=Scope' '64a6cdd6-aab1-4aaf-94b8-3cc8405e90d0=Scope'
$graphSp = @(Invoke-Az ad sp list --spn $graphAppId -o json)[0]
function Grant-SignInConsent([string]$PrincipalId, [string]$Label) {
    $grants = Invoke-Az rest --method GET --url "https://graph.microsoft.com/v1.0/servicePrincipals/$($sp.id)/oauth2PermissionGrants" -o json
    if ($grants.value | Where-Object { $_.principalId -eq $PrincipalId -and $_.resourceId -eq $graphSp.id }) { return }
    $body = New-TemporaryFile
    @{ clientId = $sp.id; consentType = 'Principal'; principalId = $PrincipalId; resourceId = $graphSp.id; scope = 'openid profile email' } |
        ConvertTo-Json | Set-Content $body -Encoding utf8
    try {
        $null = Invoke-Az rest --method POST --url 'https://graph.microsoft.com/v1.0/oauth2PermissionGrants' `
            --headers 'Content-Type=application/json' --body "@$body"
        Write-Host "  sign-in consent recorded for $Label"
    } catch { Write-Warning "Could not record sign-in consent for $Label; a tenant admin must consent to $AppRegistrationName." }
    finally { Remove-Item $body -Force }
}
Grant-SignInConsent $me.id $me.upn
foreach ($u in $Users) { Grant-SignInConsent (Invoke-Az ad user show --id $u --query id -o json) $u }

Write-Host "Adding usage telemetry to the POC routes..."
$null = Invoke-Az deployment group create --subscription $Subscription -g $ResourceGroup -n "console-telemetry-$suffix" `
    --template-file (Join-Path $root 'infra/console-telemetry.bicep') --parameters apimName=$($apim.name) -o json

# What both hosting paths run: the console modules, the canonical model rules, the pack template.
function New-AppContext([string]$Name) {
    $dir = Join-Path ([IO.Path]::GetTempPath()) "$Name-$suffix"
    Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Path (Join-Path $dir 'src') | Out-Null
    foreach ($f in 'keys.mjs', 'foundry.mjs', 'models.mjs') { Copy-Item (Join-Path $root "src/$f") (Join-Path $dir 'src') }
    Copy-Item (Join-Path $root 'src/console') (Join-Path $dir 'src') -Recurse
    $tpl = Join-Path $dir 'poc/products-keyvault/infra'
    New-Item -ItemType Directory -Path $tpl | Out-Null
    Copy-Item (Join-Path $root 'poc/products-keyvault/infra/product-policy.xml') $tpl
    @{ name = 'hackgw-key-console'; private = $true; type = 'module'; engines = @{ node = '>=24' } } |
        ConvertTo-Json | Set-Content (Join-Path $dir 'package.json') -Encoding utf8
    return $dir
}

$common = @("vnetName=$vnet", "subnetPrefix=$SubnetPrefix", "vaultName=$vault", "apimName=$($apim.name)",
    "foundryAccountName=$($foundry.name)", "workspaceName=$workspace", "clientId=$($app.appId)",
    "gatewayUrl=$($apim.url)", "allowedIp=$AllowedIp")

if ($Hosting -eq 'AppService') {
    Write-Host "Deploying infra/console-appservice.bicep..."
    $deploy = Invoke-Az deployment group create --subscription $Subscription -g $ResourceGroup -n "console-appsvc-$suffix" `
        --template-file (Join-Path $root 'infra/console-appservice.bicep') `
        --parameters appName=$appName skuName=$AppServiceSku @common --query 'properties.outputs' -o json
    $url = $deploy.appUrl.value

    Write-Host "Deploying the dashboard package..."
    $web = New-AppContext 'dashboard-web'
    $webZip = "$web.zip"
    try {
        Compress-Archive -Path (Join-Path $web '*') -DestinationPath $webZip -Force
        $null = Invoke-Az webapp deploy --subscription $Subscription -g $ResourceGroup -n $deploy.webName.value --src-path $webZip --type zip -o json
    } finally { Remove-Item $web, $webZip -Recurse -Force -ErrorAction SilentlyContinue }

    Write-Host "Deploying the automation Function App package..."
    $fn = New-AppContext 'dashboard-fn'
    $fnZip = "$fn.zip"
    try {
        New-Item -ItemType Directory -Path (Join-Path $fn 'functions') | Out-Null
        Copy-Item (Join-Path $root 'functions/sweep.mjs') (Join-Path $fn 'functions')
        Copy-Item (Join-Path $root 'functions/host.json') $fn
        Copy-Item (Join-Path $root 'functions/package.json') $fn -Force
        Push-Location $fn
        try { & npm install --omit=dev --no-audit --no-fund --silent; if ($LASTEXITCODE -ne 0) { throw 'npm install failed.' } } finally { Pop-Location }
        Compress-Archive -Path (Join-Path $fn '*') -DestinationPath $fnZip -Force
        $null = Invoke-Az functionapp deployment source config-zip --subscription $Subscription -g $ResourceGroup -n $deploy.functionName.value --src $fnZip -o json
    } finally { Remove-Item $fn, $fnZip -Recurse -Force -ErrorAction SilentlyContinue }
}
else {
    Write-Host "Ensuring registry $registry and building the image..."
    $exists = & az acr show --subscription $Subscription -g $ResourceGroup -n $registry --query name -o tsv 2>$null
    if (-not $exists) {
        $null = Invoke-Az acr create --subscription $Subscription -g $ResourceGroup -n $registry --sku Basic --admin-enabled false -o json
    }
    $ctx = New-AppContext 'console-build'
    Copy-Item (Join-Path $root 'infra/console.Dockerfile') (Join-Path $ctx 'Dockerfile')
    $tag = "$(git -C $root rev-parse --short HEAD)-$(Get-Date -Format yyyyMMddHHmmss)"
    try {
        $run = Invoke-Az acr build --subscription $Subscription -r $registry -t "key-console:$tag" -f (Join-Path $ctx 'Dockerfile') $ctx --no-logs -o json
    } finally { Remove-Item $ctx -Recurse -Force }
    if ($run.status -ne 'Succeeded') { throw "Image build ended $($run.status); see 'az acr task logs -r $registry'." }
    $image = "$registry.azurecr.io/key-console:$tag"
    Write-Host "  built $image"

    Write-Host "Deploying infra/console.bicep..."
    $deploy = Invoke-Az deployment group create --subscription $Subscription -g $ResourceGroup -n "console-$suffix" `
        --template-file (Join-Path $root 'infra/console.bicep') `
        --parameters appName=$appName registryName=$registry image=$image @common --query 'properties.outputs' -o json
    $url = $deploy.appUrl.value
}
$null = Invoke-Az ad app update --id $app.appId --web-redirect-uris "$url/.auth/login/aad/callback" --enable-id-token-issuance true

Write-Host "Waiting for $url/healthz (from this machine, which must be $AllowedIp)..."
for ($i = 0; $i -lt 30; $i++) {
    try { if ((Invoke-WebRequest "$url/healthz" -TimeoutSec 20).StatusCode -eq 200) { break } } catch { Start-Sleep 10 }
}
Write-Host "Key Dashboard ($Hosting): $url  (sign in as an assigned user; admins: open 'Signing secret' and migrate first)"