// Explicit operator opt-in only (ADR-0017, U49). Existing gateway networking is not redeployed.
targetScope = 'resourceGroup'

@description('Existing gateway VNet in this APIM resource group; its location hosts the endpoint.')
param vnetName string

@description('Existing VNet location, resolved from ARM by Connect-Foundry.ps1, not the resource group location.')
param location string

@description('Existing subnet that admits private endpoints.')
param privateEndpointSubnetName string = 'snet-pe'

@description('Full account ARM resource ID, validated by Connect-Foundry.ps1 in this subscription.')
param foundryAccountId string

var endpointName = 'pe-foundry-${uniqueString(toLower(foundryAccountId))}'
var zones = [
  'privatelink.cognitiveservices.azure.com'
  'privatelink.openai.azure.com'
  'privatelink.services.ai.azure.com'
]

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' existing = {
  name: vnetName
}

resource subnet 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' existing = {
  parent: vnet
  name: privateEndpointSubnetName
}

resource dnsZones 'Microsoft.Network/privateDnsZones@2024-06-01' existing = [
  for zone in zones: {
    name: zone
  }
]

resource endpoint 'Microsoft.Network/privateEndpoints@2024-05-01' = {
  name: endpointName
  location: location
  properties: {
    subnet: { id: subnet.id }
    privateLinkServiceConnections: [
      {
        name: endpointName
        properties: {
          privateLinkServiceId: foundryAccountId
          groupIds: ['account']
        }
      }
    ]
  }
}

resource dnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = {
  parent: endpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      for (zone, i) in zones: {
        name: replace(zone, '.', '-')
        properties: { privateDnsZoneId: dnsZones[i].id }
      }
    ]
  }
}
