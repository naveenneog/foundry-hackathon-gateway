metadata description = 'Hackathon gateway for DeepSeek models on Microsoft Foundry: time-bound, spend-capped participant keys usable from opencode, with no model credential on any participant machine.'

targetScope = 'resourceGroup'

@description('Base name used to derive resource names. Must be globally unique for the API Management instance.')
@minLength(4)
@maxLength(28)
param namePrefix string = 'hackgw${uniqueString(resourceGroup().id)}'

@description('Location for all resources.')
param location string = resourceGroup().location

@description('Name of the existing Microsoft Foundry (AIServices) account hosting the DeepSeek deployments.')
param foundryAccountName string

@description('Resource group of the Foundry account. Defaults to this resource group.')
param foundryResourceGroup string = resourceGroup().name

@description('Publisher email shown on the API Management instance.')
param publisherEmail string

@description('Publisher name shown on the API Management instance.')
param publisherName string = 'Hackathon Organisers'

@description('Name of an existing API Management instance to deploy onto, which must live in this resource group and already have a system-assigned identity. Leave empty to create apim-{namePrefix}. The Claude route additionally requires a v2 SKU - see docs/UNKNOWNS.md U12.')
param existingApimName string = ''

@description('API Management SKU. Used only when creating an instance. DeepSeek returns the OpenAI Chat Completions shape, which llm-* policies parse on ALL tiers - unlike the Anthropic shape, which needs v2. BasicV2 is still the default for fast provisioning (minutes rather than 30-45).')
@allowed([
  'BasicV2'
  'StandardV2'
  'PremiumV2'
  'Developer'
])
param apimSku string = 'BasicV2'

@description('API Management scale units.')
@minValue(1)
param apimCapacity int = 1

@description('Alias-to-deployment map, as alias=deployment;alias=deployment. Aliases are what participants put in the `model` field; deployment names must exist in the Foundry account. Adding a model later is a named-value edit, not a redeploy.')
param modelMap string = 'flash=deepseek-v4-flash;pro=deepseek-v4-pro'

@description('Alias-to-deployment map for the Claude route, as alias=deployment;alias=deployment. Separate from modelMap because the two routes reach different Foundry endpoints: an alias pinned here names a deployment the /anthropic backend serves.')
param claudeModelMap string = ';'

@description('Whether to publish the Claude route. A classic API Management tier meters zero Anthropic tokens, so a budget on one would be configured and never fire - admin.ps1 passes false rather than publishing a control that cannot work. See docs/UNKNOWNS.md U12.')
param deployClaudeRoute bool = true

@description('HS256 signing secret for participant keys. Generate with admin.ps1; never commit it.')
@secure()
param signingKey string

@description('Comma-delimited revoked key ids, wrapped in sentinel commas. Managed by admin.ps1.')
param revokedKeys string = ','

@description('Tokens per minute ceiling, per participant key. Smooths bursts; the real cap is the per-key budget.')
param tpmPerKey int = 40000

@description('Request-rate ceiling per participant per minute. Stops a runaway agent loop making many small calls.')
param callsPerMinute int = 240

@description('Hard cap on max_tokens for any single completion, so one call cannot drain a budget.')
param maxOutputTokens int = 8192

var createApim = empty(existingApimName)
var apimName = createApim ? 'apim-${namePrefix}' : existingApimName
var appInsightsName = 'appi-${namePrefix}'
var workspaceName = 'log-${namePrefix}'
var apiId = 'deepseek-gateway'
var apiPath = 'v1'
var claudeApiId = 'claude-gateway'
var claudeApiPath = 'claude'

// Defence in depth for UNKNOWNS U12. admin.ps1 refuses to publish this route onto a classic
// tier, but a direct `az deployment group create` bypasses admin.ps1 entirely. On a tier that
// meters zero Anthropic tokens the route would advertise a budget that can never fire, so the
// template refuses too. Only the create path can be checked here: a deployment condition cannot
// read an existing resource's SKU, which is a runtime value.
var claudeTierOk = empty(existingApimName) ? endsWith(toLower(apimSku), 'v2') : true
var claudeRouteEnabled = deployClaudeRoute && claudeTierOk

// The Claude backend. Read from the account's published endpoints rather than assembled from
// the resource name: a Foundry account's host and its name can differ, which the OpenAI route
// already learned. `AI Foundry API` is the published base; the Anthropic Messages surface hangs
// off it. The documented form is used when the key is absent.
// https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/use-foundry-models-claude
var foundryEndpoints = foundry.properties.endpoints
var claudeServiceUrl = contains(foundryEndpoints, 'AI Foundry API')
  ? '${foundryEndpoints['AI Foundry API']}anthropic'
  : 'https://${foundry.properties.customSubDomainName}.services.ai.azure.com/anthropic'

resource foundry 'Microsoft.CognitiveServices/accounts@2024-10-01' existing = {
  name: foundryAccountName
  scope: resourceGroup(foundryResourceGroup)
}

