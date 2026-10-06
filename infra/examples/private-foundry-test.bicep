// Test environment for the question "does the gateway work when Foundry is reachable only
// through a private endpoint?". Everything lives in one resource group, and nothing outside it is
// touched.
//
// - A Foundry (AIServices) account with a private endpoint and the three private DNS zones
//   Microsoft lists for it (learn.microsoft.com/azure/private-link/private-endpoint-dns).
// - A Standard v2 API Management instance with outbound virtual network integration: a dedicated
//   /24 subnet delegated to Microsoft.Web/serverFarms, with an NSG allowing 443 to AzureKeyVault
//   (learn.microsoft.com/azure/api-management/integrate-vnet-outbound).
// - One OpenAI-route model and one Claude model, so both gateway routes can be tested.
//
// Public network access on the account starts Enabled so the model deployments can be confirmed,
// and is switched to Disabled afterwards.

targetScope = 'resourceGroup'

param location string = resourceGroup().location
param publisherEmail string

@description('modelProviderData copied from an existing Claude deployment in this subscription.')
param claudeProviderData object

@allowed(['Enabled', 'Disabled'])
param foundryPublicNetworkAccess string = 'Enabled'

var suffix = uniqueString(resourceGroup().id)
var foundryName = 'aif-hackgw-pe-${suffix}'
var apimName = 'apim-hackgw-pe-${suffix}'
var vnetName = 'vnet-hackgw-pe'
var zones = [
  'privatelink.cognitiveservices.azure.com'
  'privatelink.openai.azure.com'
  'privatelink.services.ai.azure.com'
]

resource nsg 'Microsoft.Network/networkSecurityGroups@2024-05-01' = {
  name: 'nsg-apim-integration'
  location: location
  properties: {
    securityRules: [
      {
        name: 'AllowKeyVaultOutbound'
        properties: {
          priority: 100
          direction: 'Outbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: 'VirtualNetwork'
          sourcePortRange: '*'
          destinationAddressPrefix: 'AzureKeyVault'
          destinationPortRange: '443'
        }
      }
    ]
  }
}

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: vnetName
  location: location
  properties: {
    addressSpace: { addressPrefixes: ['10.61.0.0/16'] }
    subnets: [
      {
        name: 'snet-apim'
        properties: {
          addressPrefix: '10.61.1.0/24'
          networkSecurityGroup: { id: nsg.id }
          delegations: [
            { name: 'apim-v2-integration', properties: { serviceName: 'Microsoft.Web/serverFarms' } }
          ]
        }
      }
      {
        name: 'snet-pe'
        properties: {
          addressPrefix: '10.61.2.0/24'
          privateEndpointNetworkPolicies: 'Disabled'
        }
      }
    ]
  }
}

resource foundry 'Microsoft.CognitiveServices/accounts@2025-12-01' = {
  name: foundryName
  location: location
  kind: 'AIServices'
  sku: { name: 'S0' }
  identity: { type: 'SystemAssigned' }
  properties: {
    customSubDomainName: foundryName
    allowProjectManagement: true
    disableLocalAuth: true
    publicNetworkAccess: foundryPublicNetworkAccess
  }
}

resource deepseek 'Microsoft.CognitiveServices/accounts/deployments@2025-12-01' = {
  parent: foundry
  name: 'deepseek-v4-flash'
  sku: { name: 'GlobalStandard', capacity: 10 }
  properties: {
    model: { format: 'DeepSeek', name: 'DeepSeek-V4-Flash-0731', version: '2026-07-31' }
    raiPolicyName: 'Microsoft.DefaultV2'
    versionUpgradeOption: 'OnceNewDefaultVersionAvailable'
  }
}

resource claude 'Microsoft.CognitiveServices/accounts/deployments@2025-12-01' = {
  parent: foundry
  name: 'claude-haiku-4-5'
  sku: { name: 'GlobalStandard', capacity: 10 }
  properties: {
    model: { format: 'Anthropic', name: 'claude-haiku-4-5', version: '2' }
    raiPolicyName: 'Microsoft.DefaultV2'
    versionUpgradeOption: 'OnceNewDefaultVersionAvailable'
    modelProviderData: claudeProviderData
  }
  // An account accepts one deployment operation at a time.
  dependsOn: [deepseek]
}

resource pe 'Microsoft.Network/privateEndpoints@2024-05-01' = {
  name: 'pe-${foundryName}'
  location: location
  properties: {
    subnet: { id: '${vnet.id}/subnets/snet-pe' }
    privateLinkServiceConnections: [
      {
        name: 'foundry'
        properties: {
          privateLinkServiceId: foundry.id
          groupIds: ['account']
        }
      }
    ]
  }
  dependsOn: [claude]
}

resource dnsZones 'Microsoft.Network/privateDnsZones@2024-06-01' = [
  for z in zones: {
    name: z
    location: 'global'
  }
]

resource dnsLinks 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = [
  for (z, i) in zones: {
    parent: dnsZones[i]
    name: 'link-${vnetName}'
    location: 'global'
    properties: {
      registrationEnabled: false
      virtualNetwork: { id: vnet.id }
    }
  }
]

resource dnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = {
  parent: pe
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      for (z, i) in zones: {
        name: replace(z, '.', '-')
        properties: { privateDnsZoneId: dnsZones[i].id }
      }
    ]
  }
}

resource apim 'Microsoft.ApiManagement/service@2024-05-01' = {
  name: apimName
  location: location
  sku: { name: 'StandardV2', capacity: 1 }
  identity: { type: 'SystemAssigned' }
  properties: {
    publisherEmail: publisherEmail
    publisherName: 'Hackathon gateway private-endpoint test'
    virtualNetworkType: 'External'
    virtualNetworkConfiguration: { subnetResourceId: '${vnet.id}/subnets/snet-apim' }
  }
}

output foundryName string = foundry.name
output foundryEndpoint string = 'https://${foundryName}.services.ai.azure.com'
output apimName string = apim.name
output gatewayUrl string = apim.properties.gatewayUrl
output privateEndpointName string = pe.name
