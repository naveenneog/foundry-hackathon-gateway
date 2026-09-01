#Requires -Version 7.0
<#
.SYNOPSIS
    Participant key issuance for the Foundry Hackathon Gateway.

.DESCRIPTION
    Dot-sourced by admin.ps1, so it runs in that scope and uses its helpers and state functions.

    Keys are signed JWTs minted by scripts/mint.mjs. The token itself is NEVER persisted in
    issued-keys.json - only metadata, so a leaked state file cannot be used to call the gateway.
    The token exists in exactly one place: the participant's handout.

    Not standalone - run ./admin.ps1.
#>

# ------------------------------------------------------------------------------------------
# Shared minting
# ------------------------------------------------------------------------------------------

# Mints one key and records its metadata. Returns the mint result, or $null on failure.
function New-Key {
    param($Secret, $Subject, $Label, $Models, $Budget, $NotBefore, $ExpiresAt)

    $payload = @{
        secret    = $Secret
        subject   = $Subject
        models    = @($Models)
        budget    = $Budget
        notBefore = $NotBefore
        expiresAt = $ExpiresAt
        label     = $Label
    } | ConvertTo-Json -Compress

    # Mint via the tested Node module rather than reimplementing JWS in PowerShell.
    $result = $payload | node (Join-Path $script:Root 'scripts/mint.mjs') | ConvertFrom-Json
    if (-not $result.token) {
        Write-Err "Minting failed for '$Subject': $($result.error)"
        return $null
    }

    $keys = @(Get-IssuedKeys)
    $keys += [pscustomobject]@{
        jti       = $result.jti
        subject   = $Subject
        label     = $Label
        models    = ($Models -join ',')
        budget    = $Budget
        notBefore = ([DateTimeOffset]::FromUnixTimeMilliseconds($NotBefore)).ToString('u')
        expiresAt = ([DateTimeOffset]::FromUnixTimeMilliseconds($ExpiresAt)).ToString('u')
        issuedAt  = ([DateTimeOffset]::UtcNow).ToString('u')
        revoked   = $false
    }
    Save-IssuedKeys $keys
    return $result
}

# Prompts for the settings shared by single and bulk issuance.
function Read-KeySettings {
    param($State)

    $pinned = @($State.models)
    if ($pinned.Count -eq 0) {
        Write-Err 'No models are pinned. Use option 3 first.'
        return $null
    }

    Write-Host ''
    Write-Host '  Pinned models:'
    $i = 1
    foreach ($p in $pinned) { Write-Host ("    [{0}] {1,-14} -> {2}" -f $i, $p.alias, $p.deployment); $i++ }
    Write-Info "    a  all of them"

    $pick = (Read-Default 'Grant which models (numbers separated by commas, or a)' 'a').Trim().ToLowerInvariant()

    $models = @()
    if ($pick -eq 'a') {
        $models = @($pinned | ForEach-Object { $_.alias })
    } else {
        foreach ($tok in $pick.Split(',')) {
            $n = 0
            if ([int]::TryParse($tok.Trim(), [ref]$n) -and $n -ge 1 -and $n -le $pinned.Count) {
                $models += $pinned[$n - 1].alias
            }
        }
        $models = @($models | Select-Object -Unique)
    }

    if ($models.Count -eq 0) { Write-Err 'No valid models selected.'; return $null }
    Write-Ok "Granting: $($models -join ', ')"

    $hours   = [int](Read-Default 'Valid for how many hours' '48')
    $startIn = [int](Read-Default 'Start in how many hours from now (0 = immediately)' '0')
    $budget  = [long](Read-Default 'Token budget per key (one-time, does not reset)' '2000000')

    $now = [DateTimeOffset]::UtcNow
    return [pscustomobject]@{
        models    = $models
        budget    = $budget
        notBefore = $now.AddHours($startIn).ToUnixTimeMilliseconds()
        expiresAt = $now.AddHours($startIn + $hours).ToUnixTimeMilliseconds()
    }
}