// ---------------------------------------------------------------------------
// Observability
// ---------------------------------------------------------------------------

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: workspaceName
  location: location
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: appInsightsName
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: workspace.id
    IngestionMode: 'LogAnalytics'
    // Without WithDimensions the token metrics arrive as bare totals and the per-participant
    // breakdown is silently dropped. The Bicep type definition omits this property but the
    // REST API accepts it.
    #disable-next-line BCP037
    CustomMetricsOptedInType: 'WithDimensions'
  }
}

// ---------------------------------------------------------------------------
// Gateway
//
// Two declarations, deliberately. `apimNew` creates an instance only when none was named;
// `apim` is an `existing` reference that every child hangs off, so adopting an instance never
// rewrites its SKU, publisher details or identity. An `existing` reference produces no ARM
// dependency, which is why the children carry an explicit dependsOn.
// ---------------------------------------------------------------------------

resource apimNew 'Microsoft.ApiManagement/service@2024-05-01' = if (empty(existingApimName)) {
  name: apimName
  location: location
  sku: {
    name: apimSku
    capacity: apimCapacity
  }
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    publisherEmail: publisherEmail
    publisherName: publisherName
  }
}

resource apim 'Microsoft.ApiManagement/service@2024-05-01' existing = {
  name: apimName
}

resource apimLogger 'Microsoft.ApiManagement/service/loggers@2024-05-01' = {
  parent: apim
  // Namespaced. `appinsights` is the name nearly every APIM sample uses, so on an instance
  // somebody else runs it is the logger most likely to already exist and be silently repointed
  // at our Application Insights.
  name: 'hackgw-appinsights'
  properties: {
    loggerType: 'applicationInsights'
    description: 'Token metrics and request logs for the hackathon gateway'
    resourceId: appInsights.id
    credentials: {
      instrumentationKey: appInsights.properties.InstrumentationKey
    }
  }
  dependsOn: [
    apimNew
  ]
}

resource api 'Microsoft.ApiManagement/service/apis@2024-05-01' = {
  parent: apim
  name: apiId
  properties: {
    displayName: 'DeepSeek on Foundry (hackathon)'
    path: apiPath
    protocols: [
      'https'
    ]
    // The OpenAI v1 passthrough route. The deployment name travels in the request body as
    // `model`, not in the path, and no api-version query parameter is required.
    //
    // The hostname is built from the account's custom subdomain, NOT its resource name — the
    // two can differ, and using the resource name silently produces a dead backend.
    serviceUrl: 'https://${foundry.properties.customSubDomainName}.openai.azure.com/openai/v1'
    // Authorization is a self-issued JWT in the Authorization header, validated in policy.
    // APIM subscription keys cannot be used: the key is validated BEFORE inbound policy runs,
    // so a Bearer-prefixed value can never be rescued by a policy. See ADR-0002.
    subscriptionRequired: false
  }
  dependsOn: [
    apimNew
  ]
}

resource chatCompletions 'Microsoft.ApiManagement/service/apis/operations@2024-05-01' = {
  parent: api
  name: 'chat-completions'
  properties: {
    displayName: 'Create Chat Completion'
    method: 'POST'
    urlTemplate: '/chat/completions'
    responses: [
      {
        statusCode: 200
      }
    ]
  }
}

// opencode and most OpenAI-compatible clients call /models on startup to discover what they
// may use. Without this operation they show an empty model picker.
resource listModels 'Microsoft.ApiManagement/service/apis/operations@2024-05-01' = {
  parent: api
  name: 'list-models'
  properties: {
    displayName: 'List Models'
    method: 'GET'
    urlTemplate: '/models'
    responses: [
      {
        statusCode: 200
      }
    ]
  }
}

// ---------------------------------------------------------------------------
// Policy parameters, so limits are a config change rather than a redeploy
//
// Every name is prefixed `hackgw-`. Named values are INSTANCE-wide: on an API Management
// instance somebody else also uses, an unprefixed `signing-key` or `model-map` would overwrite
// theirs. tests/brownfield-apim.test.mjs pins the prefix and the policy/Bicep agreement.
// ---------------------------------------------------------------------------

resource nvSigningKey 'Microsoft.ApiManagement/service/namedValues@2024-05-01' = {
  parent: apim
  name: 'hackgw-signing-key'
  properties: {
    displayName: 'hackgw-signing-key'
    value: signingKey
    secret: true
  }
  dependsOn: [
    apimNew
  ]
}

var plainNamedValues = [
  { key: 'hackgw-revoked-keys', value: revokedKeys }
  { key: 'hackgw-tpm-per-key', value: string(tpmPerKey) }
  { key: 'hackgw-calls-per-minute', value: string(callsPerMinute) }
  { key: 'hackgw-max-output-tokens', value: string(maxOutputTokens) }
  { key: 'hackgw-model-map', value: modelMap }
  { key: 'hackgw-claude-model-map', value: claudeModelMap }
]

resource apimNamedValues 'Microsoft.ApiManagement/service/namedValues@2024-05-01' = [
  for nv in plainNamedValues: {
    parent: apim
    name: nv.key
    properties: {
      displayName: nv.key
      value: nv.value
    }
    dependsOn: [
      apimNew
    ]
  }
]

