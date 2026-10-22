// Key Dashboard, Container Apps path (P53, ADR-0015; first built as the Key Console, P46, ADR-0013/0014):
// a container app in the POC network that holds
// no secrets of its own. Operators sign in through Container Apps authentication (Entra ID, app
// roles); the app's system-assigned identity reaches the private Key Vault through the VNet and
// manages API Management through Azure Resource Manager. A separate user-assigned identity can only
// pull the image.

@description('Region; defaults to the resource group\'s.')
param location string = resourceGroup().location

@description('Container app name.')
param appName string

@description('Existing virtual network that already links the vault\'s private DNS zone.')
param vnetName string

@description('Address prefix for the new Container Apps infrastructure subnet (/27 or larger).')
param subnetPrefix string = '10.61.5.0/27'

@description('Existing private Key Vault (RBAC permission model).')
param vaultName string

@description('Existing API Management instance whose keys the console manages.')
param apimName string

@description('Existing container registry holding the console image.')
param registryName string

@description('Image reference in that registry, e.g. <registry>.azurecr.io/key-console:<tag>.')
param image string

@description('Entra application (client) id used for operator sign-in. Not a secret.')
param clientId string

@description('Gateway base URL put into client setup snippets.')
param gatewayUrl string

@description('The single IPv4 address allowed to reach the dashboard; everything else is refused.')
param allowedIp string

@description('Existing Foundry (AIServices) account whose deployments the dashboard lists and pins.')
param foundryAccountName string

@description('Existing Log Analytics workspace that holds the gateway\'s token metrics (AppMetrics).')
param workspaceName string

@description('When the automation runs (UTC, five-field cron): rotation, archive, deletion.')
param automationCron string = '*/15 * * * *'

var roles = {
  keyVaultSecretsOfficer: 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'
  keyVaultCryptoOfficer: '14b46e9e-c2b7-41b4-b07b-48a6ebf60603'
  apiManagementServiceContributor: '312a565d-c81f-4fd8-895a-4e21e48d571c'
  acrPull: '7f951dda-4ed3-4680-a7ca-43fe172d538d'
  reader: 'acdd72a7-3385-48ef-bd42-f606fba81ae7'
  logAnalyticsDataReader: '3b03c2da-16b3-4a49-8834-0f8130efdd3b'
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
        name: 'containerapps'
        properties: { serviceName: 'Microsoft.App/environments' }
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

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: registryName
}

resource foundry 'Microsoft.CognitiveServices/accounts@2024-10-01' existing = {
  name: foundryAccountName
}

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  name: workspaceName
}

var settings = [
  { name: 'KEY_VAULT_URL', value: 'https://${vaultName}${environment().suffixes.keyvaultDns}' }
  { name: 'APIM_RESOURCE_ID', value: apim.id }
  { name: 'GATEWAY_URL', value: gatewayUrl }
]

resource pullIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-${appName}-pull'
  location: location
}

resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: registry
  name: guid(registry.id, pullIdentity.id, roles.acrPull)
  properties: {
    principalId: pullIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.acrPull)
  }
}

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'log-${appName}'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

resource env 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: 'cae-${appName}'
  location: location
  properties: {
    vnetConfiguration: {
      infrastructureSubnetId: subnet.id
      internal: false
    }
    workloadProfiles: [
      { name: 'Consumption', workloadProfileType: 'Consumption' }
    ]
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
  }
}

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: appName
  location: location
  identity: {
    type: 'SystemAssigned,UserAssigned'
    userAssignedIdentities: { '${pullIdentity.id}': {} }
  }
  dependsOn: [ acrPull ]
  properties: {
    environmentId: env.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 8080
        transport: 'auto'
        allowInsecure: false
        // One address only; with an Allow rule present every other address is refused.
        ipSecurityRestrictions: [
          { name: 'allowed-ip', ipAddressRange: '${allowedIp}/32', action: 'Allow' }
        ]
      }
      registries: [
        { server: registry.properties.loginServer, identity: pullIdentity.id }
      ]
    }
    template: {
      containers: [
        {
          name: 'console'
          image: image
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: concat(settings, [
            { name: 'FOUNDRY_ACCOUNT_ID', value: foundry.id }
            { name: 'LOG_WORKSPACE_ID', value: workspace.properties.customerId }
            // The cron job below runs the automation; the dashboard never sweeps.
            { name: 'ROTATION_SWEEP_MINUTES', value: '0' }
            // Asserts that platform sign-in (authConfigs below) fronts every request, so the
            // console may trust X-MS-CLIENT-PRINCIPAL. Without it the console fails closed (401).
            { name: 'WEBSITE_AUTH_ENABLED', value: 'True' }
          ])
          probes: [
            { type: 'Liveness', httpGet: { path: '/healthz', port: 8080 }, periodSeconds: 30 }
            { type: 'Readiness', httpGet: { path: '/healthz', port: 8080 }, periodSeconds: 10 }
          ]
        }
      ]
      // Scales to zero when nobody is signed in; one replica at most.
      scale: { minReplicas: 0, maxReplicas: 1 }
    }
  }
}

