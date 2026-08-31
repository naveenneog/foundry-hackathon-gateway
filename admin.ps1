<#
.SYNOPSIS
    Interactive admin console for the Foundry Hackathon Gateway.

.DESCRIPTION
    Provisions the gateway, pins the model allowlist, and issues time-bound, spend-capped
    participant keys that work in opencode.

    Run it with no arguments for the menu:
        ./admin.ps1

.NOTES
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
        return Get-Content $script:StatePath -Raw | ConvertFrom-Json
    }
    return [pscustomobject]@{
        resourceGroup        = $ResourceGroup
        foundryAccount       = $FoundryAccount
        foundryResourceGroup = $FoundryResourceGroup
        location             = $Location
        apimName             = $null
        gatewayUrl           = $null
        flashModel           = 'deepseek-v4-flash'
        proModel             = 'DeepSeek-V4-Pro'
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
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)

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
    if (Test-Path $script:KeysPath) {
        return @(Get-Content $script:KeysPath -Raw | ConvertFrom-Json)
    }
    return @()
}

function Save-IssuedKeys($Keys) {
    Initialize-StateDir
    ,$Keys | ConvertTo-Json -Depth 6 | Set-Content $script:KeysPath -Encoding UTF8
}

# --------------------------------------------------------------------------------------------
# Prerequisites
# --------------------------------------------------------------------------------------------

function Test-Prerequisites {
    $ok = $true
    foreach ($t in @('az', 'node')) {
        if (-not (Get-Command $t -ErrorAction SilentlyContinue)) {
            Write-Err "$t is not on PATH."
            $ok = $false
        }
    }
    if ($ok) {
        $acct = az account show 2>$null | ConvertFrom-Json
        if (-not $acct) { Write-Err "Not signed in. Run 'az login'."; $ok = $false }
        else { Write-Ok "Signed in to '$($acct.name)'" }
    }
    return $ok
}

# --------------------------------------------------------------------------------------------
# 1. Deploy
# --------------------------------------------------------------------------------------------

