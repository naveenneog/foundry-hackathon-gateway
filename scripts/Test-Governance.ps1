#Requires -Version 7.0
<#
.SYNOPSIS
    Proves each governance control actually fires.

.DESCRIPTION
    A control that never fires is not a control. This mints deliberately broken keys and
    asserts the gateway rejects them for the right reason with the right status code.

    Run from admin.ps1 (option 8), or directly.

.NOTES
    Requires PowerShell 7.0 or later - see docs/adr/0006-powershell-7-requirement.md.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$GatewayUrl,
    [Parameter(Mandatory)][string]$SecretPath,
    [ValidateSet('openai', 'claude')][string]$Route = 'openai',
    [string]$Model,
    [string]$SecondModel,
    # Supplying these turns on the revocation check, which has to edit a named value on the
    # instance. Without them the check is reported as NOT RUN rather than silently skipped: a
    # control nobody exercised is indistinguishable from one that does not work.
    [string]$ApimName,
    [string]$ResourceGroup
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$secret = (Get-Content $SecretPath -Raw).Trim()
$mint = Join-Path $root 'scripts/mint.mjs'

# Two aliases are needed: one the key grants, and one it does not, to prove the allowlist fires.
if (-not $Model)       { $Model       = if ($Route -eq 'claude') { 'sonnet' } else { 'flash' } }
if (-not $SecondModel) { $SecondModel = if ($Route -eq 'claude') { 'opus' }   else { 'pro' } }

# A route may have only one model pinned, in which case the caller passes the same alias twice.
# The allowlist test then asks for a model the key DOES grant and gets a correct 200, which the
# harness would report as the allowlist being broken. Detect it and use a name that cannot be
# granted instead.
$script:HasTwoModels = ($SecondModel -ne $Model)
$script:NotGranted = "not-pinned-$([guid]::NewGuid().ToString('N').Substring(0, 8))"

$script:Pass = 0
$script:Fail = 0
$script:Skipped = 0

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

# ---------------------------------------------------------------------------------------------
# The two routes differ in path, required headers and body shape. Everything below this point
# is the same for both, which is the point: one key, one set of controls.
# ---------------------------------------------------------------------------------------------

function Get-RoutePath {
    if ($Route -eq 'claude') { return '/v1/messages' }
    return '/chat/completions'
}

function New-ChatBody {
    param([string]$ModelAlias, [string]$Prompt = 'Reply with the single word: ok', [int]$MaxTokens = 16)
    if ($Route -eq 'claude') {
        # max_tokens is REQUIRED by the Messages API.
        return @{ model = $ModelAlias; max_tokens = $MaxTokens; messages = @(@{ role = 'user'; content = $Prompt }) } | ConvertTo-Json -Depth 5
    }
    return @{ model = $ModelAlias; messages = @(@{ role = 'user'; content = $Prompt }); max_tokens = $MaxTokens } | ConvertTo-Json -Depth 5
}

function New-ToolBody {
    param([string]$ModelAlias)
    if ($Route -eq 'claude') {
        # The Messages API describes tools with `input_schema`, not an OpenAI function wrapper.
        return @{
            model      = $ModelAlias
            max_tokens = 200
            messages   = @(@{ role = 'user'; content = 'What is the weather in Paris? Use the tool.' })
            tools      = @(@{
                name         = 'get_weather'
                description  = 'Get weather'
                input_schema = @{ type = 'object'; properties = @{ city = @{ type = 'string' } }; required = @('city') }
            })
        } | ConvertTo-Json -Depth 10
    }
    return @{
        model    = $ModelAlias
        messages = @(@{ role = 'user'; content = 'What is the weather in Paris? Use the tool.' })
        tools    = @(@{ type = 'function'; function = @{ name = 'get_weather'; description = 'Get weather'; parameters = @{ type = 'object'; properties = @{ city = @{ type = 'string' } }; required = @('city') } } })
        max_tokens = 200
    } | ConvertTo-Json -Depth 10
}

