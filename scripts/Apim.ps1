#Requires -Version 7.0
<#
.SYNOPSIS
    API Management discovery and named-value access for the Foundry Hackathon Gateway.

.DESCRIPTION
    Dot-sourced by admin.ps1, so it runs in that scope and uses its helpers
    (Write-Ok / Write-Err / Write-Info / Write-Warn / Write-Head, Read-Default, Confirm-Action).

    Two jobs:

    1. Find an API Management instance the organisation already runs, judge whether this
       gateway can live on it, and say what deploying would do to it. The judgement is a
       transcription of src/apim.mjs, which is the canonical, unit-tested implementation.
       If you change one, change both.

    2. Read and write this gateway's named values. Named values are INSTANCE-wide, so every
       name this gateway owns is prefixed `hackgw-`; on a shared instance an unprefixed
       `model-map` would overwrite somebody else's. Reads fall back to the unprefixed name so
       a gateway deployed before the prefix keeps working until its next deployment.

    Not standalone - run ./admin.ps1.
#>

$script:NvPrefix = 'hackgw-'

# Cognitive Services User. The gateway's identity needs exactly this on the Foundry account.
$script:CognitiveServicesUserRoleId = 'a97b65f3-24c7-4388-baec-2e87135dc908'

$script:ApiIdForRoute = @{
    openai = 'deepseek-gateway'
    claude = 'claude-gateway'
}

# APIM paths are unique per instance. `claude` is the base a Claude client is pointed at; the
# client appends /v1/messages itself.
$script:ApiPathForRoute = @{
    openai = 'v1'
    claude = 'claude'
}

# --------------------------------------------------------------------------------------------
# Named values
# --------------------------------------------------------------------------------------------

