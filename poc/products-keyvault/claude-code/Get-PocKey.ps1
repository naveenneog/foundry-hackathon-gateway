<#
    P37 proof of concept: Claude Code's apiKeyHelper. Writes the current key from Key Vault to
    standard output, which is how apiKeyHelper hands a credential to Claude Code; nothing else
    reads it. Used when `az keyvault secret show` cannot be pointed at the vault's tenant.

    settings.json: "apiKeyHelper": "pwsh -NoProfile -File <path>/Get-PocKey.ps1 -Subscription <id> -VaultName <vault> -Name <name>"

    -LogPath appends one UTC timestamp per call, and nothing else, so a test can count how often
    Claude Code asked for the key.
#>
param(
    [Parameter(Mandatory)][string]$Subscription,
    [Parameter(Mandatory)][string]$VaultName,
    [Parameter(Mandatory)][string]$Name,
    [string]$LogPath = ''
)
$ErrorActionPreference = 'Stop'
if ($LogPath) { Add-Content -LiteralPath $LogPath -Value ([datetime]::UtcNow.ToString('o')) }
. (Join-Path $PSScriptRoot '..' 'scripts' 'PocKeys.ps1')
$ctx = New-PocContext -Subscription $Subscription -ResourceGroup 'unused' -ApimName 'unused' -VaultName $VaultName
[Console]::Out.Write((Get-PocKey -Context $ctx -Name $Name))
