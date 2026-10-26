#requires -Version 7
<#
.SYNOPSIS
  Deploy liteAPIM (the admin key dashboard; P46, P53) next to an existing gateway and POC vault, on the hosting
  chosen at install.

.DESCRIPTION
  1. Ensures an Entra app registration "hackgw-key-console" with app roles Console.Admin and
     Console.User, ID-token sign-in, and "assignment required" so only assigned people can sign in.
  2. Assigns the signed-in operator, and any -Admins, Console.Admin, and records
     per-user sign-in consent where the tenant blocks user consent.
  3. Adds usage telemetry to the POC routes (infra/console-telemetry.bicep).
  4. Deploys ONE hosting path (ADR-0015):
     - ContainerApps (default): builds the image with ACR Tasks (registry admin user disabled) and
       deploys infra/console.bicep: a container app that scales to zero and a cron job for the
       automation.
     - AppService: deploys infra/console-appservice.bicep (a web app and a Function App on one
       plan), then zip-deploys the dashboard and the Function App package.
  5. With -AllowedIp, admits only that address (optional; without it, Entra sign-in alone guards
     the dashboard). Points the redirect URI at the dashboard and waits for /healthz.
  6. Grants the dashboard metadata-only account/deployment discovery across the APIM subscription.
     The operator needs subscription roleDefinitions/write and roleAssignments/write privileges.
     No subscription Reader/Contributor or RBAC write permission is granted to the dashboard.
     Additional accounts need APIM inference access: use scripts/Connect-Foundry.ps1, then UI Test.
     Neither installer switches the Azure CLI's account, login or profile.

  Prints names and URLs only; no ids, keys or tokens.

  Existing Basic v2 gateway (P63, ADR-0021): a Basic v2 instance has no VNet, and its Foundry may
  sit in another resource group. -FoundryResourceGroup and -FoundryAccountName name that Foundry.
  With no VNet in the resource group the script stops unless -CreateNetwork is given, which
  (Container Apps only) creates a liteAPIM-only VNet with the vault's private endpoint and DNS
  zone, and prints each billable resource first. The script refuses to repoint an app
  registration that already signs in another app unless -TakeOverRegistration is given, so each
  install needs its own -AppRegistrationName.

.EXAMPLE
  ./scripts/Deploy-Console.ps1 -Subscription <name-or-id> -ResourceGroup rg-hackgw-pe-test -AllowedIp 203.0.113.7
.EXAMPLE
  ./scripts/Deploy-Console.ps1 -Subscription <name-or-id> -ResourceGroup rg-x -AllowedIp 203.0.113.7 -Hosting AppService
.EXAMPLE
  ./scripts/Deploy-Console.ps1 -Subscription <name-or-id> -ResourceGroup rg-hackathon-gateway -FoundryResourceGroup rg-contosohub -FoundryAccountName <foundry> -AppRegistrationName hackgw-key-console-basicv2 -CreateNetwork
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Subscription,
    [Parameter(Mandatory)][string]$ResourceGroup,
    [string]$AllowedIp = '',
    [ValidateSet('ContainerApps', 'AppService')][string]$Hosting = 'ContainerApps',
    [string]$AppRegistrationName = 'hackgw-key-console',
    [string[]]$Admins = @(),
    [string]$SubnetPrefix = '',
    [string]$AppServiceSku = 'B1',
    [string]$FoundryResourceGroup = '',
    [string]$FoundryAccountName = '',
    [switch]$CreateNetwork,
    [string]$NetworkPrefix = '10.65.0.0/24',
    [switch]$TakeOverRegistration
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent

function Assert-SafeAzArguments([object[]]$Values) {
    foreach ($value in $Values) {
        # az.cmd is interpreted by cmd.exe on Windows, even with PowerShell argument splatting.
        if ([string]$value -match '[&|<>^%!"`;\r\n()]') { throw 'Unsafe Azure CLI argument: shell metacharacter refused.' }
    }
}