function Get-GatewayNamedValue {
    param(
        [Parameter(Mandatory)][string]$Id,
        [Parameter(Mandatory)]$State,
        [switch]$Secret
    )
    if (-not $State.apimName) { return $null }

    $verb = if ($Secret) { 'show-secret' } else { 'show' }
    foreach ($name in @("$script:NvPrefix$Id", $Id)) {
        $value = az apim nv $verb -g $State.resourceGroup --service-name $State.apimName `
            --named-value-id $name --query value -o tsv 2>$null
        if ($LASTEXITCODE -eq 0 -and $value) { return $value }
    }
    return $null
}

function Set-GatewayNamedValue {
    param(
        [Parameter(Mandatory)][string]$Id,
        [Parameter(Mandatory)][AllowEmptyString()][string]$Value,
        [Parameter(Mandatory)]$State
    )
    if (-not $State.apimName) { return $false }

    $name = "$script:NvPrefix$Id"
    az apim nv update -g $State.resourceGroup --service-name $State.apimName `
        --named-value-id $name --value $Value -o none 2>$null
    if ($LASTEXITCODE -eq 0) { return $true }

    # `az apim nv update` is a generic update: it GETs the resource first, so it fails rather
    # than creating. On a gateway deployed before the prefix existed the prefixed name is not
    # there yet, and without this a revocation would be recorded locally and never reach the
    # gateway. Create it, which is also what the next deployment would do.
    az apim nv create -g $State.resourceGroup --service-name $State.apimName `
        --named-value-id $name --display-name $name --value $Value -o none 2>$null
    return ($LASTEXITCODE -eq 0)
}

# --------------------------------------------------------------------------------------------
# Discovery
# --------------------------------------------------------------------------------------------

function Test-ApimSuitable {
    <#
        Transcription of classifyApim in src/apim.mjs. Returns a verdict object:
        suitable (bool), blockers (string[]), reason (string), action (add|update|none).
    #>
    param(
        [Parameter(Mandatory)]$Instance,
        [Parameter(Mandatory)][ValidateSet('openai', 'claude')][string]$Route,
        [string[]]$ExistingApis = @(),
        $ExistingPaths = @()
    )

    $blockers = @()
    $reasons = @()
    $sku = [string]$Instance.sku.name
    $instanceName = [string]$Instance.name

    if (-not $instanceName -or -not $sku) {
        $blockers += 'malformed'
        $reasons  += 'This instance could not be read, so it is not offered.'
    }

    if ($sku -match '^Consumption$') {
        $blockers += 'consumption_tier'
        $reasons  += 'The Consumption tier supports neither named values nor a managed identity.'
        if ($Route -eq 'claude') {
            $blockers += 'classic_tier'
            $reasons  += 'It is also not a v2 tier, so Anthropic tokens would meter as zero.'
        }
    } elseif ($Route -eq 'claude' -and $sku -notmatch 'V2$') {
        $blockers += 'classic_tier'
        $reasons  += "The Claude route is published only on a v2 tier (BasicV2, StandardV2 or PremiumV2), which is where API Management supports Anthropic Messages token metering. $sku is not one of them, and on an unsupported tier the token policy is accepted and meters zero, so budgets would never fire."
    }

    if ([string]$Instance.provisioningState -and [string]$Instance.provisioningState -ne 'Succeeded') {
        $blockers += 'not_ready'
        $reasons  += "The instance is $($Instance.provisioningState), so it cannot accept an API yet."
    }

    if ([string]$Instance.identity.type -notmatch 'SystemAssigned') {
        $blockers += 'no_identity'
        $reasons  += "No system-assigned identity. Enable it with: az apim update -n $($Instance.name) -g $($Instance.resourceGroup) --enable-managed-identity true  (the flag is not optional - omitting it sets the identity to None)."
    }

    $apiId = $script:ApiIdForRoute[$Route]
    # -ccontains: case-sensitive, matching the JS `includes`. APIM ids differing only in case
    # are different APIs, and treating one as ours would offer to "update" something else.
    $carries = $ExistingApis -ccontains $apiId

    $wantedPath = $script:ApiPathForRoute[$Route]
    $clash = @($ExistingPaths | Where-Object {
        ([string]$_.path).Trim('/').ToLowerInvariant() -eq $wantedPath -and [string]$_.name -cne $apiId
    }) | Select-Object -First 1
    if ($clash) {
        $blockers += 'path_taken'
        $reasons  += "The API '$($clash.name)' already serves the path '$wantedPath' on this instance, and APIM requires paths to be unique."
    }

    $suitable = ($blockers.Count -eq 0)

    if ($suitable) {
        $reasons += if ($carries) {
            "$sku. Already carries '$apiId'; deploying updates it in place."
        } else {
            "$sku. Usable; '$apiId' would be added alongside anything already published here."
        }
    }

    return [pscustomobject]@{
        suitable = $suitable
        blockers = $blockers
        reason   = ($reasons -join ' ')
        action   = if (-not $suitable) { 'none' } elseif ($carries) { 'update' } else { 'add' }
    }
}

function Get-ApimCandidates {
    <# Every APIM instance in the subscription, with a verdict for both routes. #>
    $raw = az apim list -o json 2>$null | ConvertFrom-Json
    if (-not $raw) { return @() }

    $out = @()
    foreach ($a in @($raw)) {
        $apis = @()
        $paths = @()
        $listed = az apim api list -g $a.resourceGroup --service-name $a.name --query '[].{name:name,path:path}' -o json 2>$null | ConvertFrom-Json
        if ($LASTEXITCODE -eq 0 -and $listed) {
            $paths = @($listed)
            $apis  = @($paths | ForEach-Object { [string]$_.name } | Where-Object { $_ })
        }

        $out += [pscustomobject]@{
            name          = $a.name
            resourceGroup = $a.resourceGroup
            location      = $a.location
            sku           = [string]$a.sku.name
            apis          = $apis
            openai        = Test-ApimSuitable -Instance $a -Route 'openai' -ExistingApis $apis -ExistingPaths $paths
            claude        = Test-ApimSuitable -Instance $a -Route 'claude' -ExistingApis $apis -ExistingPaths $paths
        }
    }

    return $out
}

function Select-ApimInstance {
    <#
        Offer the instances in the subscription. Returns the chosen instance object, or $null
        to mean "create a new one".

        BOTH routes are shown per instance, because deploying publishes both. Listing only the
        route named in -Route produced a picker that said "'deepseek-gateway' would be added"
        against every instance while the deployment also added 'claude-gateway' - or silently
        did not, on a classic tier, which the operator only discovered several prompts later.

        -Route is the route that MUST work: an instance that cannot serve it is listed with its
        reason and cannot be chosen. A route that merely happens to be unusable is a warning at
        selection time, not after.
    #>
    param([ValidateSet('openai', 'claude')][string]$Route = 'openai')

    Write-Info 'Looking for API Management instances in this subscription...'
    # Usable first, then the one already serving this gateway, then by name - mirrors rankApim.
    # Sorted on the REQUESTED route: an instance that is fine for DeepSeek and unusable for
    # Claude must not be offered first when the Claude route is what is being deployed.
    $candidates = @(Get-ApimCandidates | Sort-Object `
        @{ Expression = { -not $_.$Route.suitable } }, `
        @{ Expression = { $_.$Route.action -ne 'update' } }, `
        @{ Expression = { $_.name } })

    if ($candidates.Count -eq 0) {
        Write-Info 'None found. A new instance will be created.'
        return $null
    }

    Write-Host ''
    Write-Host '  API Management instances in this subscription.'
    Write-Host '  Deploying publishes BOTH routes, so both are shown:' -ForegroundColor DarkGray
    Write-Host ''
    $i = 1
    foreach ($c in $candidates) {
        $headColour = if ($c.$Route.suitable) { 'Green' } else { 'DarkGray' }
        Write-Host ("    [{0}] {1,-28} {2,-12} {3}" -f $i, $c.name, $c.sku, $c.location) -ForegroundColor $headColour

        foreach ($r in @('openai', 'claude')) {
            $v = $c.$r
            $api = $script:ApiIdForRoute[$r]
            $path = $script:ApiPathForRoute[$r]
            if ($v.suitable) {
                $what = if ($v.action -eq 'update') { "updates '$api' in place" } else { "adds '$api'" }
                Write-Host ("         /{0,-7} {1,-7} {2}" -f $path, $v.action, $what) -ForegroundColor Gray
            } else {
                Write-Host ("         /{0,-7} {1,-7} {2}" -f $path, 'SKIPPED', $v.reason) -ForegroundColor DarkYellow
            }
        }
        $i++
    }
    Write-Host ("    [{0}] Create a new instance" -f $i)
    Write-Host ''

    $pick = Read-Default 'Which instance' ([string]$i)
    $n = 0
    if (-not [int]::TryParse($pick, [ref]$n) -or $n -lt 1 -or $n -gt $i) {
        Write-Warn 'Not a valid number. Creating a new instance.'
        return $null
    }
    if ($n -eq $i) { return $null }

    $chosen = $candidates[$n - 1]
    $verdict = $chosen.$Route
    if (-not $verdict.suitable) {
        Write-Err "$($chosen.name) cannot serve the $Route route."
        Write-Info $verdict.reason
        Write-Info 'Pick another instance, or create a new one.'
        return (Select-ApimInstance -Route $Route)
    }

    # Say now, not after five more prompts, that a route will not be published. A path collision
    # is excluded: Invoke-Deploy offers an alternative path for that, so calling it terminal here
    # would talk an operator out of an instance that works.
    foreach ($r in @('openai', 'claude')) {
        if ($r -eq $Route) { continue }
        $other = $chosen.$r
        $incurable = @($other.blockers | Where-Object { $_ -ne 'path_taken' })
        if ($incurable.Count -gt 0) {
            Write-Warn "The '$r' route will NOT be published on $($chosen.name)."
            Write-Info $other.reason
            if (-not (Confirm-Action "Continue with the '$Route' route only?")) {
                return (Select-ApimInstance -Route $Route)
            }
        } elseif ($other.blockers -contains 'path_taken') {
            Write-Info "The path '/$($script:ApiPathForRoute[$r])' is taken on $($chosen.name); the '$r' route will be offered another path."
        }
    }

    Write-Ok "Using $($chosen.name) in $($chosen.resourceGroup)."
    return $chosen
}

