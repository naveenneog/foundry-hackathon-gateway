<#
    P37 proof of concept: Claude Code's apiKeyHelper. Writes the current key from Key Vault to
    standard output, which is how apiKeyHelper hands a credential to Claude Code; nothing else
    reads it. Used when `az keyvault secret show` cannot be pointed at the vault's tenant.

    settings.json: "apiKeyHelper": "pwsh -NoProfile -File <path>/Get-PocKey.ps1 -Subscription <id> -VaultName <vault> -Name <name>"

    -LogPath appends one line per call, "<UTC time> <secret version>", and nothing else. The
    version is the last segment of the secret's id and is not secret; it lets a test tell which
    key each call returned.
#>
param(
    [Parameter(Mandatory)][string]$Subscription,
    [Parameter(Mandatory)][string]$VaultName,
    [Parameter(Mandatory)][string]$Name,
    [string]$LogPath = ''
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..' 'scripts' 'PocKeys.ps1')
$ctx = New-PocContext -Subscription $Subscription -ResourceGroup 'unused' -ApimName 'unused' -VaultName $VaultName
$record = Get-PocKeyRecord -Context $ctx -Name $Name
if ($LogPath) { Add-Content -LiteralPath $LogPath -Value "$([datetime]::UtcNow.ToString('o')) $($record.Version)" }
[Console]::Out.Write($record.Value)