# liteAPIM-only network (P63): a private IPv4 range, /16 to /26 so a /27 and a /28 fit, aligned,
# clear of the Standard v2 gateway's 10.61.0.0/16 and of 172.30.0.0/15, which Container Apps
# reserves (UNKNOWNS U58).
function Assert-NetworkPrefix([string]$Prefix) {
    $addr, $len = $Prefix -split '/', 2
    $ip = $null
    if ($len -notmatch '^\d{1,2}$' -or $addr -notmatch '^\d{1,3}(\.\d{1,3}){3}$' -or
        -not [System.Net.IPAddress]::TryParse($addr, [ref]$ip) -or $ip.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) {
        throw "-NetworkPrefix must be an IPv4 range such as 10.65.0.0/24."
    }
    $len = [int]$len
    if ($len -lt 16 -or $len -gt 26) { throw "-NetworkPrefix must be /16 to /26, to hold a /27 for Container Apps and a /28 for the private endpoint." }
    $b = $ip.GetAddressBytes()
    $n = [uint64]$b[0] * 16777216 + [uint64]$b[1] * 65536 + [uint64]$b[2] * 256 + [uint64]$b[3]
    if ($n % ([uint64]1 -shl (32 - $len)) -ne 0) { throw "-NetworkPrefix $Prefix is not aligned to its /$len boundary." }
    $private = $b[0] -eq 10 -or ($b[0] -eq 172 -and $b[1] -ge 16 -and $b[1] -le 31) -or ($b[0] -eq 192 -and $b[1] -eq 168)
    if (-not $private) { throw "-NetworkPrefix $Prefix is not a private (RFC 1918) range." }
    if ($b[0] -eq 10 -and $b[1] -eq 61) { throw "-NetworkPrefix $Prefix overlaps 10.61.0.0/16, the Standard v2 gateway's VNet." }
    if ($b[0] -eq 172 -and $b[1] -ge 30) { throw "-NetworkPrefix $Prefix overlaps 172.30.0.0/15, which Container Apps reserves." }
}

Assert-SafeAzArguments (@($Subscription, $ResourceGroup, $AllowedIp, $AppRegistrationName, $SubnetPrefix, $AppServiceSku, $FoundryResourceGroup, $FoundryAccountName, $NetworkPrefix) + $Admins)
if ([string]::IsNullOrWhiteSpace($Subscription) -or $Subscription.StartsWith('-')) { throw 'Invalid subscription.' }
if ($ResourceGroup -notmatch '^[a-zA-Z0-9_().-]{1,90}$' -or $ResourceGroup.EndsWith('.')) { throw 'Invalid resource group.' }
if ($FoundryResourceGroup -and ($FoundryResourceGroup -notmatch '^[a-zA-Z0-9_().-]{1,90}$' -or $FoundryResourceGroup.EndsWith('.'))) { throw 'Invalid Foundry resource group.' }
if ($FoundryAccountName -and $FoundryAccountName -notmatch '^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,63}$') { throw 'Invalid Foundry account name.' }
if ($CreateNetwork) {
    if ($Hosting -ne 'ContainerApps') { throw '-CreateNetwork creates a network for -Hosting ContainerApps only.' }
    if ($SubnetPrefix) { throw '-CreateNetwork takes its subnets from -NetworkPrefix; omit -SubnetPrefix.' }
    Assert-NetworkPrefix $NetworkPrefix
}

$allowedCidr = ''
if ($AllowedIp) {
    # One IPv4 address (made a /32). A CIDR is accepted only for a NAT pool that rotates the egress
    # address, at most a /24, and is reported as wider than one address.
    $addr, $prefix = $AllowedIp -split '/', 2
    $ip = $null
    if (-not [System.Net.IPAddress]::TryParse($addr, [ref]$ip) -or $ip.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork -or
        $addr -notmatch '^\d{1,3}(\.\d{1,3}){3}$') {
        throw "-AllowedIp must be one IPv4 address, such as 203.0.113.7."
    }
    $prefix = if ($null -eq $prefix) { 32 } else { [int]$prefix }
    if ($prefix -lt 24 -or $prefix -gt 32) { throw "-AllowedIp: a CIDR must be /24 to /32." }
    $script:allowedCidr = "$addr/$prefix"
    if ($prefix -ne 32) { Write-Warning "-AllowedIp $allowedCidr admits $([math]::Pow(2, 32 - $prefix)) addresses, not one." }
}
if (-not $SubnetPrefix) { $SubnetPrefix = if ($Hosting -eq 'AppService') { '10.61.6.0/27' } else { '10.61.5.0/27' } }

