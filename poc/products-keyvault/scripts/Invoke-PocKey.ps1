<#
    P37 proof of concept: the command line for PocKeys.ps1. Keys are never printed.

        ./Invoke-PocKey.ps1 -Action New -Name alice -Product poc-claude-pack @target -VaultName <vault>
        ./Invoke-PocKey.ps1 -Action Rotate -Name alice @target -VaultName <vault>
        ./Invoke-PocKey.ps1 -Action Grant -Name alice -ObjectId <object-id> @target -VaultName <vault>
        ./Invoke-PocKey.ps1 -Action SetExpiry -Name alice -ExpiresUtc 2027-01-31 @target
        ./Invoke-PocKey.ps1 -Action SuspendExpired @target
        ./Invoke-PocKey.ps1 -Action Suspend -Name alice @target
        ./Invoke-PocKey.ps1 -Action Resume -Name alice @target
        ./Invoke-PocKey.ps1 -Action List @target

    where $target = @{ Subscription = '<id or name>'; ResourceGroup = '<rg>'; ApimName = '<apim>' }.
    New and Rotate move a key into Key Vault, so they need -VaultName and a network path to the
    vault. Grant needs -VaultName for the role's scope but no path to the vault. The other actions
    use API Management only. See ../SETUP.md.
#>
param(
    [Parameter(Mandatory)][ValidateSet('New', 'Rotate', 'Grant', 'SetExpiry', 'SuspendExpired', 'Suspend', 'Resume', 'List')][string]$Action,
    [Parameter(Mandatory)][string]$Subscription,
    [Parameter(Mandatory)][string]$ResourceGroup,
    [Parameter(Mandatory)][string]$ApimName,
    [string]$VaultName = '',
    [string]$Name,
    [string]$Product,
    [datetime]$ExpiresUtc,
    # Grant: the object id of the user, group or service principal that gets read access.
    [string]$ObjectId = '',
    [ValidateSet('User', 'Group', 'ServicePrincipal')][string]$PrincipalType = 'User'
)
$ErrorActionPreference = 'Stop'
if ($Action -in 'New', 'Rotate', 'Grant' -and -not $VaultName) {
    throw "-VaultName is needed for ${Action}: the key's secret is in that vault."
}
. (Join-Path $PSScriptRoot 'PocKeys.ps1')

$ctx = New-PocContext -Subscription $Subscription -ResourceGroup $ResourceGroup -ApimName $ApimName -VaultName $(if ($VaultName) { $VaultName } else { 'none' })
switch ($Action) {
    'New' { $null = New-PocKey -Context $ctx -Name $Name -Product $Product }
    'Rotate' { $null = Invoke-PocKeyRotation -Context $ctx -Name $Name }
    'Grant' { Grant-PocKeyAccess -Context $ctx -Name $Name -ObjectId $ObjectId -PrincipalType $PrincipalType }
    'SetExpiry' { Set-PocKeyExpiry -Context $ctx -Name $Name -ExpiresUtc $ExpiresUtc }
    'SuspendExpired' { $null = Suspend-ExpiredPocKeys -Context $ctx }
    'Suspend' { Set-PocKeyState -Context $ctx -Name $Name -State suspended }
    'Resume' { Set-PocKeyState -Context $ctx -Name $Name -State active }
    'List' { Get-PocKeyList -Context $ctx | Format-Table Name, Product, State, Expires -AutoSize | Out-String | Write-Host }
}
