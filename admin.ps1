#Requires -Version 7.0
<#
.SYNOPSIS
    Interactive admin console for the Foundry Hackathon Gateway.

.DESCRIPTION
    Provisions the gateway, pins the model allowlist, and issues time-bound, spend-capped
    participant keys that work in opencode.

    Run it with no arguments for the menu:
        ./admin.ps1

.NOTES
    Requires PowerShell 7.0 or later. Windows PowerShell 5.1 is NOT supported - see the
    preflight message, or docs/adr/0006-powershell-7-requirement.md for why.

    The signing secret is the master credential. It is written to .gateway/secret.txt with
    restricted ACLs and is never printed, logged, or committed.
#>

[CmdletBinding()]
param(
    [string]$ResourceGroup,
    [string]$FoundryAccount,
    [string]$FoundryResourceGroup,
    [string]$Location = 'eastus2',
    [string]$PublisherEmail,
    [switch]$NonInteractive
)

$ErrorActionPreference = 'Stop'
$script:Root = $PSScriptRoot
$script:StateDir = Join-Path $script:Root '.gateway'
$script:StatePath = Join-Path $script:StateDir 'state.json'
$script:SecretPath = Join-Path $script:StateDir 'secret.txt'
$script:KeysPath = Join-Path $script:StateDir 'issued-keys.json'

# --------------------------------------------------------------------------------------------
# Helpers
#
# PowerShell 7.0+ is required (see the #Requires above and ADR-0006). Coalesce predates that
# decision and is kept because it reads better than a chain of ?? for multi-value fallbacks.
# --------------------------------------------------------------------------------------------

function Coalesce {
    param([Parameter(ValueFromRemainingArguments = $true)]$Values)
    foreach ($v in $Values) {
        if ($null -ne $v -and "$v" -ne '') { return $v }
    }
    return $null
}

# --------------------------------------------------------------------------------------------
# Presentation
# --------------------------------------------------------------------------------------------

function Write-Head($Text) {
    Write-Host ''
    Write-Host "  $Text" -ForegroundColor Cyan
    Write-Host "  $('-' * $Text.Length)" -ForegroundColor DarkCyan
}
function Write-Ok($Text)    { Write-Host "  [ok] $Text"   -ForegroundColor Green }
function Write-Warn($Text)  { Write-Host "  [!]  $Text"   -ForegroundColor Yellow }
function Write-Err($Text)   { Write-Host "  [x]  $Text"   -ForegroundColor Red }
function Write-Info($Text)  { Write-Host "       $Text"   -ForegroundColor Gray }

function Read-Default($Prompt, $Default) {
    if ($NonInteractive) { return $Default }
    $suffix = if ($Default) { " [$Default]" } else { '' }
    $v = Read-Host "  $Prompt$suffix"
    if ([string]::IsNullOrWhiteSpace($v)) { return $Default }
    return $v.Trim()
}

function Confirm-Action($Prompt) {
    if ($NonInteractive) { return $true }
    $v = Read-Host "  $Prompt (type 'yes' to confirm)"
    return $v -eq 'yes'
}

# --------------------------------------------------------------------------------------------
# State
# --------------------------------------------------------------------------------------------

function Initialize-StateDir {
    if (-not (Test-Path $script:StateDir)) {
        New-Item -ItemType Directory -Path $script:StateDir -Force | Out-Null
    }
}

