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
        $reasons  += "The Claude route needs a v2 tier (BasicV2, StandardV2 or PremiumV2). $sku accepts the token policy and meters zero Anthropic tokens, so budgets would never fire."
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

        An instance that cannot serve the requested route is listed with its reason but cannot
        be chosen: a classic tier would accept the Claude policy and meter nothing, which is a
        control that reports itself as present and enforces nothing.
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
    Write-Host '  API Management instances in this subscription:'
    $i = 1
    foreach ($c in $candidates) {
        $v = $c.$Route
        $colour = if ($v.suitable) { 'Green' } else { 'DarkGray' }
        $tag = if ($v.suitable) { $v.action } else { 'unusable' }
        Write-Host ("    [{0}] {1,-28} {2,-12} {3,-10} {4}" -f $i, $c.name, $c.sku, $c.location, $tag) -ForegroundColor $colour
        Write-Host ("         {0}" -f $v.reason) -ForegroundColor Gray
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

    Write-Ok "Using $($chosen.name) in $($chosen.resourceGroup)."
    return $chosen
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