function Get-RouteVerdict {
    <#
        Judge a live instance for one route, fetching the instance and its published APIs.

        Select-ApimInstance works this out at selection time, but Invoke-Deploy runs again on
        every update and the instance can change underneath it. Re-reading is cheap and means
        the deployment never attempts what discovery already knows is impossible.

        Returns the verdict plus `freePath`, a path nothing else on the instance is using.
    #>
    param(
        [Parameter(Mandatory)][string]$ApimName,
        [Parameter(Mandatory)][string]$ResourceGroup,
        [ValidateSet('openai', 'claude')][string]$Route = 'claude'
    )

    $inst = az apim show -g $ResourceGroup -n $ApimName -o json 2>$null | ConvertFrom-Json
    if (-not $inst) {
        return [pscustomobject]@{ suitable = $false; blockers = @('malformed'); reason = "Could not read $ApimName."; action = 'none'; freePath = $script:ApiPathForRoute[$Route] }
    }

    $paths = @()
    $listed = az apim api list -g $ResourceGroup --service-name $ApimName --query '[].{name:name,path:path}' -o json 2>$null | ConvertFrom-Json
    if ($LASTEXITCODE -eq 0 -and $listed) { $paths = @($listed) }
    $apis = @($paths | ForEach-Object { [string]$_.name } | Where-Object { $_ })

    $v = Test-ApimSuitable -Instance $inst -Route $Route -ExistingApis $apis -ExistingPaths $paths
    $v | Add-Member -NotePropertyName freePath -NotePropertyValue (Get-FreeApiPath -ExistingPaths $paths -Preferred $script:ApiPathForRoute[$Route] -OwnApiId $script:ApiIdForRoute[$Route]) -Force
    return $v
}