function Get-State {
    if (Test-Path $script:StatePath) {
        $s = Get-Content $script:StatePath -Raw | ConvertFrom-Json

        # Migrate state written before ADR-0007, when exactly two models were supported.
        if (-not ($s.PSObject.Properties.Name -contains 'models') -or $null -eq $s.models) {
            $migrated = @()
            if ($s.PSObject.Properties.Name -contains 'flashModel' -and $s.flashModel) {
                $migrated += [pscustomobject]@{ alias = 'flash'; deployment = $s.flashModel }
            }
            if ($s.PSObject.Properties.Name -contains 'proModel' -and $s.proModel) {
                $migrated += [pscustomobject]@{ alias = 'pro'; deployment = $s.proModel }
            }
            $s | Add-Member -NotePropertyName models -NotePropertyValue $migrated -Force
        }
        # ConvertFrom-Json objects reject assignment to a property the JSON did not contain, so
        # a state file written before P15 would throw the moment an instance is adopted.
        if (-not ($s.PSObject.Properties.Name -contains 'existingApimName')) {
            $s | Add-Member -NotePropertyName existingApimName -NotePropertyValue $null -Force
        }
        if (-not ($s.PSObject.Properties.Name -contains 'claudeGatewayUrl')) {
            $s | Add-Member -NotePropertyName claudeGatewayUrl -NotePropertyValue $null -Force
        }
        # Pins written before the Claude route existed have no route and are OpenAI-shaped.
        $s.models = @(@($s.models) | ForEach-Object {
            if ($_ -and -not ($_.PSObject.Properties.Name -contains 'route' -and $_.route)) {
                $_ | Add-Member -NotePropertyName route -NotePropertyValue 'openai' -Force
            }
            $_
        })
        return $s
    }
    return [pscustomobject]@{
        resourceGroup        = $ResourceGroup
        foundryAccount       = $FoundryAccount
        foundryResourceGroup = $FoundryResourceGroup
        location             = $Location
        apimName             = $null
        existingApimName     = $null
        gatewayUrl           = $null
        claudeGatewayUrl     = $null
        # Alias -> deployment pins. Any number of models; see ADR-0007. `route` says which wire
        # format the deployment speaks, and therefore which gateway route can serve it.
        models               = @(
            [pscustomobject]@{ alias = 'flash'; deployment = 'deepseek-v4-flash'; route = 'openai' }
            [pscustomobject]@{ alias = 'pro';   deployment = 'deepseek-v4-pro';   route = 'openai' }
        )
    }
}

function Save-State($State) {
    Initialize-StateDir
    $State | ConvertTo-Json -Depth 6 | Set-Content $script:StatePath -Encoding UTF8
}

function Get-SigningSecret {
    if (-not (Test-Path $script:SecretPath)) { return $null }
    return (Get-Content $script:SecretPath -Raw).Trim()
}

function New-SigningSecret {
    Initialize-StateDir
    $bytes = New-Object byte[] 32
    # RandomNumberGenerator.Create().GetBytes() exists on both .NET Framework (PS 5.1) and
    # .NET (PS 7+). The static ::Fill() overload is .NET Core only and throws on 5.1.
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }

    # STANDARD Base64, padded. Not base64url.
    #
    # APIM Base64-DECODES the <key> named value and uses those bytes as the HMAC key, so the
    # stored form must be decodable by a standard decoder. An earlier version substituted '-'
    # and '_' for '+' and '/', which produced a decodable value only ~26% of the time — so
    # whether the gateway worked at all depended on which random bytes were drawn.
    # src/keys.mjs derives its key the same way. See ADR-0005.
    $secret = [Convert]::ToBase64String($bytes)

    Set-Content -Path $script:SecretPath -Value $secret -Encoding ASCII -NoNewline

    # Restrict to the current user only. This secret can mint a key for any participant, with
    # any budget, for any model — holding it is total compromise of the governance model.
    try {
        $acl = Get-Acl $script:SecretPath
        $acl.SetAccessRuleProtection($true, $false)
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
            [System.Security.Principal.WindowsIdentity]::GetCurrent().Name,
            'FullControl', 'Allow')
        $acl.SetAccessRule($rule)
        Set-Acl -Path $script:SecretPath -AclObject $acl
    } catch {
        Write-Warn "Could not restrict ACLs on the secret file: $($_.Exception.Message)"
    }
    return $secret
}

