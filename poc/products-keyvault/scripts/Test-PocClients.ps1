<#
    P38: run every client example in ../examples against the live gateway, so the setup guide
    shows only what works. Two temporary keys, one per pack, are issued through API Management
    directly (the examples need a key, not the vault), passed to each example in POC_KEY, never
    printed, and deleted at the end.

    Needs Python 3 (a virtual environment with the anthropic and openai packages is created in
    -WorkDir), Node.js and npm (the openai package is installed in -WorkDir), and curl. opencode
    and Claude Code are run when installed. Exit code 1 if any example fails.

    Examples run: claude-request.json, openai-request.json (curl); anthropic_sdk.py,
    openai_sdk.py, openai_sdk.mjs; opencode.json; Claude Code with ANTHROPIC_API_KEY; and Claude
    Code with ../claude-code/settings.example.json, whose apiKeyHelper is replaced by one that
    prints POC_KEY (the vault may be private), plus a control with a wrong key that must be
    refused.
#>
param(
    [Parameter(Mandatory)][string]$Subscription,
    [Parameter(Mandatory)][string]$ResourceGroup,
    [Parameter(Mandatory)][string]$ApimName,
    [string]$ClaudeProduct = 'poc-claude-pack',
    [string]$OpenAiProduct = 'poc-deepseek-pack',
    [string]$WorkDir = (Join-Path ([IO.Path]::GetTempPath()) 'poc-clients')
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'PocKeys.ps1')
. (Join-Path $PSScriptRoot 'PocMeasure.ps1')
$ctx = New-PocContext -Subscription $Subscription -ResourceGroup $ResourceGroup -ApimName $ApimName -VaultName 'none'
$examples = (Resolve-Path (Join-Path $PSScriptRoot '..' 'examples')).Path
$run = [datetime]::UtcNow.ToString('MMddHHmm')
$results = [System.Collections.Generic.List[object]]::new()

function Add-Result([string]$Check, [bool]$Pass, [string]$Detail) {
    $results.Add([pscustomobject]@{ check = $Check; pass = $Pass; detail = $Detail })
    Write-Host ('{0}  {1} - {2}' -f $(if ($Pass) { 'PASS' } else { 'FAIL' }), $Check, $Detail)
}
function Get-Snippet([string]$Text) { $t = ($Text -replace '\s+', ' ').Trim(); $t.Substring(0, [Math]::Min(160, $t.Length)) }

# --- Tools, installed once into the work directory -----------------------------------------
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
$venv = Join-Path $WorkDir 'venv'
$python = if ($IsWindows) { Join-Path $venv 'Scripts' 'python.exe' } else { Join-Path $venv 'bin' 'python' }
if (-not (Test-Path $python)) {
    $system = if (Get-Command python3 -ErrorAction SilentlyContinue) { 'python3' } else { 'python' }
    & $system -m venv $venv
    & $python -m pip install --quiet --disable-pip-version-check anthropic openai
    if ($LASTEXITCODE -ne 0) { throw 'Installing the anthropic and openai packages failed.' }
}
$nodeDir = Join-Path $WorkDir 'node'
if (-not (Test-Path (Join-Path $nodeDir 'node_modules' 'openai'))) {
    New-Item -ItemType Directory -Force -Path $nodeDir | Out-Null
    npm install --silent --no-audit --no-fund --prefix $nodeDir openai | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Installing the openai package for Node.js failed.' }
}
# Node.js resolves packages from the script's own folder, so the example runs from there.
Copy-Item (Join-Path $examples 'openai_sdk.mjs') $nodeDir -Force
$curl = if ($IsWindows) { 'curl.exe' } else { 'curl' }