function Invoke-Az {
    Assert-SafeAzArguments $args
    $out = & az @args 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Azure CLI command failed ($($args[0..1] -join ' ')); inspect operator permissions and retry." }
    $text = ($out | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] }) -join "`n"
    if ($text.Trim()) { return $text | ConvertFrom-Json }
}

# Where liteAPIM runs (P63). The gateway's VNet when the resource group has one; otherwise only
# with -CreateNetwork, a liteAPIM-only VNet, recognised by name on later runs. Never a second
# network beside a gateway VNet.
function Resolve-ConsoleNetwork([string[]]$VnetNames, [string]$Suffix, [bool]$Create) {
    $own = "vnet-liteapim-$Suffix"
    $names = @($VnetNames | Where-Object { $_ })
    if ($names -contains $own) { return [pscustomobject]@{ name = $own; deploy = $Create; gatewayVnet = '' } }
    if ($names.Count) {
        if ($Create) { throw "-CreateNetwork is for a resource group with no virtual network; $ResourceGroup already has $($names -join ', '). Run without -CreateNetwork to use it." }
        return [pscustomobject]@{ name = $names[0]; deploy = $false; gatewayVnet = $names[0] }
    }
    if (-not $Create) {
        throw "$ResourceGroup has no virtual network (a Basic v2 gateway has none), and the private vault is reachable only through one. Rerun with -CreateNetwork (Container Apps hosting) to create a liteAPIM-only network: a VNet, two subnets, a private endpoint for the vault and its private DNS zone."
    }
    return [pscustomobject]@{ name = $own; deploy = $true; gatewayVnet = '' }
}

# The Foundry whose deployments liteAPIM lists: named, or the first AIServices account in the
# named resource group, or in the gateway's.
function Resolve-Foundry([string]$Group, [string]$Name) {
    $rg = if ($Group) { $Group } else { $ResourceGroup }
    if ($Name) {
        $f = Invoke-Az cognitiveservices account show --subscription $Subscription -g $rg -n $Name --query '{name:name,kind:kind}' -o json
        if ($f.kind -ne 'AIServices') { throw "Foundry account $Name in $rg is $($f.kind), not AIServices." }
    } else {
        $f = @(Invoke-Az cognitiveservices account list --subscription $Subscription -g $rg --query '[].{name:name,kind:kind}' -o json) |
            Where-Object { $_.kind -eq 'AIServices' } | Select-Object -First 1
        if (-not $f) { throw "No Foundry (AIServices) account in $rg. Name the Foundry's resource group with -FoundryResourceGroup, and the account with -FoundryAccountName." }
    }
    return [pscustomobject]@{ name = $f.name; resourceGroup = $rg }
}

# The Application Insights component the gateway's logger writes to. A resource group can hold
# components of other apps; the first one listed is not necessarily the gateway's (P63).
function Resolve-GatewayComponent([string]$ApimName) {
    $components = @(Invoke-Az resource list --subscription $Subscription -g $ResourceGroup --resource-type Microsoft.Insights/components --query '[].id' -o json)
    if (-not $components.Count) { throw "No Application Insights component in $ResourceGroup; usage needs the gateway's telemetry." }
    $logger = $null
    try {
        $logger = Invoke-Az rest --method GET --url "https://management.azure.com/subscriptions/$subscriptionId/resourceGroups/$ResourceGroup/providers/Microsoft.ApiManagement/service/$ApimName/loggers/hackgw-appinsights?api-version=2024-05-01" --query properties.resourceId -o json
    } catch { $logger = $null }
    if ($logger) {
        $match = @($components | Where-Object { $_ -eq $logger })
        if (-not $match.Count) { throw "The gateway's hackgw-appinsights logger writes to a component outside $ResourceGroup; liteAPIM reads usage from a workspace in this resource group." }
        return $match[0]
    }
    if ($components.Count -gt 1) { throw "More than one Application Insights component in $ResourceGroup, and $ApimName has no hackgw-appinsights logger to choose between them." }
    return $components[0]
}