# ------------------------------------------------------------------------------------------
# Single key
# ------------------------------------------------------------------------------------------

function New-ParticipantKey {
    $state  = Get-State
    $secret = Get-SigningSecret
    if (-not $secret) { Write-Err 'No signing secret. Deploy the gateway first.'; return }
    if (-not $state.gatewayUrl) { Write-Warn 'Gateway URL unknown; the key will still work once deployed.' }

    Write-Head 'Issue a participant key'

    # `sub` is the tenancy boundary for ALL four counters: the budget cache, the TPM limit, the
    # lifetime quota and the request-rate limit. Two keys with the same subject silently share
    # one budget and rate-limit each other.
    $subject = Read-Default 'Participant or team id' "team-$([guid]::NewGuid().ToString('N').Substring(0,8))"
    if (-not (Test-SubjectFree $subject)) { return }

    $label = Read-Default 'Label (optional, e.g. a name)' ''

    $cfg = Read-KeySettings $state
    if (-not $cfg) { return }

    $result = New-Key -Secret $secret -Subject $subject -Label $label -Models $cfg.models `
                      -Budget $cfg.budget -NotBefore $cfg.notBefore -ExpiresAt $cfg.expiresAt
    if (-not $result) { return }

    $baseUrl = Coalesce $state.gatewayUrl 'https://<deploy-first>/v1'

    Write-Host ''
    Write-Host '  ============================================================' -ForegroundColor Green
    Write-Host '   PARTICIPANT KEY - shown once, copy it now' -ForegroundColor Green
    Write-Host '  ============================================================' -ForegroundColor Green
    Write-Host ''
    Write-Host "   Participant : $subject"
    Write-Host "   Models      : $($cfg.models -join ', ')"
    Write-Host "   Budget      : $('{0:N0}' -f $cfg.budget) tokens (one-time)"
    Write-Host "   Valid       : $(([DateTimeOffset]::FromUnixTimeMilliseconds($cfg.notBefore)).ToString('u')) -> $(([DateTimeOffset]::FromUnixTimeMilliseconds($cfg.expiresAt)).ToString('u'))"
    Write-Host "   Key id      : $($result.jti)"
    Write-Host ''
    Write-Host "   OPENAI_BASE_URL=$baseUrl" -ForegroundColor Yellow
    Write-Host "   OPENAI_API_KEY=$($result.token)" -ForegroundColor Yellow
    Write-Host ''

    if ((Read-Default 'Write an opencode.json + card for this participant? (y/n)' 'y') -eq 'y') {
        Write-Handout -Subject $subject -Token $result.token -BaseUrl $baseUrl `
                      -Models $cfg.models -Budget $cfg.budget -ExpiresAt $cfg.expiresAt
        Write-Ok "Handout written to handouts/$subject/"
    }
}

function Test-SubjectFree {
    param([string]$Subject)
    $existing = @(Get-IssuedKeys | Where-Object { $_.subject -eq $Subject -and -not $_.revoked })
    if ($existing.Count -eq 0) { return $true }

    Write-Warn "'$Subject' already has $($existing.Count) active key(s)."
    Write-Info 'Budget, rate limit and quota are all keyed on the subject, so a second key'
    Write-Info 'SHARES the same allowance rather than getting its own.'
    Write-Info 'That is correct when re-issuing a lost key; it is a bug otherwise.'
    if ((Read-Default 'Is this a deliberate re-issue for the same participant? (y/n)' 'n') -ne 'y') {
        Write-Info 'Cancelled. Choose a different id.'
        return $false
    }
    return $true
}

# ------------------------------------------------------------------------------------------
# Bulk
# ------------------------------------------------------------------------------------------

