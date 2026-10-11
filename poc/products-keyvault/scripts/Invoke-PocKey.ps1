<#
    P37 proof of concept: the command line for PocKeys.ps1. Keys are never printed.

        ./Invoke-PocKey.ps1 -Action New -Name alice -Product poc-claude-pack @target
        ./Invoke-PocKey.ps1 -Action Rotate -Name alice @target
        ./Invoke-PocKey.ps1 -Action SetExpiry -Name alice -ExpiresUtc 2027-01-01T00:00:00Z @target
        ./Invoke-PocKey.ps1 -Action SuspendExpired @target

    where $target = @{ Subscription = '<id or name>'; ResourceGroup = '<rg>'; ApimName = '<apim>';
    VaultName = '<vault>' }. Deploy-Poc.ps1 prints the vault name.
#>
param(
    [Parameter(Mandatory)][ValidateSet('New', 'Rotate', 'SetExpiry', 'SuspendExpired')][string]$Action,
    [Parameter(Mandatory)][string]$Subscription,
    [Parameter(Mandatory)][string]$ResourceGroup,
    [Parameter(Mandatory)][string]$ApimName,
    [Parameter(Mandatory)][string]$VaultName,
    [string]$Name,
    [string]$Product,
    [datetime]$ExpiresUtc
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'PocKeys.ps1')

$ctx = New-PocContext -Subscription $Subscription -ResourceGroup $ResourceGroup -ApimName $ApimName -VaultName $VaultName
switch ($Action) {
    'New' { $null = New-PocKey -Context $ctx -Name $Name -Product $Product }
    'Rotate' { $null = Invoke-PocKeyRotation -Context $ctx -Name $Name }
    'SetExpiry' { Set-PocKeyExpiry -Context $ctx -Name $Name -ExpiresUtc $ExpiresUtc }
    'SuspendExpired' { $null = Suspend-ExpiredPocKeys -Context $ctx }
}