# Refuses to repoint a registration whose redirect URI belongs to another app: the update below
# replaces the whole list, which would end sign-in there (P63).
function Assert-RegistrationOwnership([string[]]$RedirectUris, [string]$AppName, [string]$RegistrationName, [bool]$TakeOver) {
    $others = @(foreach ($u in @($RedirectUris | Where-Object { $_ })) {
        $parsed = $null
        $hostName = if ([uri]::TryCreate($u, [UriKind]::Absolute, [ref]$parsed)) { $parsed.Host } else { '' }
        if (($hostName -split '\.')[0] -ne $AppName) { if ($hostName) { $hostName } else { 'an unreadable redirect URI' } }
    })
    if (-not $others.Count) { return }
    if (-not $TakeOver) {
        throw "App registration $RegistrationName already signs in another app ($($others -join ', ')). Give this install its own registration with -AppRegistrationName, or pass -TakeOverRegistration to move $RegistrationName to $AppName; sign-in on the other app then stops."
    }
    Write-Warning "-TakeOverRegistration: $RegistrationName moves from $($others -join ', ') to $AppName; sign-in there stops."
}

# What -CreateNetwork adds that Azure bills, printed before it is created.
function Get-LiteNetworkBillables([string]$VnetName, [string]$VaultName, [bool]$CreateZone) {
    $lines = @("VNet $VnetName with subnets snet-console and snet-pe: no charge")
    $lines += "private endpoint pe-${VaultName} for the vault: per hour, plus per GB processed"
    if ($CreateZone) { $lines += 'private DNS zone privatelink.vaultcore.azure.net: per zone per month, plus per million queries' }
    else { $lines += 'the existing privatelink.vaultcore.azure.net zone is reused: no new zone' }
    return $lines
}

# Template parameters beyond the ones every install passes; none for a Foundry and VNet in the
# gateway's resource group, so those installs deploy exactly as before (P63).
function Get-ExtraConsoleParameters([object]$Foundry, [object]$Network) {
    $extra = @()
    if ($Foundry.resourceGroup -ne $ResourceGroup) { $extra += "foundryResourceGroup=$($Foundry.resourceGroup)" }
    if ($Network.gatewayVnet -ne $Network.name) { $extra += "gatewayVnetName=$($Network.gatewayVnet)" }
    return $extra
}

# Entra calls (az ad, Graph) use the CLI's ACTIVE account, not --subscription. On a shared machine
# another process can switch it; the app registration would then be made in the wrong tenant.
function Assert-SameTenant {
    $want = Invoke-Az account show --subscription $Subscription --query tenantId -o json
    $have = Invoke-Az account show --query tenantId -o json
    if (-not $want -or $want -ne $have) {
        throw "The Azure CLI's active account is in a different tenant from $Subscription. Run 'az account set --subscription $Subscription' (or use a separate AZURE_CONFIG_DIR) and retry."
    }
}
Assert-SameTenant
$subscriptionId = (Invoke-Az account show --subscription $Subscription --query id -o json)
if ($subscriptionId -notmatch '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$') { throw 'Invalid resolved subscription id.' }
Write-Host "Discovering the gateway in $ResourceGroup..."
$apim = @(Invoke-Az apim list --subscription $Subscription -g $ResourceGroup --query '[].{name:name,url:gatewayUrl}' -o json)[0]
if (-not $apim) { throw "No API Management instance in $ResourceGroup." }
$suffix = ($apim.name -split '-')[-1]
# Filter in PowerShell: az.cmd on Windows mangles quoted JMESPath filters.
$vault = @(Invoke-Az keyvault list --subscription $Subscription -g $ResourceGroup --query '[].name' -o json) |
    Where-Object { $_ -like 'kv-poc-*' } | Select-Object -First 1
