<#
    P38: run every client example against the live gateway, so the setup guide shows only what
    works. The checks are the table $checks below: each names the example file it runs (under
    poc/products-keyvault/), the pack whose key it gets, and what a pass prints. The control has
    a wrong key and passes only when the gateway refuses it.

    Two temporary keys, one per pack, are issued through API Management directly (the examples
    need a key, not the vault), passed to each check in POC_KEY, never printed, and deleted at
    the end. Environment variables the checks set are restored afterwards, also when the script
    runs in an interactive session.

    Needs curl, Node.js with npm, and Python 3; packages are installed into -WorkDir and reused.
    A check whose tool (opencode, Claude Code) is missing is reported as SKIP and counts as not
    proven. Exit code 0 only when every check passed.

    -Plan prints the work folder and every check, from the loop that runs them, and stops before
    any Azure call or installation.
#>
param(
    [Parameter(Mandatory)][string]$Subscription,
    [Parameter(Mandatory)][string]$ResourceGroup,
    [Parameter(Mandatory)][string]$ApimName,
    [string]$ClaudeProduct = 'poc-claude-pack',
    [string]$OpenAiProduct = 'poc-deepseek-pack',
    # Packages are installed and run from here, with a key in the environment. Per user by
    # default: code planted in a folder other users can write to, such as /tmp, would run here.
    [string]$WorkDir = '',
    [switch]$Plan
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'PocKeys.ps1')
. (Join-Path $PSScriptRoot 'PocMeasure.ps1')
$poc = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $WorkDir) {
    $base = [Environment]::GetFolderPath('LocalApplicationData')
    if (-not $base) { throw 'This account has no per-user data folder; pass -WorkDir.' }
    $WorkDir = Join-Path $base 'poc-clients'
}
$curl = if ($IsWindows) { 'curl.exe' } else { 'curl' }
$prompt = 'Reply with exactly: OK'
$answer = '\bOK\b'

# Every environment variable a check sets or clears; saved before the run, restored after it.
# The CLAUDE_CODE_USE_ switches and ANTHROPIC_AUTH_TOKEN outrank the key a Claude Code check
# tests, so those checks start with all of them cleared.
$touched = 'POC_GATEWAY', 'POC_KEY', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'

function Clear-PocClaudeEnvironment {
    foreach ($v in $touched) { if ($v -notlike 'POC_*') { Remove-Item "env:$v" -ErrorAction SilentlyContinue } }
}