function New-BulkKeys {
    $state  = Get-State
    $secret = Get-SigningSecret
    if (-not $secret) { Write-Err 'No signing secret. Deploy the gateway first.'; return }

    Write-Head 'Issue keys in bulk'
    Write-Info 'Tokens are NOT printed in bulk mode - a terminal scrollback full of live keys'
    Write-Info 'is a credential leak. Each key is written to its own handout folder instead.'
    Write-Host ''
    Write-Host '    [1] Generate N numbered teams  (team-01, team-02, ...)'
    Write-Host '    [2] Read names from a file     (one participant or team per line)'
    $mode = Read-Default 'Which' '1'

    $subjects = @()
    if ($mode -eq '2') {
        $path = Read-Default 'Path to the file' 'participants.txt'
        if (-not (Test-Path $path)) { Write-Err "File not found: $path"; return }
        $subjects = @(Get-Content $path |
            ForEach-Object { $_.Trim() } |
            Where-Object { $_ -ne '' -and -not $_.StartsWith('#') })
        if ($subjects.Count -eq 0) { Write-Err 'No usable lines in that file.'; return }
    } else {
        $count = [int](Read-Default 'How many keys' '10')
        if ($count -lt 1 -or $count -gt 500) { Write-Err 'Choose between 1 and 500.'; return }
        $prefix = Read-Default 'Team id prefix' 'team'
        $width  = [Math]::Max(2, "$count".Length)
        $subjects = @(1..$count | ForEach-Object { "$prefix-$($_.ToString().PadLeft($width, '0'))" })
    }

    # Subject collisions silently share a budget, so resolve them before minting anything.
    $active = @(Get-IssuedKeys | Where-Object { -not $_.revoked } | ForEach-Object { $_.subject })
    $clashes = @($subjects | Where-Object { $active -contains $_ })
    if ($clashes.Count -gt 0) {
        Write-Warn "$($clashes.Count) of these already have an active key: $($clashes -join ', ')"
        Write-Info 'They would SHARE one budget and rate-limit each other.'
        Write-Host '    [1] Skip the ones that clash  [2] Cancel'
        if ((Read-Default 'Which' '1') -ne '1') { Write-Info 'Cancelled.'; return }
        $subjects = @($subjects | Where-Object { $active -notcontains $_ })
        if ($subjects.Count -eq 0) { Write-Info 'Nothing left to issue.'; return }
    }

    $cfg = Read-KeySettings $state
    if (-not $cfg) { return }

    $totalBudget = [long]$cfg.budget * $subjects.Count
    Write-Host ''
    Write-Host "  About to issue $($subjects.Count) key(s)."
    Write-Host "  Models        : $($cfg.models -join ', ')"
    Write-Host "  Budget each   : $('{0:N0}' -f $cfg.budget) tokens"
    Write-Host "  Budget total  : $('{0:N0}' -f $totalBudget) tokens across all keys" -ForegroundColor Yellow
    Write-Host "  Expires       : $(([DateTimeOffset]::FromUnixTimeMilliseconds($cfg.expiresAt)).ToString('u'))"
    Write-Host ''
    if (-not (Confirm-Action "Issue $($subjects.Count) key(s)?")) { Write-Info 'Cancelled.'; return }

    $baseUrl = Coalesce $state.gatewayUrl 'https://<deploy-first>/v1'
    $stamp   = (Get-Date).ToString('yyyyMMdd-HHmmss')
    $batch   = Join-Path $script:Root "handouts/batch-$stamp"
    New-Item -ItemType Directory -Path $batch -Force | Out-Null

    $issued = 0
    $failed = 0
    $index  = @()

    foreach ($subject in $subjects) {
        $result = New-Key -Secret $secret -Subject $subject -Label '' -Models $cfg.models `
                          -Budget $cfg.budget -NotBefore $cfg.notBefore -ExpiresAt $cfg.expiresAt
        if (-not $result) { $failed++; continue }

        Write-Handout -Subject $subject -Token $result.token -BaseUrl $baseUrl `
                      -Models $cfg.models -Budget $cfg.budget -ExpiresAt $cfg.expiresAt `
                      -Root $batch
        $issued++
        $index += [pscustomobject]@{
            subject = $subject
            keyId   = $result.jti
            models  = ($cfg.models -join ' ')
            budget  = $cfg.budget
            folder  = "handouts/batch-$stamp/$subject"
        }
        Write-Host ("    {0,-18} {1}" -f $subject, $result.jti) -ForegroundColor DarkGray
    }

    # An index WITHOUT tokens, so an organiser can track distribution without holding every
    # credential in one file.
    $index | Export-Csv -Path (Join-Path $batch 'index.csv') -NoTypeInformation -Encoding UTF8

    Write-Host ''
    Write-Ok "$issued key(s) issued to handouts/batch-$stamp/"
    if ($failed -gt 0) { Write-Err "$failed failed." }
    Write-Info 'index.csv lists who got what. It deliberately contains no tokens -'
    Write-Info 'each token is only in that participant''s own README.md.'
}

# ------------------------------------------------------------------------------------------
# Handouts
# ------------------------------------------------------------------------------------------

function Write-Handout {
    param($Subject, $Token, $BaseUrl, $Models, $Budget, $ExpiresAt, $Root)

    $base = Coalesce $Root (Join-Path $script:Root 'handouts')
    $dir  = Join-Path $base $Subject
    New-Item -ItemType Directory -Path $dir -Force | Out-Null

    $modelEntries = [ordered]@{}
    foreach ($m in @($Models)) { $modelEntries[$m] = @{ name = $m } }

    $cfg = [ordered]@{
        '$schema' = 'https://opencode.ai/config.json'
        provider  = [ordered]@{
            'hackathon-gateway' = [ordered]@{
                npm     = '@ai-sdk/openai-compatible'
                name    = 'Hackathon Gateway (Foundry)'
                options = [ordered]@{
                    baseURL = $BaseUrl
                    # Required. For a CUSTOM-NAMED provider, opencode does NOT fall back to
                    # OPENAI_API_KEY - it looks for a provider-specific variable. Without this
                    # line the participant sets OPENAI_API_KEY, curl works, and opencode still
                    # returns 401. Found by following the setup guide on a clean machine.
                    apiKey  = '{env:OPENAI_API_KEY}'
                }
                models  = $modelEntries
            }
        }
        model = "hackathon-gateway/$(@($Models)[0])"
    }
    $cfg | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $dir 'opencode.json') -Encoding UTF8

    $expires = ([DateTimeOffset]::FromUnixTimeMilliseconds($ExpiresAt)).ToString('u')
    $modelRows = (@($Models) | ForEach-Object { "| ``$_`` |" }) -join "`n"

    $card = @"
# Your gateway key - $Subject

Budget: $('{0:N0}' -f $Budget) tokens (one-time - it does not reset)
Expires: $expires

## 1. Set your environment

PowerShell:

    `$env:OPENAI_BASE_URL = "$BaseUrl"
    `$env:OPENAI_API_KEY  = "$Token"

bash/zsh:

    export OPENAI_BASE_URL="$BaseUrl"
    export OPENAI_API_KEY="$Token"

## 2. Use opencode

Copy ``opencode.json`` into your project directory, then run:

    opencode

## 3. Models you can use

$modelRows

Ask for one of these in the ``model`` field. Anything else returns 403.

## Checking your remaining budget

Every response carries headers:

    x-budget-used       tokens consumed so far
    x-budget-total      your total allowance
    x-budget-remaining  what is left

## When something fails

| Status | Code | Meaning |
|--------|------|---------|
| 403 | budget_exhausted    | You spent your whole allowance. It does **not** reset - retrying will not help. This is NOT a broken key. |
| 403 | expired             | Your window has closed. Keys are not extended. |
| 403 | model_not_permitted | That model is not on your key. |
| 403 | revoked             | An organiser revoked this key. |
| 429 | (rate limit)        | Too fast - this one IS worth retrying. Your client backs off automatically. |
| 401 | -                   | The key is invalid or malformed. Ask for a new one. |

Only the 429 is retryable. Everything else is final, and your agent will stop rather than spin.
"@
    $card | Set-Content (Join-Path $dir 'README.md') -Encoding UTF8
}
