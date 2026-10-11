<#
    P37 proof of concept: the live checks and measurements, on a deployed POC (Deploy-Poc.ps1).

    Issues fresh keys for this run (names end in the run's UTC timestamp), never prints a key,
    prints one line per check, and writes the results (no keys) as JSON to -ResultsPath. Exit
    code 1 if any check fails. Spends a few thousand tokens on the two pinned models.

    What it settles: UNKNOWNS U24 (EndDate), U25 (time for a new, rotated, regenerated, suspended
    or reactivated key to reach the gateway), U26 (keys with no product), U27 (Claude Code across
    a rotation), U28 (budget across a rotation). See ../README.md for the recorded results.
#>
param(
    [Parameter(Mandatory)][string]$Subscription,
    [Parameter(Mandatory)][string]$ResourceGroup,
    [Parameter(Mandatory)][string]$ApimName,
    [Parameter(Mandatory)][string]$VaultName,
    [string]$ClaudeModel = 'claude-haiku-4-5',
    [string]$OpenAiModel = 'deepseek-v4-flash',
    [int]$TinyBudget = 300,
    [switch]$SkipClaudeCode,
    [string]$ResultsPath = (Join-Path ([IO.Path]::GetTempPath()) 'poc-products-keyvault-results.json')
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'PocKeys.ps1')
. (Join-Path $PSScriptRoot 'PocMeasure.ps1')
$ctx = New-PocContext -Subscription $Subscription -ResourceGroup $ResourceGroup -ApimName $ApimName -VaultName $VaultName
$gw = $ctx.Gateway
$run = [datetime]::UtcNow.ToString('MMddHHmm')
$results = [System.Collections.Generic.List[object]]::new()
$measured = [ordered]@{ run = $run; startedUtc = [datetime]::UtcNow.ToString('o') }

function Add-Result([string]$Check, [bool]$Pass, [string]$Detail) {
    $results.Add([pscustomobject]@{ check = $Check; pass = $Pass; detail = $Detail })
    Write-Host ('{0}  {1} - {2}' -f $(if ($Pass) { 'PASS' } else { 'FAIL' }), $Check, $Detail)
}

function Send-Gateway {
    param([string]$Method = 'POST', [string]$Path, [hashtable]$Headers = @{}, [string]$Body)
    $call = @{ Method = $Method; Uri = "$gw$Path"; Headers = $Headers; SkipHttpErrorCheck = $true; TimeoutSec = 120 }
    if ($Body) { $call.Body = $Body; $call.ContentType = 'application/json' }
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $r = Invoke-WebRequest @call
    [pscustomobject]@{ Status = [int]$r.StatusCode; Body = [string]$r.Content; Headers = $r.Headers; Ms = $sw.ElapsedMilliseconds }
}
function Read-Header($Response, [string]$Name) { $v = $Response.Headers[$Name]; if ($v -is [array]) { "$($v[0])" } else { "$v" } }
function Read-Json([string]$Text) { try { $Text | ConvertFrom-Json } catch { $null } }
function Get-Snippet([string]$Text) { $t = ($Text -replace '\s+', ' ').Trim(); $t.Substring(0, [Math]::Min(150, $t.Length)) }

function Invoke-Claude([string]$Key, [string]$Model = $ClaudeModel, [int]$MaxTokens = 16, [string]$Prompt = 'Reply with exactly: OK') {
    $body = @{ model = $Model; max_tokens = $MaxTokens; messages = @(@{ role = 'user'; content = $Prompt }) } | ConvertTo-Json -Depth 5 -Compress
    $headers = @{ 'anthropic-version' = '2023-06-01' }
    if ($Key) { $headers['x-api-key'] = $Key }
    Send-Gateway -Path '/poc/claude/v1/messages' -Headers $headers -Body $body
}
function Invoke-OpenAi([string]$Key, [string]$Model = $OpenAiModel) {
    $body = @{ model = $Model; max_tokens = 16; messages = @(@{ role = 'user'; content = 'Reply with exactly: OK' }) } | ConvertTo-Json -Depth 5 -Compress
    Send-Gateway -Path '/poc/v1/chat/completions' -Headers @{ 'api-key' = $Key } -Body $body
}
function Invoke-Probe([string]$Key) { Send-Gateway -Method GET -Path '/poc/probe/whoami' -Headers @{ 'x-api-key' = $Key } }

# Every time below is from just before the change it measures until the gateway answered the
# same way five times in a row (Measure-PocUntil, PocMeasure.ps1).
$temporary = [System.Collections.Generic.List[string]]::new()
try {
    Write-Host "Run $run against $gw"

    # --- Keys for this run -------------------------------------------------------------------
    $who = [ordered]@{ alice = 'poc-claude-pack'; bob = 'poc-deepseek-pack'; tiny = 'poc-tiny-pack'; carol = 'poc-claude-pack'; dev = 'poc-claude-pack' }
    $keys = @{}
    $t0 = [datetime]::UtcNow
    $null = New-PocKey -Context $ctx -Name "alice-$run" -Product $who.alice
    $keys.alice = Get-PocKey -Context $ctx -Name "alice-$run"
    $t = Measure-PocUntil { (Invoke-Probe $keys.alice).Status -eq 200 } -Since $t0
    $measured.newKeyAcceptedSeconds = $t
    Add-Result 'U25 a new key reaches the gateway' ($t -ge 0) "accepted from $t s after the issue request"
    foreach ($n in 'bob', 'tiny', 'carol', 'dev') {
        $null = New-PocKey -Context $ctx -Name "$n-$run" -Product $who[$n]
        $keys[$n] = Get-PocKey -Context $ctx -Name "$n-$run"
    }
    foreach ($n in 'bob', 'tiny', 'carol', 'dev') { $null = Measure-PocUntil { (Invoke-Probe $keys[$n]).Status -eq 200 } -TimeoutSec 300 }

    # --- Packs -------------------------------------------------------------------------------
    $r = Invoke-Claude $keys.alice
    $remaining = Read-Header $r 'x-budget-remaining'
    Add-Result 'a Claude-pack key calls its model' ($r.Status -eq 200 -and $remaining -match '^\d+$') "$($r.Status) in $($r.Ms) ms, x-budget-remaining $remaining"

    $r = Invoke-Claude $keys.alice -Model 'claude-sonnet-5'
    $j = Read-Json $r.Body
    Add-Result 'a Claude-pack key is refused a model outside its pack' ($r.Status -eq 403 -and $j.type -eq 'error' -and "$($j.error.message)" -like 'model_not_allowed*') "$($r.Status) $(Get-Snippet $r.Body)"

    $r = Invoke-OpenAi $keys.alice
    Add-Result 'a Claude-pack key is refused on the OpenAI route' ($r.Status -eq 401) "$($r.Status) $(Get-Snippet $r.Body)"

    $r = Invoke-OpenAi $keys.bob
    Add-Result 'a DeepSeek-pack key calls its model' ($r.Status -eq 200 -and (Read-Header $r 'x-budget-remaining') -match '^\d+$') "$($r.Status) in $($r.Ms) ms, x-budget-remaining $(Read-Header $r 'x-budget-remaining')"

    $r = Invoke-OpenAi $keys.bob -Model $ClaudeModel
    $j = Read-Json $r.Body
    Add-Result 'a DeepSeek-pack key is refused a Claude model' ($r.Status -eq 403 -and $j.error.code -eq 'model_not_allowed') "$($r.Status) $(Get-Snippet $r.Body)"

    $r = Invoke-Claude ''
    Add-Result 'a call with no key is refused' ($r.Status -eq 401) "$($r.Status) $(Get-Snippet $r.Body)"

    # --- U26: keys with no product -----------------------------------------------------------
    $master = (Invoke-PocApim -Context $ctx -Method POST -Path '/subscriptions/master/listSecrets').primaryKey
    $p = Read-Json (Invoke-Probe $master).Body
    $measured.allAccessProduct = $p.product
    $r = Invoke-Claude $master
    Add-Result 'U26 the all-access key is refused on a model route' ($null -eq $p.product -and $r.Status -eq 403 -and $r.Body -like '*product_required*') "probe product=$($p.product); $($r.Status) $(Get-Snippet $r.Body)"
    $master = $null

    foreach ($scope in '/apis', '/apis/poc-claude') {
        $sid = "poc-scope-$($scope.Split('/')[-1])-$run"
        $temporary.Add($sid)
        $null = Invoke-PocApim -Context $ctx -Method PUT -Path "/subscriptions/$sid" -Body @{ properties = @{ scope = $scope; displayName = $sid; state = 'active' } }
        $k = (Invoke-PocApim -Context $ctx -Method POST -Path "/subscriptions/$sid/listSecrets").primaryKey
        $null = Measure-PocUntil { (Invoke-Claude $k).Status -ne 401 } -TimeoutSec 300
        $r = Invoke-Claude $k
        Add-Result "U26 a key scoped to $scope is refused on a model route" ($r.Status -eq 403 -and $r.Body -like '*product_required*') "$($r.Status) $(Get-Snippet $r.Body)"
        $k = $null
    }

    # --- Budget: spend the tiny pack -------------------------------------------------------
    # A longer answer per call, so the budget is spent in a few calls.
    $spent = 0; $ok = 0; $last = $null; $lastRemaining = ''; $byCall = @()
    for ($i = 1; $i -le 20; $i++) {
        $last = Invoke-Claude $keys.tiny -MaxTokens 64 -Prompt 'Count from 1 to 60, separated by spaces.'
        if ($last.Status -eq 200) {
            $u = (Read-Json $last.Body).usage
            $spent += [int]$u.input_tokens + [int]$u.output_tokens
            $ok++
            $lastRemaining = Read-Header $last 'x-budget-remaining'
            $byCall += "$($spent):$lastRemaining"
        } elseif ($last.Status -eq 429) { Start-Sleep -Seconds 5 } else { break }
    }
    $measured.budget = [ordered]@{ quota = $TinyBudget; acceptedCalls = $ok; realTokens = $spent; realTokensAndHeaderByCall = $byCall; finalStatus = $last.Status }
    $over = if ($TinyBudget -gt 0) { [Math]::Round(100.0 * ($spent - $TinyBudget) / $TinyBudget) } else { 0 }
    Add-Result 'a spent monthly budget returns 403' ($last.Status -eq 403) "after $ok calls and $spent real tokens on a $TinyBudget-token budget ($over% over); last x-budget-remaining $lastRemaining; $($last.Status) $(Get-Snippet $last.Body)"

    # --- U28 and U25: rotation -------------------------------------------------------------
    # The quota is counted at each gateway node and synchronised later, so right after the first
    # 403 a further call can still pass. U28 waits until the spent key is refused five times in a
    # row, then rotates it and makes five calls with the new key. A counter that restarted would
    # refuse none of them (five short calls are about 90 tokens of a fresh 300), so any quota
    # refusal shows the count carried across.
    $tHeld = Measure-PocUntil { (Invoke-Claude $keys.tiny).Status -eq 403 } -TimeoutSec 300
    $measured.budget.secondsUntil403Held = $tHeld
    $null = Invoke-PocKeyRotation -Context $ctx -Name "tiny-$run"
    $tinyNext = Get-PocKey -Context $ctx -Name "tiny-$run"
    $tinyChanged = $tinyNext -ne $keys.tiny
    $null = Measure-PocUntil { (Invoke-Probe $tinyNext).Status -eq 200 } -TimeoutSec 300
    $after = @(1..5 | ForEach-Object { $r = Invoke-Claude $tinyNext; Start-Sleep -Seconds 1; $r })
    $tinyNext = $null
    $quotaRefusals = @($after | Where-Object { $_.Status -eq 403 -and $_.Body -like '*quota*' }).Count
    $measured.budget.rotatedKeyQuotaRefusalsOf5 = $quotaRefusals
    Add-Result 'U28 the budget count carries across a rotation' ($tHeld -ge 0 -and $tinyChanged -and $quotaRefusals -ge 1) "the spent key's 403 held from $tHeld s; its rotated key (a different key: $tinyChanged) was refused for quota $quotaRefusals of 5 times (a restarted count refuses none)"

    $headers = @((Read-Header (Invoke-Claude $keys.alice) 'x-budget-remaining'))
    $k0 = $keys.alice
    $t0 = [datetime]::UtcNow
    $null = Invoke-PocKeyRotation -Context $ctx -Name "alice-$run"
    $k1 = Get-PocKey -Context $ctx -Name "alice-$run"
    $t = Measure-PocUntil { (Invoke-Probe $k1).Status -eq 200 } -Since $t0
    $measured.rotatedKeyAcceptedSeconds = $t
    $overlap = @(1..5 | ForEach-Object { (Invoke-Probe $k0).Status; Start-Sleep -Seconds 1 })
    $overlapOk = @($overlap | Where-Object { $_ -eq 200 }).Count -eq 5
    Add-Result 'U25 a rotated key reaches the gateway, and the key clients hold still works' ($t -ge 0 -and $overlapOk -and $k1 -ne $k0) "new key accepted from $t s after the rotation request; previous key on five checks: $($overlap -join ',')"
    $headers += Read-Header (Invoke-Claude $k1) 'x-budget-remaining'
    $measured.remainingHeaderAcrossRotation = $headers
    $t0 = [datetime]::UtcNow
    $null = Invoke-PocKeyRotation -Context $ctx -Name "alice-$run"
    $k2 = Get-PocKey -Context $ctx -Name "alice-$run"
    $tOld = Measure-PocUntil { (Invoke-Probe $k0).Status -eq 401 } -Since $t0
    $tNew = Measure-PocUntil { (Invoke-Probe $k2).Status -eq 200 } -Since $t0
    $measured.regeneratedKeyRefusedSeconds = $tOld
    $measured.regeneratedReplacementAcceptedSeconds = $tNew
    Add-Result 'U25 a regenerated key stops working' ($tOld -ge 0) "the replaced key was refused (401) from $tOld s after the rotation request; its replacement accepted from $tNew s"
    $k0 = $null; $k1 = $null; $k2 = $null

    # --- U24 and U25: expiry and suspension ------------------------------------------------
    $sidCarol = "poc-carol-$run"
    $baseProbe = Invoke-Probe $keys.carol
    $base = Read-Json $baseProbe.Body
    $future = [datetime]::new([datetime]::UtcNow.AddDays(30).Ticks, [DateTimeKind]::Utc).Date.AddHours(13).AddMinutes(45).AddSeconds(10)
    Set-PocKeyExpiry -Context $ctx -Name "carol-$run" -ExpiresUtc $future
    $stored = "$((Invoke-WebRequest -Uri "$($ctx.ApimBase)/subscriptions/$sidCarol`?api-version=2024-05-01" -Headers @{ Authorization = "Bearer $(Get-PocToken -Context $ctx -Resource 'https://management.azure.com/')" }).Content)"
    $measured.expiryStored = [ordered]@{ set = $future.ToString('o'); stored = [regex]::Match($stored, '"expirationDate":\s*"([^"]+)"').Groups[1].Value }
    Add-Result 'the stored expiry, read back' ($measured.expiryStored.stored -ne '') "set $($measured.expiryStored.set), stored $($measured.expiryStored.stored)"
    $tEnd = Measure-PocUntil { $e = (Read-Json (Invoke-Probe $keys.carol).Body).endDate; [bool]$e } -TimeoutSec 300
    $afterProbe = Invoke-Probe $keys.carol
    $seen = (Read-Json $afterProbe.Body).endDate
    $reflects = $tEnd -ge 0
    $measured.endDate = [ordered]@{ before = $base.endDate; expirationDateSet = $future.ToString('o'); probeEndDate = $seen; reflectsExpirationDate = $reflects; secondsToAppear = $tEnd }
    # A measurement: either answer settles U24. It fails only if the probe could not be read.
    Add-Result 'U24 measured: does context.Subscription.EndDate show the expiry?' ($baseProbe.Status -eq 200 -and $afterProbe.Status -eq 200) "$(if ($reflects) { 'yes' } else { 'no' }): EndDate before '$($base.endDate)'; after setting expirationDate $($future.ToString('u')) it read '$seen' (waited $(if ($reflects) { "$tEnd s" } else { '300 s' }))"

    # API Management refuses an expiry already past ("Subscription expiration date should be
    # greater than current UTC date") and keeps only the date, so an expiry a minute ahead is
    # stored as 00:00 UTC today: expired for the job, still accepted by the gateway.
    Set-PocKeyExpiry -Context $ctx -Name "carol-$run" -ExpiresUtc ([datetime]::UtcNow.AddSeconds(60))
    # Not one probe, which one node can answer either way: a minute of five-in-a-row checks.
    $tStop = Measure-PocUntil { (Invoke-Probe $keys.carol).Status -eq 401 } -TimeoutSec 60
    Add-Result 'an expiry date alone does not stop a key (the gateway does not enforce it)' ($tStop -lt 0) "with the stored expiry already past, the key was $(if ($tStop -lt 0) { 'still accepted for 60 s' } else { "refused from $tStop s" })"

    $t0 = [datetime]::UtcNow
    $suspended = Suspend-ExpiredPocKeys -Context $ctx
    $tSus = Measure-PocUntil { (Invoke-Probe $keys.carol).Status -eq 401 } -Since $t0
    $measured.suspendedKeyRefusedSeconds = $tSus
    Add-Result 'U25 suspending an expired key stops it' ($suspended -contains $sidCarol -and $tSus -ge 0) "suspended [$($suspended -join ', ')]; refused (401) from $tSus s after the suspend job started"

    # "Only 'active' subscriptions can be renewed": reactivate first, then set a new expiry.
    $t0 = [datetime]::UtcNow
    $null = Invoke-PocApim -Context $ctx -Method PATCH -Path "/subscriptions/$sidCarol" -IfMatch -Body @{ properties = @{ state = 'active' } }
    Set-PocKeyExpiry -Context $ctx -Name "carol-$run" -ExpiresUtc ([datetime]::UtcNow.AddDays(30))
    $tAct = Measure-PocUntil { (Invoke-Probe $keys.carol).Status -eq 200 } -Since $t0
    $measured.reactivatedKeyAcceptedSeconds = $tAct
    Add-Result 'U25 a reactivated key works again' ($tAct -ge 0) "accepted from $tAct s after the reactivation request"

    # --- U27: Claude Code with apiKeyHelper reading Key Vault -----------------------------
    if (-not $SkipClaudeCode -and (Get-Command claude -ErrorAction SilentlyContinue)) {
        $cfg = Join-Path ([IO.Path]::GetTempPath()) "poc-claude-$run"
        New-Item -ItemType Directory -Force -Path $cfg | Out-Null
        $helperLog = Join-Path $cfg 'helper.log'
        $helper = "pwsh -NoProfile -File `"$(Join-Path $PSScriptRoot '..' 'claude-code' 'Get-PocKey.ps1')`" -Subscription $($ctx.SubscriptionId) -VaultName $VaultName -Name dev-$run -LogPath `"$helperLog`""
        # The session below sleeps in a tool call for longer than a regenerated key takes to stop
        # working (measured above), plus margin; the Bash tool's timeout is raised to allow it.
        $sleep = [Math]::Min(540, [Math]::Max(60, [int]($tOld + $tNew + 45)))
        $settingsEnv = [ordered]@{
            ANTHROPIC_BASE_URL                       = "$gw/poc/claude"
            ANTHROPIC_MODEL                          = $ClaudeModel
            ANTHROPIC_DEFAULT_HAIKU_MODEL            = $ClaudeModel
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
            BASH_DEFAULT_TIMEOUT_MS                  = '600000'
            BASH_MAX_TIMEOUT_MS                      = '600000'
        }
        if ($IsWindows) {
            $gitBash = Join-Path "$env:ProgramFiles" 'Git' 'bin' 'bash.exe'
            if (Test-Path $gitBash) { $settingsEnv['CLAUDE_CODE_GIT_BASH_PATH'] = $gitBash }
        }
        [ordered]@{ apiKeyHelper = $helper; env = $settingsEnv } | ConvertTo-Json -Depth 4 | Set-Content -Path (Join-Path $cfg 'settings.json') -Encoding UTF8
        $env:CLAUDE_CONFIG_DIR = $cfg
        foreach ($v in 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL') { Remove-Item "env:$v" -ErrorAction SilentlyContinue }

        $out = (& claude -p 'Reply with exactly: OK' 2>&1 | Out-String)
        Add-Result 'U27 Claude Code answers with the key from Key Vault' ($LASTEXITCODE -eq 0 -and $out -match '\bOK\b') "exit $LASTEXITCODE; $(Get-Snippet $out)"

        # A session that outlives two rotations. It must hold the key from before them: the
        # rotations start only after the helper log shows the session's first read. The check is
        # on which key version each read returned and when (Test-PocSessionRefresh), not on how
        # many reads there were.
        $linesBefore = @(Get-Content $helperLog -ErrorAction SilentlyContinue).Count
        $old = Get-PocKeyRecord -Context $ctx -Name "dev-$run"
        $sessionStart = [datetime]::UtcNow
        $job = Start-Job -ArgumentList $cfg, $sleep -ScriptBlock {
            param($Cfg, $Sleep)
            $env:CLAUDE_CONFIG_DIR = $Cfg
            foreach ($v in 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL') { Remove-Item "env:$v" -ErrorAction SilentlyContinue }
            $o = (& claude -p "Use the Bash tool to run exactly this command: sleep $Sleep. After it finishes, reply with exactly: DONE" --allowedTools 'Bash(sleep:*)' 2>&1 | Out-String)
            [pscustomobject]@{ Exit = $LASTEXITCODE; Output = $o }
        }
        $firstRead = Measure-PocUntil { @(Get-Content $helperLog -ErrorAction SilentlyContinue).Count -gt $linesBefore } -Consecutive 1 -TimeoutSec 120
        Start-Sleep -Seconds 10
        $rotationsStart = [datetime]::UtcNow
        $null = Invoke-PocKeyRotation -Context $ctx -Name "dev-$run"
        $null = Invoke-PocKeyRotation -Context $ctx -Name "dev-$run"
        $new = Get-PocKeyRecord -Context $ctx -Name "dev-$run"
        $tGone = Measure-PocUntil { (Invoke-Probe $old.Value).Status -eq 401 } -Since $rotationsStart -TimeoutSec ($sleep - 10)
        $tBack = Measure-PocUntil { (Invoke-Probe $new.Value).Status -eq 200 } -Since $rotationsStart -TimeoutSec ($sleep - 10)
        $session = Receive-Job -Job $job -Wait -AutoRemoveJob
        $sessionLines = @(Get-Content $helperLog | Select-Object -Skip $linesBefore)
        $refresh = Test-PocSessionRefresh -Lines $sessionLines -SessionStartUtc $sessionStart -OldVersion $old.Version -NewVersion $new.Version -RefusedFromUtc $rotationsStart.AddSeconds([Math]::Max(0, $tGone))
        $measured.claudeCodeSession = [ordered]@{ firstReadSeconds = $firstRead; keyRefusedSeconds = $tGone; replacementAcceptedSeconds = $tBack; helperReadsInSession = $sessionLines.Count; refresh = $refresh.Detail }
        $old = $null; $new = $null
        Add-Result 'U27 a Claude Code session keeps working across a rotation' ($session.Exit -eq 0 -and $session.Output -match '\bDONE\b' -and $tGone -ge 0 -and $refresh.Pass) "exit $($session.Exit); its key was refused (401) from $tGone s after the rotations began; $($sessionLines.Count) helper reads in the session; $($refresh.Detail)"

        $out = (& claude -p 'Reply with exactly: OK' 2>&1 | Out-String)
        Add-Result 'U27 a new Claude Code session after the rotations needs no settings change' ($LASTEXITCODE -eq 0 -and $out -match '\bOK\b') "exit $LASTEXITCODE; $(Get-Snippet $out)"
        Remove-Item -Recurse -Force $cfg -ErrorAction SilentlyContinue
    } else { Write-Host 'SKIP  Claude Code checks' }
} finally {
    foreach ($sid in $temporary) {
        try { $null = Invoke-PocApim -Context $ctx -Method DELETE -Path "/subscriptions/$sid" -IfMatch } catch { Write-Host "Could not delete temporary key $sid; Remove-Poc.ps1 removes it." }
    }
    $keys = $null
    $measured.finishedUtc = [datetime]::UtcNow.ToString('o')
    [ordered]@{ measured = $measured; results = $results } | ConvertTo-Json -Depth 6 | Set-Content -Path $ResultsPath -Encoding UTF8
    Write-Host "Results (no keys): $ResultsPath"
}

$failed = @($results | Where-Object { -not $_.pass }).Count
Write-Host "$($results.Count - $failed) of $($results.Count) checks passed."
if ($failed) { exit 1 }
