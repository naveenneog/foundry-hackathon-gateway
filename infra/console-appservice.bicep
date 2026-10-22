// Key Dashboard, App Service path (P53, ADR-0015). One Linux plan carries the dashboard (a web app)
// and the automation (a Function App timer), so there is one plan to pay for. Both sites are
// VNet-integrated, so the private vault resolves and every outbound call stays in the network.
// Both sites, and their scm endpoints, admit one IPv4 address; everything else is refused at the
// App Service front end, before sign-in or app code runs.
//
// Not deployable in this subscription's eastus2 today: App Service quota is 0 (UNKNOWNS U40).

@description('Region; defaults to the resource group\'s.')
param location string = resourceGroup().location

@description('Base name for the plan and both sites.')
param appName string

@description('Plan SKU. B1 is the smallest that supports VNet integration and Always On.')
param skuName string = 'B1'

@description('Existing virtual network that already links the vault\'s private DNS zone.')
param vnetName string

@description('Address prefix for the new App Service integration subnet (/28 or larger).')
param subnetPrefix string = '10.61.6.0/27'

@description('Existing private Key Vault (RBAC permission model).')
param vaultName string

@description('Existing API Management instance whose keys the dashboard manages.')
param apimName string

@description('Existing Foundry (AIServices) account whose deployments the dashboard lists and pins.')
param foundryAccountName string

@description('Existing Log Analytics workspace that holds the gateway\'s token metrics (AppMetrics).')
param workspaceName string

@description('Entra application (client) id used for operator sign-in. Not a secret.')
param clientId string

@description('Gateway base URL put into client setup snippets.')
param gatewayUrl string

@description('The one address allowed to reach both sites, as CIDR: <ip>/32, or a narrow NAT pool. Everything else is refused.')
param allowedCidr string

var roles = {
  keyVaultSecretsOfficer: 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'
  keyVaultCryptoOfficer: '14b46e9e-c2b7-41b4-b07b-48a6ebf60603'
  apiManagementServiceContributor: '312a565d-c81f-4fd8-895a-4e21e48d571c'
  reader: 'acdd72a7-3385-48ef-bd42-f606fba81ae7'
  logAnalyticsDataReader: '3b03c2da-16b3-4a49-8834-0f8130efdd3b'
  storageBlobDataOwner: 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b'
  storageQueueDataContributor: '974c5e8b-45b9-4653-ba55-5f855dd0fb88'
  storageTableDataContributor: '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'
}

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' existing = {
  name: vnetName
}

resource subnet 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' = {
  parent: vnet
  name: 'snet-appsvc'
  properties: {
    addressPrefix: subnetPrefix
    delegations: [
      {
        name: 'appservice'
        properties: { serviceName: 'Microsoft.Web/serverFarms' }
      }
    ]
  }
}

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: vaultName
}

resource apim 'Microsoft.ApiManagement/service@2024-05-01' existing = {
  name: apimName
}

resource foundry 'Microsoft.CognitiveServices/accounts@2024-10-01' existing = {
  name: foundryAccountName
}

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  name: workspaceName
}

var common = [
  { name: 'KEY_VAULT_URL', value: 'https://${vaultName}${environment().suffixes.keyvaultDns}' }
  { name: 'APIM_RESOURCE_ID', value: apim.id }
  { name: 'GATEWAY_URL', value: gatewayUrl }
  { name: 'ROTATION_SWEEP_MINUTES', value: '0' }
]

var ipRules = [
  { name: 'allowed-ip', action: 'Allow', priority: 100, ipAddress: allowedCidr }
]

resource plan 'Microsoft.Web/serverfarms@2024-04-01' = {
  name: 'asp-${appName}'
  location: location
  kind: 'linux'
  sku: { name: skuName }
  properties: { reserved: true }
}

resource web 'Microsoft.Web/sites@2024-04-01' = {
  name: appName
  location: location
  kind: 'app,linux'
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    virtualNetworkSubnetId: subnet.id
    publicNetworkAccess: 'Enabled'
    siteConfig: {
      linuxFxVersion: 'NODE|24-lts'
      appCommandLine: 'node src/console/main.mjs'
      alwaysOn: true
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      http20Enabled: true
      vnetRouteAllEnabled: true
      ipSecurityRestrictionsDefaultAction: 'Deny'
      ipSecurityRestrictions: ipRules
      scmIpSecurityRestrictionsUseMain: true
      healthCheckPath: '/healthz'
      appSettings: concat(common, [
        { name: 'FOUNDRY_ACCOUNT_ID', value: foundry.id }
        { name: 'LOG_WORKSPACE_ID', value: workspace.properties.customerId }
        { name: 'PORT', value: '8080' }
        { name: 'WEBSITES_PORT', value: '8080' }
        { name: 'SCM_DO_BUILD_DURING_DEPLOYMENT', value: 'false' }
      ])
    }
  }
}

resource webFtp 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2024-04-01' = {
  parent: web
  name: 'ftp'
  properties: { allow: false }
}

resource webScm 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2024-04-01' = {
  parent: web
  name: 'scm'
  properties: { allow: false }
}

