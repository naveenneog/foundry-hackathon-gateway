<#
.SYNOPSIS
    Proves each governance control actually fires.

.DESCRIPTION
    A control that never fires is not a control. This mints deliberately broken keys and
    asserts the gateway rejects them for the right reason with the right status code.

    Run from admin.ps1 (option 8), or directly.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$GatewayUrl,
    [Parameter(Mandatory)][string]$SecretPath,
    [string]$Model = 'flash'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$secret = (Get-Content $SecretPath -Raw).Trim()
$mint = Join-Path $root 'scripts/mint.mjs'

$script:Pass = 0
$script:Fail = 0

function New-TestKey {
    param($Subject, $Models, $Budget, $StartOffsetHours, $EndOffsetHours)
    $now = [DateTimeOffset]::UtcNow
    $payload = @{
        secret    = $secret
        subject   = $Subject
        models    = $Models
        budget    = $Budget
        notBefore = $now.AddHours($StartOffsetHours).ToUnixTimeMilliseconds()
        expiresAt = $now.AddHours($EndOffsetHours).ToUnixTimeMilliseconds()
    } | ConvertTo-Json -Compress
    $r = $payload | node $mint | ConvertFrom-Json
    if (-not $r.token) { throw "mint failed: $($r.error)" }
    return $r.token
}

function Invoke-Gateway {
    param($Token, $Body)
    try {
        $resp = Invoke-WebRequest -Uri "$GatewayUrl/chat/completions" -Method Post `
            -Headers @{ Authorization = "Bearer $Token"; 'Content-Type' = 'application/json' } `
            -Body $Body -SkipHttpErrorCheck -TimeoutSec 120
        return @{ Status = [int]$resp.StatusCode; Body = $resp.Content; Headers = $resp.Headers }
    } catch {
        return @{ Status = -1; Body = $_.Exception.Message; Headers = @{} }
    }
}

function Assert-Control {
    param($Name, $Expected, $Actual, $Detail)
    if ($Expected -contains $Actual) {
        Write-Host ("  [PASS] {0,-34} -> {1}" -f $Name, $Actual) -ForegroundColor Green
        $script:Pass++
    } else {
        Write-Host ("  [FAIL] {0,-34} -> {1} (expected {2})" -f $Name, $Actual, ($Expected -join '/')) -ForegroundColor Red
        if ($Detail) { Write-Host "         $Detail" -ForegroundColor DarkGray }
        $script:Fail++
    }
}

$chat = @{ model = $Model; messages = @(@{ role = 'user'; content = 'Reply with the single word: ok' }); max_tokens = 16 } | ConvertTo-Json -Depth 5
$withTools = @{
    model = 'pro'
    messages = @(@{ role = 'user'; content = 'hi' })
    tools = @(@{ type = 'function'; function = @{ name = 'noop'; description = 'x'; parameters = @{ type = 'object'; properties = @{} } } })
} | ConvertTo-Json -Depth 8

Write-Host ''
Write-Host '  Verifying governance controls' -ForegroundColor Cyan
Write-Host '  -----------------------------' -ForegroundColor DarkCyan
Write-Host "  Gateway: $GatewayUrl" -ForegroundColor DarkGray
Write-Host ''

# 1. Happy path
$good = New-TestKey -Subject 'verify-ok' -Models @('flash','pro') -Budget 500000 -StartOffsetHours 0 -EndOffsetHours 2
$r = Invoke-Gateway -Token $good -Body $chat
Assert-Control 'valid key is served' @(200) $r.Status $r.Body

# 2. No credential
$r = Invoke-Gateway -Token '' -Body $chat
Assert-Control 'missing key rejected' @(401) $r.Status

# 3. Forged signature
$forged = New-TestKey -Subject 'verify-forge' -Models @('flash') -Budget 500000 -StartOffsetHours 0 -EndOffsetHours 2
$tampered = $forged.Substring(0, $forged.LastIndexOf('.')) + '.AAAAinvalidsignatureAAAA'
$r = Invoke-Gateway -Token $tampered -Body $chat
Assert-Control 'forged signature rejected' @(401) $r.Status