# --- Two temporary keys --------------------------------------------------------------------
$keys = @{}
$sids = [ordered]@{ claude = "poc-client-claude-$run"; openai = "poc-client-openai-$run" }
$products = @{ claude = $ClaudeProduct; openai = $OpenAiProduct }
$saved = @{}
foreach ($v in 'POC_GATEWAY', 'POC_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS') {
    $saved[$v] = [Environment]::GetEnvironmentVariable($v)
}
try {
    foreach ($k in $sids.Keys) {
        $null = Invoke-PocApim -Context $ctx -Method PUT -Path "/subscriptions/$($sids[$k])" -Body @{ properties = @{ scope = "/products/$($products[$k])"; displayName = $sids[$k]; state = 'active' } }
        $keys[$k] = (Invoke-PocApim -Context $ctx -Method POST -Path "/subscriptions/$($sids[$k])/listSecrets").primaryKey
    }
    foreach ($k in $sids.Keys) {
        $key = $keys[$k]
        $t = Measure-PocUntil { [int](Invoke-WebRequest -Uri "$($ctx.Gateway)/poc/probe/whoami" -Headers @{ 'x-api-key' = $key } -SkipHttpErrorCheck).StatusCode -eq 200 } -TimeoutSec 300
        if ($t -lt 0) { throw "The temporary key $($sids[$k]) was not accepted within 300 s." }
    }
    $env:POC_GATEWAY = $ctx.Gateway

    # Runs one example with the given key in POC_KEY; passes on exit code 0 and output matching
    # $Expect. With -Refused it is a control, and passes when that does not happen.
    function Invoke-Example([string]$Check, [string]$Pack, [scriptblock]$Command, [string]$Expect, [switch]$Refused) {
        $env:POC_KEY = $keys[$Pack]
        $out = & $Command 2>&1 | Out-String
        $code = $LASTEXITCODE
        $answered = $code -eq 0 -and $out -match $Expect
        Add-Result $Check ($answered -ne [bool]$Refused) "exit $code; $(Get-Snippet $out)"
    }

    Invoke-Example 'curl, Claude route (claude-request.json)' 'claude' {
        & $curl -sS --fail-with-body "$env:POC_GATEWAY/poc/claude/v1/messages" -H "x-api-key: $env:POC_KEY" -H 'anthropic-version: 2023-06-01' -H 'content-type: application/json' -d "@$(Join-Path $examples 'claude-request.json')"
    } '"type":\s*"message"'
    Invoke-Example 'curl, OpenAI-compatible route (openai-request.json)' 'openai' {
        & $curl -sS --fail-with-body "$env:POC_GATEWAY/poc/v1/chat/completions" -H "api-key: $env:POC_KEY" -H 'content-type: application/json' -d "@$(Join-Path $examples 'openai-request.json')"
    } '"object":\s*"chat\.completion"'
    Invoke-Example 'Anthropic SDK for Python (anthropic_sdk.py)' 'claude' { & $python (Join-Path $examples 'anthropic_sdk.py') } '\bOK\b'
    Invoke-Example 'OpenAI SDK for Python (openai_sdk.py)' 'openai' { & $python (Join-Path $examples 'openai_sdk.py') } '\S'
    Invoke-Example 'OpenAI SDK for Node.js (openai_sdk.mjs)' 'openai' { node (Join-Path $nodeDir 'openai_sdk.mjs') } '\S'

    if (Get-Command opencode -ErrorAction SilentlyContinue) {
        # opencode reads opencode.json from the folder it runs in.
        $ocDir = Join-Path $WorkDir 'opencode'
        New-Item -ItemType Directory -Force -Path $ocDir | Out-Null
        Copy-Item (Join-Path $examples 'opencode.json') $ocDir -Force
        Push-Location $ocDir
        try {
            Invoke-Example 'opencode, OpenAI-compatible route (opencode.json, poc/deepseek-v4-flash)' 'openai' { opencode run 'Reply with exactly: OK' -m 'poc/deepseek-v4-flash' } '\bOK\b'
            Invoke-Example 'opencode, Claude route (opencode.json, poc-claude/claude-haiku-4-5)' 'claude' { opencode run 'Reply with exactly: OK' -m 'poc-claude/claude-haiku-4-5' } '\bOK\b'
        } finally { Pop-Location }
    } else { Write-Host 'SKIP  opencode is not installed' }

    if (Get-Command claude -ErrorAction SilentlyContinue) {
        # A scratch configuration folder: a user's own ~/.claude/settings.json can override
        # the variables below.
        $env:CLAUDE_CONFIG_DIR = Join-Path $WorkDir "claude-$run"
        New-Item -ItemType Directory -Force -Path $env:CLAUDE_CONFIG_DIR | Out-Null
        try {
            $env:ANTHROPIC_BASE_URL = "$env:POC_GATEWAY/poc/claude"
            $env:ANTHROPIC_MODEL = 'claude-haiku-4-5'
            $env:ANTHROPIC_DEFAULT_HAIKU_MODEL = 'claude-haiku-4-5'
            # Foundry refuses some pre-release anthropic-beta values Claude Code sends (UNKNOWNS
            # U17); this documented switch strips them.
            $env:CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1'
            Remove-Item env:ANTHROPIC_AUTH_TOKEN -ErrorAction SilentlyContinue
            $env:ANTHROPIC_API_KEY = $keys.claude
            Invoke-Example 'Claude Code with ANTHROPIC_API_KEY' 'claude' { claude -p 'Reply with exactly: OK' } '\bOK\b'

            # The settings example as the guide shows it. Its helper reads Key Vault, which may
            # be private, so here the helper prints POC_KEY; every other value is the file's.
            # The variables set above are removed: ANTHROPIC_API_KEY outranks apiKeyHelper, and
            # the rest have to come from the file's env block.
            foreach ($v in 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS') {
                Remove-Item "env:$v" -ErrorAction SilentlyContinue
            }
            $settings = Get-Content -Raw (Join-Path $PSScriptRoot '..' 'claude-code' 'settings.example.json') | ConvertFrom-Json -AsHashtable
            $placeholder = 'https://<apim-name>.azure-api.net'
            if (-not $settings.env.ANTHROPIC_BASE_URL.StartsWith($placeholder)) {
                throw "settings.example.json: ANTHROPIC_BASE_URL no longer starts with $placeholder."
            }
            $settings.env.ANTHROPIC_BASE_URL = $env:POC_GATEWAY + $settings.env.ANTHROPIC_BASE_URL.Substring($placeholder.Length)
            $settings.apiKeyHelper = 'node -e "process.stdout.write(process.env.POC_KEY)"'
            $settings | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8NoBOM -Path (Join-Path $env:CLAUDE_CONFIG_DIR 'settings.json')
            Invoke-Example 'Claude Code with apiKeyHelper (settings.example.json)' 'claude' { claude -p 'Reply with exactly: OK' } '\bOK\b'
            # Not a key: random, so the gateway refuses it. If anything other than the helper's
            # key reached the gateway, this would be answered.
            $keys.wrong = [guid]::NewGuid().ToString('N')
            Invoke-Example 'control: the same settings with a wrong key are refused' 'wrong' { claude -p 'Reply with exactly: OK' } '\bOK\b' -Refused
        } finally { Remove-Item -Recurse -Force $env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue }
    } else { Write-Host 'SKIP  Claude Code is not installed' }
} finally {
    foreach ($sid in $sids.Values) {
        try { $null = Invoke-PocApim -Context $ctx -Method DELETE -Path "/subscriptions/$sid" -IfMatch }
        catch { Write-Host "Could not delete the temporary key $sid; Remove-Poc.ps1 removes it." }
    }
    $keys = $null
    foreach ($v in $saved.Keys) { [Environment]::SetEnvironmentVariable($v, $saved[$v]) }
}

$failed = @($results | Where-Object { -not $_.pass }).Count
Write-Host "$($results.Count - $failed) of $($results.Count) examples passed."
if ($failed) { exit 1 }