resource apiPolicy 'Microsoft.ApiManagement/service/apis/policies@2024-05-01' = {
  parent: api
  name: 'policy'
  properties: {
    format: 'rawxml'
    value: loadTextContent('policy.xml')
  }
  dependsOn: [
    apimNamedValues
    nvSigningKey
    chatCompletions
    listModels
  ]
}

resource apiDiagnostic 'Microsoft.ApiManagement/service/apis/diagnostics@2024-05-01' = {
  parent: api
  name: 'applicationinsights'
  properties: {
    loggerId: apimLogger.id
    alwaysLog: 'allErrors'
    // metrics:true is what makes llm-emit-token-metric actually emit. Without it the custom
    // metric namespace never appears and per-participant attribution is silently absent.
    metrics: true
    verbosity: 'information'
    httpCorrelationProtocol: 'W3C'
    sampling: {
      samplingType: 'fixed'
      percentage: 100
    }
  }
}

// ---------------------------------------------------------------------------
// Claude route — the Anthropic Messages API
//
// A different endpoint and a different wire format from the OpenAI route, so it is a separate
// API with its own policy rather than another operation on the existing one. Conditional
// because a classic-tier instance meters zero Anthropic tokens: publishing this there would
// advertise a budget that cannot fire. See docs/UNKNOWNS.md U12 and ADR-0009.
// ---------------------------------------------------------------------------

resource claudeApi 'Microsoft.ApiManagement/service/apis@2024-05-01' = if (claudeRouteEnabled) {
  parent: apim
  name: claudeApiId
  properties: {
    displayName: 'Claude on Foundry (hackathon)'
    // A client appends /v1/messages to ANTHROPIC_BASE_URL itself, so the base is this path.
    path: claudeApiPath
    protocols: [
      'https'
    ]
    serviceUrl: claudeServiceUrl
    subscriptionRequired: false
  }
  dependsOn: [
    apimNew
  ]
}

resource claudeMessages 'Microsoft.ApiManagement/service/apis/operations@2024-05-01' = if (claudeRouteEnabled) {
  parent: claudeApi
  name: 'messages'
  properties: {
    displayName: 'Create a Message'
    method: 'POST'
    urlTemplate: '/v1/messages'
    responses: [
      {
        statusCode: 200
      }
    ]
  }
}

// Optional per the gateway protocol, but without it Claude Code falls back to a character-based
// estimate of context usage and shows the participant that estimate.
resource claudeCountTokens 'Microsoft.ApiManagement/service/apis/operations@2024-05-01' = if (claudeRouteEnabled) {
  parent: claudeApi
  name: 'count-tokens'
  properties: {
    displayName: 'Count Message Tokens'
    method: 'POST'
    urlTemplate: '/v1/messages/count_tokens'
    responses: [
      {
        statusCode: 200
      }
    ]
  }
}

resource claudePolicy 'Microsoft.ApiManagement/service/apis/policies@2024-05-01' = if (claudeRouteEnabled) {
  parent: claudeApi
  name: 'policy'
  properties: {
    format: 'rawxml'
    value: loadTextContent('policy-claude.xml')
  }
  dependsOn: [
    apimNamedValues
    nvSigningKey
    claudeMessages
    claudeCountTokens
  ]
}

resource claudeDiagnostic 'Microsoft.ApiManagement/service/apis/diagnostics@2024-05-01' = if (claudeRouteEnabled) {
  parent: claudeApi
  name: 'applicationinsights'
  properties: {
    loggerId: apimLogger.id
    alwaysLog: 'allErrors'
    // metrics:true is what makes llm-emit-token-metric actually emit. Without it the custom
    // metric namespace never appears and per-participant attribution is silently absent.
    metrics: true
    verbosity: 'information'
    httpCorrelationProtocol: 'W3C'
    sampling: {
      samplingType: 'fixed'
      percentage: 100
    }
  }
}

// ---------------------------------------------------------------------------
// The gateway identity is the only principal that may call Foundry
// ---------------------------------------------------------------------------

module foundryRole 'foundry-role.bicep' = {
  name: 'grant-apim-cognitive-services-user'
  scope: resourceGroup(foundryResourceGroup)
  params: {
    foundryAccountName: foundryAccountName
    principalId: apim.identity.principalId
  }
  // `apim` is an `existing` reference, which creates no ARM dependency. Without this the role
  // grant is scheduled in the first parallel wave and resolves identity.principalId against an
  // instance that does not exist yet, failing every fresh deployment.
  dependsOn: [
    apimNew
  ]
}

output apimName string = apim.name
output gatewayUrl string = '${apim.properties.gatewayUrl}/${apiPath}'
output claudeGatewayUrl string = claudeRouteEnabled ? '${apim.properties.gatewayUrl}/${claudeApiPath}' : ''
output claudeServiceUrl string = claudeServiceUrl
output apimPrincipalId string = apim.identity.principalId
output appInsightsName string = appInsights.name
output modelMap string = modelMap
