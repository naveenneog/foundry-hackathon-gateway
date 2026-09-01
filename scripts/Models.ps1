#Requires -Version 7.0
<#
.SYNOPSIS
    Model pinning and deployment for the Foundry Hackathon Gateway.

.DESCRIPTION
    Dot-sourced by admin.ps1, so it runs in that scope and uses its helpers
    (Write-Ok / Write-Err / Write-Info / Write-Warn / Write-Head, Read-Default,
    Confirm-Action, Get-State, Save-State).

    Models are held as an alias -> deployment map. Any number of models can be pinned; the
    gateway resolves the alias at request time from a single `model-map` named value, so adding
    a model is a config edit rather than a redeployment. See ADR-0007.

    Not standalone - run ./admin.ps1.
#>

# The wire format the policy parses. Kept identical to src/models.mjs buildModelMap, which is
# the canonical, unit-tested implementation.
function ConvertTo-ModelMapString {
    param($Models)
    $seen = @{}
    $parts = @()
    foreach ($m in @($Models)) {
        $alias = ([string]$m.alias).Trim().ToLowerInvariant()
        $dep   = ([string]$m.deployment).Trim()
        if ($alias -eq '' -or $dep -eq '') { continue }
        # ; and = are structural separators; a value containing one would split the map.
        if ($alias -match '[;=]' -or $dep -match '[;=]') {
            Write-Warn "Skipping '$alias': alias or deployment contains a reserved ';' or '='."
            continue
        }
        if ($seen.ContainsKey($alias)) {
            Write-Warn "Skipping duplicate alias '$alias'."
            continue
        }
        $seen[$alias] = $true
        $parts += "$alias=$dep"
    }
    return ($parts -join ';')
}

function ConvertFrom-ModelMapString {
    param([string]$Raw)
    $out = @()
    if ([string]::IsNullOrWhiteSpace($Raw)) { return $out }
    foreach ($entry in $Raw.Split(';')) {
        $idx = $entry.IndexOf('=')
        if ($idx -le 0) { continue }
        $alias = $entry.Substring(0, $idx).Trim().ToLowerInvariant()
        $dep   = $entry.Substring($idx + 1).Trim()
        if ($alias -eq '' -or $dep -eq '') { continue }
        $out += [pscustomobject]@{ alias = $alias; deployment = $dep }
    }
    return $out
}