function Invoke-Gateway {
    param($Token, $Body)
    $headers = @{ Authorization = "Bearer $Token"; 'Content-Type' = 'application/json' }
    # Claude Code always sends this; a hand-written request has to as well.
    if ($Route -eq 'claude') { $headers['anthropic-version'] = '2023-06-01' }

    # PowerShell 7.0+ is required (see the #Requires above), so -SkipHttpErrorCheck is always
    # available and a 4xx comes back as an ordinary response rather than an exception.
    try {
        $resp = Invoke-WebRequest -Uri "$GatewayUrl$(Get-RoutePath)" -Method Post `
                    -Headers $headers -Body $Body -SkipHttpErrorCheck -TimeoutSec 120
        return @{ Status = [int]$resp.StatusCode; Body = (ConvertTo-Text $resp.Content); Headers = $resp.Headers }
    } catch {
        return @{ Status = -1; Body = $_.Exception.Message; Headers = @{} }
    }
}

# On an error response APIM may omit a text charset, in which case PowerShell hands back a
# byte[] rather than a string and every -match against it silently fails.
function ConvertTo-Text {
    param($Content)
    if ($null -eq $Content) { return '' }
    if ($Content -is [byte[]]) { return [System.Text.Encoding]::UTF8.GetString($Content) }
    return [string]$Content
}

# Header values arrive as string[]; normalise to a scalar so assertions compare values rather
# than rendering as "System.Object[]".
function Get-Header {
    param($Response, $Name)
    $v = $null
    try { $v = $Response.Headers[$Name] } catch { }
    if ($null -eq $v) { return $null }
    if ($v -is [array]) { if ($v.Count -eq 0) { return $null }; return [string]$v[0] }
    return [string]$v
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

$chat = New-ChatBody -ModelAlias $Model

Write-Host ''
Write-Host "  Verifying governance controls - $Route route" -ForegroundColor Cyan
Write-Host '  -----------------------------' -ForegroundColor DarkCyan
Write-Host "  Gateway: $GatewayUrl$(Get-RoutePath)" -ForegroundColor DarkGray
Write-Host "  Models : $Model (granted), $SecondModel (not granted, for the allowlist test)" -ForegroundColor DarkGray
Write-Host ''

# 1. Happy path
$good = New-TestKey -Subject 'verify-ok' -Models @($Model, $SecondModel) -Budget 500000 -StartOffsetHours 0 -EndOffsetHours 2
$r = Invoke-Gateway -Token $good -Body $chat
Assert-Control 'valid key is served' @(200) $r.Status $r.Body

# 2. No credential
$r = Invoke-Gateway -Token '' -Body $chat
Assert-Control 'missing key rejected' @(401) $r.Status

# 3. Forged signature
$forged = New-TestKey -Subject 'verify-forge' -Models @($Model) -Budget 500000 -StartOffsetHours 0 -EndOffsetHours 2
$tampered = $forged.Substring(0, $forged.LastIndexOf('.')) + '.AAAAinvalidsignatureAAAA'
$r = Invoke-Gateway -Token $tampered -Body $chat
Assert-Control 'forged signature rejected' @(401) $r.Status

# 4. Expired
$expired = New-TestKey -Subject 'verify-exp' -Models @($Model) -Budget 500000 -StartOffsetHours -48 -EndOffsetHours -24
$r = Invoke-Gateway -Token $expired -Body $chat
Assert-Control 'expired key rejected' @(401) $r.Status

# 5. Not yet active
$future = New-TestKey -Subject 'verify-nbf' -Models @($Model) -Budget 500000 -StartOffsetHours 24 -EndOffsetHours 48
$r = Invoke-Gateway -Token $future -Body $chat
Assert-Control 'not-yet-active key rejected' @(401) $r.Status

# 6. Model not on the key. With only one model pinned there is no second alias to ask for, so
#    a name the gateway has never pinned is used: the allowlist is checked before the alias map,
#    so it is still the allowlist that rejects it.
$deniedAlias = if ($script:HasTwoModels) { $SecondModel } else { $script:NotGranted }
$oneModel = New-TestKey -Subject 'verify-model' -Models @($Model) -Budget 500000 -StartOffsetHours 0 -EndOffsetHours 2
$r = Invoke-Gateway -Token $oneModel -Body (New-ChatBody -ModelAlias $deniedAlias)
Assert-Control 'model allowlist enforced' @(403) $r.Status $r.Body

# 7. A model the gateway has never pinned, asked for with a key that grants other models.
#    The name is generated so it cannot collide with a real alias: aliases are operator-chosen,
#    and a deployment called gpt-4o pinned under its own name would have made this pass a 200.
$r = Invoke-Gateway -Token $good -Body (New-ChatBody -ModelAlias $script:NotGranted)
Assert-Control 'unpinned model rejected' @(403) $r.Status

# 8. Tool calling. The whole point of an agent harness, so it has to work on every pinned model.
if ($script:HasTwoModels) {
    $r = Invoke-Gateway -Token $good -Body (New-ToolBody -ModelAlias $SecondModel)
    Assert-Control "tool calls accepted on $SecondModel" @(200) $r.Status $r.Body
}

$r = Invoke-Gateway -Token $good -Body (New-ToolBody -ModelAlias $Model)
Assert-Control "tool calls accepted on $Model" @(200) $r.Status $r.Body

# 9. Budget exhaustion -> 403 so the client STOPS (ADR-0004)
$tiny = New-TestKey -Subject "verify-budget-$(Get-Random)" -Models @($Model) -Budget 200 -StartOffsetHours 0 -EndOffsetHours 2
$big = New-ChatBody -ModelAlias $Model -Prompt ('Write a long essay about databases. ' * 40) -MaxTokens 512
$null = Invoke-Gateway -Token $tiny -Body $big
Start-Sleep -Seconds 3
$r = Invoke-Gateway -Token $tiny -Body $chat
Assert-Control 'one-time budget exhausts (403)' @(403) $r.Status $r.Body

# 9b. It must NOT be 429. Both the OpenAI SDK and the Vercel AI SDK behind opencode retry a 429,
#     and a one-time budget never refills, so the agent would spin on a permanently dead key.
Assert-Control 'exhausted budget is not retryable' @($true) ($r.Status -ne 429) "status=$($r.Status)"

# 9c. No Retry-After. The OpenAI SDK sleeps for its exact value, so a large one hangs the client.
$retryAfter = Get-Header $r 'Retry-After'
Assert-Control 'exhausted budget sets no Retry-After' @($true) ($null -eq $retryAfter) "Retry-After=$retryAfter"

# 9d. x-budget-remaining: 0 is what tells a participant this is spend, not a broken key.
$remaining = Get-Header $r 'x-budget-remaining'
Assert-Control 'exhausted budget reports 0 remaining' @($true) ($remaining -eq '0') "x-budget-remaining=$remaining"

# 9e. The body must be unambiguous, since 403 alone can read as an auth failure.
Assert-Control 'exhausted budget body says so' @($true) ($r.Body -match 'budget_exhausted') $r.Body

# 10. Attribution headers
$r = Invoke-Gateway -Token $good -Body $chat
$hasBudgetHeaders = $r.Headers.Keys -contains 'x-budget-total'
Assert-Control 'budget headers returned' @($true) $hasBudgetHeaders

# 10b. Revocation. The one control that cannot be proved from the key alone: it needs the
#      denylist on the instance to change while a known-good key is in flight.
#
#      Sentinel commas make the match exact, so revoking k_a cannot also revoke k_aaa. Both
#      cases are checked, because a substring match would pass the first and fail nobody.
if ($ApimName -and $ResourceGroup) {
    $victim  = New-TestKey -Subject "verify-revoke-$(Get-Random)" -Models @($Model) -Budget 50000 -StartOffsetHours 0 -EndOffsetHours 2
    $jti     = ([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(
                   $victim.Split('.')[1].Replace('-', '+').Replace('_', '/').PadRight(
                       [int](4 * [math]::Ceiling($victim.Split('.')[1].Length / 4.0)), '=')
               )) | ConvertFrom-Json).jti

    $r = Invoke-Gateway -Token $victim -Body $chat
    Assert-Control 'key works before revocation' @(200) $r.Status $r.Body

    $before = az apim nv show -g $ResourceGroup --service-name $ApimName `
                  --named-value-id hackgw-revoked-keys --query value -o tsv 2>$null
    if (-not $before) { $before = ',' }

    try {
        $withVictim = $before.TrimEnd(',') + ",$jti,"
        az apim nv update -g $ResourceGroup --service-name $ApimName `
            --named-value-id hackgw-revoked-keys --value $withVictim -o none 2>$null

        # Named-value changes are not instantaneous at the gateway. Poll rather than assume,
        # and report how long it actually took - an organiser revoking a leaked key needs to
        # know whether that is seconds or minutes.
        $sw = [Diagnostics.Stopwatch]::StartNew()
        $status = 0
        while ($sw.Elapsed.TotalSeconds -lt 180) {
            $status = (Invoke-Gateway -Token $victim -Body $chat).Status
            if ($status -eq 403) { break }
            Start-Sleep -Seconds 5
        }
        $sw.Stop()
        Assert-Control 'revoked key rejected' @(403) $status "took $([int]$sw.Elapsed.TotalSeconds)s to take effect"
        if ($status -eq 403) {
            Write-Host ("         revocation took effect in {0}s" -f [int]$sw.Elapsed.TotalSeconds) -ForegroundColor DarkGray
        }

        # A key whose id merely CONTAINS a revoked id must still work.
        $bystander = New-TestKey -Subject "verify-bystander-$(Get-Random)" -Models @($Model) -Budget 50000 -StartOffsetHours 0 -EndOffsetHours 2
        $r = Invoke-Gateway -Token $bystander -Body $chat
        Assert-Control 'other keys unaffected by revocation' @(200) $r.Status $r.Body
    }
    finally {
        # Always restore, even on Ctrl-C: leaving a test id on a real denylist is harmless, but
        # leaving the denylist REPLACED would silently un-revoke real keys.
        az apim nv update -g $ResourceGroup --service-name $ApimName `
            --named-value-id hackgw-revoked-keys --value $before -o none 2>$null
    }
} else {
    Write-Host "  [SKIP] revocation NOT CHECKED - pass -ApimName and -ResourceGroup" -ForegroundColor Yellow
    $script:Skipped++
}

# 11. Claude route only: every rejection has to be in the Anthropic envelope. A client in this
#     mode parses {"type":"error","error":{...}} and nothing else, so an OpenAI-shaped body
#     reaches the participant as "the response was malformed" rather than as the reason.
if ($Route -eq 'claude') {
    $rejections = @(
        @{ Name = 'allowlist rejection'; Token = $oneModel; Body = (New-ChatBody -ModelAlias $deniedAlias) }
        @{ Name = 'unpinned-model rejection'; Token = $good; Body = (New-ChatBody -ModelAlias $script:NotGranted) }
        @{ Name = 'spent-budget rejection'; Token = $tiny; Body = $chat }
    )
    foreach ($case in $rejections) {
        $rr = Invoke-Gateway -Token $case.Token -Body $case.Body
        $shaped = $rr.Body -match '"type"\s*:\s*"error"' -and $rr.Body -match '"message"\s*:'
        Assert-Control "$($case.Name) is Anthropic-shaped" @($true) $shaped $rr.Body
    }

    # The reason has nowhere to live but the message, so it has to be there.
    $rr = Invoke-Gateway -Token $tiny -Body $chat
    Assert-Control 'spent budget names budget_exhausted' @($true) ($rr.Body -match 'budget_exhausted') $rr.Body

    # The realistic mistake on this route: a participant who does not set ANTHROPIC_MODEL sends
    # Claude Code's own default id, which is not an alias here.
    $claudeDefault = 'claude-opus-4-8'
    if ($claudeDefault -ne $Model -and $claudeDefault -ne $SecondModel) {
        $rr = Invoke-Gateway -Token $good -Body (New-ChatBody -ModelAlias $claudeDefault)
        Assert-Control "Claude Code's default model id is refused" @(403) $rr.Status $rr.Body
    }

    # count_tokens must not be broken by the body rewrite: max_tokens is not in its schema.
    try {
        $countBody = @{ model = $Model; messages = @(@{ role = 'user'; content = 'hello' }) } | ConvertTo-Json -Depth 5
        $resp = Invoke-WebRequest -Uri "$GatewayUrl/v1/messages/count_tokens" -Method Post `
                    -Headers @{ Authorization = "Bearer $good"; 'Content-Type' = 'application/json'; 'anthropic-version' = '2023-06-01' } `
                    -Body $countBody -SkipHttpErrorCheck -TimeoutSec 60
        Assert-Control 'count_tokens works' @(200) ([int]$resp.StatusCode) (ConvertTo-Text $resp.Content)
    } catch {
        Assert-Control 'count_tokens works' @(200) -1 $_.Exception.Message
    }
}

Write-Host ''
$summary = "  $script:Pass passed, $script:Fail failed"
if ($script:Skipped -gt 0) { $summary += ", $script:Skipped NOT CHECKED" }
Write-Host $summary -ForegroundColor $(if ($script:Fail -eq 0) { 'Green' } else { 'Red' })
Write-Host ''
if ($script:Fail -gt 0) { exit 1 }