# Claude Code with a new, empty configuration folder, because a user's own settings.json can
# override the variables under test; $SettingsJson becomes its settings.json when given.
function Invoke-PocClaudeCode([string]$SettingsJson = '') {
    $dir = Join-Path $WorkDir "claude-$([guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Path $dir | Out-Null
    try {
        $env:CLAUDE_CONFIG_DIR = $dir
        if ($SettingsJson) { Set-Content -LiteralPath (Join-Path $dir 'settings.json') -Value $SettingsJson -Encoding utf8NoBOM }
        claude -p $prompt
    } finally {
        Remove-Item env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# The settings example as the guide shows it, pointed at this gateway. Its helper reads Key
# Vault, which may accept private traffic only, so here the helper prints POC_KEY instead; every
# other value is the file's own.
function ConvertTo-PocTestSettings([string]$File) {
    $settings = Get-Content -Raw -LiteralPath $File | ConvertFrom-Json -AsHashtable
    $placeholder = 'https://<apim-name>.azure-api.net'
    if (-not "$($settings.env.ANTHROPIC_BASE_URL)".StartsWith($placeholder)) {
        throw "${File}: ANTHROPIC_BASE_URL no longer starts with $placeholder."
    }
    $settings.env.ANTHROPIC_BASE_URL = $env:POC_GATEWAY + $settings.env.ANTHROPIC_BASE_URL.Substring($placeholder.Length)
    $settings.apiKeyHelper = 'node -e "process.stdout.write(process.env.POC_KEY)"'
    return $settings | ConvertTo-Json -Depth 5
}

# Every check. Run gets the example's full path and runs from poc/products-keyvault/, where the
# guide's commands run. Needs names a tool that may be missing; Refusal makes a check a control.
$checks = @(
    @{ Name = 'curl, probe'; Example = ''; Pack = 'claude'; Expect = '"product":\s*"poc-[a-z0-9-]+"'; Run = {
            & $curl -sS --fail-with-body -H "x-api-key: $env:POC_KEY" "$env:POC_GATEWAY/poc/probe/whoami"
        }
    }
    @{ Name = 'curl, Claude route (claude-request.json)'; Example = 'examples/claude-request.json'; Pack = 'claude'; Expect = '"type":\s*"message"'; Run = {
            & $curl -sS --fail-with-body "$env:POC_GATEWAY/poc/claude/v1/messages" -H "x-api-key: $env:POC_KEY" -H 'anthropic-version: 2023-06-01' -H 'content-type: application/json' -d '@examples/claude-request.json'
        }
    }
    @{ Name = 'curl, OpenAI-compatible route (openai-request.json)'; Example = 'examples/openai-request.json'; Pack = 'openai'; Expect = '"object":\s*"chat\.completion"'; Run = {
            & $curl -sS --fail-with-body "$env:POC_GATEWAY/poc/v1/chat/completions" -H "api-key: $env:POC_KEY" -H 'content-type: application/json' -d '@examples/openai-request.json'
        }
    }
    @{ Name = 'Anthropic SDK for Python (anthropic_sdk.py)'; Example = 'examples/anthropic_sdk.py'; Pack = 'claude'; Expect = $answer; Run = { param($File) & $python $File } }
    @{ Name = 'OpenAI SDK for Python (openai_sdk.py)'; Example = 'examples/openai_sdk.py'; Pack = 'openai'; Expect = $answer; Run = { param($File) & $python $File } }
    @{ Name = 'OpenAI SDK for Node.js (openai_sdk.mjs)'; Example = 'examples/openai_sdk.mjs'; Pack = 'openai'; Expect = $answer; Run = {
            # Node.js resolves packages from the script's own folder, so the example runs from there.
            param($File)
            Copy-Item -LiteralPath $File -Destination $nodeDir -Force
            node (Join-Path $nodeDir (Split-Path $File -Leaf))
        }
    }
    @{ Name = 'opencode, OpenAI-compatible route (poc/deepseek-v4-flash)'; Example = 'examples/opencode.json'; Pack = 'openai'; Needs = 'opencode'; Expect = $answer; Run = {
            param($File)
            Invoke-PocOpencode $File 'poc/deepseek-v4-flash'
        }
    }
    @{ Name = 'opencode, Claude route (poc-claude/claude-haiku-4-5)'; Example = 'examples/opencode.json'; Pack = 'claude'; Needs = 'opencode'; Expect = $answer; Run = {
            param($File)
            Invoke-PocOpencode $File 'poc-claude/claude-haiku-4-5'
        }
    }
    @{ Name = 'Claude Code with ANTHROPIC_API_KEY (claude-code-env.ps1)'; Example = 'examples/claude-code-env.ps1'; Pack = 'claude'; Needs = 'claude'; Expect = $answer; Run = {
            param($File)
            Clear-PocClaudeEnvironment
            . $File
            Invoke-PocClaudeCode
        }
    }
    @{ Name = 'Claude Code with apiKeyHelper (settings.example.json)'; Example = 'claude-code/settings.example.json'; Pack = 'claude'; Needs = 'claude'; Expect = $answer; Run = {
            param($File)
            Clear-PocClaudeEnvironment
            Invoke-PocClaudeCode (ConvertTo-PocTestSettings $File)
        }
    }
    # A random key, so the gateway refuses it. If anything other than the helper's key reached
    # the gateway, this would be answered.
    @{ Name = 'control: the same settings with a wrong key are refused'; Example = 'claude-code/settings.example.json'; Pack = 'wrong'; Needs = 'claude'; Expect = $answer; Refusal = '\b401\b[\s\S]*invalid subscription key'; Run = {
            param($File)
            Clear-PocClaudeEnvironment
            Invoke-PocClaudeCode (ConvertTo-PocTestSettings $File)
        }
    }
)

# opencode reads opencode.json from the folder it runs in.
function Invoke-PocOpencode([string]$File, [string]$Model) {
    $dir = Join-Path $WorkDir 'opencode'
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    Copy-Item -LiteralPath $File -Destination $dir -Force
    Push-Location $dir
    try { opencode run $prompt -m $Model } finally { Pop-Location }
}

function Install-PocPython {
    $venv = Join-Path $WorkDir 'venv'
    $exe = if ($IsWindows) { Join-Path $venv 'Scripts' 'python.exe' } else { Join-Path $venv 'bin' 'python' }
    if (-not (Test-Path -LiteralPath $exe)) {
        # On Windows, python3 can be the Microsoft Store alias, which exits 9009 without running;
        # the py launcher is used there when present.
        if ($IsWindows -and (Get-Command py -ErrorAction SilentlyContinue)) { py -3 -m venv $venv | Out-Host }
        elseif (-not $IsWindows -and (Get-Command python3 -ErrorAction SilentlyContinue)) { python3 -m venv $venv | Out-Host }
        else { python -m venv $venv | Out-Host }
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $exe)) { throw "Creating a Python virtual environment in $venv failed." }
    }
    & $exe -c 'import anthropic, openai' 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
        & $exe -m pip install --quiet --disable-pip-version-check anthropic openai | Out-Host
        & $exe -c 'import anthropic, openai' | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "The anthropic and openai packages could not be installed into $venv. Deleting that folder starts again." }
    }
    return $exe
}

function Install-PocNode {
    $dir = Join-Path $WorkDir 'node'
    if (-not (Test-Path -LiteralPath (Join-Path $dir 'node_modules' 'openai'))) {
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
        npm install --silent --no-audit --no-fund --prefix $dir openai | Out-Host
        if ($LASTEXITCODE -ne 0) { throw 'Installing the openai package for Node.js failed.' }
    }
    return $dir
}

