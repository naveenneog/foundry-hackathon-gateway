<#
    P37 proof of concept: issue, rotate and expire long-lived API Management subscription keys,
    holding each key in Key Vault. A function library: dot-source it, or use Invoke-PocKey.ps1
    from the command line. See ../README.md.

    Keys are never printed or written to disk. They move between API Management and Key Vault in
    memory, over the two REST APIs, with tokens from the Azure CLI. Every call names its
    subscription, so the CLI's default subscription is neither used nor changed.

    Each key is the Key Vault secret poc-key-<name>, tagged with the subscription it belongs to
    and the slot (primary or secondary) it holds. A rotation regenerates the OTHER slot and
    stores it as the secret's next version, so the key clients hold keeps working until the
    rotation after (the two-key pattern in
    https://learn.microsoft.com/azure/key-vault/secrets/tutorial-rotation-dual).

    No param() block, on purpose: dot-sourcing a script that has one resets the caller's
    variables of the same names.
#>

$script:PocApimApiVersion = '2024-05-01'
$script:PocVaultApiVersion = '7.4'

function New-PocContext {
    param(
        [Parameter(Mandatory)][string]$Subscription,
        [Parameter(Mandatory)][string]$ResourceGroup,
        [Parameter(Mandatory)][string]$ApimName,
        [Parameter(Mandatory)][string]$VaultName
    )
    $id = "$(az account show --subscription $Subscription --query id -o tsv)".Trim()
    if ($LASTEXITCODE -ne 0 -or -not $id) { throw "The Azure CLI cannot use subscription '$Subscription'. Run az login." }
    [pscustomobject]@{
        SubscriptionId = $id
        ApimBase       = "https://management.azure.com/subscriptions/$id/resourceGroups/$ResourceGroup/providers/Microsoft.ApiManagement/service/$ApimName"
        VaultBase      = "https://$VaultName.vault.azure.net"
        Gateway        = "https://$ApimName.azure-api.net"
        Tokens         = @{}
    }
}

# A token per resource, reused until five minutes before it expires. The Azure CLI returns its
# cached token until shortly before expiry, so reuse for a fixed time could run past it.
function Get-PocToken {
    param([Parameter(Mandatory)]$Context, [Parameter(Mandatory)][string]$Resource)
    $cached = $Context.Tokens[$Resource]
    if ($cached -and $cached.ExpiresUtc -gt [datetime]::UtcNow.AddMinutes(5)) { return $cached.Value }
    $raw = az account get-access-token --resource $Resource --subscription $Context.SubscriptionId -o json
    if ($LASTEXITCODE -ne 0 -or -not $raw) { throw "The Azure CLI could not get a token for $Resource." }
    $t = ($raw | Out-String) | ConvertFrom-Json
    if (-not $t.accessToken) { throw "The Azure CLI returned no token for $Resource." }
    $Context.Tokens[$Resource] = @{ Value = $t.accessToken; ExpiresUtc = [DateTimeOffset]::FromUnixTimeSeconds([long]$t.expires_on).UtcDateTime }
    return $t.accessToken
}

function Invoke-PocRest {
    param($Context, [string]$Method, [string]$Uri, [string]$Resource, $Body, [switch]$IfMatch)
    $headers = @{ Authorization = "Bearer $(Get-PocToken -Context $Context -Resource $Resource)" }
    if ($IfMatch) { $headers['If-Match'] = '*' }
    $call = @{ Method = $Method; Uri = $Uri; Headers = $headers }
    if ($null -ne $Body) {
        $call.Body = $Body | ConvertTo-Json -Depth 10 -Compress
        $call.ContentType = 'application/json'
    }
    try { Invoke-RestMethod @call }
    catch {
        # The path, not the query string, and never the request body, which can hold a key.
        $detail = if ($_.ErrorDetails -and $_.ErrorDetails.Message) { " $($_.ErrorDetails.Message)" } else { '' }
        throw "$Method $($Uri.Split('?')[0]) failed: $($_.Exception.Message)$detail"
    }
}

function Invoke-PocApim {
    param([Parameter(Mandatory)]$Context, [Parameter(Mandatory)][string]$Method, [Parameter(Mandatory)][string]$Path, $Body, [switch]$IfMatch)
    # A nextLink is already absolute and carries its own api-version.
    $uri = if ($Path -like 'https://*') { $Path } else {
        $separator = if ($Path.Contains('?')) { '&' } else { '?' }
        "$($Context.ApimBase)$Path${separator}api-version=$script:PocApimApiVersion"
    }
    Invoke-PocRest -Context $Context -Method $Method -Uri $uri -Resource 'https://management.azure.com/' -Body $Body -IfMatch:$IfMatch
}

function Invoke-PocVault {
    param([Parameter(Mandatory)]$Context, [Parameter(Mandatory)][string]$Method, [Parameter(Mandatory)][string]$Path, $Body)
    Invoke-PocRest -Context $Context -Method $Method -Uri "$($Context.VaultBase)$Path`?api-version=$script:PocVaultApiVersion" -Resource 'https://vault.azure.net' -Body $Body
}

# The name becomes part of a subscription id, a secret name and two URLs.
function Assert-PocName {
    param([AllowEmptyString()][string]$Name)
    if ($Name -cnotmatch '^[a-z0-9][a-z0-9-]{0,39}$') {
        throw "'$Name' is not a key name: use 1 to 40 lowercase letters, digits and hyphens."
    }
}

function ConvertTo-PocUtc {
    param($Value)
    if ($null -eq $Value -or "$Value" -eq '') { return $null }
    if ($Value -is [datetime]) {
        if ($Value.Kind -eq [DateTimeKind]::Unspecified) { return [datetime]::SpecifyKind($Value, [DateTimeKind]::Utc) }
        return $Value.ToUniversalTime()
    }
    $parsed = [datetime]::MinValue
    $styles = [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal
    if ([datetime]::TryParse("$Value", [Globalization.CultureInfo]::InvariantCulture, $styles, [ref]$parsed)) { return $parsed }
    return $null
}

function New-PocKey {
    param(
        [Parameter(Mandatory)]$Context,
        [Parameter(Mandatory)][AllowEmptyString()][string]$Name,
        [Parameter(Mandatory)][string]$Product
    )
    Assert-PocName $Name
    if ($Product -cnotmatch '^poc-[a-z0-9-]+$') { throw "'$Product' is not a proof-of-concept product." }
    $sid = "poc-$Name"
    $secret = "poc-key-$Name"
    $null = Invoke-PocApim -Context $Context -Method PUT -Path "/subscriptions/$sid" -Body @{
        properties = @{ scope = "/products/$Product"; displayName = $sid; state = 'active' }
    }
    $keys = Invoke-PocApim -Context $Context -Method POST -Path "/subscriptions/$sid/listSecrets"
    $null = Invoke-PocVault -Context $Context -Method PUT -Path "/secrets/$secret" -Body @{
        value       = $keys.primaryKey
        contentType = 'API Management subscription key'
        tags        = @{ slot = 'primary'; subscription = $sid; product = $Product }
    }
    Write-Host "Issued $sid on $Product. Its key is in Key Vault as $secret (primary slot) and is not printed."
    [pscustomobject]@{ Subscription = $sid; Secret = $secret; Slot = 'primary' }
}

# The key clients currently get, with its secret version (the last segment of the secret's id,
# which is not secret) and slot. For callers that need the value in memory; never printed here.
function Get-PocKeyRecord {
    param([Parameter(Mandatory)]$Context, [Parameter(Mandatory)][string]$Name)
    Assert-PocName $Name
    $s = Invoke-PocVault -Context $Context -Method GET -Path "/secrets/poc-key-$Name"
    [pscustomobject]@{ Value = $s.value; Version = "$($s.id)".TrimEnd('/').Split('/')[-1]; Slot = "$($s.tags.slot)" }
}

function Get-PocKey {
    param([Parameter(Mandatory)]$Context, [Parameter(Mandatory)][string]$Name)
    (Get-PocKeyRecord -Context $Context -Name $Name).Value
}

function Invoke-PocKeyRotation {
    param([Parameter(Mandatory)]$Context, [Parameter(Mandatory)][string]$Name)
    Assert-PocName $Name
    $secret = "poc-key-$Name"
    $current = Invoke-PocVault -Context $Context -Method GET -Path "/secrets/$secret"
    $held = "$($current.tags.slot)"
    $sid = "$($current.tags.subscription)"
    # Guessing the slot wrong would regenerate the key every client holds and cut them all off.
    if ($held -notin 'primary', 'secondary') {
        throw "$secret has no slot tag saying which key clients hold, so nothing was regenerated."
    }
    if ($sid -cnotmatch '^poc-[a-z0-9-]+$') {
        throw "$secret does not name a proof-of-concept subscription, so nothing was regenerated."
    }
    $next = if ($held -eq 'primary') { 'secondary' } else { 'primary' }
    $regenerate = @{ primary = 'regeneratePrimaryKey'; secondary = 'regenerateSecondaryKey' }[$next]
    $null = Invoke-PocApim -Context $Context -Method POST -Path "/subscriptions/$sid/$regenerate"
    $keys = Invoke-PocApim -Context $Context -Method POST -Path "/subscriptions/$sid/listSecrets"
    $null = Invoke-PocVault -Context $Context -Method PUT -Path "/secrets/$secret" -Body @{
        value       = if ($next -eq 'primary') { $keys.primaryKey } else { $keys.secondaryKey }
        contentType = 'API Management subscription key'
        tags        = @{ slot = $next; subscription = $sid; product = "$($current.tags.product)"; rotatedAt = [datetime]::UtcNow.ToString('o') }
    }
    Write-Host "Rotated ${sid}: Key Vault now holds the new $next key. The $held key keeps working until the next rotation."
    [pscustomobject]@{ Subscription = $sid; Slot = $next; PreviousSlot = $held }
}

# Records an expiry on the subscription. API Management keeps only the date (13:45 is stored as
# 00:00 UTC that day), refuses a time already past, and does not enforce it ("for audit purposes
# only"); Suspend-ExpiredPocKeys does, from 00:00 UTC on the stored date. Only an active
# subscription can be given a new expiry.
function Set-PocKeyExpiry {
    param([Parameter(Mandatory)]$Context, [Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][datetime]$ExpiresUtc)
    Assert-PocName $Name
    $null = Invoke-PocApim -Context $Context -Method PATCH -Path "/subscriptions/poc-$Name" -IfMatch -Body @{
        properties = @{ expirationDate = (ConvertTo-PocUtc $ExpiresUtc).ToString('o') }
    }
    Write-Host "poc-$Name expires on $((ConvertTo-PocUtc $ExpiresUtc).ToString('yyyy-MM-dd')) (00:00 UTC; API Management keeps the date only)."
}

# Every key on a proof-of-concept product: name, product, state and stored expiry date (API
# Management keeps the date only). Reads subscriptions; never fetches a key.
function Get-PocKeyList {
    param([Parameter(Mandatory)]$Context)
    $page = Invoke-PocApim -Context $Context -Method GET -Path '/subscriptions'
    while ($page) {
        foreach ($s in @($page.value)) {
            $m = [regex]::Match("$($s.properties.scope)", '/products/(poc-[a-z0-9-]+)$')
            if (-not $m.Success) { continue }
            $expires = ConvertTo-PocUtc $s.properties.expirationDate
            [pscustomobject]@{
                Name       = $s.name
                Product    = $m.Groups[1].Value
                State      = "$($s.properties.state)"
                Expires    = if ($expires) { $expires.ToString('yyyy-MM-dd') } else { '' }
                ExpiresUtc = $expires
            }
        }
        $page = if ($page.nextLink) { Invoke-PocApim -Context $Context -Method GET -Path $page.nextLink } else { $null }
    }
}

# Suspends or resumes one key. Measured on Standard v2: a suspended key was refused (401) from
# 1.4 s after the request, a resumed one accepted again from 9.8 s (UNKNOWNS U25).
function Set-PocKeyState {
    param(
        [Parameter(Mandatory)]$Context,
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][ValidateSet('active', 'suspended')][string]$State
    )
    Assert-PocName $Name
    $null = Invoke-PocApim -Context $Context -Method PATCH -Path "/subscriptions/poc-$Name" -IfMatch -Body @{ properties = @{ state = $State } }
    Write-Host "poc-$Name is now $State."
}

# Suspends every active key on a proof-of-concept product whose expiry has passed. Keys on other
# products, the all-access key and keys already suspended are left alone.
function Suspend-ExpiredPocKeys {
    param([Parameter(Mandatory)]$Context, [datetime]$Now = [datetime]::UtcNow)
    $now = ConvertTo-PocUtc $Now
    $suspended = [System.Collections.Generic.List[string]]::new()
    foreach ($k in @(Get-PocKeyList -Context $Context)) {
        if ($k.State -ne 'active' -or $null -eq $k.ExpiresUtc -or $k.ExpiresUtc -gt $now) { continue }
        $null = Invoke-PocApim -Context $Context -Method PATCH -Path "/subscriptions/$($k.Name)" -IfMatch -Body @{
            properties = @{ state = 'suspended'; stateComment = "Expired $($k.Expires)" }
        }
        Write-Host "Suspended $($k.Name): expired $($k.Expires)."
        $suspended.Add($k.Name)
    }
    return , $suspended.ToArray()
}
