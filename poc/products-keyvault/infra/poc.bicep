// P37 proof of concept, branch poc/apim-products-keyvault: long-lived keys on API Management
// products, with each key held in Key Vault. Adds poc- routes and products to an EXISTING
// instance and creates one Key Vault. Nothing on the instance that this template did not create
// is changed. Deploy with ../scripts/Deploy-Poc.ps1; see ../README.md.

@description('Existing API Management instance on a v2 tier: llm-token-limit meters the Anthropic Messages API only on v2 tiers.')
param apimName string

@description('Foundry account the routes call, in this resource group. The instance\'s managed identity must already hold Cognitive Services User on it.')
param foundryAccountName string

@description('Object id of the operator who issues and rotates keys. Gets Key Vault Secrets Officer on the vault.')
param operatorObjectId string

@allowed([
  'User'
  'ServicePrincipal'
  'Group'
])
param operatorPrincipalType string = 'User'

@description('Log Analytics workspace in this resource group for the vault\'s audit log, which records who read which key. Empty: no audit log.')
param auditWorkspaceName string = ''

param location string = resourceGroup().location

@description('Globally unique, 3-24 characters.')
@maxLength(24)
param vaultName string = 'kv-poc-${uniqueString(resourceGroup().id, apimName)}'

@description('Public network access to the vault that holds every key. Disabled: reached through a private endpoint (runner.bicep). A redeploy does not reopen a vault something else closed.')
@allowed([
  'Disabled'
  'Enabled'
])
param vaultPublicNetworkAccess string = 'Disabled'

@description('One product per model pack. keyTokens and poolTokens are per calendar month (UTC); tpm is per key per minute.')
param products array = [
  {
    id: 'poc-claude-pack'
    displayName: 'POC: Claude pack'
    routes: [
      'poc-claude'
    ]
    models: [
      'claude-haiku-4-5'
    ]
    keyTokens: 200000
    poolTokens: 2000000
    tpm: 20000
  }
  {
    id: 'poc-deepseek-pack'
    displayName: 'POC: DeepSeek pack'
    routes: [
      'poc-openai'
    ]
    models: [
      'deepseek-v4-flash'
    ]
    keyTokens: 200000
    poolTokens: 2000000
    tpm: 20000
  }
  {
    // A budget small enough to spend in a few calls, to measure the 403 and the overshoot.
    id: 'poc-tiny-pack'
    displayName: 'POC: tiny budget'
    routes: [
      'poc-claude'
    ]
    models: [
      'claude-haiku-4-5'
    ]
    keyTokens: 300
    poolTokens: 100000
    tpm: 20000
  }
]

resource apim 'Microsoft.ApiManagement/service@2024-05-01' existing = {
  name: apimName
}

resource foundry 'Microsoft.CognitiveServices/accounts@2024-10-01' existing = {
  name: foundryAccountName
}

// The same derivation as infra/main.bicep: the account's published endpoint, not its name.
var foundryEndpoints = foundry.properties.endpoints
var claudeServiceUrl = contains(foundryEndpoints, 'AI Foundry API')
  ? '${foundryEndpoints['AI Foundry API']}anthropic'
  : 'https://${foundry.properties.customSubDomainName}.services.ai.azure.com/anthropic'
var openaiServiceUrl = 'https://${foundry.properties.customSubDomainName}.openai.azure.com/openai/v1'

// keyHeader is the header API Management reads the subscription key from: x-api-key is where
// Claude Code sends ANTHROPIC_API_KEY and apiKeyHelper output; api-key is what OpenAI SDKs add
// through default headers.
var routes = [
  {
    id: 'poc-claude'
    keyHeader: 'x-api-key'
    path: 'poc/claude'
    displayName: 'POC: Claude on Foundry, product keys'
    backend: 'claude'
    policy: loadTextContent('api-claude-policy.xml')
  }
  {
    id: 'poc-openai'
    keyHeader: 'api-key'
    path: 'poc/v1'
    displayName: 'POC: OpenAI-compatible on Foundry, product keys'
    backend: 'openai'
    policy: loadTextContent('api-openai-policy.xml')
  }
  {
    id: 'poc-probe'
    keyHeader: 'x-api-key'
    path: 'poc/probe'
    displayName: 'POC: what the gateway knows about a key'
    backend: ''
    policy: loadTextContent('api-probe-policy.xml')
  }
]
var routeIds = map(routes, r => r.id)

