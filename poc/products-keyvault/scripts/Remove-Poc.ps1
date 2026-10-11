<#
    P37 proof of concept: remove everything poc.bicep and the key scripts created. Products are
    deleted with their subscriptions; the routes, any leftover poc- subscriptions, the operator's
    role assignment and the vault follow. Each step that finds nothing is skipped.
#>
param(
    [Parameter(Mandatory)][string]$Subscription,
    [Parameter(Mandatory)][string]$ResourceGroup,
    [Parameter(Mandatory)][string]$ApimName,
    [string]$VaultName = '',
    [switch]$PurgeVault
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'PocKeys.ps1')
$ctx = New-PocContext -Subscription $Subscription -ResourceGroup $ResourceGroup -ApimName $ApimName -VaultName $(if ($VaultName) { $VaultName } else { 'none' })

function Remove-PocItem([string]$Path, [string]$Label) {
    try {
        $null = Invoke-PocApim -Context $ctx -Method DELETE -Path $Path -IfMatch
        Write-Host "Removed $Label."
    } catch {
        if ("$_" -match '404|NotFound') { Write-Host "$Label was not there." } else { throw }
    }
}

foreach ($p in 'poc-claude-pack', 'poc-deepseek-pack', 'poc-tiny-pack') {
    Remove-PocItem "/products/$p`?deleteSubscriptions=true" "product $p and its keys"
}
foreach ($a in 'poc-claude', 'poc-openai', 'poc-probe') { Remove-PocItem "/apis/$a" "route $a" }

# Keys not on a product (Test-Poc.ps1 creates all-APIs and single-API keys for a few seconds).
$page = Invoke-PocApim -Context $ctx -Method GET -Path '/subscriptions'
while ($page) {
    foreach ($s in @($page.value) | Where-Object { $_.name -like 'poc-*' }) { Remove-PocItem "/subscriptions/$($s.name)" "key $($s.name)" }
    $page = if ($page.nextLink) { Invoke-PocApim -Context $ctx -Method GET -Path $page.nextLink } else { $null }
}

if ($VaultName) {
    $vaultId = "$(az keyvault show --name $VaultName --subscription $Subscription --query id -o tsv 2>$null)".Trim()
    if ($vaultId) {
        az role assignment delete --scope $vaultId --role 'Key Vault Secrets Officer' --subscription $Subscription 2>$null
        az keyvault delete --name $VaultName --subscription $Subscription -o none
        Write-Host "Deleted vault $VaultName (soft-deleted for its retention period)."
        if ($PurgeVault) {
            az keyvault purge --name $VaultName --subscription $Subscription -o none
            Write-Host "Purged vault $VaultName."
        }
    } else { Write-Host "Vault $VaultName was not there." }
}