function Get-IssuedKeys {
    if (-not (Test-Path $script:KeysPath)) { return @() }
    $raw = Get-Content $script:KeysPath -Raw
    if ([string]::IsNullOrWhiteSpace($raw)) { return @() }

    $parsed = $null
    try { $parsed = $raw | ConvertFrom-Json } catch {
        Write-Warn "issued-keys.json is not valid JSON; treating as empty."
        return @()
    }

    # Repair records written by an earlier version on Windows PowerShell 5.1, where
    # `,$Keys | ConvertTo-Json` serialised the array WRAPPER rather than the array, producing
    # {"value":[...],"Count":n}. Reading that back gave one object with no key fields, which
    # broke both the key list and revocation.
    if ($parsed -and -not ($parsed -is [array]) -and ($parsed.PSObject.Properties.Name -contains 'value')) {
        $parsed = $parsed.value
    }
    return @($parsed)
}

function Save-IssuedKeys($Keys) {
    Initialize-StateDir
    # -InputObject rather than the pipeline, so the array is not unrolled. PowerShell 5.1 still
    # emits a bare object for a single-element array, so force array form explicitly - the file
    # must always be a JSON array or the next read misinterprets it.
    $json = ConvertTo-Json -InputObject @($Keys) -Depth 6
    if ($json -notmatch '^\s*\[') { $json = "[$json]" }
    Set-Content -Path $script:KeysPath -Value $json -Encoding UTF8
}