if (-not $vault) { throw "No POC vault (kv-poc-*) in $ResourceGroup; deploy poc/products-keyvault first." }
$network = Resolve-ConsoleNetwork @(Invoke-Az network vnet list --subscription $Subscription -g $ResourceGroup --query '[].name' -o json) $suffix $CreateNetwork.IsPresent
$vnet = $network.name
$foundry = Resolve-Foundry $FoundryResourceGroup $FoundryAccountName
# The gateway's workspace is the one its Application Insights component writes to.
$component = Resolve-GatewayComponent $apim.name
$workspace = ((Invoke-Az resource show --subscription $Subscription --ids $component --query properties.WorkspaceResourceId -o json) -split '/')[-1]
$appName = if ($Hosting -eq 'AppService') { "app-keys-$suffix" } else { "ca-console-$suffix" }
$registry = "crconsole$suffix"
$networkLabel = if ($network.gatewayVnet) { $vnet } else { "$vnet (liteAPIM only$(if ($network.deploy) { ', to be created or updated' }))" }
$foundryLabel = if ($foundry.resourceGroup -ne $ResourceGroup) { "$($foundry.name) in $($foundry.resourceGroup)" } else { $foundry.name }
Write-Host "  APIM $($apim.name), vault $vault, Foundry $foundryLabel, workspace $workspace, network $networkLabel"
Write-Host "  hosting: $Hosting -> $appName, open to $(if ($allowedCidr) { "$allowedCidr only" } else { "any address (sign-in required)" })"

