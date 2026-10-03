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
    param(
        $Models,
        [ValidateSet('openai', 'claude')][string]$Route = 'openai'
    )
    $seen = @{}
    $parts = @()
    foreach ($m in @($Models)) {
        # Pins written before the Claude route existed have no route and are OpenAI-shaped.
        $r = if ($m.PSObject.Properties.Name -contains 'route' -and $m.route) { [string]$m.route } else { 'openai' }
        if ($r -ne $Route) { continue }

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

# ---------------------------------------------------------------------------------------------
# Discovery across the subscription
#
# Transcription of src/foundry.mjs, which is the canonical, unit-tested implementation.
# If you change one, change both.
# ---------------------------------------------------------------------------------------------

# Model formats served on the OpenAI-compatible endpoint. An unlisted format is 'unknown'
# rather than assumed: assuming puts a model on a route that cannot serve it, and the symptom
# is a 404 that reads as a gateway fault.
$script:OpenAiFormats = @('openai', 'deepseek', 'meta', 'mistral ai', 'mistral', 'microsoft', 'xai', 'ai21 labs')

function Get-WireFormat {
    param($Deployment)
    $format = ([string]$Deployment.properties.model.format).Trim().ToLowerInvariant()
    $name   = ([string]$Deployment.properties.model.name).Trim().ToLowerInvariant()

    # The name is checked too: a Claude deployment with no format field must not fall through
    # to the OpenAI route.
    if ($format -eq 'anthropic' -or $name.StartsWith('claude')) { return 'anthropic-messages' }
    if ($script:OpenAiFormats -contains $format) { return 'openai-chat-completions' }
    return 'unknown'
}

function Get-RouteForWire {
    param([string]$Wire)
    switch ($Wire) {
        'anthropic-messages'      { return 'claude' }
        'openai-chat-completions' { return 'openai' }
        default                   { return $null }
    }
}

function Get-FoundryCatalogue {
    <#
        Every model deployment in every Foundry account in the subscription.

        The gateway's own account is not special here: an organisation routinely keeps Claude in
        one account and everything else in another, and a picker limited to one account makes
        half the subscription look empty.
    #>
    param([switch]$ThisAccountOnly, $State)

    $accounts = @()
    if ($ThisAccountOnly -and $State -and $State.foundryAccount) {
        $one = az cognitiveservices account show -n $State.foundryAccount -g $State.foundryResourceGroup -o json 2>$null | ConvertFrom-Json
        if ($one) { $accounts = @($one) }
    } else {
        $listed = az cognitiveservices account list --query "[?kind=='AIServices']" -o json 2>$null | ConvertFrom-Json
        if ($listed) { $accounts = @($listed) }
    }

    $out = @()
    foreach ($a in $accounts) {
        $deps = az cognitiveservices account deployment list -n $a.name -g $a.resourceGroup -o json 2>$null | ConvertFrom-Json
        foreach ($d in @($deps)) {
            $wire  = Get-WireFormat $d
            $state = [string]$d.properties.provisioningState
            $out += [pscustomobject]@{
                account       = $a.name
                resourceGroup = $a.resourceGroup
                location      = $a.location
                deployment    = $d.name
                model         = [string]$d.properties.model.name
                version       = [string]$d.properties.model.version
                format        = [string]$d.properties.model.format
                wire          = $wire
                route         = Get-RouteForWire $wire
                state         = $state
                ready         = ($state -eq '' -or $state -eq 'Succeeded')
            }
        }
    }
    return $out
}

function Test-CanPin {
    <# Transcription of canPin in src/foundry.mjs. #>
    param($Entry, [ValidateSet('openai', 'claude')][string]$Route)

    if (-not $Entry) { return [pscustomobject]@{ allowed = $false; reason = 'That deployment could not be read.' } }

    if ($Entry.wire -eq 'unknown') {
        return [pscustomobject]@{
            allowed = $false
            reason  = "'$($Entry.deployment)' reports the model format '$($Entry.format)', which this gateway does not know how to route."
        }
    }
    if ($Entry.route -ne $Route) {
        $shape = if ($Entry.wire -eq 'anthropic-messages') { 'the Anthropic Messages API' } else { 'OpenAI Chat Completions' }
        return [pscustomobject]@{
            allowed = $false
            reason  = "'$($Entry.deployment)' speaks $shape, which the '$($Entry.route)' route serves. Pinning it to '$Route' would forward every request to an endpoint that has never heard of the model."
        }
    }
    if (-not $Entry.ready) {
        return [pscustomobject]@{
            allowed = $false
            reason  = "'$($Entry.deployment)' is $($Entry.state), not Succeeded. It would return 404 until it finishes."
        }
    }
    return [pscustomobject]@{ allowed = $true; reason = '' }
}

function Get-SuggestedAlias {
    param([string]$DeploymentName)
    $name = ([string]$DeploymentName).Trim().ToLowerInvariant()
    if ($name -eq '') { return '' }
    if ($name -match '^claude-([a-z]+)') { return $Matches[1] }
    return ($name -replace '^deepseek-v\d+-', '' -replace '[^a-z0-9-]', '')
}

function Show-Models {
    $state = Get-State
    Write-Head 'Models'

    $pinned = @($state.models)
    $catalogue = @(Get-FoundryCatalogue)

    Write-Host '  Pinned on the gateway (what participants can ask for):'
    if ($pinned.Count -eq 0) {
        Write-Info '    none'
    } else {
        foreach ($p in $pinned) {
            $r = if ($p.PSObject.Properties.Name -contains 'route' -and $p.route) { $p.route } else { 'openai' }
            $exists = @($catalogue | Where-Object { $_.deployment -eq $p.deployment }).Count -gt 0
            $mark = if ($exists) { 'ok' } else { 'MISSING in this subscription' }
            $colour = if ($exists) { 'Green' } else { 'Red' }
            Write-Host ("    {0,-10} {1,-14} -> {2,-28} {3}" -f $r, $p.alias, $p.deployment, $mark) -ForegroundColor $colour
        }
    }

    Write-Host ''
    Write-Host '  Deployments in this subscription:'
    if ($catalogue.Count -eq 0) {
        Write-Info '    none'
    } else {
        $byAccount = $catalogue | Group-Object account
        foreach ($g in $byAccount) {
            Write-Host ("    {0}" -f $g.Name) -ForegroundColor Cyan
            foreach ($d in $g.Group) {
                $isPinned = @($pinned | Where-Object { $_.deployment -eq $d.deployment }).Count -gt 0
                $tag = if ($isPinned) { '  (pinned)' } else { '' }
                $route = if ($d.route) { $d.route } else { 'unroutable' }
                $colour = if ($d.ready -and $d.route) { 'Gray' } else { 'DarkYellow' }
                Write-Host ("      {0,-28} {1,-26} {2,-11} {3}{4}" -f $d.deployment, $d.model, $route, $d.state, $tag) -ForegroundColor $colour
            }
        }
    }
    Write-Host ''
    Write-Info 'Only pinned aliases are reachable. Anything else returns 403.'
    Write-Info "A model is reachable only on the route that speaks its wire format: 'openai' for"
    Write-Info "Chat Completions, 'claude' for the Anthropic Messages API."
}

function Edit-ModelPins {
    $state = Get-State
    Write-Head 'Pin models'

    $catalogue = @(Get-FoundryCatalogue)
    if ($catalogue.Count -eq 0) {
        Write-Warn 'No model deployments found in this subscription. Use option 4 to deploy one.'
        return
    }

    $pins = @($state.models)

    while ($true) {
        Write-Host ''
        Write-Host '  Current pins:'
        if ($pins.Count -eq 0) { Write-Info '    none' }
        else {
            $i = 1
            foreach ($p in $pins) {
                $r = if ($p.PSObject.Properties.Name -contains 'route' -and $p.route) { $p.route } else { 'openai' }
                Write-Host ("    [{0}] {1,-10} {2,-14} -> {3}" -f $i, $r, $p.alias, $p.deployment)
                $i++
            }
        }
        Write-Host ''
        Write-Host '    a  add a pin      r  remove a pin      s  save and exit      q  cancel'
        $action = (Read-Default 'Action' 's').ToLowerInvariant()

        switch ($action) {
            'a' {
                Write-Host ''
                $i = 1
                foreach ($d in $catalogue) {
                    $route = if ($d.route) { $d.route } else { 'unroutable' }
                    $colour = if ($d.ready -and $d.route) { 'Gray' } else { 'DarkYellow' }
                    Write-Host ("    [{0}] {1,-26} {2,-24} {3,-11} {4}" -f $i, $d.deployment, $d.account, $route, $d.state) -ForegroundColor $colour
                    $i++
                }
                $pick = Read-Default 'Deployment number' ''
                $n = 0
                if (-not [int]::TryParse($pick, [ref]$n) -or $n -lt 1 -or $n -gt $catalogue.Count) {
                    Write-Warn 'Not a valid number.'
                    break
                }
                $entry = $catalogue[$n - 1]

                # The route is the deployment's, not the operator's choice: a model is only
                # reachable on the route that speaks its wire format.
                $route = $entry.route
                if (-not $route) {
                    Write-Err (Test-CanPin $entry 'openai').reason
                    break
                }
                $verdict = Test-CanPin $entry $route
                if (-not $verdict.allowed) { Write-Err $verdict.reason; break }

                if ($entry.account -ne $state.foundryAccount) {
                    Write-Warn "'$($entry.deployment)' lives in '$($entry.account)', not the gateway's account '$($state.foundryAccount)'."
                    Write-Info 'The gateway can only reach deployments in the account it was deployed against.'
                    if (-not (Confirm-Action 'Pin it anyway?')) { break }
                }

                $alias = (Read-Default 'Alias participants will use' (Get-SuggestedAlias $entry.deployment)).Trim().ToLowerInvariant()

                if ($alias -eq '') { Write-Warn 'Alias cannot be empty.'; break }
                if ($alias -match '[;=]') { Write-Warn "Alias cannot contain ';' or '='."; break }
                if (@($pins | Where-Object { $_.alias -eq $alias }).Count -gt 0) {
                    Write-Warn "Alias '$alias' is already pinned. Remove it first."
                    break
                }
                $pins += [pscustomobject]@{ alias = $alias; deployment = $entry.deployment; route = $route }
                Write-Ok "Pinned $alias -> $($entry.deployment) on the '$route' route"
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
                # the map in a single named value: no redeployment needed. One map per route.
                if ($state.apimName) {
                    $ok = $true
                    foreach ($r in @('openai', 'claude')) {
                        $id = if ($r -eq 'openai') { 'model-map' } else { 'claude-model-map' }
                        $mapString = ConvertTo-ModelMapString $pins -Route $r
                        # A route with no pins is written as a lone separator, never as an empty
                        # string: an APIM named value cannot reliably hold one, and removing a
                        # route's last pin is exactly when the write has to land. See EMPTY_MAP
                        # in src/models.mjs.
                        if ($mapString -eq '') { $mapString = ';' }
                        if (-not (Set-GatewayNamedValue -Id $id -Value $mapString -State $state)) { $ok = $false }
                    }
                    if ($ok) {
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

    Write-Info "Listing models available in $($state.location)..."
    $avail = az cognitiveservices model list -l $state.location -o json 2>$null | ConvertFrom-Json

    # Anthropic deployments are excluded deliberately. They require a `modelProviderData` object
    # (organisation name, industry, country) and acceptance of Azure Marketplace terms, neither
    # of which `az cognitiveservices account deployment create` can supply - it fails with
    # InvalidModelProviderData. See docs/UNKNOWNS.md U14.
    $claudeOffered = @($avail | Where-Object { $_.model.format -eq 'Anthropic' }).Count -gt 0
    $ds = @($avail | Where-Object { $_.model.format -ne 'Anthropic' -and $_.model.name -like '*DeepSeek*' } |
        Sort-Object -Property @{ Expression = { $_.model.name } } -Unique)

    if ($claudeOffered) {
        Write-Info 'Claude models are offered in this region but are not deployable from here:'
        Write-Info '  they need organisation details and Marketplace terms that the CLI cannot send.'
        Write-Info '  Deploy one in the Foundry portal, then pin it with option 3.'
        Write-Host ''
    }

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
