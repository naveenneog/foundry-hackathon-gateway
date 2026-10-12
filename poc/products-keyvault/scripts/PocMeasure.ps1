<#
    P37 proof of concept: measurement helpers for Test-Poc.ps1, kept apart from the key
    operations in PocKeys.ps1 so they can be tested without a gateway. A function library with
    no param() block, so dot-sourcing it does not reset the caller's variables.
#>

# Seconds from $Since (the moment of the change) until $Condition has held for $Consecutive
# checks in a row, measured to the first check of that run; -1 after $TimeoutSec. The gateway
# runs several nodes that learn about a change at different times: in one run a new key was
# accepted and then refused on the next call, so one passing check is not an answer.
function Measure-PocUntil {
    param(
        [Parameter(Mandatory)][scriptblock]$Condition,
        [datetime]$Since = [datetime]::UtcNow,
        [int]$TimeoutSec = 900,
        [int]$Consecutive = 5,
        [int]$IntervalMs = 1000
    )
    $pocFrom = $Since.ToUniversalTime()
    $pocStreak = 0
    $pocStreakStart = $pocFrom
    while (([datetime]::UtcNow - $pocFrom).TotalSeconds -lt $TimeoutSec) {
        $pocCheckedAt = [datetime]::UtcNow
        if (& $Condition) {
            if ($pocStreak -eq 0) { $pocStreakStart = $pocCheckedAt }
            $pocStreak++
            if ($pocStreak -ge $Consecutive) { return [Math]::Round(($pocStreakStart - $pocFrom).TotalSeconds, 1) }
        } else { $pocStreak = 0 }
        if ($IntervalMs -gt 0) { Start-Sleep -Milliseconds $IntervalMs }
    }
    return -1
}

# Whether a Claude Code session held the old key until it was refused and then fetched the
# replacement. $Lines are Get-PocKey.ps1 -LogPath lines, "<UTC ISO-8601> <secret version>". The
# session's first read must return $OldVersion, and a later read at or after $RefusedFromUtc
# must return $NewVersion. Counting reads alone passes when the session started on a key the
# rotations never refused, or when the helper simply runs on every request.
function Test-PocSessionRefresh {
    param(
        [string[]]$Lines,
        [Parameter(Mandatory)][datetime]$SessionStartUtc,
        [Parameter(Mandatory)][string]$OldVersion,
        [Parameter(Mandatory)][string]$NewVersion,
        [Parameter(Mandatory)][datetime]$RefusedFromUtc
    )
    $styles = [Globalization.DateTimeStyles]::AdjustToUniversal -bor [Globalization.DateTimeStyles]::AssumeUniversal
    $reads = @(foreach ($line in @($Lines)) {
            $parts = "$line".Trim() -split '\s+'
            $at = [datetime]::MinValue
            if ($parts.Count -ge 2 -and [datetime]::TryParse($parts[0], [Globalization.CultureInfo]::InvariantCulture, $styles, [ref]$at)) {
                [pscustomobject]@{ At = $at; Version = $parts[1] }
            }
        }) | Where-Object { $_.At -ge $SessionStartUtc.ToUniversalTime() } | Sort-Object At
    $result = { param($Pass, $Detail) [pscustomobject]@{ Pass = $Pass; Detail = $Detail } }
    if ($reads.Count -eq 0) { return & $result $false 'the session never read the key' }
    if ($reads[0].Version -ne $OldVersion) { return & $result $false "the session's first read returned $($reads[0].Version), not the key the rotations replaced" }
    $refresh = @($reads | Where-Object { $_.At -ge $RefusedFromUtc.ToUniversalTime() -and $_.Version -eq $NewVersion }) | Select-Object -First 1
    if (-not $refresh) { return & $result $false "no read of the new key after the old one was refused ($($reads.Count) reads)" }
    return & $result $true "first read the old key at $($reads[0].At.ToString('HH:mm:ss')); read the new key at $($refresh.At.ToString('HH:mm:ss')), after the old one was refused"
}

# Whether one client check in Test-PocClients.ps1 passed. A check passes when the client exits 0
# and prints the expected answer. A control passes only when the gateway refused its key: a
# non-zero exit and output matching $Refusal. A network error or a 429 is not a refusal.
function Test-PocClientResult {
    param(
        [int]$ExitCode,
        [AllowEmptyString()][string]$Output,
        [Parameter(Mandatory)][string]$Expect,
        [string]$Refusal = ''
    )
    if ($Refusal) { return $ExitCode -ne 0 -and $Output -match $Refusal }
    return $ExitCode -eq 0 -and $Output -match $Expect
}