# The deployments that actually exist in the configured Foundry account.
function Get-FoundryDeployments {
    param($State)
    if (-not $State.foundryAccount) { return @() }
    $raw = az cognitiveservices account deployment list `
        -n $State.foundryAccount -g $State.foundryResourceGroup -o json 2>$null | ConvertFrom-Json
    if (-not $raw) { return @() }
    return @($raw | ForEach-Object {
        [pscustomobject]@{
            name  = $_.name
            model = $_.properties.model.name
            state = $_.properties.provisioningState
        }
    })
}

function Show-Models {
    $state = Get-State
    Write-Head 'Models'
    if (-not $state.foundryAccount) { Write-Warn 'No Foundry account configured. Deploy first.'; return }

    $pinned = @($state.models)
    $deployed = Get-FoundryDeployments $state

    Write-Host '  Pinned on the gateway (what participants can ask for):'
    if ($pinned.Count -eq 0) {
        Write-Info '    none'
    } else {
        foreach ($p in $pinned) {
            $exists = @($deployed | Where-Object { $_.name -eq $p.deployment }).Count -gt 0
            $mark = if ($exists) { 'ok' } else { 'MISSING in Foundry' }
            $colour = if ($exists) { 'Green' } else { 'Red' }
            Write-Host ("    {0,-14} -> {1,-28} {2}" -f $p.alias, $p.deployment, $mark) -ForegroundColor $colour
        }
    }

    Write-Host ''
    Write-Host "  Deployments in $($state.foundryAccount):"
    if ($deployed.Count -eq 0) {
        Write-Info '    none'
    } else {
        foreach ($d in $deployed) {
            $isPinned = @($pinned | Where-Object { $_.deployment -eq $d.name }).Count -gt 0
            $tag = if ($isPinned) { '  (pinned)' } else { '' }
            Write-Host ("    {0,-28} {1}{2}" -f $d.name, $d.model, $tag)
        }
    }
    Write-Host ''
    Write-Info 'Only pinned aliases are reachable. Anything else returns 403.'
}

function Edit-ModelPins {
    $state = Get-State
    Write-Head 'Pin models'
    if (-not $state.foundryAccount) { Write-Warn 'Deploy the gateway first.'; return }

    $deployed = Get-FoundryDeployments $state
    if ($deployed.Count -eq 0) {
        Write-Warn "No deployments found in $($state.foundryAccount). Use option 3 to deploy one."
        return
    }

    $pins = @($state.models)

    while ($true) {
        Write-Host ''
        Write-Host '  Current pins:'
        if ($pins.Count -eq 0) { Write-Info '    none' }
        else {
            $i = 1
            foreach ($p in $pins) { Write-Host ("    [{0}] {1,-14} -> {2}" -f $i, $p.alias, $p.deployment); $i++ }
        }
        Write-Host ''
        Write-Host '    a  add a pin      r  remove a pin      s  save and exit      q  cancel'
        $action = (Read-Default 'Action' 's').ToLowerInvariant()

        switch ($action) {
            'a' {
                Write-Host ''
                $i = 1
                foreach ($d in $deployed) { Write-Host ("    [{0}] {1,-28} {2}" -f $i, $d.name, $d.model); $i++ }
                $pick = Read-Default 'Deployment number' ''
                $n = 0
                if (-not [int]::TryParse($pick, [ref]$n) -or $n -lt 1 -or $n -gt $deployed.Count) {
                    Write-Warn 'Not a valid number.'
                    break
                }
                $dep = $deployed[$n - 1].name

                # Suggest a short alias derived from the deployment name.
                $suggest = ($dep -replace '^deepseek-v4-', '' -replace '^gpt-', 'gpt' -replace '[^a-z0-9\-]', '').ToLowerInvariant()
                $alias = (Read-Default 'Alias participants will use' $suggest).Trim().ToLowerInvariant()

                if ($alias -eq '') { Write-Warn 'Alias cannot be empty.'; break }
                if ($alias -match '[;=]') { Write-Warn "Alias cannot contain ';' or '='."; break }
                if (@($pins | Where-Object { $_.alias -eq $alias }).Count -gt 0) {
                    Write-Warn "Alias '$alias' is already pinned. Remove it first."
                    break
                }
                $pins += [pscustomobject]@{ alias = $alias; deployment = $dep }
                Write-Ok "Pinned $alias -> $dep"
            }
            'r' {
                if ($pins.Count -eq 0) { Write-Info 'Nothing to remove.'; break }
                $pick = Read-Default 'Remove which number' ''
                $n = 0
                if (-not [int]::TryParse($pick, [ref]$n) -or $n -lt 1 -or $n -gt $pins.Count) {
                    Write-Warn 'Not a valid number.'
                    break
                }
                $gone = $pins[$n - 1]
                Write-Warn "Removing '$($gone.alias)' breaks any key already issued with it."
                if (Confirm-Action "Remove $($gone.alias)?") {
                    $pins = @($pins | Where-Object { $_.alias -ne $gone.alias })
                    Write-Ok "Removed $($gone.alias)"
                }
            }
            's' {
                if ($pins.Count -eq 0) { Write-Warn 'At least one model must be pinned.'; break }
                $state.models = $pins
                Save-State $state
                Write-Ok 'Saved locally.'

                # Push to the live gateway if there is one. This is the whole point of holding
                # the map in a single named value: no redeployment needed.
                if ($state.apimName) {
                    $mapString = ConvertTo-ModelMapString $pins
                    az apim nv update -g $state.resourceGroup --service-name $state.apimName `
                        --named-value-id model-map --value $mapString -o none 2>$null
                    if ($LASTEXITCODE -eq 0) {
                        Write-Ok 'Pushed to the gateway. Live on the next request - no redeploy needed.'
                    } else {
                        Write-Err 'Could not update the gateway. Run option 1 to redeploy.'
                    }
                }
                return
            }
            'q' { Write-Info 'Cancelled; nothing saved.'; return }
            default { Write-Warn 'Choose a, r, s or q.' }
        }
    }
}

function Invoke-DeployModel {
    $state = Get-State
    Write-Head 'Deploy a model to Foundry'
    if (-not $state.foundryAccount) { Write-Warn 'Deploy the gateway first.'; return }

    Write-Info "Listing DeepSeek models available in $($state.location)..."
    $avail = az cognitiveservices model list -l $state.location -o json 2>$null | ConvertFrom-Json
    $ds = @($avail | Where-Object { $_.model.name -like '*DeepSeek*' } |
        Sort-Object -Property @{ Expression = { $_.model.name } } -Unique)

    if ($ds.Count -eq 0) {
        Write-Warn "No DeepSeek models offered in $($state.location)."
        Write-Info 'Check region availability, or deploy through the Foundry portal.'
        return
    }

    $i = 1
    foreach ($m in $ds) { Write-Host ("    [{0}] {1,-26} version {2}" -f $i, $m.model.name, $m.model.version); $i++ }
    $pick = Read-Default 'Which model' '1'
    $n = 0
    if (-not [int]::TryParse($pick, [ref]$n) -or $n -lt 1 -or $n -gt $ds.Count) {
        Write-Warn 'Not a valid number.'
        return
    }
    $chosen = $ds[$n - 1]

    $default = $chosen.model.name.ToLowerInvariant()
    $name = Read-Default 'Deployment name' $default
    $cap  = Read-Default 'Capacity (thousands of TPM)' '100'

    Write-Info "Deploying $($chosen.model.name) ($($chosen.model.version)) as '$name'..."
    az cognitiveservices account deployment create `
        -n $state.foundryAccount -g $state.foundryResourceGroup `
        --deployment-name $name `
        --model-name $chosen.model.name --model-version $chosen.model.version --model-format $chosen.model.format `
        --sku-capacity $cap --sku-name 'GlobalStandard' -o none

    if ($LASTEXITCODE -ne 0) {
        Write-Err 'Deployment failed. Check quota and region availability.'
        return
    }
    Write-Ok "Deployed '$name'."
    Write-Info 'It is not reachable through the gateway until you pin an alias to it (option 3).'
}