Write-Host "Ensuring app registration $AppRegistrationName..."
$app = @(Invoke-Az ad app list --display-name $AppRegistrationName --query '[0]' -o json)[0]
# A registration has one set of redirect URIs; another install's would be replaced (P63).
if ($app) { Assert-RegistrationOwnership @($app.web.redirectUris) $appName $AppRegistrationName $TakeOverRegistration.IsPresent }
if (-not $app) {
    $rolesFile = Join-Path $root ".console-roles-$([guid]::NewGuid()).json"
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
    $body = Join-Path $root ".console-role-grant-$([guid]::NewGuid()).json"
    @{ principalId = $PrincipalId; resourceId = $sp.id; appRoleId = $roleId } | ConvertTo-Json | Set-Content $body -Encoding utf8
    try {
        $null = Invoke-Az rest --method POST --url "https://graph.microsoft.com/v1.0/servicePrincipals/$($sp.id)/appRoleAssignedTo" `
            --headers 'Content-Type=application/json' --body "@$body"
    } finally { Remove-Item $body -Force }
    Write-Host "  granted $RoleValue to $Label"
}
$me = Invoke-Az ad signed-in-user show --query '{id:id,upn:userPrincipalName}' -o json
Grant-ConsoleRole $me.id 'Console.Admin' $me.upn
# Admin-only dashboard (ADR-0016): keys reach their holders by copy, keys.csv or an export bundle.
foreach ($u in $Admins) { Grant-ConsoleRole (Invoke-Az ad user show --id $u --query id -o json) 'Console.Admin' $u }

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
    $body = Join-Path $root ".console-consent-$([guid]::NewGuid()).json"
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
foreach ($u in $Admins) { Grant-SignInConsent (Invoke-Az ad user show --id $u --query id -o json) $u }

Write-Host "Adding usage telemetry to the POC routes..."
$null = Invoke-Az deployment group create --subscription $Subscription -g $ResourceGroup -n "console-telemetry-$suffix" `
    --template-file (Join-Path $root 'infra/console-telemetry.bicep') --parameters apimName=$($apim.name) -o json

if ($network.deploy) {
    # Keep the address space of a network made by an earlier run; a VNet in use cannot be resized.
    if (@(Invoke-Az network vnet list --subscription $Subscription -g $ResourceGroup --query '[].name' -o json) -contains $network.name) {
        $NetworkPrefix = Invoke-Az network vnet show --subscription $Subscription -g $ResourceGroup -n $network.name --query 'addressSpace.addressPrefixes[0]' -o json
        Assert-NetworkPrefix $NetworkPrefix
    }
    $zones = @(Invoke-Az network private-dns zone list --subscription $Subscription -g $ResourceGroup --query '[].name' -o json)
    $createZone = -not ($zones -contains 'privatelink.vaultcore.azure.net')
    Write-Host "Creating liteAPIM's network $($network.name) ($NetworkPrefix). Billable resources:"
    Get-LiteNetworkBillables $network.name $vault $createZone | ForEach-Object { Write-Host "  billable: $_" }
    $netDeploy = Invoke-Az deployment group create --subscription $Subscription -g $ResourceGroup -n "console-network-$suffix" `
        --template-file (Join-Path $root 'infra/console-network.bicep') `
        --parameters vnetName=$($network.name) addressPrefix=$NetworkPrefix vaultName=$vault createVaultZone=$($createZone.ToString().ToLowerInvariant()) `
        --query 'properties.outputs' -o json
    $SubnetPrefix = $netDeploy.consoleSubnetPrefix.value
} elseif (-not $network.gatewayVnet) {
    $SubnetPrefix = Invoke-Az network vnet subnet show --subscription $Subscription -g $ResourceGroup --vnet-name $network.name -n snet-console --query addressPrefix -o json
}

# What both hosting paths run: the console modules, the canonical model rules, the pack template.
function New-AppContext([string]$Name) {
    $dir = Join-Path $root ".$Name-$suffix"
    Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Path (Join-Path $dir 'src') | Out-Null
    foreach ($f in 'keys.mjs', 'foundry.mjs', 'models.mjs') { Copy-Item (Join-Path $root "src/$f") (Join-Path $dir 'src') }
    Copy-Item (Join-Path $root 'src/console') (Join-Path $dir 'src') -Recurse
    $tpl = Join-Path $dir 'poc/products-keyvault/infra'
    New-Item -ItemType Directory -Path $tpl | Out-Null
    Copy-Item (Join-Path $root 'poc/products-keyvault/infra/product-policy.xml') $tpl
    foreach ($policy in 'poc/products-keyvault/infra/api-openai-policy.xml', 'poc/products-keyvault/infra/api-claude-policy.xml') {
        Copy-Item (Join-Path $root $policy) $tpl
    }
    $gatewayTemplates = Join-Path $dir 'infra'
    New-Item -ItemType Directory -Path $gatewayTemplates | Out-Null
    foreach ($policy in 'infra/policy.xml', 'infra/policy-claude.xml') { Copy-Item (Join-Path $root $policy) $gatewayTemplates }
    @{ name = 'hackgw-key-console'; private = $true; type = 'module'; engines = @{ node = '>=24' } } |
        ConvertTo-Json | Set-Content (Join-Path $dir 'package.json') -Encoding utf8
    return $dir
}

$common = @("vnetName=$vnet", "subnetPrefix=$SubnetPrefix", "vaultName=$vault", "apimName=$($apim.name)",
    "foundryAccountName=$($foundry.name)", "workspaceName=$workspace", "clientId=$($app.appId)",
    "gatewayUrl=$($apim.url)", "allowedCidr=$allowedCidr")
$common += @(Get-ExtraConsoleParameters $foundry $network)

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
    Assert-SafeAzArguments @($Subscription, $ResourceGroup, $registry)
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

function Grant-FoundryDiscovery([string]$PrincipalId, [string]$SubscriptionId) {
    $guidPattern = '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$'
    if ($PrincipalId -notmatch $guidPattern -or $SubscriptionId -notmatch $guidPattern) {
        throw 'Invalid dashboard principal or subscription id; discovery permissions were not granted.'
    }
    $scope = "/subscriptions/$($SubscriptionId.ToLowerInvariant())"
    $roleName = "HackGW Foundry metadata discovery - $($SubscriptionId.ToLowerInvariant())"
    $actions = @('Microsoft.CognitiveServices/accounts/read', 'Microsoft.CognitiveServices/accounts/deployments/read')
    try {
        $roles = @(Invoke-Az role definition list --subscription $SubscriptionId --scope $scope --custom-role-only true -o json)
        # Match in PowerShell: quoted CLI filters are fragile with az.cmd. Azure CLI generates
        # the GUID on create; the subscription-specific display name is our stable lookup key.
        $existing = @($roles | Where-Object { $_.roleName -eq $roleName })
        if ($existing.Count) {
            $role = $existing[0]
        } else {
            $body = Join-Path $root ".foundry-discovery-$([guid]::NewGuid()).json"
            try {
                @{ Name = $roleName; IsCustom = $true
                   Description = 'Discover Foundry accounts and deployments without inference, keys or RBAC access.'
                   Actions = $actions; NotActions = @(); DataActions = @(); NotDataActions = @()
                   AssignableScopes = @($scope) } |
                    ConvertTo-Json -Depth 6 | Set-Content $body -Encoding utf8
                $role = Invoke-Az role definition create --subscription $SubscriptionId --role-definition $body -o json
            } finally { Remove-Item $body -Force -ErrorAction SilentlyContinue }
        }
        $permissions = @($role.permissions)
        if ($existing.Count -gt 1 -or $role.roleName -ne $roleName -or $role.name -notmatch $guidPattern -or
            $role.roleType -ne 'CustomRole' -or @($role.assignableScopes).Count -ne 1 -or
            $role.assignableScopes[0] -ne $scope -or $permissions.Count -ne 1 -or
            @($permissions[0].actions).Count -ne 2 -or
            @(Compare-Object ($permissions[0].actions | Sort-Object) ($actions | Sort-Object)).Count -or
            @($permissions[0].notActions).Count -or @($permissions[0].dataActions).Count -or
            @($permissions[0].notDataActions).Count) {
            throw 'Existing discovery role collision: definition does not match the metadata-only contract; nothing overwritten.'
        }
        $roleId = "$scope/providers/Microsoft.Authorization/roleDefinitions/$($role.name)"
        $existingGrant = @(Invoke-Az role assignment list --subscription $SubscriptionId --scope $scope -o json) |
            Where-Object { $_.principalId -eq $PrincipalId -and $_.scope -eq $scope -and $_.roleDefinitionId -eq $roleId }
        if (-not $existingGrant) {
            $null = Invoke-Az role assignment create --subscription $SubscriptionId --assignee-object-id $PrincipalId `
                --assignee-principal-type ServicePrincipal --scope $scope --role $roleId -o json
        }
    } catch {
        throw "Discovery permission NOT ready. The operator needs subscription custom-role definition and role assignment privileges (roleDefinitions/write, roleAssignments/write). Ask a subscription RBAC administrator to run this installer. $($_.Exception.Message)"
    }
    Write-Host 'Foundry discovery permission ready (account and deployment metadata only; RBAC propagation may take time).'
}
Grant-FoundryDiscovery $deploy.principalId.value $subscriptionId
$redirectUris = Invoke-Az ad app show --id $app.appId --query web.redirectUris -o json
Assert-RegistrationOwnership @($redirectUris) $appName $AppRegistrationName $TakeOverRegistration.IsPresent
$null = Invoke-Az ad app update --id $app.appId --web-redirect-uris "$url/.auth/login/aad/callback" --enable-id-token-issuance true

Write-Host "Waiting for $url/healthz ..."
$healthy = $false
for ($i = 0; $i -lt 30 -and -not $healthy; $i++) {
    try { $healthy = (Invoke-WebRequest "$url/healthz" -TimeoutSec 20).StatusCode -eq 200 } catch { Start-Sleep 10 }
}
if (-not $healthy) { throw "$url/healthz did not answer 200 within five minutes." }
Write-Host "liteAPIM ($Hosting): $url  (sign in as an admin, open Settings, then under Signing secret select Migrate from API Management)"