function Get-FreeApiPath {
    <# Transcription of suggestFreePath in src/apim.mjs. #>
    param($ExistingPaths, [string]$Preferred, [string]$OwnApiId)

    $wanted = ([string]$Preferred).Trim('/').ToLowerInvariant()
    $taken = @($ExistingPaths | Where-Object { $_ -and [string]$_.name -cne $OwnApiId } |
        ForEach-Object { ([string]$_.path).Trim('/').ToLowerInvariant() } | Where-Object { $_ })

    if ($taken -notcontains $wanted) { return $wanted }
    $alt = "$wanted-hackgw"
    if ($taken -notcontains $alt) { return $alt }
    for ($n = 2; $n -lt 100; $n++) {
        if ($taken -notcontains "$alt-$n") { return "$alt-$n" }
    }
    return "$alt-$(Get-Random)"
}

function Show-DeploymentPlan {
    <#
        Gathers what is actually on the target and prints what the deployment would do, before
        it runs. An ARM deployment is atomic: one resource that cannot be created fails the
        whole thing and leaves behind whatever it already made. Returns the number of blocked
        rows so the caller can stop.

        The decision itself is buildDeploymentPlan in src/apim.mjs, reached through
        scripts/plan.mjs. This function only gathers facts and renders the answer. It used to
        carry its own copy of the rules, which drifted: the tested copy blocked a route on a
        classic tier that this copy reported as CREATE.
    #>
    param($State, [bool]$DeployClaude, [string]$ClaudePath, [bool]$GrantRole)

    Write-Head 'Deployment plan'

    $apimExists = $false; $sku = ''; $apis = @(); $paths = @(); $nvs = @()
    if ($State.existingApimName) {
        $inst = az apim show -g $State.resourceGroup -n $State.existingApimName -o json 2>$null | ConvertFrom-Json
        if ($inst) {
            $apimExists = $true
            $sku = [string]$inst.sku.name
            $listed = az apim api list -g $State.resourceGroup --service-name $State.existingApimName --query '[].{name:name,path:path}' -o json 2>$null | ConvertFrom-Json
            if ($LASTEXITCODE -eq 0 -and $listed) { $paths = @($listed); $apis = @($paths | ForEach-Object { [string]$_.name }) }
            $nvList = az apim nv list -g $State.resourceGroup --service-name $State.existingApimName --query '[].name' -o tsv 2>$null
            if ($LASTEXITCODE -eq 0 -and $nvList) { $nvs = @($nvList -split '\r?\n' | Where-Object { $_ }) }
        }
    }

    $deps = @()
    $acctOk = $false
    $found = az cognitiveservices account show -n $State.foundryAccount -g $State.foundryResourceGroup -o json 2>$null | ConvertFrom-Json
    if ($found) {
        $acctOk = $true
        $raw = az cognitiveservices account deployment list -n $State.foundryAccount -g $State.foundryResourceGroup -o json 2>$null | ConvertFrom-Json
        if ($raw) { $deps = @($raw | ForEach-Object { [string]$_.name }) }
    }

    # Pins are passed as they are, and the decision not to publish the Claude route is passed
    # as itself. Withholding the Claude pins used to stand in for that decision, which made the
    # plan say "no Claude models pinned" to an operator who had pinned three.
    $pins = @($State.models | ForEach-Object {
        $r = if ($_.PSObject.Properties.Name -contains 'route' -and $_.route) { [string]$_.route } else { 'openai' }
        [pscustomobject]@{ alias = [string]$_.alias; deployment = [string]$_.deployment; route = $r }
    })

    $facts = [pscustomobject]@{
        apim          = [pscustomobject]@{
            name        = if ($State.existingApimName) { [string]$State.existingApimName } else { [string]$State.apimName }
            exists      = $apimExists
            sku         = $sku
            hasIdentity = $true
        }
        existingApis  = $apis
        existingPaths = $paths
        namedValues   = $nvs
        roleAssigned  = (-not $GrantRole)
        claudePath    = $ClaudePath
        deployClaude  = $DeployClaude
        foundry       = [pscustomobject]@{ name = [string]$State.foundryAccount; exists = $acctOk; deployments = $deps }
        pins          = $pins
    }

    $planJson = $facts | ConvertTo-Json -Depth 6 -Compress
    $result = $planJson | node (Join-Path $script:Root 'scripts/plan.mjs') 2>$null | ConvertFrom-Json
    if (-not $result -or $result.PSObject.Properties.Name -contains 'error') {
        Write-Err "The deployment plan could not be worked out$(if ($result.error) { ": $($result.error)" })."
        Write-Info 'Deploying blind is how the half-built gateway happened, so this stops here.'
        return 1
    }

    foreach ($r in @($result.rows)) {
        $colour = switch ($r.action) {
            'blocked' { 'Red' }
            'create'  { 'Green' }
            'update'  { 'Cyan' }
            'skip'    { 'DarkYellow' }
            default   { 'Gray' }
        }
        Write-Host ("    {0,-16} {1,-8} {2}" -f $r.component, $r.action.ToUpperInvariant(), $r.detail) -ForegroundColor $colour
    }

    return [int]$result.blocked
}