resource auth 'Microsoft.App/containerApps/authConfigs@2024-03-01' = {
  parent: app
  name: 'current'
  properties: {
    platform: { enabled: true }
    globalValidation: {
      unauthenticatedClientAction: 'RedirectToLoginPage'
      redirectToProvider: 'azureactivedirectory'
      excludedPaths: [ '/healthz' ]
    }
    identityProviders: {
      azureActiveDirectory: {
        enabled: true
        registration: {
          // No client secret: sign-in uses the ID token flow, so the console has no credential
          // of its own to leak. The app registration must allow ID token issuance.
          openIdIssuer: '${environment().authentication.loginEndpoint}${tenant().tenantId}/v2.0'
          clientId: clientId
        }
        validation: {
          allowedAudiences: [ clientId, 'api://${clientId}' ]
        }
      }
    }
    login: {
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
  name: guid(vault.id, app.id, roles.keyVaultSecretsOfficer)
  properties: {
    principalId: app.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.keyVaultSecretsOfficer)
  }
}

resource cryptoOfficer 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: vault
  name: guid(vault.id, app.id, roles.keyVaultCryptoOfficer)
  properties: {
    principalId: app.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.keyVaultCryptoOfficer)
  }
}

resource apimContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: apim
  name: guid(apim.id, app.id, roles.apiManagementServiceContributor)
  properties: {
    principalId: app.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.apiManagementServiceContributor)
  }
}

// The automation: one sweep per schedule, then exit. Billed only while it runs; no ingress.
resource job 'Microsoft.App/jobs@2024-03-01' = {
  name: 'job-${appName}'
  location: location
  identity: {
    type: 'SystemAssigned,UserAssigned'
    userAssignedIdentities: { '${pullIdentity.id}': {} }
  }
  dependsOn: [ acrPull ]
  properties: {
    environmentId: env.id
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Schedule'
      replicaTimeout: 900
      replicaRetryLimit: 0
      scheduleTriggerConfig: {
        cronExpression: automationCron
        parallelism: 1
        replicaCompletionCount: 1
      }
      registries: [
        { server: registry.properties.loginServer, identity: pullIdentity.id }
      ]
    }
    template: {
      containers: [
        {
          name: 'automation'
          image: image
          command: [ 'node', 'src/console/automation.mjs' ]
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          env: settings
        }
      ]
    }
  }
}

resource foundryReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: foundry
  name: guid(foundry.id, app.id, roles.reader)
  properties: {
    principalId: app.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.reader)
  }
}

resource usageReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: workspace
  name: guid(workspace.id, app.id, roles.logAnalyticsDataReader)
  properties: {
    principalId: app.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.logAnalyticsDataReader)
  }
}

resource jobSecretsOfficer 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: vault
  name: guid(vault.id, job.id, roles.keyVaultSecretsOfficer)
  properties: {
    principalId: job.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.keyVaultSecretsOfficer)
  }
}

resource jobApimContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: apim
  name: guid(apim.id, job.id, roles.apiManagementServiceContributor)
  properties: {
    principalId: job.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.apiManagementServiceContributor)
  }
}

output appUrl string = 'https://${app.properties.configuration.ingress.fqdn}'
output principalId string = app.identity.principalId
output jobName string = job.name