resource webAuth 'Microsoft.Web/sites/config@2024-04-01' = {
  parent: web
  name: 'authsettingsV2'
  properties: {
    platform: { enabled: true }
    globalValidation: {
      requireAuthentication: true
      unauthenticatedClientAction: 'RedirectToLoginPage'
      redirectToProvider: 'azureactivedirectory'
      excludedPaths: [ '/healthz' ]
    }
    identityProviders: {
      azureActiveDirectory: {
        enabled: true
        registration: {
          // No client secret: sign-in uses the ID token flow, so the dashboard has no credential
          // of its own to leak. The app registration must allow ID token issuance.
          openIdIssuer: '${environment().authentication.loginEndpoint}${tenant().tenantId}/v2.0'
          clientId: clientId
        }
        validation: {
          allowedAudiences: [ clientId, 'api://${clientId}' ]
        }
      }
    }
    login: { preserveUrlFragmentsForLogins: false }
    httpSettings: {
      requireHttps: true
      forwardProxy: { convention: 'NoProxy' }
    }
  }
}

// The Function App's host storage. Shared keys are off: the host connects with its identity.
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: take('st${replace(appName, '-', '')}${uniqueString(resourceGroup().id)}', 24)
  location: location
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    allowSharedKeyAccess: false
    allowBlobPublicAccess: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
  }
}

resource fn 'Microsoft.Web/sites@2024-04-01' = {
  name: 'func-${appName}'
  location: location
  kind: 'functionapp,linux'
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    virtualNetworkSubnetId: subnet.id
    siteConfig: {
      linuxFxVersion: 'Node|24'
      // Timer triggers on a dedicated plan fire reliably only with Always On (Learn: functions-scale).
      alwaysOn: true
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      vnetRouteAllEnabled: true
      ipSecurityRestrictionsDefaultAction: 'Deny'
      ipSecurityRestrictions: ipRules
      scmIpSecurityRestrictionsUseMain: true
      appSettings: concat(common, [
        { name: 'FUNCTIONS_EXTENSION_VERSION', value: '~4' }
        { name: 'FUNCTIONS_WORKER_RUNTIME', value: 'node' }
        { name: 'AzureWebJobsStorage__accountName', value: storage.name }
        { name: 'AzureWebJobsStorage__credential', value: 'managedidentity' }
        { name: 'SCM_DO_BUILD_DURING_DEPLOYMENT', value: 'false' }
      ])
    }
  }
}

resource fnFtp 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2024-04-01' = {
  parent: fn
  name: 'ftp'
  properties: { allow: false }
}

resource fnScm 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2024-04-01' = {
  parent: fn
  name: 'scm'
  properties: { allow: false }
}

// Dashboard: vault secrets and the bundle key, API Management, read the Foundry account, query usage.
resource webSecrets 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: vault
  name: guid(vault.id, web.id, roles.keyVaultSecretsOfficer)
  properties: { principalId: web.identity.principalId, principalType: 'ServicePrincipal', roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.keyVaultSecretsOfficer) }
}

resource webCrypto 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: vault
  name: guid(vault.id, web.id, roles.keyVaultCryptoOfficer)
  properties: { principalId: web.identity.principalId, principalType: 'ServicePrincipal', roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.keyVaultCryptoOfficer) }
}

resource webApim 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: apim
  name: guid(apim.id, web.id, roles.apiManagementServiceContributor)
  properties: { principalId: web.identity.principalId, principalType: 'ServicePrincipal', roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.apiManagementServiceContributor) }
}

resource webFoundry 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: foundry
  name: guid(foundry.id, web.id, roles.reader)
  properties: { principalId: web.identity.principalId, principalType: 'ServicePrincipal', roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.reader) }
}

resource webUsage 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: workspace
  name: guid(workspace.id, web.id, roles.logAnalyticsDataReader)
  properties: { principalId: web.identity.principalId, principalType: 'ServicePrincipal', roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.logAnalyticsDataReader) }
}

// Automation: vault secrets and API Management for the sweep, and its own host storage.
resource fnSecrets 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: vault
  name: guid(vault.id, fn.id, roles.keyVaultSecretsOfficer)
  properties: { principalId: fn.identity.principalId, principalType: 'ServicePrincipal', roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.keyVaultSecretsOfficer) }
}

resource fnApim 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: apim
  name: guid(apim.id, fn.id, roles.apiManagementServiceContributor)
  properties: { principalId: fn.identity.principalId, principalType: 'ServicePrincipal', roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.apiManagementServiceContributor) }
}

resource fnBlob 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: storage
  name: guid(storage.id, fn.id, roles.storageBlobDataOwner)
  properties: { principalId: fn.identity.principalId, principalType: 'ServicePrincipal', roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.storageBlobDataOwner) }
}

resource fnQueue 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: storage
  name: guid(storage.id, fn.id, roles.storageQueueDataContributor)
  properties: { principalId: fn.identity.principalId, principalType: 'ServicePrincipal', roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.storageQueueDataContributor) }
}

resource fnTable 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: storage
  name: guid(storage.id, fn.id, roles.storageTableDataContributor)
  properties: { principalId: fn.identity.principalId, principalType: 'ServicePrincipal', roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.storageTableDataContributor) }
}

output appUrl string = 'https://${web.properties.defaultHostName}'
output webName string = web.name
output functionName string = fn.name
output principalId string = web.identity.principalId
