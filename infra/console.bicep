// Key Console (P46, ADR-0013): a Linux App Service in the POC network that holds no secrets of
// its own. Operators sign in through App Service authentication (Entra ID, app roles); the app's
// system-assigned identity reaches the private Key Vault through VNet integration and manages
// API Management through Azure Resource Manager.

@description('Region; defaults to the resource group\'s.')
param location string = resourceGroup().location

@description('Web app name; its default host name must match the Entra app\'s redirect URI.')
param appName string

@description('Existing virtual network that already links the vault\'s private DNS zone.')
param vnetName string

@description('Address prefix for the new App Service integration subnet.')
param subnetPrefix string = '10.61.5.0/27'

@description('Existing private Key Vault (RBAC permission model).')
param vaultName string

@description('Existing API Management instance whose keys the console manages.')
param apimName string

@description('Entra application (client) id used for operator sign-in. Not a secret.')
param clientId string

@description('Gateway base URL put into client setup snippets.')
param gatewayUrl string

@description('Minutes between rotation sweeps; 0 switches automation off.')
@minValue(0)
@maxValue(1440)
param rotationSweepMinutes int = 60

var roles = {
  keyVaultSecretsOfficer: 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'
  keyVaultCryptoOfficer: '14b46e9e-c2b7-41b4-b07b-48a6ebf60603'
  apiManagementServiceContributor: '312a565d-c81f-4fd8-895a-4e21e48d571c'
}

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' existing = {
  name: vnetName
}

resource subnet 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' = {
  parent: vnet
  name: 'snet-console'
  properties: {
    addressPrefix: subnetPrefix
    delegations: [
      {
        name: 'web'
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

resource plan 'Microsoft.Web/serverfarms@2024-04-01' = {
  name: 'plan-${appName}'
  location: location
  kind: 'linux'
  sku: { name: 'B1' }
  properties: { reserved: true }
}

resource site 'Microsoft.Web/sites@2024-04-01' = {
  name: appName
  location: location
  kind: 'app,linux'
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    virtualNetworkSubnetId: subnet.id
    clientAffinityEnabled: false
    siteConfig: {
      linuxFxVersion: 'NODE|22-lts'
      appCommandLine: 'node src/console/main.mjs'
      alwaysOn: true
      healthCheckPath: '/healthz'
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      scmMinTlsVersion: '1.2'
      http20Enabled: true
      vnetRouteAllEnabled: true
      appSettings: [
        { name: 'KEY_VAULT_URL', value: 'https://${vaultName}${environment().suffixes.keyvaultDns}' }
        { name: 'APIM_RESOURCE_ID', value: apim.id }
        { name: 'GATEWAY_URL', value: gatewayUrl }
        { name: 'ROTATION_SWEEP_MINUTES', value: string(rotationSweepMinutes) }
        { name: 'SCM_DO_BUILD_DURING_DEPLOYMENT', value: 'false' }
      ]
    }
  }
}

resource ftpCredentials 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2024-04-01' = {
  parent: site
  name: 'ftp'
  properties: { allow: false }
}

resource scmCredentials 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2024-04-01' = {
  parent: site
  name: 'scm'
  properties: { allow: false }
}

resource auth 'Microsoft.Web/sites/config@2024-04-01' = {
  parent: site
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
          // No client secret: sign-in uses the ID token (implicit) flow, so the console has no
          // credential of its own to leak. The app registration must allow ID token issuance.
          openIdIssuer: '${environment().authentication.loginEndpoint}${tenant().tenantId}/v2.0'
          clientId: clientId
        }
        validation: {
          allowedAudiences: [ clientId, 'api://${clientId}' ]
        }
      }
    }
    login: {
      tokenStore: { enabled: false }
      preserveUrlFragmentsForLogins: false
    }
    httpSettings: {
      requireHttps: true
      forwardProxy: { convention: 'NoProxy' }
    }
  }
}

resource secretsOfficer 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: vault
  name: guid(vault.id, site.id, roles.keyVaultSecretsOfficer)
  properties: {
    principalId: site.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.keyVaultSecretsOfficer)
  }
}

resource cryptoOfficer 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: vault
  name: guid(vault.id, site.id, roles.keyVaultCryptoOfficer)
  properties: {
    principalId: site.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.keyVaultCryptoOfficer)
  }
}

resource apimContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: apim
  name: guid(apim.id, site.id, roles.apiManagementServiceContributor)
  properties: {
    principalId: site.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.apiManagementServiceContributor)
  }
}

output appUrl string = 'https://${site.properties.defaultHostName}'
output principalId string = site.identity.principalId