function Invoke-Deploy {
    $state = Get-State
    Write-Head 'Deploy the gateway'

    $state.resourceGroup = Read-Default 'Resource group for the gateway' ($state.resourceGroup ?? 'rg-hackathon-gateway')
    $state.location      = Read-Default 'Location' ($state.location ?? 'eastus2')

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
    $state.foundryResourceGroup = Read-Default 'Foundry resource group' ($state.foundryResourceGroup ?? $state.resourceGroup)

    $email = Read-Default 'Publisher email (for APIM)' ($PublisherEmail ?? (az account show --query user.name -o tsv 2>$null))

    # Model pinning
    Write-Head 'Pin the models'
    Write-Info 'flash = agent model (DeepSeek-V4-Flash-0731). Faster and cheaper per turn.'
    Write-Info 'pro   = reasoning model (DeepSeek-V4-Pro). Both support tool calling.'
    $state.flashModel = Read-Default "Deployment name for 'flash'" ($state.flashModel ?? 'deepseek-v4-flash')
    $state.proModel   = Read-Default "Deployment name for 'pro'"   ($state.proModel   ?? 'deepseek-v4-pro')

    $secret = Get-SigningSecret
    if (-not $secret) {
        $secret = New-SigningSecret
        Write-Ok "Generated a new signing secret -> $script:SecretPath (not printed, not committed)"
    } else {
        Write-Ok 'Reusing the existing signing secret.'
    }

    Write-Head 'Deploying'
    az group create -n $state.resourceGroup -l $state.location -o none

    # Alert 3 fix: revoked-keys is a Bicep-declared named value, so a redeploy would ARM-PUT it
    # back to the default and silently un-revoke every key. Menu option 1 is explicitly
    # "Deploy / update", so this WILL be re-run. Read the live value and pass it through.
    $revoked = ','
    if ($state.apimName) {
        $live = az apim nv show -g $state.resourceGroup --service-name $state.apimName `
            --named-value-id revoked-keys --query value -o tsv 2>$null
        if ($LASTEXITCODE -eq 0 -and $live) {
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
                publisherEmail       = @{ value = $email }
                signingKey           = @{ value = $secret }
                flashDeployment      = @{ value = $state.flashModel }
                proDeployment        = @{ value = $state.proModel }
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
    Save-State $state

    Write-Ok "Gateway is live: $($state.gatewayUrl)"
    Write-Info 'Next: issue a participant key (menu option 3).'
}

# --------------------------------------------------------------------------------------------
# 2. Models
# --------------------------------------------------------------------------------------------

function Show-Models {
    $state = Get-State
    Write-Head 'Foundry deployments'
    if (-not $state.foundryAccount) { Write-Warn 'No Foundry account configured. Deploy first.'; return }

    $deployments = az cognitiveservices account deployment list `
        -n $state.foundryAccount -g $state.foundryResourceGroup -o json 2>$null | ConvertFrom-Json

    if (-not $deployments) { Write-Warn 'No deployments found.'; return }

    foreach ($d in $deployments) {
        $pinned = switch ($d.name) {
            $state.flashModel { ' <- pinned as "flash"' }
            $state.proModel   { ' <- pinned as "pro"' }
            default           { '' }
        }
        Write-Host ("    {0,-32} {1}{2}" -f $d.name, $d.properties.model.name, $pinned)
    }

    Write-Host ''
    Write-Info "Only 'flash' and 'pro' are reachable through the gateway. Everything else returns 403."
}

function Invoke-DeployModel {
    $state = Get-State
    Write-Head 'Deploy a DeepSeek model'
    if (-not $state.foundryAccount) { Write-Warn 'No Foundry account configured. Deploy the gateway first.'; return }

    # Exact catalog names and versions, confirmed via `az cognitiveservices model list`.
    # Casing matters: the model name is matched exactly. The deployment name is ours to choose.
    Write-Host '    [1] DeepSeek-V4-Flash-0731  agent model, tool calling, 1M context  (recommended)'
    Write-Host '    [2] DeepSeek-V4-Pro         reasoning model (tool calling also works)'
    $pick = Read-Default 'Which model' '1'

    if ($pick -eq '2') {
        $model = 'DeepSeek-V4-Pro';        $version = '2026-04-23'; $default = 'deepseek-v4-pro'
    } else {
        $model = 'DeepSeek-V4-Flash-0731'; $version = '2026-07-31'; $default = 'deepseek-v4-flash'
    }
    $name = Read-Default 'Deployment name' $default
    $cap  = Read-Default 'Capacity (thousands of TPM)' '100'

    Write-Info "Deploying $model ($version) as '$name'..."
    az cognitiveservices account deployment create `
        -n $state.foundryAccount -g $state.foundryResourceGroup `
        --deployment-name $name `
        --model-name $model --model-version $version --model-format 'DeepSeek' `
        --sku-capacity $cap --sku-name 'GlobalStandard' -o none

    if ($LASTEXITCODE -eq 0) { Write-Ok "Deployed '$name'." }
    else { Write-Err 'Deployment failed. Check region availability and quota.' }
}

# --------------------------------------------------------------------------------------------
# 3. Issue a key
# --------------------------------------------------------------------------------------------

function New-ParticipantKey {
    $state  = Get-State
    $secret = Get-SigningSecret
    if (-not $secret) { Write-Err 'No signing secret. Deploy the gateway first.'; return }
    if (-not $state.gatewayUrl) { Write-Warn 'Gateway URL unknown; the key will still work once deployed.' }

    Write-Head 'Issue a participant key'

    # `sub` is the tenancy boundary for ALL four counters: the budget cache, the TPM limit, the
    # lifetime quota and the request-rate limit. Two keys with the same subject silently share
    # one budget and rate-limit each other. Default from a wide space, and check collisions.
    $suggested = "team-$([guid]::NewGuid().ToString('N').Substring(0,8))"
    $subject = Read-Default 'Participant or team id' $suggested

    $existing = @(Get-IssuedKeys | Where-Object { $_.subject -eq $subject -and -not $_.revoked })
    if ($existing.Count -gt 0) {
        Write-Warn "'$subject' already has $($existing.Count) active key(s)."
        Write-Info 'Budget, rate limit and quota are all keyed on the subject, so a second key'
        Write-Info 'SHARES the same allowance rather than getting its own.'
        Write-Info 'That is correct when re-issuing a lost key; it is a bug otherwise.'
        $intent = Read-Default 'Is this a deliberate re-issue for the same participant? (y/n)' 'n'
        if ($intent -ne 'y') {
            Write-Info 'Cancelled. Choose a different id.'
            return
        }
    }

    $label   = Read-Default 'Label (optional, e.g. a name)' ''

    Write-Info 'Models: flash = agent, faster/cheaper | pro = reasoning, slower/pricier'
    Write-Info 'Both support tool calling (verified live; the Learn docs claim pro does not).'
    $modelPick = Read-Default 'Grant which models? [1] flash  [2] flash+pro  [3] pro only' '1'
    $models = switch ($modelPick) {
        '2' { @('flash', 'pro') }
        '3' { @('pro') }
        default { @('flash') }
    }
    if ($models -notcontains 'flash') {
        Write-Warn "This key has no 'flash'. 'pro' works for agent loops but is slower and costs more per turn."
        if (-not (Confirm-Action 'Issue anyway?')) { return }
    }

    $hours  = [int](Read-Default 'Valid for how many hours' '48')
    $budget = [long](Read-Default 'Token budget (one-time, does not reset)' '2000000')
    $startIn = [int](Read-Default 'Start in how many hours from now (0 = immediately)' '0')

    $now       = [DateTimeOffset]::UtcNow
    $notBefore = $now.AddHours($startIn).ToUnixTimeMilliseconds()
    $expiresAt = $now.AddHours($startIn + $hours).ToUnixTimeMilliseconds()

    # Mint via the tested Node module rather than reimplementing JWS in PowerShell.
    $mintScript = Join-Path $script:Root 'scripts/mint.mjs'
    $payload = @{
        secret    = $secret
        subject   = $subject
        models    = $models
        budget    = $budget
        notBefore = $notBefore
        expiresAt = $expiresAt
        label     = $label
    } | ConvertTo-Json -Compress

    $result = $payload | node $mintScript | ConvertFrom-Json
    if (-not $result.token) { Write-Err "Minting failed: $($result.error)"; return }

    # Record metadata only. The token itself is deliberately NOT persisted.
    $keys = @(Get-IssuedKeys)
    $keys += [pscustomobject]@{
        jti       = $result.jti
        subject   = $subject
        label     = $label
        models    = $models -join ','
        budget    = $budget
        notBefore = ([DateTimeOffset]::FromUnixTimeMilliseconds($notBefore)).ToString('u')
        expiresAt = ([DateTimeOffset]::FromUnixTimeMilliseconds($expiresAt)).ToString('u')
        issuedAt  = $now.ToString('u')
        revoked   = $false
    }
    Save-IssuedKeys $keys

    $baseUrl = if ($state.gatewayUrl) { $state.gatewayUrl } else { 'https://<deploy-first>/v1' }

    Write-Host ''
    Write-Host '  ============================================================' -ForegroundColor Green
    Write-Host '   PARTICIPANT KEY - shown once, copy it now' -ForegroundColor Green
    Write-Host '  ============================================================' -ForegroundColor Green
    Write-Host ''
    Write-Host "   Participant : $subject"
    Write-Host "   Models      : $($models -join ', ')"
    Write-Host "   Budget      : $('{0:N0}' -f $budget) tokens (one-time)"
    Write-Host "   Valid       : $(([DateTimeOffset]::FromUnixTimeMilliseconds($notBefore)).ToString('u')) -> $(([DateTimeOffset]::FromUnixTimeMilliseconds($expiresAt)).ToString('u'))"
    Write-Host "   Key id      : $($result.jti)"
    Write-Host ''
    Write-Host "   OPENAI_BASE_URL=$baseUrl" -ForegroundColor Yellow
    Write-Host "   OPENAI_API_KEY=$($result.token)" -ForegroundColor Yellow
    Write-Host ''

    $save = Read-Default 'Write an opencode.json + card for this participant? (y/n)' 'y'
    if ($save -eq 'y') {
        $dir = Join-Path $script:Root "handouts/$subject"
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
        Write-OpencodeConfig -Dir $dir -BaseUrl $baseUrl -Models $models
        Write-ParticipantCard -Dir $dir -Subject $subject -Token $result.token -BaseUrl $baseUrl `
            -Models $models -Budget $budget -ExpiresAt $expiresAt
        Write-Ok "Handout written to handouts/$subject/"
    }
}

function Write-OpencodeConfig {
    param($Dir, $BaseUrl, $Models)

    $modelEntries = @{}
    if ($Models -contains 'flash') { $modelEntries['flash'] = @{ name = 'DeepSeek V4 Flash (agent)' } }
    if ($Models -contains 'pro')   { $modelEntries['pro']   = @{ name = 'DeepSeek V4 Pro (reasoning, no tools)' } }

    $cfg = [ordered]@{
        '$schema' = 'https://opencode.ai/config.json'
        provider  = [ordered]@{
            'hackathon-gateway' = [ordered]@{
                npm     = '@ai-sdk/openai-compatible'
                name    = 'Hackathon Gateway (DeepSeek on Foundry)'
                options = [ordered]@{ baseURL = $BaseUrl }
                models  = $modelEntries
            }
        }
        model = 'hackathon-gateway/flash'
    }
    $cfg | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $Dir 'opencode.json') -Encoding UTF8
}

function Write-ParticipantCard {
    param($Dir, $Subject, $Token, $BaseUrl, $Models, $Budget, $ExpiresAt)

    $expires = ([DateTimeOffset]::FromUnixTimeMilliseconds($ExpiresAt)).ToString('u')
    $card = @"
# Your gateway key — $Subject

Budget: $('{0:N0}' -f $Budget) tokens (one-time — it does not reset)
Expires: $expires
Models: $($Models -join ', ')

## 1. Set your environment

PowerShell:
    `$env:OPENAI_BASE_URL = "$BaseUrl"
    `$env:OPENAI_API_KEY  = "$Token"

bash/zsh:
    export OPENAI_BASE_URL="$BaseUrl"
    export OPENAI_API_KEY="$Token"

## 2. Use opencode

Copy opencode.json into your project directory, then:

    opencode

Pick `hackathon-gateway/flash`.

## 3. Which model?

| Alias   | Use it for                          | Notes           |
|---------|-------------------------------------|-----------------|
| flash   | Building. Agent loop, file edits.   | Faster, cheaper |
| pro     | Hard reasoning, one-shot questions. | Slower, pricier |

Both support tool calling, so both work in `opencode`. Use `flash` for building unless you
specifically want the reasoner.

## Checking your remaining budget

Every response carries headers:

    x-budget-used       tokens consumed so far
    x-budget-total      your total allowance
    x-budget-remaining  what is left

## When something fails

| Status | Code | Meaning |
|--------|------|---------|
| 403 | budget_exhausted   | You spent your whole allowance. It does **not** reset — retrying will not help. This is NOT a broken key. |
| 403 | expired            | Your window has closed. Keys are not extended. |
| 403 | model_not_permitted| That model is not on your key. |
| 403 | revoked            | An organiser revoked this key. |
| 429 | (rate limit)       | Too fast — this one IS worth retrying. Your client backs off automatically. |
| 401 | —                  | The key is invalid or malformed. Ask for a new one. |

Only the 429 is retryable. Everything else is final, and your agent will stop rather than spin.
"@
    $card | Set-Content (Join-Path $Dir 'README.md') -Encoding UTF8
}

# --------------------------------------------------------------------------------------------
# 4. List / 5. Revoke
# --------------------------------------------------------------------------------------------

function Show-Keys {
    Write-Head 'Issued keys'
    $keys = @(Get-IssuedKeys)
    if ($keys.Count -eq 0) { Write-Info 'None issued yet.'; return }

    $now = [DateTimeOffset]::UtcNow
    Write-Host ("    {0,-14} {1,-12} {2,-12} {3,-22} {4}" -f 'PARTICIPANT', 'MODELS', 'BUDGET', 'EXPIRES (UTC)', 'STATE')
    foreach ($k in $keys) {
        $exp = [DateTimeOffset]::Parse($k.expiresAt)
        $state = if ($k.revoked) { 'revoked' } elseif ($exp -lt $now) { 'expired' } else { 'active' }
        $colour = switch ($state) { 'active' { 'Green' } 'expired' { 'DarkGray' } default { 'Red' } }
        Write-Host ("    {0,-14} {1,-12} {2,-12} {3,-22} {4}" -f `
            $k.subject, $k.models, ('{0:N0}' -f $k.budget), $exp.ToString('yyyy-MM-dd HH:mm'), $state) -ForegroundColor $colour
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
        az apim nv update -g $state.resourceGroup --service-name $state.apimName `
            --named-value-id revoked-keys --value $value -o none
        if ($LASTEXITCODE -eq 0) { Write-Ok "Revoked $($target.subject). Takes effect on the next request." }
        else { Write-Err 'Could not update the gateway denylist.' }
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
        Write-Host "   Models  : flash -> $($state.flashModel) | pro -> $($state.proModel)" -ForegroundColor DarkGray
    } else {
        Write-Host '   Not deployed yet.' -ForegroundColor DarkGray
    }
    Write-Host ''
    Write-Host '    1  Deploy / update the gateway'
    Write-Host '    2  Show Foundry deployments (and what is pinned)'
    Write-Host '    3  Deploy a DeepSeek model'
    Write-Host '    4  Issue a participant key'
    Write-Host '    5  List issued keys'
    Write-Host '    6  Revoke a key'
    Write-Host '    7  Show consumption'
    Write-Host '    8  Verify the controls'
    Write-Host '    9  Tear down'
    Write-Host '    0  Exit'
    Write-Host ''
}

function Invoke-Verify {
    $state = Get-State
    if (-not $state.gatewayUrl) { Write-Warn 'Deploy first.'; return }
    & (Join-Path $script:Root 'scripts/Test-Governance.ps1') `
        -GatewayUrl $state.gatewayUrl -SecretPath $script:SecretPath
}

# --------------------------------------------------------------------------------------------

if (-not (Test-Prerequisites)) { exit 1 }

while ($true) {
    Show-Menu
    $choice = Read-Host '  Choose'
    switch ($choice) {
        '1' { Invoke-Deploy }
        '2' { Show-Models }
        '3' { Invoke-DeployModel }
        '4' { New-ParticipantKey }
        '5' { Show-Keys }
        '6' { Revoke-Key }
        '7' { Show-Usage }
        '8' { Invoke-Verify }
        '9' { Remove-Gateway }
        '0' { Write-Host ''; exit 0 }
        default { Write-Warn 'Pick a number from the menu.' }
    }
    if ($NonInteractive) { break }
}
