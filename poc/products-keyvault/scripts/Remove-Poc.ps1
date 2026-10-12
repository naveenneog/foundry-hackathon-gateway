<#
    P37 proof of concept: remove everything poc.bicep, runner.bicep and the key scripts created.
    Products are deleted with their subscriptions; the routes, any leftover poc- subscriptions,
    the operator's role assignment and the vault follow. A step that finds nothing is skipped.
    Each step's result is checked: a failure is reported, the rest still run, and the script
    exits 1 if anything was left behind.
#>
param(
    [Parameter(Mandatory)][string]$Subscription,
    [Parameter(Mandatory)][string]$ResourceGroup,
    [Parameter(Mandatory)][string]$ApimName,
    [string]$VaultName = '',
    [switch]$PurgeVault,
    # Also remove what runner.bicep added: the VM and its roles, NAT, subnet and private endpoint,
    # and the privatelink DNS zone if no other record is left in it.
    [switch]$Runner,
    [string]$VnetName = 'vnet-hackgw-pe'
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'PocKeys.ps1')
$ctx = New-PocContext -Subscription $Subscription -ResourceGroup $ResourceGroup -ApimName $ApimName -VaultName $(if ($VaultName) { $VaultName } else { 'none' })
$failures = [System.Collections.Generic.List[string]]::new()

# Runs one az command and reports what happened; a non-zero exit is recorded, not hidden.
function Invoke-RemovalStep([string]$Label, [scriptblock]$Command) {
    $output = & $Command 2>&1 | Out-String
    if ($LASTEXITCODE -eq 0) { Write-Host "Removed $Label." }
    else {
        $failures.Add($Label)
        Write-Host "Could not remove ${Label}: $(($output -split "`n" | Where-Object { $_ -match 'ERROR|Code:' } | Select-Object -First 1).Trim())"
    }
}

if ($Runner) {
    $principal = "$(az vm show -g $ResourceGroup -n vm-poc-runner --subscription $Subscription --query identity.principalId -o tsv 2>$null)".Trim()
    if ($principal) {
        $apimId = "$(az apim show -g $ResourceGroup -n $ApimName --subscription $Subscription --query id -o tsv)".Trim()
        $vaultId = if ($VaultName) { "$(az keyvault show --name $VaultName --subscription $Subscription --query id -o tsv 2>$null)".Trim() } else { '' }
        foreach ($scope in @($apimId, $vaultId) | Where-Object { $_ }) {
            Invoke-RemovalStep "the runner's role on $($scope.Split('/')[-1])" { az role assignment delete --assignee-object-id $principal --scope $scope --subscription $Subscription }
        }
        Invoke-RemovalStep 'the runner VM, its disk and NIC' { az vm delete -g $ResourceGroup -n vm-poc-runner --subscription $Subscription --yes -o none }
    } else { Write-Host 'The runner VM was not there.' }
    Invoke-RemovalStep 'the runner subnet' { az network vnet subnet delete -g $ResourceGroup --vnet-name $VnetName -n snet-poc-runner --subscription $Subscription -o none }
    Invoke-RemovalStep 'the NAT gateway' { az network nat gateway delete -g $ResourceGroup -n nat-poc-runner --subscription $Subscription -o none }
    Invoke-RemovalStep "the NAT gateway's public IP" { az network public-ip delete -g $ResourceGroup -n pip-poc-runner-nat --subscription $Subscription -o none }
    Invoke-RemovalStep 'the runner NSG' { az network nsg delete -g $ResourceGroup -n nsg-poc-runner --subscription $Subscription -o none }
    if ($VaultName) {
        # The endpoint's DNS zone group removes its own record from the zone.
        Invoke-RemovalStep "the vault's private endpoint" { az network private-endpoint delete -g $ResourceGroup -n "pe-$VaultName" --subscription $Subscription -o none }
    }
    # The zone is the resource group's, not only this POC's: it goes only if no record is left.
    $zone = 'privatelink.vaultcore.azure.net'
    $records = @(az network private-dns record-set a list -g $ResourceGroup -z $zone --subscription $Subscription --query '[].name' -o tsv 2>$null | Where-Object { $_ })
    if ($LASTEXITCODE -ne 0) { Write-Host "The $zone zone was not there." }
    elseif ($records.Count -gt 0) { Write-Host "Kept the $zone zone: it still holds $($records.Count) other record(s)." }
    else {
        Invoke-RemovalStep "the $zone link to $VnetName" { az network private-dns link vnet delete -g $ResourceGroup -z $zone -n "link-$VnetName" --subscription $Subscription --yes -o none }
        Invoke-RemovalStep "the $zone zone" { az network private-dns zone delete -g $ResourceGroup -n $zone --subscription $Subscription --yes -o none }
    }
}

function Remove-PocItem([string]$Path, [string]$Label) {
    try {
        $null = Invoke-PocApim -Context $ctx -Method DELETE -Path $Path -IfMatch
        Write-Host "Removed $Label."
    } catch {
        if ("$_" -match '404|NotFound') { Write-Host "$Label was not there." }
        else { $failures.Add($Label); Write-Host "Could not remove ${Label}: $_" }
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
        # Read access given by Grant: Key Vault Secrets User on single key secrets of this vault.
        # Removed before the vault, so none outlives it.
        $listed = az role assignment list --all --subscription $Subscription -o json 2>$null
        if ($LASTEXITCODE -ne 0) {
            $failures.Add("the read access Grant gave on $VaultName's secrets")
            Write-Host "Could not list the role assignments on $VaultName's secrets."
        } else {
            $all = if ($listed) { @(($listed | Out-String) | ConvertFrom-Json) } else { @() }
            foreach ($g in @($all | Where-Object { $_.id -and "$($_.scope)" -like "$vaultId/secrets/poc-key-*" })) {
                Invoke-RemovalStep "read access to $("$($g.scope)".Split('/')[-1]) for $($g.principalId)" { az role assignment delete --ids $g.id --subscription $Subscription }
            }
        }
        Invoke-RemovalStep "the operator's role on $VaultName" { az role assignment delete --scope $vaultId --role 'Key Vault Secrets Officer' --subscription $Subscription }
        Invoke-RemovalStep "vault $VaultName (soft-deleted for its retention period)" { az keyvault delete --name $VaultName --subscription $Subscription -o none }
        if ($PurgeVault) { Invoke-RemovalStep "vault $VaultName, purged" { az keyvault purge --name $VaultName --subscription $Subscription -o none } }
    } else { Write-Host "Vault $VaultName was not there." }
}

if ($failures.Count -gt 0) {
    Write-Host "Left behind: $($failures -join '; ')."
    exit 1
}