function New-DeploymentParameters {
    <#
        The parameters file for infra/main.bicep, as a hashtable.

        Kept out of Invoke-Deploy so what a deployment is given can be tested without deploying.
        A deployment is all-or-nothing, so one parameter APIM rejects fails every resource in it.
    #>
    param($State, [string]$Email, [string]$Secret, [bool]$DeployClaude, [string]$ClaudePath, [bool]$GrantRole, [string]$Revoked)

    return @{
        '$schema'      = 'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#'
        contentVersion = '1.0.0.0'
        parameters     = @{
            foundryAccountName   = @{ value = $State.foundryAccount }
            foundryResourceGroup = @{ value = $State.foundryResourceGroup }
            existingApimName     = @{ value = [string]$State.existingApimName }
            publisherEmail       = @{ value = $Email }
            signingKey           = @{ value = $Secret }
            modelMap             = @{ value = (Get-ModelMapValue $State.models -Route 'openai') }
            claudeModelMap       = @{ value = (Get-ModelMapValue $State.models -Route 'claude') }
            deployClaudeRoute    = @{ value = $DeployClaude }
            claudeApiPath        = @{ value = $ClaudePath }
            grantFoundryRole     = @{ value = $GrantRole }
            revokedKeys          = @{ value = $Revoked }
        }
    }
}

function Get-GatewayCustomHost {
    <#
        The custom hostname the gateway answers on, or $null when it has none or the instance
        cannot be read.

        Read from the instance's hostnameConfigurations: a Proxy entry whose name is not the
        built-in *.azure-api.net one. Management, portal and other hostname types are not the
        gateway. When several custom gateway hostnames exist, the one bound as the default SSL
        hostname is the instance's default.
    #>
    param($State)
    $name = Coalesce $State.apimName $State.existingApimName
    if (-not $name -or -not $State.resourceGroup) { return $null }

    $inst = az apim show -n $name -g $State.resourceGroup -o json 2>$null | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or -not $inst) {
        Write-Warn "$name could not be read, so a custom domain, if it has one, is not offered."
        return $null
    }

    # A wildcard hostname (*.contoso.com) is valid for the gateway but is not an address a
    # participant can be given.
    $custom = @($inst.hostnameConfigurations | Where-Object {
        $_.type -eq 'Proxy' -and $_.hostName -and ([string]$_.hostName) -notlike '*.azure-api.net' -and ([string]$_.hostName) -notmatch '\*'
    })
    if ($custom.Count -eq 0) { return $null }
    $pick = @($custom | Where-Object { $_.defaultSslBinding }) | Select-Object -First 1
    if (-not $pick) { $pick = $custom[0] }
    return ([string]$pick.hostName).ToLowerInvariant()
}

