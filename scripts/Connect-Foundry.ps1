#requires -Version 7
<#
.SYNOPSIS
  Grant an existing APIM gateway inference access to one selected Foundry account.
.DESCRIPTION
  Operator-only permission setup for P56 (ADR-0017). Resolves the subscription without changing
  the CLI account/login/profile. Requires roleAssignments/write on the selected account.
  Does not attach APIs, change firewall/DNS, or grant dashboard permissions. The dashboard's
  subscription discovery role reads metadata only; it cannot perform this operator grant.
  AIServices: Cognitive Services User. OpenAI: Cognitive Services OpenAI User.
  Built-in IDs verified against Microsoft Learn's AI + machine learning role reference, 2026-10-23:
  https://learn.microsoft.com/azure/role-based-access-control/built-in-roles/ai-machine-learning
.EXAMPLE
  pwsh scripts/Connect-Foundry.ps1 -Subscription <subId> -ResourceGroup <apimRG> -ApimName <apim> -FoundryAccountId <accountId>
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Subscription,
    [Parameter(Mandatory)][string]$ResourceGroup,
    [Parameter(Mandatory)][string]$ApimName,
    [Parameter(Mandatory)][AllowEmptyString()][string]$FoundryAccountId
)
$ErrorActionPreference = 'Stop'

function Assert-SafeAzArguments([object[]]$Values) {
    foreach ($value in $Values) {
        # Protect the az.cmd boundary as well as the PowerShell invocation.
        if ([string]$value -match '[&|<>^%!"`;\r\n()]') { throw 'Unsafe Azure CLI argument: shell metacharacter refused.' }
    }
}
function Invoke-Az {
    Assert-SafeAzArguments $args
    $out = & az @args 2>&1
    if ($LASTEXITCODE -ne 0) { throw 'Azure CLI command failed. Verify operator read access and roleAssignments/write at the selected account, then retry.' }
    $text = ($out | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] }) -join "`n"
    if ($text.Trim()) { return $text | ConvertFrom-Json }
}
Assert-SafeAzArguments @($Subscription, $ResourceGroup, $ApimName, $FoundryAccountId)
if ([string]::IsNullOrWhiteSpace($Subscription) -or $Subscription.StartsWith('-')) { throw 'Invalid subscription.' }
if ($ResourceGroup -notmatch '^[a-zA-Z0-9_.-]{1,90}$' -or $ResourceGroup.EndsWith('.')) { throw 'Invalid resource group.' }
if ($ApimName -notmatch '^[a-zA-Z0-9][a-zA-Z0-9-]*$') { throw 'Invalid APIM name.' }
$guidPattern = '[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}'
if ($FoundryAccountId -notmatch "^/subscriptions/($guidPattern)/resourceGroups/([a-zA-Z0-9_.-]{1,90})/providers/Microsoft\.CognitiveServices/accounts/([a-zA-Z0-9][a-zA-Z0-9-]*)$") {
    throw 'Invalid FoundryAccountId: supply the exact Cognitive Services accounts ARM resource id, not a URL or deployment.'
}
$accountSubscription = $Matches[1]
$selected = Invoke-Az account show --subscription $Subscription -o json
if ($selected.id -notmatch "^$guidPattern$" -or $selected.id -ne $accountSubscription) {
    throw 'The selected Foundry account must belong to the chosen subscription.'
}
$subscriptionId = $selected.id
$account = Invoke-Az resource show --subscription $subscriptionId --ids $FoundryAccountId -o json
if ($account.id -ne $FoundryAccountId -or $null -eq $account.properties) { throw 'Foundry account metadata did not match the requested account.' }
$roleId = switch ($account.kind) {
    'AIServices' { 'a97b65f3-24c7-4388-baec-2e87135dc908' }
    'OpenAI' { '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd' }
    default { throw 'Unsupported account kind: select an AIServices or OpenAI Foundry account.' }
}
$apim = Invoke-Az apim show --subscription $subscriptionId --resource-group $ResourceGroup --name $ApimName -o json
$principalId = $apim.identity.principalId
if ($principalId -notmatch "^$guidPattern$") { throw 'APIM must have a nonempty system-assigned managed identity principal id.' }
# Verify the public built-in ID rather than accepting a similarly named custom role.
$roles = @(Invoke-Az role definition list --subscription $subscriptionId --name $roleId -o json)
if ($roles.Count -ne 1 -or $roles[0].name -ne $roleId -or $roles[0].roleType -ne 'BuiltInRole') {
    throw 'The required built-in inference role could not be verified.'
}
$assignments = @(Invoke-Az role assignment list --subscription $subscriptionId --scope $FoundryAccountId -o json)
$existing = $assignments | Where-Object {
    $_.principalId -eq $principalId -and $_.scope -eq $FoundryAccountId -and
    $_.roleDefinitionId -match "/providers/Microsoft\.Authorization/roleDefinitions/$roleId$"
}
if (-not $existing) {
    $null = Invoke-Az role assignment create --subscription $subscriptionId --assignee-object-id $principalId `
        --assignee-principal-type ServicePrincipal --role $roleId --scope $FoundryAccountId -o json
}
Write-Host 'APIM inference role grant configured (RBAC propagation may take time).'
Write-Host 'Private networking and DNS still must be reachable from APIM; no firewall or DNS settings were changed.'
Write-Host 'Return to the UI and run Test for the attached account. This helper does not attach APIs.'