# Dates in issued-keys.json are round-trip strings. Parse them culture-invariantly and never
# throw: one malformed record must not take out the whole listing.
function ConvertTo-Dto {
    param($Value)
    if ($null -eq $Value -or "$Value" -eq '') { return $null }
    if ($Value -is [datetimeoffset]) { return $Value }
    if ($Value -is [datetime]) { return [datetimeoffset]$Value }
    $parsed = [datetimeoffset]::MinValue
    $styles = [System.Globalization.DateTimeStyles]::AssumeUniversal -bor `
              [System.Globalization.DateTimeStyles]::AdjustToUniversal
    if ([datetimeoffset]::TryParse([string]$Value, [System.Globalization.CultureInfo]::InvariantCulture, $styles, [ref]$parsed)) {
        return $parsed
    }
    return $null
}

# --------------------------------------------------------------------------------------------
# Prerequisites
# --------------------------------------------------------------------------------------------

# Preflight lives in its own file to keep this one within its complexity budget. It is
# dot-sourced, so it runs in this scope and can use the helpers defined above.
. (Join-Path $PSScriptRoot 'scripts/Apim.ps1')
. (Join-Path $PSScriptRoot 'scripts/Admin-Preflight.ps1')

# --------------------------------------------------------------------------------------------
# 1. Deploy
# --------------------------------------------------------------------------------------------

function Invoke-Deploy {
    $state = Get-State
    Write-Head 'Deploy the gateway'

    # ------------------------------------------------------------------------------------
    # Adopt an instance the organisation already runs, or create one.
    #
    # Child resources must share the deployment's resource group, so adopting an instance
    # sets the resource group to that instance's. See ADR-0008.
    # ------------------------------------------------------------------------------------
    if (-not $state.apimName) {
        $chosen = Select-ApimInstance -Route 'openai'
        if ($chosen) {
            $state.existingApimName = $chosen.name
            $state.resourceGroup    = $chosen.resourceGroup
            $state.location         = $chosen.location
        }
    } elseif ($state.existingApimName) {
        Write-Info "Updating the gateway on the adopted instance '$($state.existingApimName)'."
    }

    if ($state.existingApimName) {
        # Not a prompt. ARM child resources share their parent's scope, so deploying into any
        # other resource group resolves the `existing` reference to a name that is not there
        # and fails every child with ResourceNotFound - an error that names the API Management
        # instance rather than the real mistake.
        Write-Info "Resource group : $($state.resourceGroup)  (fixed by '$($state.existingApimName)')"
        Write-Info "Location       : $($state.location)"
    } else {
        $state.resourceGroup = Read-Default 'Resource group for the gateway' (Coalesce $state.resourceGroup 'rg-hackathon-gateway')
        $state.location      = Read-Default 'Location' (Coalesce $state.location 'eastus2')
    }

    if (-not $state.foundryAccount) {
        Write-Info 'Looking for Foundry accounts...'
        $accounts = az cognitiveservices account list --query "[?kind=='AIServices'].{name:name,rg:resourceGroup,loc:location}" -o json 2>$null | ConvertFrom-Json
        if ($accounts) {
            $i = 1
            foreach ($a in $accounts) { Write-Host "    [$i] $($a.name)  (rg: $($a.rg), $($a.loc))"; $i++ }
            $pick = Read-Default 'Pick a Foundry account by number' '1'
            $chosen = $accounts[[int]$pick - 1]
            $state.foundryAccount = $chosen.name
            $state.foundryResourceGroup = $chosen.rg
        }
    }
    $state.foundryAccount       = Read-Default 'Foundry account name' $state.foundryAccount
    $state.foundryResourceGroup = Read-Default 'Foundry resource group' (Coalesce $state.foundryResourceGroup $state.resourceGroup)

    $email = Read-Default 'Publisher email (for APIM)' (Coalesce $PublisherEmail (az account show --query user.name -o tsv 2>$null))

    # Models are pinned separately (menu option 3) so that adding one later does not require a
    # redeployment. The current pins are carried through to the deployment below.
    Write-Head 'Models to pin'
    if (@($state.models).Count -eq 0) {
        Write-Warn 'No models pinned yet. Deploying with none means every request returns 403.'
        Write-Info 'You can pin them after deploying with menu option 3.'
    } else {
        foreach ($m in $state.models) { Write-Info "    $($m.alias) -> $($m.deployment)" }
    }

    $secret = Get-SigningSecret
    if (-not $secret) {
        $secret = New-SigningSecret
        Write-Ok "Generated a new signing secret -> $script:SecretPath (not printed, not committed)"
    } else {
        Write-Ok 'Reusing the existing signing secret.'
    }

    # ------------------------------------------------------------------------------------
    # Validate the target BEFORE deploying.
    #
    # A gateway pointed at a Foundry account that lacks the pinned deployments deploys
    # "successfully" and then returns DeploymentNotFound on every call - an opaque 404 that
    # looks like a gateway bug. This has already happened once. Catch it here.
    # ------------------------------------------------------------------------------------
    Write-Head 'Checking the target Foundry account'

    $acctOk = $true
    $found = az cognitiveservices account show -n $state.foundryAccount -g $state.foundryResourceGroup -o json 2>$null | ConvertFrom-Json
    if (-not $found) {
        Write-Err "Foundry account '$($state.foundryAccount)' not found in resource group '$($state.foundryResourceGroup)'."
        return
    }
    Write-Ok "$($state.foundryAccount) ($($found.location))"

    $existing = @()
    $raw = az cognitiveservices account deployment list -n $state.foundryAccount -g $state.foundryResourceGroup -o json 2>$null | ConvertFrom-Json
    if ($raw) { $existing = @($raw | ForEach-Object { $_.name }) }

    foreach ($pin in @($state.models)) {
        if ($existing -contains $pin.deployment) {
            Write-Ok "$($pin.alias) -> $($pin.deployment)"
        } else {
            Write-Err "$($pin.alias) -> '$($pin.deployment)' does NOT exist in $($state.foundryAccount)."
            $acctOk = $false
        }
    }

    if (-not $acctOk) {
        Write-Host ''
        if ($existing.Count -gt 0) {
            Write-Info "Deployments that DO exist in this account:"
            foreach ($e in $existing) { Write-Info "    $e" }
        } else {
            Write-Info 'This account has no model deployments at all.'
        }
        Write-Host ''
        Write-Warn 'Deploying now would produce a gateway that returns 404 DeploymentNotFound on every call.'
        Write-Info 'Use menu option 3 to deploy the DeepSeek models, or re-run option 1 and choose'
        Write-Info 'a different Foundry account or deployment names.'
        if (-not (Confirm-Action 'Deploy anyway?')) { Write-Info 'Cancelled.'; return }
    }

    # Warn if this would repoint an existing gateway at a different Foundry account - that
    # breaks every key in flight and is almost never intended.
    if ($state.apimName) {
        $liveUrl = az apim api show -g $state.resourceGroup --service-name $state.apimName `
            --api-id deepseek-gateway --query serviceUrl -o tsv 2>$null
        if ($liveUrl -and $liveUrl -notmatch [regex]::Escape($found.properties.customSubDomainName)) {
            Write-Host ''
            Write-Warn "The deployed gateway currently points at:"
            Write-Info "    $liveUrl"
            Write-Warn "This deployment would repoint it at '$($found.properties.customSubDomainName)'."
            if (-not (Confirm-Action 'Repoint it?')) { Write-Info 'Cancelled.'; return }
        }
    }

    # ------------------------------------------------------------------------------------
    # The Claude route is published only where it can actually enforce a budget.
    #
    # llm-token-limit parses the Anthropic Messages shape on v2 tiers only; a classic tier
    # accepts the identical policy and meters zero tokens. Publishing it there would advertise
    # a cap that silently never fires. See docs/UNKNOWNS.md U12.
    # ------------------------------------------------------------------------------------
    $claudePins = @($state.models | Where-Object {
        $_.PSObject.Properties.Name -contains 'route' -and $_.route -eq 'claude'
    })
    $deployClaude = $true
    if ($state.existingApimName) {
        $sku = az apim show -g $state.resourceGroup -n $state.existingApimName --query sku.name -o tsv 2>$null
        if ($LASTEXITCODE -eq 0 -and $sku -and $sku -notmatch 'V2$') {
            $deployClaude = $false
            Write-Warn "$($state.existingApimName) is $sku, which meters zero Anthropic tokens."
            Write-Info 'The Claude route will not be published on it; budgets there could never fire.'
            if ($claudePins.Count -gt 0) {
                Write-Warn "$($claudePins.Count) Claude pin(s) will be unreachable until the gateway moves to a v2 instance."
            }
        }
    }
    if ($deployClaude) {
        Write-Info ("Claude route : {0} pinned model(s)" -f $claudePins.Count)
    }

    Write-Head 'Deploying'
    az group create -n $state.resourceGroup -l $state.location -o none

    # Alert 3 fix: revoked-keys is a Bicep-declared named value, so a redeploy would ARM-PUT it
    # back to the default and silently un-revoke every key. Menu option 1 is explicitly
    # "Deploy / update", so this WILL be re-run. Read the live value and pass it through.
    $revoked = ','
    if ($state.apimName) {
        $live = Get-GatewayNamedValue -Id 'revoked-keys' -State $state
        if ($live) {
            $revoked = $live
            $count = @($live.Split(',') | Where-Object { $_ }).Count
            Write-Info "Preserving $count revoked key(s) across this deployment."
        }
    }
    # Belt and braces: union with local state, in case the gateway was rebuilt from scratch.
    $localRevoked = @(Get-IssuedKeys | Where-Object { $_.revoked } | ForEach-Object { $_.jti })
    foreach ($j in $localRevoked) {
        if ($revoked -notmatch [regex]::Escape(",$j,")) { $revoked = $revoked.TrimEnd(',') + ",$j," }
    }

    $deployName = "hackgw-$(Get-Date -Format 'yyyyMMddHHmmss')"

    # Alert 2 fix: the signing secret must NOT appear in argv. Process command lines are
    # readable by any same-user process, by administrators and EDR, and are written verbatim
    # into Event ID 4688 when command-line auditing is on (a common GPO baseline). Pass it in
    # an ACL-restricted parameters file instead, and always delete it.
    $paramFile = Join-Path $script:StateDir "deploy-params-$deployName.json"
    try {
        $params = @{
            '$schema'      = 'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#'
            contentVersion = '1.0.0.0'
            parameters     = @{
                foundryAccountName   = @{ value = $state.foundryAccount }
                foundryResourceGroup = @{ value = $state.foundryResourceGroup }
                existingApimName     = @{ value = [string]$state.existingApimName }
                publisherEmail       = @{ value = $email }
                signingKey           = @{ value = $secret }
                modelMap             = @{ value = (ConvertTo-ModelMapString $state.models -Route 'openai') }
                claudeModelMap       = @{ value = (Coalesce (ConvertTo-ModelMapString $state.models -Route 'claude') ';') }
                deployClaudeRoute    = @{ value = $deployClaude }
                revokedKeys          = @{ value = $revoked }
            }
        }
        $params | ConvertTo-Json -Depth 6 | Set-Content $paramFile -Encoding UTF8

        try {
            $acl = Get-Acl $paramFile
            $acl.SetAccessRuleProtection($true, $false)
            $acl.SetAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
                [System.Security.Principal.WindowsIdentity]::GetCurrent().Name, 'FullControl', 'Allow')))
            Set-Acl -Path $paramFile -AclObject $acl
        } catch {
            Write-Warn "Could not restrict ACLs on the parameters file: $($_.Exception.Message)"
        }

        az deployment group create `
            --name $deployName `
            --resource-group $state.resourceGroup `
            --template-file (Join-Path $script:Root 'infra/main.bicep') `
            --parameters "@$paramFile" `
            -o none
    }
    finally {
        # Always, even on Ctrl-C or a failed deployment.
        if (Test-Path $paramFile) { Remove-Item $paramFile -Force -ErrorAction SilentlyContinue }
    }

    if ($LASTEXITCODE -ne 0) { Write-Err 'Deployment failed.'; return }

    $out = az deployment group show -g $state.resourceGroup -n $deployName --query properties.outputs -o json | ConvertFrom-Json
    $state.apimName   = $out.apimName.value
    $state.gatewayUrl = $out.gatewayUrl.value
    if ($out.PSObject.Properties.Name -contains 'claudeGatewayUrl') {
        $state.claudeGatewayUrl = $out.claudeGatewayUrl.value
    }
    Save-State $state

    Write-Ok "Gateway is live: $($state.gatewayUrl)"
    if ($state.claudeGatewayUrl) { Write-Ok "Claude route  : $($state.claudeGatewayUrl)" }
    Write-Info 'Next: issue a participant key (menu option 5).'
}

# --------------------------------------------------------------------------------------------
# 2. Models
# --------------------------------------------------------------------------------------------

# Model pinning/deployment and key issuance live in their own files, dot-sourced so they run
# in this scope. Keeps this file to the menu, shared state and deployment.
. (Join-Path $PSScriptRoot 'scripts/Models.ps1')
. (Join-Path $PSScriptRoot 'scripts/Keys.ps1')


# --------------------------------------------------------------------------------------------
# 4. List / 5. Revoke
# --------------------------------------------------------------------------------------------

function Show-Keys {
    Write-Head 'Issued keys'
    $keys = @(Get-IssuedKeys)
    if ($keys.Count -eq 0) { Write-Info 'None issued yet.'; return }

    $now = [DateTimeOffset]::UtcNow
    $tz = [TimeZoneInfo]::Local.StandardName
    Write-Host "  Times shown in local time ($tz). The gateway enforces them in UTC." -ForegroundColor DarkGray
    Write-Host ("    {0,-16} {1,-12} {2,-12} {3,-20} {4}" -f 'PARTICIPANT', 'MODELS', 'BUDGET', 'EXPIRES (local)', 'STATE')
    foreach ($k in $keys) {
        $exp = ConvertTo-Dto $k.expiresAt

        if ($k.revoked) { $state = 'revoked' }
        elseif ($null -eq $exp) { $state = 'unknown' }
        elseif ($exp -lt $now) { $state = 'expired' }
        else { $state = 'active' }

        $colour = switch ($state) {
            'active'  { 'Green' }
            'expired' { 'DarkGray' }
            'unknown' { 'Yellow' }
            default   { 'Red' }
        }
        # Local time, because an organiser reads this against the clock on the wall.
        $expText = if ($null -eq $exp) { '?' } else { $exp.ToLocalTime().ToString('yyyy-MM-dd HH:mm') }
        $budget = 0
        if ($null -ne $k.budget) { try { $budget = [long]$k.budget } catch { } }

        Write-Host ("    {0,-16} {1,-12} {2,-12} {3,-18} {4}" -f `
            (Coalesce $k.subject '?'), (Coalesce $k.models '?'), ('{0:N0}' -f $budget), $expText, $state) -ForegroundColor $colour
    }
}