function Get-ParticipantUrls {
    <#
        The base URLs participants are given: the deployed URLs with the hostname replaced by
        $HostName. Each route keeps its own path - /v1, and /claude or the path chosen when
        /claude was taken. Without a hostname the deployed URLs are returned unchanged.
    #>
    param($State, [string]$HostName)
    $swap = {
        param($url)
        if (-not $url -or -not $HostName) { return $url }
        $b = [System.UriBuilder]::new([string]$url)
        $b.Host = $HostName
        $b.Port = -1
        return $b.Uri.AbsoluteUri.TrimEnd('/')
    }
    return [pscustomobject]@{
        openai = & $swap $State.gatewayUrl
        claude = & $swap $State.claudeGatewayUrl
    }
}

function Read-ParticipantHost {
    <#
        The hostname for participants' base URLs, asked once per issuance.

        The default is the instance's custom domain when it has one, then a hostname typed here
        before, then the built-in *.azure-api.net name. A typed hostname is remembered because a
        front door or application gateway in front of API Management does not show up on the
        instance. Returns '' when the gateway is not deployed yet.
    #>
    param($State)
    if (-not $State.gatewayUrl) { return '' }

    $builtIn    = ([uri]$State.gatewayUrl).Host.ToLowerInvariant()
    $custom     = Get-GatewayCustomHost -State $State
    $remembered = if ($State.PSObject.Properties.Name -contains 'participantHost') { [string]$State.participantHost } else { '' }
    $default    = Coalesce $custom $remembered $builtIn
    if ($custom) { Write-Info "The gateway has a custom domain: $custom" }

    $answer = ([string](Read-Default "Hostname in participants' base URLs" $default)).Trim()
    # A pasted URL is accepted as well as a bare hostname.
    if ($answer -match '^[a-zA-Z][a-zA-Z0-9+.-]*://') {
        $u = $null
        if ([uri]::TryCreate($answer, [System.UriKind]::Absolute, [ref]$u)) {
            if (-not $u.IsDefaultPort) {
                Write-Warn "The port in '$answer' is not kept: participants' base URLs use https on 443."
            }
            $answer = $u.Host
        }
    }
    $answer = $answer.TrimEnd('/').ToLowerInvariant()
    if ($answer -notmatch '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$') {
        Write-Warn "'$answer' is not a hostname; using $builtIn."
        $answer = $builtIn
    }

    # Remember a hostname the instance does not report; forget it when the built-in one is chosen.
    $toRemember = if ($answer -ne $builtIn -and $answer -ne $custom) { $answer } else { '' }
    if ($toRemember -ne $remembered) {
        $State | Add-Member -NotePropertyName participantHost -NotePropertyValue $toRemember -Force
        Save-State $State
    }

    # Advisory only: the machine issuing keys may not see the same DNS as participants.
    if ($answer -ne $builtIn) {
        try { [void][System.Net.Dns]::GetHostAddresses($answer) }
        catch { Write-Warn "'$answer' does not resolve from this machine. Participants need it to resolve to the gateway." }
    }
    return $answer
}

function Test-FoundryRoleNeeded {
    <#
        Transcription of needsRoleAssignment in src/apim.mjs.

        Creating an assignment that already exists fails the whole deployment with
        RoleAssignmentExists, and `what-if` does not predict it. An unreadable list returns
        $true: a missing grant produces 401s from Foundry that read as a policy fault, whereas
        a redundant create is rejected by ARM with an error that names itself.
    #>
    param(
        [Parameter(Mandatory)][string]$PrincipalId,
        [Parameter(Mandatory)][string]$Scope
    )
    if (-not $PrincipalId -or -not $Scope) { return $true }

    $existing = az role assignment list --assignee $PrincipalId --scope $Scope -o json 2>$null | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or $null -eq $existing) { return $true }

    foreach ($a in @($existing)) {
        $role = ([string]$a.roleDefinitionId -split '/' | Where-Object { $_ } | Select-Object -Last 1)
        $sameScope = ([string]$a.scope).TrimEnd('/').ToLowerInvariant() -eq $Scope.TrimEnd('/').ToLowerInvariant()
        if ($sameScope -and $role -eq $script:CognitiveServicesUserRoleId) { return $false }
    }
    return $true
}