$results = [System.Collections.Generic.List[object]]::new()
function Add-PocResult([string]$Check, [string]$Status, [string]$Detail) {
    $results.Add([pscustomobject]@{ check = $Check; status = $Status; detail = $Detail })
    Write-Host ('{0,-4}  {1} - {2}' -f $Status, $Check, $Detail)
}
function Get-PocSnippet([string]$Text) { $t = ($Text -replace '\s+', ' ').Trim(); $t.Substring(0, [Math]::Min(160, $t.Length)) }

function Invoke-PocCheck($Check) {
    if ($Check.Needs -and -not (Get-Command $Check.Needs -ErrorAction SilentlyContinue)) {
        Add-PocResult $Check.Name 'SKIP' "$($Check.Needs) is not installed, so this example is not proven"
        return
    }
    $env:POC_KEY = $keys[$Check.Pack]
    $global:LASTEXITCODE = 0
    try {
        $out = & $Check.Run (Join-Path $poc $Check.Example) 2>&1 | Out-String
        $code = $LASTEXITCODE
    } catch { $out = "$_"; $code = -1 }
    $pass = Test-PocClientResult -ExitCode $code -Output $out -Expect $Check.Expect -Refusal "$($Check.Refusal)"
    Add-PocResult $Check.Name $(if ($pass) { 'PASS' } else { 'FAIL' }) "exit $code; $(Get-PocSnippet $out)"
}

if ($Plan) { "WORKDIR $WorkDir" }
else {
    $missing = @(@($curl, 'node', 'npm') | Where-Object { -not (Get-Command $_ -ErrorAction SilentlyContinue) })
    $pythons = if ($IsWindows) { 'py', 'python' } else { 'python3', 'python' }
    if (-not ($pythons | Where-Object { Get-Command $_ -ErrorAction SilentlyContinue })) { $missing += 'Python 3' }
    if ($missing) { throw "Not installed: $($missing -join ', ')." }
    New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
    $python = Install-PocPython
    $nodeDir = Install-PocNode
}

$keys = @{}
$created = [System.Collections.Generic.List[string]]::new()
$ctx = $null
$saved = @{}
foreach ($v in $touched) { $saved[$v] = [Environment]::GetEnvironmentVariable($v) }
try {
    if (-not $Plan) {
        $ctx = New-PocContext -Subscription $Subscription -ResourceGroup $ResourceGroup -ApimName $ApimName -VaultName 'none'
        $run = [datetime]::UtcNow.ToString('MMddHHmm')
        foreach ($pack in @{ claude = $ClaudeProduct; openai = $OpenAiProduct }.GetEnumerator()) {
            $sid = "poc-client-$($pack.Key)-$run"
            $null = Invoke-PocApim -Context $ctx -Method PUT -Path "/subscriptions/$sid" -Body @{ properties = @{ scope = "/products/$($pack.Value)"; displayName = $sid; state = 'active' } }
            $created.Add($sid)
            $keys[$pack.Key] = (Invoke-PocApim -Context $ctx -Method POST -Path "/subscriptions/$sid/listSecrets").primaryKey
            $key = $keys[$pack.Key]
            $t = Measure-PocUntil { [int](Invoke-WebRequest -Uri "$($ctx.Gateway)/poc/probe/whoami" -Headers @{ 'x-api-key' = $key } -SkipHttpErrorCheck).StatusCode -eq 200 } -TimeoutSec 300
            if ($t -lt 0) { throw "The temporary key $sid was not accepted within 300 s." }
        }
        $keys.wrong = [guid]::NewGuid().ToString('N')
        $env:POC_GATEWAY = $ctx.Gateway
    }
    Push-Location $poc
    try {
        foreach ($c in $checks) {
            if ($Plan) {
                'PLAN ' + ([ordered]@{ name = $c.Name; example = $c.Example; pack = $c.Pack; needs = "$($c.Needs)"; expect = $c.Expect; refusal = "$($c.Refusal)" } | ConvertTo-Json -Compress)
                continue
            }
            Invoke-PocCheck $c
        }
    } finally { Pop-Location }
} finally {
    foreach ($sid in $created) {
        try { $null = Invoke-PocApim -Context $ctx -Method DELETE -Path "/subscriptions/$sid" -IfMatch }
        catch { Write-Host "Could not delete the temporary key $sid; Remove-Poc.ps1 removes it." }
    }
    $keys = $null
    foreach ($v in $touched) { [Environment]::SetEnvironmentVariable($v, $saved[$v]) }
}

if ($Plan) { return }
$passed = @($results | Where-Object status -EQ 'PASS').Count
$skipped = @($results | Where-Object status -EQ 'SKIP').Count
Write-Host ("$passed of $($checks.Count) checks passed." + $(if ($skipped) { " $skipped skipped, not proven." } else { '' }))
if ($results.Count -ne $checks.Count -or $passed -ne $checks.Count) { exit 1 }
