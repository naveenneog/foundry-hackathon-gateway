#Requires -Version 7.0
<#
.SYNOPSIS
    Preflight checks for the Foundry Hackathon Gateway admin console.

.DESCRIPTION
    Dot-sourced by admin.ps1, so it runs in that scope and uses its output helpers
    (Write-Ok / Write-Err / Write-Info / Write-Warn / Write-Head), Coalesce and Get-State.

    Split out of admin.ps1 to keep that file within its complexity budget. It is not
    standalone - run ./admin.ps1.
#>
function Test-Prerequisites {
    Write-Head 'Preflight'
    $fail = 0
    $warn = 0

    # --- PowerShell: hard requirement ---
    #
    # 7.0 is the real technical floor: ?? , -SkipHttpErrorCheck, and correct ConvertTo-Json
    # array handling all need it. Windows PowerShell 5.1 silently corrupted issued-keys.json
    # by serialising the array wrapper instead of the array, which broke key listing AND
    # revocation. See docs/adr/0006-powershell-7-requirement.md.
    #
    # #Requires -Version 7.0 at the top of this file catches it before the script even parses;
    # this check is the belt-and-braces for dot-sourced or non-standard invocation.
    $psv = $PSVersionTable.PSVersion
    if ($psv.Major -lt 7) {
        Write-Err "PowerShell $psv is not supported. PowerShell 7.0 or later is required."
        Write-Info 'Install:  winget install --id Microsoft.PowerShell --source winget'
        Write-Info 'Then run this script with:  pwsh ./admin.ps1'
        $fail++
    } elseif ($psv.Major -eq 7 -and $psv.Minor -lt 4) {
        Write-Ok "PowerShell $psv"
        Write-Warn "PowerShell $psv is past end of support. 7.4 LTS or later is recommended."
        $warn++
    } else {
        Write-Ok "PowerShell $psv"
    }

    # --- Azure CLI ---
    $azCmd = Get-Command az -ErrorAction SilentlyContinue
    if (-not $azCmd) {
        Write-Err 'Azure CLI not found on PATH.'
        Write-Info 'Install: https://aka.ms/installazurecliwindows   then reopen this terminal.'
        $fail++
    } else {
        $azVer = $null
        try { $azVer = (az version --output json 2>$null | ConvertFrom-Json).'azure-cli' } catch { }
        Write-Ok "Azure CLI $(Coalesce $azVer 'present')"

        # --- Signed in ---
        $acct = $null
        try { $acct = az account show --output json 2>$null | ConvertFrom-Json } catch { }
        if (-not $acct) {
            Write-Err 'Not signed in to Azure.'
            Write-Info "Run: az login"
            $fail++
        } else {
            Write-Ok "Signed in as $($acct.user.name)"
            Write-Info "Subscription: $($acct.name)"
        }

        # --- Bicep, needed to deploy ---
        $bicepOk = $false
        try { $null = az bicep version 2>$null; $bicepOk = ($LASTEXITCODE -eq 0) } catch { }
        if ($bicepOk) { Write-Ok 'Bicep CLI' }
        else {
            Write-Warn 'Bicep not installed. It is required for option 1 (deploy).'
            Write-Info 'Install: az bicep install'
            $warn++
        }
    }

    # --- Node, used to mint keys ---
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if (-not $nodeCmd) {
        Write-Err 'Node.js not found on PATH. Required to mint participant keys.'
        Write-Info 'Install Node 20 or later: https://nodejs.org'
        $fail++
    } else {
        $nodeVer = (node --version 2>$null)
        $major = 0
        if ($nodeVer -match 'v(\d+)') { $major = [int]$Matches[1] }
        if ($major -ge 20) {
            Write-Ok "Node $nodeVer"
        } else {
            Write-Err "Node $nodeVer is too old. Version 20 or later is required."
            $fail++
        }
    }

    # --- The minting script must be present and working ---
    $mint = Join-Path $script:Root 'scripts/mint.mjs'
    if (-not (Test-Path $mint)) {
        Write-Err "Missing scripts/mint.mjs - the repository looks incomplete."
        $fail++
    } elseif ($nodeCmd) {
        # Round-trip a throwaway key so a broken Node install fails here rather than in front
        # of a participant. The probe secret is generated on the spot and discarded — nothing
        # credential-shaped is stored in this file.
        $probeBytes = New-Object byte[] 32
        $probeRng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
        try { $probeRng.GetBytes($probeBytes) } finally { $probeRng.Dispose() }

        $probe = @{
            secret    = [Convert]::ToBase64String($probeBytes)
            subject   = 'preflight'
            models    = @('flash')
            budget    = 1
            notBefore = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
            expiresAt = [DateTimeOffset]::UtcNow.AddMinutes(1).ToUnixTimeMilliseconds()
        } | ConvertTo-Json -Compress
        $out = $null
        try { $out = $probe | node $mint 2>$null | ConvertFrom-Json } catch { }
        if ($out -and $out.token) { Write-Ok 'Key minting works' }
        else { Write-Err 'Key minting failed. Run "npm test" to diagnose.'; $fail++ }
    }

    # --- Signing-secret drift ---
    #
    # If the local secret stops matching the one deployed as the `signing-key` named value,
    # every key ever issued fails with a bare 401 and no diagnostic. This happens whenever the
    # gateway is deployed from a second machine, which generates its own secret. Detect it.
    $st = Get-State
    if ($st.apimName -and (Test-Path $script:SecretPath)) {
        $localSecret = (Get-Content $script:SecretPath -Raw).Trim()
        $deployed = Get-GatewayNamedValue -Id 'signing-key' -State $st -Secret
        if ($deployed) {
            if ($deployed -eq $localSecret) {
                Write-Ok 'Signing secret matches the deployed gateway'
            } else {
                Write-Err 'Signing secret does NOT match the deployed gateway.'
                Write-Info 'Every key minted here would be rejected with 401.'
                Write-Info 'This usually means the gateway was deployed from another machine.'
                Write-Info "Fix: copy that machine's .gateway/secret.txt here, or re-run option 1"
                Write-Info '     to redeploy with this secret (invalidating keys minted elsewhere).'
                $fail++
            }
        }
    }

    Write-Host ''
    if ($fail -gt 0) {
        Write-Err "$fail blocking problem(s). Fix the above and re-run."
        return $false
    }
    if ($warn -gt 0) { Write-Warn "$warn warning(s) - you can continue." }
    else { Write-Ok 'All checks passed.' }
    return $true
}
