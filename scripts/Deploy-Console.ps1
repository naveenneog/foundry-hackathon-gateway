#requires -Version 7
<#
.SYNOPSIS
  Deploy the Key Console (P46) next to an existing gateway and POC vault.

.DESCRIPTION
  1. Ensures an Entra app registration "hackgw-key-console" with app roles Console.Admin and
     Console.User, ID-token sign-in, and "assignment required" so only assigned people can sign in.
  2. Assigns the signed-in operator Console.Admin, and any -Users Console.User.
  3. Deploys infra/console.bicep (subnet, plan, web app, sign-in, role assignments).
  4. Packages src/keys.mjs + src/console and zip-deploys it, then waits for /healthz.

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
    [string]$SubnetPrefix = '10.61.5.0/27',
    [switch]$SkipCode
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
$vault = @(Invoke-Az keyvault list --subscription $Subscription -g $ResourceGroup --query "[?starts_with(name,'kv-poc-')].name" -o json)[0]
if (-not $vault) { throw "No POC vault (kv-poc-*) in $ResourceGroup; deploy poc/products-keyvault first." }
$vnet = @(Invoke-Az network vnet list --subscription $Subscription -g $ResourceGroup --query '[].name' -o json)[0]
$suffix = ($apim.name -split '-')[-1]
$appName = "app-hackgw-console-$suffix"
$hostName = "$appName.azurewebsites.net"
$redirect = "https://$hostName/.auth/login/aad/callback"
Write-Host "  APIM $($apim.name), vault $vault, network $vnet -> web app $appName"

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
            --web-redirect-uris $redirect --enable-id-token-issuance true --app-roles "@$rolesFile" -o json
    } finally { Remove-Item $rolesFile -Force }
} else {
    $null = Invoke-Az ad app update --id $app.appId --web-redirect-uris $redirect --enable-id-token-issuance true
    $app = Invoke-Az ad app show --id $app.appId -o json
}
$sp = Invoke-Az ad sp list --filter "appId eq '$($app.appId)'" --query '[0]' -o json
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

Write-Host "Deploying infra/console.bicep..."
$deploy = Invoke-Az deployment group create --subscription $Subscription -g $ResourceGroup -n "console-$suffix" `
    --template-file (Join-Path $root 'infra/console.bicep') `
    --parameters appName=$appName vnetName=$vnet subnetPrefix=$SubnetPrefix vaultName=$vault apimName=$($apim.name) `
                 clientId=$($app.appId) gatewayUrl=$($apim.url) `
    --query 'properties.outputs' -o json
$url = $deploy.appUrl.value

if (-not $SkipCode) {
    Write-Host "Packaging and deploying the console code..."
    $zip = Join-Path ([IO.Path]::GetTempPath()) "console-$suffix.zip"
    Remove-Item $zip -ErrorAction SilentlyContinue
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::Open($zip, 'Create')
    try {
        $files = @(Get-Item (Join-Path $root 'src/keys.mjs')) + @(Get-ChildItem (Join-Path $root 'src/console') -Recurse -File)
        foreach ($f in $files) {
            # Forward slashes: the archive is unpacked on Linux.
            $entry = [IO.Path]::GetRelativePath($root, $f.FullName).Replace('\', '/')
            $null = [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $f.FullName, $entry)
        }
        $pkg = $archive.CreateEntry('package.json')
        $w = New-Object IO.StreamWriter($pkg.Open())
        $w.Write((@{ name = 'hackgw-key-console'; private = $true; type = 'module'; engines = @{ node = '>=20' }
                    scripts = @{ start = 'node src/console/main.mjs' } } | ConvertTo-Json))
        $w.Dispose()
    } finally { $archive.Dispose() }
    $null = Invoke-Az webapp deploy --subscription $Subscription -g $ResourceGroup -n $appName --src-path $zip --type zip --restart true
    Remove-Item $zip -Force
}

Write-Host "Waiting for $url/healthz..."
for ($i = 0; $i -lt 30; $i++) {
    try { if ((Invoke-WebRequest "$url/healthz" -TimeoutSec 20).StatusCode -eq 200) { break } } catch { Start-Sleep 10 }
}
Write-Host "Key Console: $url  (sign in as an assigned user; admins: open 'Signing secret' and migrate first)"
