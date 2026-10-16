#requires -Version 7
<#
.SYNOPSIS
  Deploy the Key Console (P46) next to an existing gateway and POC vault.

.DESCRIPTION
  1. Ensures an Entra app registration "hackgw-key-console" with app roles Console.Admin and
     Console.User, ID-token sign-in, and "assignment required" so only assigned people can sign in.
  2. Assigns the signed-in operator Console.Admin, and any -Users Console.User.
  3. Ensures a container registry (admin user disabled) and builds the console image there with
     ACR Tasks from a minimal context: src/keys.mjs, src/console/**, a package.json, the Dockerfile.
  4. Deploys infra/console.bicep (subnet, environment, container app, sign-in, role assignments),
     points the app registration's redirect URI at the app, and waits for /healthz.

  Prints names and URLs only; no ids, keys or tokens.

.EXAMPLE
  ./scripts/Deploy-Console.ps1 -Subscription <name-or-id> -ResourceGroup rg-hackgw-pe-test
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Subscription,
    [Parameter(Mandatory)][string]$ResourceGroup,
    [string]$AppRegistrationName = 'hackgw-key-console',
    [string[]]$Users = @(),
    [string]$SubnetPrefix = '10.61.5.0/27'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent

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
$suffix = ($apim.name -split '-')[-1]
$appName = "ca-console-$suffix"
$registry = "crconsole$suffix"
Write-Host "  APIM $($apim.name), vault $vault, network $vnet -> container app $appName"

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

Write-Host "Ensuring registry $registry and building the image..."
$exists = & az acr show --subscription $Subscription -g $ResourceGroup -n $registry --query name -o tsv 2>$null
if (-not $exists) {
    $null = Invoke-Az acr create --subscription $Subscription -g $ResourceGroup -n $registry --sku Basic --admin-enabled false -o json
}
$ctx = Join-Path ([IO.Path]::GetTempPath()) "console-build-$suffix"
Remove-Item $ctx -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path (Join-Path $ctx 'src') | Out-Null
Copy-Item (Join-Path $root 'src/keys.mjs') (Join-Path $ctx 'src')
Copy-Item (Join-Path $root 'src/console') (Join-Path $ctx 'src') -Recurse
Copy-Item (Join-Path $root 'infra/console.Dockerfile') (Join-Path $ctx 'Dockerfile')
@{ name = 'hackgw-key-console'; private = $true; type = 'module'; engines = @{ node = '>=20' } } |
    ConvertTo-Json | Set-Content (Join-Path $ctx 'package.json') -Encoding utf8
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
    --parameters appName=$appName vnetName=$vnet subnetPrefix=$SubnetPrefix vaultName=$vault apimName=$($apim.name) `
                 registryName=$registry image=$image clientId=$($app.appId) gatewayUrl=$($apim.url) `
    --query 'properties.outputs' -o json
$url = $deploy.appUrl.value
$null = Invoke-Az ad app update --id $app.appId --web-redirect-uris "$url/.auth/login/aad/callback" --enable-id-token-issuance true

Write-Host "Waiting for $url/healthz..."
for ($i = 0; $i -lt 30; $i++) {
    try { if ((Invoke-WebRequest "$url/healthz" -TimeoutSec 20).StatusCode -eq 200) { break } } catch { Start-Sleep 10 }
}
Write-Host "Key Console: $url  (sign in as an assigned user; admins: open 'Signing secret' and migrate first)"
