<#
    P37 proof of concept: deploy ../infra/poc.bicep onto an existing v2 API Management instance.
    Adds poc- routes, products and policies, one Key Vault, and Key Vault Secrets Officer for the
    signed-in operator. Prints names and URLs only. See ../README.md.
#>
param(
    [Parameter(Mandatory)][string]$Subscription,
    [Parameter(Mandatory)][string]$ResourceGroup,
    [Parameter(Mandatory)][string]$ApimName,
    [Parameter(Mandatory)][string]$FoundryAccountName,
    [string]$AuditWorkspaceName = ''
)
$ErrorActionPreference = 'Stop'
$template = Join-Path $PSScriptRoot '..' 'infra' 'poc.bicep'

# The operator's object id, from their own token for this subscription's tenant. No directory
# (Graph) call, so this works where directory reads are restricted.
$token = "$(az account get-access-token --subscription $Subscription --query accessToken -o tsv)".Trim()
if ($LASTEXITCODE -ne 0 -or -not $token) { throw "No token for subscription '$Subscription'. Run az login." }
$payload = $token.Split('.')[1].Replace('-', '+').Replace('_', '/')
$payload += '=' * ((4 - $payload.Length % 4) % 4)
$claims = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload)) | ConvertFrom-Json
$token = $null
$principalType = if ($claims.idtyp -eq 'app') { 'ServicePrincipal' } else { 'User' }

$parameters = @(
    "apimName=$ApimName"
    "foundryAccountName=$FoundryAccountName"
    "operatorObjectId=$($claims.oid)"
    "operatorPrincipalType=$principalType"
)
if ($AuditWorkspaceName) { $parameters += "auditWorkspaceName=$AuditWorkspaceName" }

$deployment = "poc-products-keyvault-$(Get-Date -Format 'yyyyMMddHHmmss')"
Write-Host "Deploying $deployment to $ResourceGroup ..."
$outputs = az deployment group create --subscription $Subscription --resource-group $ResourceGroup `
    --name $deployment --template-file $template --parameters @parameters `
    --query properties.outputs -o json
if ($LASTEXITCODE -ne 0) {
    throw "Deployment $deployment failed. Details: az deployment operation group list --subscription <subscription> -g $ResourceGroup -n $deployment"
}
$o = $outputs | ConvertFrom-Json
Write-Host ''
Write-Host "Key Vault   : $($o.vaultName.value)"
Write-Host "Claude route: $($o.claudeBaseUrl.value)"
Write-Host "OpenAI route: $($o.openaiBaseUrl.value)"
Write-Host "Probe       : $($o.probeUrl.value)"
Write-Host ''
Write-Host 'Azure RBAC role assignments can take a few minutes to apply before the vault accepts this operator.'