function Revoke-Key {
    Write-Head 'Revoke a key'
    $keys = @(Get-IssuedKeys)
    $active = @($keys | Where-Object { -not $_.revoked })
    if ($active.Count -eq 0) { Write-Info 'No active keys.'; return }

    $i = 1
    foreach ($k in $active) { Write-Host "    [$i] $($k.subject)  ($($k.jti))"; $i++ }
    $pick = Read-Default 'Revoke which' ''
    if (-not $pick) { return }

    $target = $active[[int]$pick - 1]
    if (-not (Confirm-Action "Revoke $($target.subject)?")) { return }

    foreach ($k in $keys) { if ($k.jti -eq $target.jti) { $k.revoked = $true } }
    Save-IssuedKeys $keys

    # Push the denylist into the gateway. Sentinel commas keep the match exact.
    $revoked = @($keys | Where-Object { $_.revoked } | ForEach-Object { $_.jti })
    $value = ',' + ($revoked -join ',') + ','

    $state = Get-State
    if ($state.apimName) {
        if (Set-GatewayNamedValue -Id 'revoked-keys' -Value $value -State $state) {
            Write-Ok "Revoked $($target.subject). Takes effect on the next request."
        } else { Write-Err 'Could not update the gateway denylist.' }
    } else {
        Write-Warn 'Gateway not deployed; recorded locally only.'
    }
}

