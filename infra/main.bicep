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

@description('API Management SKU. DeepSeek returns the OpenAI Chat Completions shape, which llm-* policies parse on ALL tiers - unlike the Anthropic shape, which needs v2. BasicV2 is still the default for fast provisioning (minutes rather than 30-45).')
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

@description('Foundry deployment name for the agent-capable model. This one supports tool calling and is what opencode needs.')
param flashDeployment string = 'deepseek-v4-flash'

@description('Foundry deployment name for the reasoning model. Tool calling works despite the Learn docs claiming otherwise - see ADR-0003.')
param proDeployment string = 'deepseek-v4-pro'

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

var apimName = 'apim-${namePrefix}'
var appInsightsName = 'appi-${namePrefix}'
var workspaceName = 'log-${namePrefix}'
var apiId = 'deepseek-gateway'
var apiPath = 'v1'

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
// ---------------------------------------------------------------------------

resource apim 'Microsoft.ApiManagement/service@2024-05-01' = {
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

resource apimLogger 'Microsoft.ApiManagement/service/loggers@2024-05-01' = {
  parent: apim
  name: 'appinsights'
  properties: {
    loggerType: 'applicationInsights'
    description: 'Token metrics and request logs for the hackathon gateway'
    resourceId: appInsights.id
    credentials: {
      instrumentationKey: appInsights.properties.InstrumentationKey
    }
  }
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
// ---------------------------------------------------------------------------

resource nvSigningKey 'Microsoft.ApiManagement/service/namedValues@2024-05-01' = {
  parent: apim
  name: 'signing-key'
  properties: {
    displayName: 'signing-key'
    value: signingKey
    secret: true
  }
}

var plainNamedValues = [
  { key: 'revoked-keys', value: revokedKeys }
  { key: 'tpm-per-key', value: string(tpmPerKey) }
  { key: 'calls-per-minute', value: string(callsPerMinute) }
  { key: 'max-output-tokens', value: string(maxOutputTokens) }
  { key: 'model-flash', value: flashDeployment }
  { key: 'model-pro', value: proDeployment }
]

resource apimNamedValues 'Microsoft.ApiManagement/service/namedValues@2024-05-01' = [
  for nv in plainNamedValues: {
    parent: apim
    name: nv.key
    properties: {
      displayName: nv.key
      value: nv.value
    }
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
// The gateway identity is the only principal that may call Foundry
// ---------------------------------------------------------------------------

module foundryRole 'foundry-role.bicep' = {
  name: 'grant-apim-cognitive-services-user'
  scope: resourceGroup(foundryResourceGroup)
  params: {
    foundryAccountName: foundryAccountName
    principalId: apim.identity.principalId
  }
}

output apimName string = apim.name
output gatewayUrl string = '${apim.properties.gatewayUrl}/${apiPath}'
output apimPrincipalId string = apim.identity.principalId
output appInsightsName string = appInsights.name
output flashModel string = flashDeployment
output proModel string = proDeployment