# 4. Expired
$expired = New-TestKey -Subject 'verify-exp' -Models @('flash') -Budget 500000 -StartOffsetHours -48 -EndOffsetHours -24
$r = Invoke-Gateway -Token $expired -Body $chat
Assert-Control 'expired key rejected' @(401) $r.Status

# 5. Not yet active
$future = New-TestKey -Subject 'verify-nbf' -Models @('flash') -Budget 500000 -StartOffsetHours 24 -EndOffsetHours 48
$r = Invoke-Gateway -Token $future -Body $chat
Assert-Control 'not-yet-active key rejected' @(401) $r.Status

# 6. Model not on the key
$flashOnly = New-TestKey -Subject 'verify-model' -Models @('flash') -Budget 500000 -StartOffsetHours 0 -EndOffsetHours 2
$proBody = @{ model = 'pro'; messages = @(@{ role = 'user'; content = 'hi' }); max_tokens = 16 } | ConvertTo-Json -Depth 5
$r = Invoke-Gateway -Token $flashOnly -Body $proBody
Assert-Control 'model allowlist enforced' @(403) $r.Status $r.Body

# 7. Model that does not exist at all
$ghost = @{ model = 'gpt-4o'; messages = @(@{ role = 'user'; content = 'hi' }); max_tokens = 16 } | ConvertTo-Json -Depth 5
$r = Invoke-Gateway -Token $good -Body $ghost
Assert-Control 'unpinned model rejected' @(403) $r.Status

# 8. Tool calling against the reasoning model (ADR-0003 guard rail)
$r = Invoke-Gateway -Token $good -Body $withTools
Assert-Control 'tools-on-pro rejected clearly' @(400) $r.Status $r.Body

# 9. Budget exhaustion -> 403 so the client STOPS (ADR-0004)
$tiny = New-TestKey -Subject "verify-budget-$(Get-Random)" -Models @('flash') -Budget 200 -StartOffsetHours 0 -EndOffsetHours 2
$big = @{ model = 'flash'; messages = @(@{ role = 'user'; content = ('Write a long essay about databases. ' * 40) }); max_tokens = 512 } | ConvertTo-Json -Depth 5
$null = Invoke-Gateway -Token $tiny -Body $big
Start-Sleep -Seconds 3
$r = Invoke-Gateway -Token $tiny -Body $chat
Assert-Control 'one-time budget exhausts (403)' @(403) $r.Status $r.Body

# 9b. It must NOT be 429. Both the OpenAI SDK and the Vercel AI SDK behind opencode retry a 429,
#     and a one-time budget never refills, so the agent would spin on a permanently dead key.
Assert-Control 'exhausted budget is not retryable' @($true) ($r.Status -ne 429) "status=$($r.Status)"

# 9c. No Retry-After. The OpenAI SDK sleeps for its exact value, so a large one hangs the client.
$retryAfter = $r.Headers['Retry-After']
Assert-Control 'exhausted budget sets no Retry-After' @($true) ($null -eq $retryAfter) "Retry-After=$retryAfter"

# 9d. x-budget-remaining: 0 is what tells a participant this is spend, not a broken key.
$remaining = $r.Headers['x-budget-remaining']
Assert-Control 'exhausted budget reports 0 remaining' @($true) ($remaining -eq '0') "x-budget-remaining=$remaining"

# 9e. The body must be unambiguous, since 403 alone can read as an auth failure.
Assert-Control 'exhausted budget body says so' @($true) ($r.Body -match 'budget_exhausted') $r.Body

# 10. Attribution headers
$r = Invoke-Gateway -Token $good -Body $chat
$hasBudgetHeaders = $r.Headers.Keys -contains 'x-budget-total'
Assert-Control 'budget headers returned' @($true) $hasBudgetHeaders

Write-Host ''
Write-Host "  $script:Pass passed, $script:Fail failed" -ForegroundColor $(if ($script:Fail -eq 0) { 'Green' } else { 'Red' })
Write-Host ''
if ($script:Fail -gt 0) { exit 1 }