# --------------------------------------------------------------------------------------------
# 6. Usage
# --------------------------------------------------------------------------------------------

function Show-Usage {
    $state = Get-State
    Write-Head 'Consumption per participant'
    if (-not $state.apimName) { Write-Warn 'Deploy first.'; return }

    $appi = az monitor app-insights component show -g $state.resourceGroup `
        --query "[?starts_with(name,'appi-')].appId | [0]" -o tsv 2>$null

    if (-not $appi) { Write-Warn 'Application Insights not found.'; return }

    $q = "customMetrics | where name == 'Total Tokens' | extend p = tostring(customDimensions.Participant) | summarize Tokens = sum(valueSum) by p | order by Tokens desc"
    az monitor app-insights query --app $appi --analytics-query $q -o table 2>$null

    Write-Info 'Metrics can lag a few minutes. The x-budget-used response header is real-time.'
}

# --------------------------------------------------------------------------------------------
# 7. Teardown
# --------------------------------------------------------------------------------------------

function Remove-Gateway {
    $state = Get-State
    Write-Head 'Tear down'
    if (-not $state.resourceGroup) { Write-Warn 'Nothing recorded.'; return }

    Write-Warn "This deletes resource group '$($state.resourceGroup)' and everything in it."
    if (-not (Confirm-Action 'Are you sure?')) { Write-Info 'Cancelled.'; return }

    az group delete -n $state.resourceGroup --yes --no-wait
    Write-Ok 'Deletion started.'
    if ($state.apimName) {
        Write-Info "Then purge the soft-deleted APIM so the name is reusable:"
        Write-Info "  az apim deletedservice purge --service-name $($state.apimName) --location $($state.location)"
    }
}

# --------------------------------------------------------------------------------------------
# Menu
# --------------------------------------------------------------------------------------------

function Show-Menu {
    $state = Get-State
    Write-Host ''
    Write-Host '  ============================================================' -ForegroundColor Cyan
    Write-Host '   Foundry Hackathon Gateway - admin' -ForegroundColor Cyan
    Write-Host '  ============================================================' -ForegroundColor Cyan
    if ($state.gatewayUrl) {
        Write-Host "   Gateway : $($state.gatewayUrl)" -ForegroundColor DarkGray
        $pins = @($state.models)
        if ($pins.Count -eq 0) {
            Write-Host '   Models  : none pinned - every request returns 403' -ForegroundColor Red
        } else {
            $summary = ($pins | ForEach-Object { "$($_.alias) -> $($_.deployment)" }) -join ' | '
            Write-Host "   Models  : $summary" -ForegroundColor DarkGray
        }
    } else {
        Write-Host '   Not deployed yet.' -ForegroundColor DarkGray
    }
    Write-Host ''
    Write-Host '    1  Deploy / update the gateway'
    Write-Host '    2  Show models (pinned, and what exists in Foundry)'
    Write-Host '    3  Pin / unpin models'
    Write-Host '    4  Deploy a new model to Foundry'
    Write-Host '    5  Issue a participant key'
    Write-Host '    6  Issue keys in BULK'
    Write-Host '    7  List issued keys'
    Write-Host '    8  Revoke a key'
    Write-Host '    9  Why is a key being rejected?'
    Write-Host '   10  Show consumption'
    Write-Host '   11  Verify the controls'
    Write-Host '   12  Tear down'
    Write-Host '    0  Exit'
    Write-Host ''
}

function Invoke-Verify {
    $state = Get-State
    if (-not $state.gatewayUrl) { Write-Warn 'Deploy first.'; return }

    $pins = @($state.models)
    $openaiPins = @($pins | Where-Object { -not ($_.PSObject.Properties.Name -contains 'route') -or $_.route -eq 'openai' })
    $claudePins = @($pins | Where-Object { $_.PSObject.Properties.Name -contains 'route' -and $_.route -eq 'claude' })

    if ($openaiPins.Count -ge 1) {
        & (Join-Path $script:Root 'scripts/Test-Governance.ps1') `
            -GatewayUrl $state.gatewayUrl -SecretPath $script:SecretPath -Route 'openai' `
            -Model $openaiPins[0].alias -SecondModel (Coalesce $openaiPins[1].alias $openaiPins[0].alias)
    }

    if ($state.claudeGatewayUrl -and $claudePins.Count -ge 1) {
        & (Join-Path $script:Root 'scripts/Test-Governance.ps1') `
            -GatewayUrl $state.claudeGatewayUrl -SecretPath $script:SecretPath -Route 'claude' `
            -Model $claudePins[0].alias -SecondModel (Coalesce $claudePins[1].alias $claudePins[0].alias)
    } elseif ($state.claudeGatewayUrl) {
        Write-Info 'Claude route is deployed but has no pinned models; skipping its checks (option 3 to pin one).'
    }
}

# --------------------------------------------------------------------------------------------

if (-not (Test-Prerequisites)) { exit 1 }

while ($true) {
    Show-Menu
    $choice = Read-Host '  Choose'
    switch ($choice) {
        '1'  { Invoke-Deploy }
        '2'  { Show-Models }
        '3'  { Edit-ModelPins }
        '4'  { Invoke-DeployModel }
        '5'  { New-ParticipantKey }
        '6'  { New-BulkKeys }
        '7'  { Show-Keys }
        '8'  { Revoke-Key }
        '9'  { Test-ParticipantKey }
        '10' { Show-Usage }
        '11' { Invoke-Verify }
        '12' { Remove-Gateway }
        '0'  { Write-Host ''; exit 0 }
        default { Write-Warn 'Pick a number from the menu.' }
    }
    if ($NonInteractive) { break }
}
