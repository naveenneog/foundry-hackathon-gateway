<#
    P37 proof of concept: drive the runner VM (../infra/runner.bicep) from this machine, for a
    vault that accepts only private traffic. Every step goes through Azure Run Command; nothing
    connects to the VM directly, and no key passes through this machine.

        -Step Deploy  the private endpoint, NAT, subnet and VM (a throwaway SSH key is generated
                      for the VM's required login and deleted at once)
        -Step Setup   install the Azure CLI, PowerShell, Node.js and Claude Code on the VM, and
                      sign the CLI in with the VM's managed identity
        -Step Push    copy the key scripts and the apiKeyHelper to /opt/poc, verified by SHA-256
        -Step Test    start Test-Poc.ps1 on the VM as a systemd unit, so no call stays open
        -Step Fetch   print a page of the run's check lines (-From, -Lines); no keys are logged
#>
param(
    [Parameter(Mandatory)][ValidateSet('Deploy', 'Setup', 'Push', 'Test', 'Fetch')][string]$Step,
    [Parameter(Mandatory)][string]$Subscription,
    # These three reach a shell running as root on the VM, so only plain names are accepted.
    [Parameter(Mandatory)][ValidatePattern('^[A-Za-z0-9._-]{1,90}$')][string]$ResourceGroup,
    [Parameter(Mandatory)][ValidatePattern('^[A-Za-z][A-Za-z0-9-]{0,49}$')][string]$ApimName,
    [Parameter(Mandatory)][ValidatePattern('^[A-Za-z][A-Za-z0-9-]{1,22}[A-Za-z0-9]$')][string]$VaultName,
    [string]$VnetName = 'vnet-hackgw-pe',
    [string]$VmName = 'vm-poc-runner',
    [int]$From = 1,
    [int]$Lines = 11
)
$ErrorActionPreference = 'Stop'
$poc = Join-Path $PSScriptRoot '..'

function Invoke-OnRunner([string]$Bash) {
    $file = Join-Path ([IO.Path]::GetTempPath()) "poc-runner-$([guid]::NewGuid().ToString('N')).sh"
    Set-Content -Path $file -Value ($Bash -replace "`r`n", "`n") -Encoding utf8NoBOM -NoNewline
    try {
        $out = az vm run-command invoke --subscription $Subscription -g $ResourceGroup -n $VmName `
            --command-id RunShellScript --scripts "@$file" -o json
        if ($LASTEXITCODE -ne 0) { throw "Run Command on $VmName failed." }
        # Run Command returns the last 4,096 bytes of standard output and of standard error.
        return (($out | ConvertFrom-Json).value | ForEach-Object { $_.message }) -join "`n"
    } finally { Remove-Item -LiteralPath $file -ErrorAction SilentlyContinue }
}

switch ($Step) {
    'Deploy' {
        $keyFile = Join-Path ([IO.Path]::GetTempPath()) "poc-runner-$([guid]::NewGuid().ToString('N'))"
        ssh-keygen -q -t rsa -b 3072 -N '' -f $keyFile | Out-Null
        try { $publicKey = (Get-Content "$keyFile.pub" -Raw).Trim() }
        finally { Remove-Item -LiteralPath $keyFile, "$keyFile.pub" -ErrorAction SilentlyContinue }
        $deployment = "poc-runner-$(Get-Date -Format 'yyyyMMddHHmmss')"
        az deployment group create --subscription $Subscription -g $ResourceGroup -n $deployment `
            --template-file (Join-Path $poc 'infra' 'runner.bicep') `
            --parameters vnetName=$VnetName vaultName=$VaultName apimName=$ApimName sshPublicKey="$publicKey" -o none
        if ($LASTEXITCODE -ne 0) { throw "Deployment $deployment failed." }
        Write-Host "Deployed $VmName with a private endpoint for $VaultName."
    }
    'Setup' {
        Invoke-OnRunner @'
set -e
export HOME=/root DEBIAN_FRONTEND=noninteractive
apt-get update -y -q >/dev/null
apt-get install -y -q ca-certificates curl wget gnupg lsb-release nodejs npm >/dev/null
curl -sL https://aka.ms/InstallAzureCLIDeb | bash >/dev/null
wget -q https://packages.microsoft.com/config/ubuntu/24.04/packages-microsoft-prod.deb -O /tmp/pmp.deb
dpkg -i /tmp/pmp.deb >/dev/null && apt-get update -y -q >/dev/null && apt-get install -y -q powershell >/dev/null
npm install -g --silent @anthropic-ai/claude-code >/dev/null
az login --identity -o none
echo "az $(az version --query '"azure-cli"' -o tsv); pwsh $(pwsh -v); node $(node -v); claude $(claude --version)"
echo "subscriptions visible to the VM identity: $(az account list --query 'length(@)' -o tsv)"
'@
    }
    'Push' {
        $files = [ordered]@{
            '/opt/poc/scripts/PocKeys.ps1'        = Join-Path $poc 'scripts' 'PocKeys.ps1'
            '/opt/poc/scripts/PocMeasure.ps1'     = Join-Path $poc 'scripts' 'PocMeasure.ps1'
            '/opt/poc/scripts/Test-Poc.ps1'       = Join-Path $poc 'scripts' 'Test-Poc.ps1'
            '/opt/poc/claude-code/Get-PocKey.ps1' = Join-Path $poc 'claude-code' 'Get-PocKey.ps1'
        }
        $bash = "set -e`nmkdir -p /opt/poc/scripts /opt/poc/claude-code`n"
        foreach ($target in $files.Keys) {
            $b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($files[$target]))
            $bash += "base64 -d > $target <<'POC_EOF'`n$b64`nPOC_EOF`n"
        }
        $bash += "sha256sum $($files.Keys -join ' ')`n"
        $remote = Invoke-OnRunner $bash
        foreach ($target in $files.Keys) {
            $local = (Get-FileHash -Algorithm SHA256 $files[$target]).Hash.ToLowerInvariant()
            $ok = $remote -match "$local\s+$([regex]::Escape($target))"
            Write-Host ('{0}  {1}' -f $(if ($ok) { 'same' } else { 'DIFFERENT' }), $target)
            if (-not $ok) { throw "$target did not arrive intact." }
        }
    }
    'Test' {
        $id = "$(az account show --subscription $Subscription --query id -o tsv)".Trim()
        if ($LASTEXITCODE -ne 0 -or $id -notmatch '^[0-9a-fA-F-]{36}$') { throw "The Azure CLI cannot use subscription '$Subscription'." }
        Invoke-OnRunner @"
set -e
rm -f /opt/poc/run.log /opt/poc/results.json
systemd-run --unit=poc-test-`$(date +%s) --setenv=HOME=/root /bin/bash -c "pwsh -NoProfile -File /opt/poc/scripts/Test-Poc.ps1 -Subscription '$id' -ResourceGroup '$ResourceGroup' -ApimName '$ApimName' -VaultName '$VaultName' -ResultsPath /opt/poc/results.json > /opt/poc/run.log 2>&1; echo EXIT \`$? >> /opt/poc/run.log"
echo started
"@
    }
    'Fetch' {
        # Run Command returns at most 4,096 bytes, so the log is read a page of lines at a time.
        # Failure lines are included, so a run that stopped shows why.
        $to = $From + $Lines - 1
        Invoke-OnRunner @"
if [ -f /opt/poc/run.log ]; then grep -E '^(PASS|FAIL|SKIP|Run |EXIT|Results|[0-9]+ of )|failed:|Exception' /opt/poc/run.log | cut -c1-330 | sed -n '$From,${to}p'; else echo 'no run.log yet'; fi
"@
    }
}