var operations = [
  {
    route: 'poc-claude'
    op: 'messages'
    method: 'POST'
    url: '/v1/messages'
  }
  {
    route: 'poc-claude'
    op: 'count-tokens'
    method: 'POST'
    url: '/v1/messages/count_tokens'
  }
  {
    route: 'poc-openai'
    op: 'chat-completions'
    method: 'POST'
    url: '/chat/completions'
  }
  {
    route: 'poc-probe'
    op: 'whoami'
    method: 'GET'
    url: '/whoami'
  }
]

resource api 'Microsoft.ApiManagement/service/apis@2024-05-01' = [for r in routes: {
  parent: apim
  name: r.id
  properties: {
    displayName: r.displayName
    path: r.path
    protocols: [
      'https'
    ]
    serviceUrl: r.backend == 'claude' ? claudeServiceUrl : (r.backend == 'openai' ? openaiServiceUrl : null)
    subscriptionRequired: true
    subscriptionKeyParameterNames: {
      header: r.keyHeader
      query: 'subscription-key'
    }
  }
}]

resource operation 'Microsoft.ApiManagement/service/apis/operations@2024-05-01' = [for o in operations: {
  parent: api[indexOf(routeIds, o.route)]
  name: o.op
  properties: {
    displayName: o.op
    method: o.method
    urlTemplate: o.url
    responses: []
  }
}]

resource apiPolicy 'Microsoft.ApiManagement/service/apis/policies@2024-05-01' = [for (r, i) in routes: {
  parent: api[i]
  name: 'policy'
  properties: {
    format: 'rawxml'
    value: r.policy
  }
  dependsOn: [
    operation
  ]
}]

var productIds = map(products, p => p.id)
var productPolicyTemplate = loadTextContent('product-policy.xml')

resource product 'Microsoft.ApiManagement/service/products@2024-05-01' = [for p in products: {
  parent: apim
  name: p.id
  properties: {
    displayName: p.displayName
    description: 'P37 proof of concept. Models: ${join(p.models, ', ')}. ${p.keyTokens} tokens per key and ${p.poolTokens} per product, each calendar month (UTC).'
    subscriptionRequired: true
    // Not listed in the developer portal. The gateway serves a product either way.
    state: 'notPublished'
  }
}]

resource productPolicy 'Microsoft.ApiManagement/service/products/policies@2024-05-01' = [for (p, i) in products: {
  parent: product[i]
  name: 'policy'
  properties: {
    format: 'rawxml'
    value: replace(replace(replace(replace(productPolicyTemplate,
      '__MODELS__', join(p.models, '|')),
      '__KEY_TOKENS__', string(p.keyTokens)),
      '__POOL_TOKENS__', string(p.poolTokens)),
      '__TPM__', string(p.tpm))
  }
}]

// Every product carries its routes and the probe.
var productRoutes = flatten(map(products, p => map(concat(p.routes, ['poc-probe']), r => {
  product: p.id
  route: r
})))

resource productApi 'Microsoft.ApiManagement/service/products/apis@2024-05-01' = [for l in productRoutes: {
  parent: product[indexOf(productIds, l.product)]
  name: l.route
  dependsOn: [
    api
  ]
}]

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: vaultName
  location: location
  properties: {
    tenantId: subscription().tenantId
    sku: {
      family: 'A'
      name: 'standard'
    }
    // Azure RBAC rather than access policies, so access can be granted per secret.
    enableRbacAuthorization: true
    accessPolicies: []
    // A proof of concept: the shortest soft-delete retention and no purge protection, so the
    // vault can be removed completely.
    softDeleteRetentionInDays: 7
    publicNetworkAccess: vaultPublicNetworkAccess
    networkAcls: {
      defaultAction: 'Deny'
      bypass: 'None'
    }
  }
}

var keyVaultSecretsOfficer = 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'

resource operatorRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, operatorObjectId, keyVaultSecretsOfficer)
  scope: vault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsOfficer)
    principalId: operatorObjectId
    principalType: operatorPrincipalType
  }
}

resource auditWorkspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = if (!empty(auditWorkspaceName)) {
  name: empty(auditWorkspaceName) ? 'unused' : auditWorkspaceName
}

resource vaultAudit 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(auditWorkspaceName)) {
  name: 'poc-audit'
  scope: vault
  properties: {
    workspaceId: auditWorkspace.id
    logs: [
      {
        categoryGroup: 'audit'
        enabled: true
      }
    ]
  }
}

output vaultName string = vault.name
output claudeBaseUrl string = '${apim.properties.gatewayUrl}/poc/claude'
output openaiBaseUrl string = '${apim.properties.gatewayUrl}/poc/v1'
output probeUrl string = '${apim.properties.gatewayUrl}/poc/probe/whoami'
