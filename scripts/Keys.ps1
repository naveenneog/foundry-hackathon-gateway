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

# Where handouts are written: handouts/ in the repository unless $script:HandoutsDir says
# otherwise. The tests point it at a scratch directory.
function Get-HandoutsDir {
    if ($script:HandoutsDir) { return $script:HandoutsDir }
    return (Join-Path $script:Root 'handouts')
}

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

function Move-ExpiredKeysToArchive {
    <#
        Move keys more than ten minutes past their expiry from issued-keys.json to
        issued-keys-archive.json, so the key list shows keys that can still be used. Returns how
        many moved.

        Ten minutes, not zero: the gateway allows 60 seconds of clock skew when it checks `exp`
        (infra/policy.xml, validate-jwt), and an archived key no longer goes into the denylist
        Revoke-Key pushes. Past the skew, `exp` refuses it on its own.

        A key whose expiry cannot be read stays where it is. The archive is written first, so a
        failure between the two writes leaves a key in both files rather than in neither, and
        archived records are de-duplicated by key id.
    #>
    param([DateTimeOffset]$Now = [DateTimeOffset]::UtcNow)

    $cutoff  = $Now.AddMinutes(-10)
    $keys    = @(Get-IssuedKeys)
    $expired = @($keys | Where-Object { $e = ConvertTo-Dto $_.expiresAt; $null -ne $e -and $e -lt $cutoff })
    if ($expired.Count -eq 0) { return 0 }

    $archive = @(Get-ArchivedKeys)
    $known   = @($archive | ForEach-Object { [string]$_.jti })
    foreach ($k in $expired) {
        if ($known -contains [string]$k.jti) { continue }
        $k | Add-Member -NotePropertyName archivedAt -NotePropertyValue $Now.ToString('u') -Force
        $archive += $k
    }
    Save-ArchivedKeys $archive

    $gone = @($expired | ForEach-Object { [string]$_.jti })
    Save-IssuedKeys @($keys | Where-Object { $gone -notcontains [string]$_.jti })
    return $expired.Count
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
    Write-Host '  Pinned models — pick the ones THIS key may use:'
    $i = 1
    foreach ($p in $pinned) {
        $r = if ($p.PSObject.Properties.Name -contains 'route' -and $p.route) { $p.route } else { 'openai' }
        Write-Host ("    [{0}] {1,-10} {2,-14} -> {3}" -f $i, $r, $p.alias, $p.deployment)
        $i++
    }
    Write-Info '    a  all of them'
    Write-Info 'Each key can grant a different set. Pin everything once, then choose per key.'

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

    # A window of minutes is almost always a typo, and it produces a key that dies while the
    # participant is still reading the card. Confirm it deliberately.
    if ($hours -lt 1) {
        Write-Warn "A $hours-hour window means the key is dead almost immediately."
        if (-not (Confirm-Action 'Really issue a key that short?')) { return $null }
    } elseif ($hours -lt 4) {
        Write-Warn "$hours hour(s) is short for an event. Participants often lose the first hour to setup."
    }

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

    $hostName = Read-ParticipantHost -State $state
    $urls = Get-ParticipantUrls -State $state -HostName $hostName

    $result = New-Key -Secret $secret -Subject $subject -Label $label -Models $cfg.models `
                      -Budget $cfg.budget -NotBefore $cfg.notBefore -ExpiresAt $cfg.expiresAt
    if (-not $result) { return }

    $baseUrl = Coalesce $urls.openai 'https://<deploy-first>/v1'

    Write-Host ''
    Write-Host '  ============================================================' -ForegroundColor Green
    Write-Host '   PARTICIPANT KEY - shown once, copy it now' -ForegroundColor Green
    Write-Host '  ============================================================' -ForegroundColor Green
    Write-Host ''
    Write-Host "   Participant : $subject"
    Write-Host "   Models      : $($cfg.models -join ', ')"
    Write-Host "   Budget      : $('{0:N0}' -f $cfg.budget) tokens (one-time)"
    $nbfDto = [DateTimeOffset]::FromUnixTimeMilliseconds($cfg.notBefore)
    $expDto = [DateTimeOffset]::FromUnixTimeMilliseconds($cfg.expiresAt)
    Write-Host "   Active from : $($nbfDto.ToLocalTime().ToString('yyyy-MM-dd HH:mm zzz'))  ($($nbfDto.UtcDateTime.ToString('HH:mm')) UTC)"
    Write-Host "   Expires     : $($expDto.ToLocalTime().ToString('yyyy-MM-dd HH:mm zzz'))  ($($expDto.UtcDateTime.ToString('HH:mm')) UTC)"
    Write-Host "   Key id      : $($result.jti)"
    Write-Host ''
    # The token is shown once and is not recoverable, so it is printed unconditionally before
    # anything route-specific. An earlier revision printed it only inside the per-route blocks,
    # which meant a key granting only Claude models, issued before the Claude route was
    # deployed, was minted and then lost.
    Write-Host "   KEY: $($result.token)" -ForegroundColor Yellow
    Write-Host ''
    $issuedSplit = Split-ModelsByRoute -State $state -Models $cfg.models
    if ($issuedSplit.openai.Count -gt 0) {
        Write-Host "   OPENAI_BASE_URL=$baseUrl" -ForegroundColor Yellow
        Write-Host "   OPENAI_API_KEY=<the key above>" -ForegroundColor Yellow
    }
    if ($issuedSplit.claude.Count -gt 0 -and $urls.claude) {
        Write-Host ''
        Write-Host "   ANTHROPIC_BASE_URL=$($urls.claude)" -ForegroundColor Yellow
        Write-Host "   ANTHROPIC_AUTH_TOKEN=<the key above>" -ForegroundColor Yellow
        Write-Host "   ANTHROPIC_MODEL=$(@($issuedSplit.claude)[0])" -ForegroundColor Yellow
        Write-Info 'AUTH_TOKEN, not API_KEY: the second is sent as x-api-key and returns 401.'
    } elseif ($issuedSplit.claude.Count -gt 0) {
        Write-Warn 'This key grants Claude models but the Claude route is not deployed yet.'
        Write-Info 'The key will start working on that route as soon as option 1 publishes it.'
    }
    Write-Host ''

    if ((Read-Default 'Write a config + card for this participant? (y/n)' 'y') -eq 'y') {
        $split = Split-ModelsByRoute -State $state -Models $cfg.models
        Write-Handout -Subject $subject -Token $result.token -BaseUrl $baseUrl `
                      -Models $cfg.models -Budget $cfg.budget -ExpiresAt $cfg.expiresAt `
                      -ClaudeBaseUrl $urls.claude -ClaudeModels $split.claude
        Write-Ok "Handout written to handouts/$subject/"
    }
}

function Test-SubjectFree {
    param([string]$Subject)
    $existing = @(Get-IssuedKeys | Where-Object { $_.subject -eq $Subject -and -not $_.revoked })
    # Archived keys count too: the counters are keyed on the subject, not the key, so an
    # expired key's spend can count against a new key with the same id.
    $earlier  = @(Get-ArchivedKeys | Where-Object { $_.subject -eq $Subject })
    if ($existing.Count -eq 0 -and $earlier.Count -eq 0) { return $true }

    if ($existing.Count -gt 0) { Write-Warn "'$Subject' already has $($existing.Count) active key(s)." }
    if ($earlier.Count -gt 0) { Write-Warn "'$Subject' was used by $($earlier.Count) expired key(s), now archived." }
    Write-Info 'Budget, rate limit and quota are all keyed on the subject, so a second key'
    Write-Info 'SHARES the same allowance rather than getting its own, including what earlier keys spent.'
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
    # Archived (expired) keys count: their spend is on the same subject-keyed counters.
    $active = @(Get-IssuedKeys | Where-Object { -not $_.revoked } | ForEach-Object { $_.subject })
    $active += @(Get-ArchivedKeys | ForEach-Object { $_.subject })
    $clashes = @($subjects | Where-Object { $active -contains $_ })
    if ($clashes.Count -gt 0) {
        Write-Warn "$($clashes.Count) of these already have a key, current or expired: $($clashes -join ', ')"
        Write-Info 'They would SHARE one budget and rate-limit each other.'
        Write-Host '    [1] Skip the ones that clash  [2] Cancel'
        if ((Read-Default 'Which' '1') -ne '1') { Write-Info 'Cancelled.'; return }
        $subjects = @($subjects | Where-Object { $active -notcontains $_ })
        if ($subjects.Count -eq 0) { Write-Info 'Nothing left to issue.'; return }
    }

    $cfg = Read-KeySettings $state
    if (-not $cfg) { return }

    $hostName = Read-ParticipantHost -State $state
    $urls = Get-ParticipantUrls -State $state -HostName $hostName

    $totalBudget = [long]$cfg.budget * $subjects.Count
    Write-Host ''
    Write-Host "  About to issue $($subjects.Count) key(s)."
    Write-Host "  Models        : $($cfg.models -join ', ')"
    Write-Host "  Budget each   : $('{0:N0}' -f $cfg.budget) tokens"
    Write-Host "  Budget total  : $('{0:N0}' -f $totalBudget) tokens across all keys" -ForegroundColor Yellow
    Write-Host "  Expires       : $(([DateTimeOffset]::FromUnixTimeMilliseconds($cfg.expiresAt)).ToLocalTime().ToString('yyyy-MM-dd HH:mm zzz'))"
    Write-Host "                  $(([DateTimeOffset]::FromUnixTimeMilliseconds($cfg.expiresAt)).UtcDateTime.ToString('yyyy-MM-dd HH:mm')) UTC" -ForegroundColor DarkGray
    if ($urls.openai) { Write-Host "  Base URL      : $($urls.openai)" }
    if ($urls.claude) { Write-Host "  Claude URL    : $($urls.claude)" }
    Write-Host ''
    if (-not (Confirm-Action "Issue $($subjects.Count) key(s)?")) { Write-Info 'Cancelled.'; return }

    $baseUrl = Coalesce $urls.openai 'https://<deploy-first>/v1'
    $stamp   = (Get-Date).ToString('yyyyMMdd-HHmmss')
    $batch   = Join-Path (Get-HandoutsDir) "batch-$stamp"
    New-Item -ItemType Directory -Path $batch -Force | Out-Null

    $issued = 0
    $failed = 0
    $index  = @()
    $bulkSplit = Split-ModelsByRoute -State $state -Models $cfg.models

    foreach ($subject in $subjects) {
        $result = New-Key -Secret $secret -Subject $subject -Label '' -Models $cfg.models `
                          -Budget $cfg.budget -NotBefore $cfg.notBefore -ExpiresAt $cfg.expiresAt
        if (-not $result) { $failed++; continue }

        Write-Handout -Subject $subject -Token $result.token -BaseUrl $baseUrl `
                      -Models $cfg.models -Budget $cfg.budget -ExpiresAt $cfg.expiresAt `
                      -ClaudeBaseUrl $urls.claude -ClaudeModels $bulkSplit.claude `
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
# Diagnose a rejected key
# ------------------------------------------------------------------------------------------

function Test-ParticipantKey {
    $state  = Get-State
    $secret = Get-SigningSecret
    if (-not $secret) { Write-Err 'No signing secret on this machine. Deploy the gateway first.'; return }

    Write-Head 'Why is this key being rejected?'
    Write-Info 'The gateway returns one message for three different causes. Paste the key and'
    Write-Info 'this will tell you which one it actually is. Nothing is sent anywhere.'
    Write-Host ''

    $token = Read-Host '  Paste the key'
    if ([string]::IsNullOrWhiteSpace($token)) { Write-Info 'Cancelled.'; return }

    # Diagnose against the map the GATEWAY currently has, not the local pins, so a pin that
    # was never pushed shows up as the problem it is. Both routes' maps are read: a key can
    # grant a Claude alias, and reading only the OpenAI map would report it as unconfigured.
    $map = ''
    if ($state.apimName) {
        $parts = @()
        foreach ($id in @('model-map', 'claude-model-map')) {
            $m = Get-GatewayNamedValue -Id $id -State $state
            if ($m -and $m.Trim() -ne '' -and $m.Trim() -ne ';') { $parts += $m.Trim() }
        }
        $map = ($parts -join ';')
    }
    if (-not $map) {
        $map = (@('openai', 'claude') | ForEach-Object { ConvertTo-ModelMapString $state.models -Route $_ } |
            Where-Object { $_ -ne '' }) -join ';'
    }

    $revoked = @(Get-IssuedKeys | Where-Object { $_.revoked } | ForEach-Object { $_.jti })

    $payload = @{ token = $token.Trim(); secret = $secret; modelMap = $map; revoked = $revoked } | ConvertTo-Json -Compress
    $r = $payload | node (Join-Path $script:Root 'scripts/diagnose.mjs') | ConvertFrom-Json
    if ($r.error) { Write-Err "Could not read the key: $($r.error)"; return }

    Write-Host ''
    if ($r.subject) { Write-Host "   Participant : $($r.subject)" }
    if ($r.keyId)   { Write-Host "   Key id      : $($r.keyId)" }
    if ($r.models)  { Write-Host "   Models      : $($r.models -join ', ')" }
    if ($null -ne $r.budget) { Write-Host "   Budget      : $('{0:N0}' -f $r.budget) tokens" }
    if ($r.expiresAtEpochMs) {
        $exp = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$r.expiresAtEpochMs)
        Write-Host "   Expires     : $($exp.ToLocalTime().ToString('yyyy-MM-dd HH:mm zzz'))  ($($r.expiresAtUtc))"
    }
    Write-Host ''

    if ($r.ok) {
        Write-Ok $r.detail
        Write-Info 'If the participant still sees 401, they are pointed at a different gateway,'
        Write-Info 'or they did not paste the whole key.'
    } else {
        Write-Err "$($r.fault): $($r.detail)"
        Write-Host ''
        Write-Info "Fix: $($r.fix)"
    }
}

# ------------------------------------------------------------------------------------------
# Handouts
# ------------------------------------------------------------------------------------------

function Split-ModelsByRoute {
    <#
        Which of the granted aliases belong to which route. The handout differs: opencode gets
        an opencode.json and OPENAI_* variables; Claude Code gets ANTHROPIC_* variables and a
        .claude/settings.json.
    #>
    param($State, $Models)
    $pins = @($State.models)
    $claude = @()
    $openai = @()
    foreach ($alias in @($Models)) {
        $pin = @($pins | Where-Object { $_.alias -eq $alias }) | Select-Object -First 1
        $route = if ($pin -and ($pin.PSObject.Properties.Name -contains 'route') -and $pin.route) { $pin.route } else { 'openai' }
        if ($route -eq 'claude') { $claude += $alias } else { $openai += $alias }
    }
    return [pscustomobject]@{ openai = $openai; claude = $claude }
}

function Write-Handout {
    param(
        $Subject, $Token, $BaseUrl, $Models, $Budget, $ExpiresAt, $Root,
        $ClaudeBaseUrl, $ClaudeModels
    )

    $base = Coalesce $Root (Get-HandoutsDir)
    $dir  = Join-Path $base $Subject
    New-Item -ItemType Directory -Path $dir -Force | Out-Null

    $claudeAliases = @($ClaudeModels)
    $openaiAliases = @(@($Models) | Where-Object { $claudeAliases -notcontains $_ })

    $modelEntries = [ordered]@{}
    foreach ($m in $openaiAliases) { $modelEntries[$m] = @{ name = $m } }

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
        model = "hackathon-gateway/$(@($openaiAliases)[0])"
    }
    if ($openaiAliases.Count -gt 0) {
        $cfg | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $dir 'opencode.json') -Encoding UTF8
    }

    # Claude Code reads an `env` block from a settings file, which is what makes the gateway
    # apply to background agents too - a shell export does not reach those.
    # https://code.claude.com/docs/en/llm-gateway-connect
    if ($claudeAliases.Count -gt 0 -and $ClaudeBaseUrl) {
        $claudeDir = Join-Path $dir '.claude'
        New-Item -ItemType Directory -Path $claudeDir -Force | Out-Null
        $claudeSettings = [ordered]@{
            env = [ordered]@{
                # AUTH_TOKEN, not API_KEY: this value is sent as `Authorization: Bearer`, which
                # is what the gateway validates. ANTHROPIC_API_KEY would be sent as `x-api-key`
                # and produce a bare 401.
                ANTHROPIC_BASE_URL   = $ClaudeBaseUrl
                ANTHROPIC_AUTH_TOKEN = $Token
                # Without this, Claude Code asks for its own default model id, which is not an
                # alias on this gateway, and the key refuses it.
                ANTHROPIC_MODEL      = @($claudeAliases)[0]
            }
        }
        $claudeSettings | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $claudeDir 'settings.json') -Encoding UTF8
    }

    $expDto  = [DateTimeOffset]::FromUnixTimeMilliseconds($ExpiresAt)
    $expUtc   = $expDto.UtcDateTime.ToString('yyyy-MM-dd HH:mm') + ' UTC'
    $expLocal = $expDto.ToLocalTime().ToString('yyyy-MM-dd HH:mm zzz')
    $modelRows = (@($Models) | ForEach-Object { "| ``$_`` |" }) -join "`n"

    $openaiSection = ''
    if ($openaiAliases.Count -gt 0) {
        $openaiSection = @"

## opencode (and any OpenAI-compatible client)

Models on this route: $($openaiAliases -join ', ')

PowerShell:

    `$env:OPENAI_BASE_URL = "$BaseUrl"
    `$env:OPENAI_API_KEY  = "$Token"

bash/zsh:

    export OPENAI_BASE_URL="$BaseUrl"
    export OPENAI_API_KEY="$Token"

Copy ``opencode.json`` into your project directory, then run ``opencode``.
"@
    }

    $claudeSection = ''
    if ($claudeAliases.Count -gt 0 -and $ClaudeBaseUrl) {
        $firstClaude = @($claudeAliases)[0]
        $claudeSection = @"

## Claude Code

Models on this route: $($claudeAliases -join ', ')

PowerShell:

    `$env:ANTHROPIC_BASE_URL   = "$ClaudeBaseUrl"
    `$env:ANTHROPIC_AUTH_TOKEN = "$Token"
    `$env:ANTHROPIC_MODEL      = "$firstClaude"

bash/zsh:

    export ANTHROPIC_BASE_URL="$ClaudeBaseUrl"
    export ANTHROPIC_AUTH_TOKEN="$Token"
    export ANTHROPIC_MODEL="$firstClaude"

Then run ``claude``.

Three things are worth knowing before you start.

**``ANTHROPIC_AUTH_TOKEN``, not ``ANTHROPIC_API_KEY``.** The first is sent as
``Authorization: Bearer``, which is what this gateway checks. The second is sent as
``x-api-key``, and the same key in that variable returns a bare 401.

**``ANTHROPIC_MODEL`` is required, and must be one of the names above.** Do not shorten it to
``sonnet``, ``opus`` or ``haiku``: Claude Code treats those as its own model slots and replaces
them with its default model id before the request leaves your machine, so the gateway sees a
model your key does not grant and returns 403.

**If Claude Code is already configured on this machine, its settings win.** A
``~/.claude/settings.json`` carrying ``model``, ``availableModels``, ``ANTHROPIC_DEFAULT_*_MODEL``
or ``CLAUDE_CODE_USE_FOUNDRY`` overrides everything above, including a project settings file, and
requests go to the old destination. The reliable fix is a scratch config directory, which also
leaves your own setup untouched:

    `$env:CLAUDE_CONFIG_DIR = "`$env:TEMP\gw-claude"     # PowerShell
    export CLAUDE_CONFIG_DIR="/tmp/gw-claude"           # bash/zsh

Closing that terminal restores everything. ``/status`` shows which base URL and credential are
actually in use.

**Shell exports do not reach background agents.** The included ``.claude/settings.json`` sets
everything everywhere Claude Code runs. Copy it into your project, or merge its ``env`` block
into ``~/.claude/settings.json``. It contains your key, so do not commit it.

Claude Code will say the model "isn't described by this version's model catalog" and assume a
200K context window. That is expected for a gateway alias and is safe: it under-reports a larger
window rather than over-reporting. Set ``CLAUDE_CODE_MAX_CONTEXT_TOKENS`` if you need the real
one.
"@
    }

    # A grant can resolve to neither section: Claude aliases pinned before the Claude route is
    # deployed. The card is then the only record of the token, so it carries it plainly rather
    # than silently omitting a credential that cannot be recovered.
    $fallbackSection = ''
    if ($openaiSection -eq '' -and $claudeSection -eq '') {
        $fallbackSection = @"

## Your key

    $Token

The route for the models on this key is not published yet. Ask the organiser when it is, then
use the base URL they give you with this key.
"@
    }

    $card = @"
# Your gateway key - $Subject

Budget: $('{0:N0}' -f $Budget) tokens (one-time - it does not reset)

Expires: **$expLocal**
Same moment in UTC: $expUtc

The gateway decides expiry using its own clock, not yours. Changing your computer's clock
or timezone does not extend the key, and a wrong clock on your machine does not break it.

One key, one budget. If you use both routes below, they draw on the same allowance.
$openaiSection
$claudeSection
$fallbackSection

## Models you can use

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
| 400 | (anthropic-beta)    | Claude Code advertised a capability Foundry does not accept yet; the message names the value. Run with a scratch `CLAUDE_CONFIG_DIR` as above. |
| 403 | expired             | Your window has closed. Keys are not extended. |
| 403 | model_not_permitted | That model is not on your key. |
| 403 | revoked             | An organiser revoked this key. |
| 429 | (rate limit)        | Too fast - this one IS worth retrying. Your client backs off automatically. |
| 401 | -                   | The key is invalid or malformed. Ask for a new one. |

Only the 429 is retryable. Everything else is final, and your agent will stop rather than spin.
"@
    $card | Set-Content (Join-Path $dir 'README.md') -Encoding UTF8
}
