// liteAPIM's own network (P63, ADR-0021). Deployed only by Deploy-Console.ps1 -CreateNetwork, for
// a gateway with no VNet of its own, such as Basic v2. Holds the Container Apps environment and
// the private endpoint through which liteAPIM and its automation job reach the vault. The vault
// stays private: nothing here changes its public network access.
targetScope = 'resourceGroup'

param location string = resourceGroup().location

@description('The new VNet, liteAPIM-only.')
param vnetName string

// 10.65.0.0/24 overlapped no VNet in the test subscription on 2026-10-26 and stays outside the
// Standard v2 gateway's 10.61.0.0/16, so the two networks could later be peered.
@description('Address space, /16 to /26. The Container Apps subnet is its first /27 and the private-endpoint subnet its third /28.')
param addressPrefix string = '10.65.0.0/24'

@description('Existing private Key Vault (kv-poc-*) in this resource group.')
param vaultName string

@description('False when this resource group already holds the vault\'s private DNS zone, which is then reused.')
param createVaultZone bool = true

var consoleSubnetPrefix = cidrSubnet(addressPrefix, 27, 0)
var zoneName = 'privatelink.vaultcore.azure.net'

// Both subnets are declared here, so a redeploy keeps the one console.bicep also declares.
// Workload-profiles environment: /27 at least, delegated to Microsoft.App/environments (U58).
resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: vnetName
  location: location
  properties: {
    addressSpace: { addressPrefixes: [ addressPrefix ] }
    subnets: [
      {
        name: 'snet-console'
        properties: {
          addressPrefix: cidrSubnet(addressPrefix, 27, 0)
          delegations: [
            { name: 'containerapps', properties: { serviceName: 'Microsoft.App/environments' } }
          ]
        }
      }
      {
        name: 'snet-pe'
        properties: {
          addressPrefix: cidrSubnet(addressPrefix, 28, 2)
          privateEndpointNetworkPolicies: 'Disabled'
        }
      }
    ]
  }
}

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: vaultName
}

resource newZone 'Microsoft.Network/privateDnsZones@2020-06-01' = if (createVaultZone) {
  name: 'privatelink.vaultcore.azure.net'
  location: 'global'
}

resource zone 'Microsoft.Network/privateDnsZones@2020-06-01' existing = {
  name: zoneName
}

resource zoneLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = {
  parent: zone
  name: 'link-${vnetName}'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: { id: vnet.id }
  }
  dependsOn: [ newZone ]
}

resource endpoint 'Microsoft.Network/privateEndpoints@2024-05-01' = {
  name: 'pe-${vaultName}'
  location: location
  properties: {
    subnet: { id: '${vnet.id}/subnets/snet-pe' }
    privateLinkServiceConnections: [
      {
        name: 'vault'
        properties: {
          privateLinkServiceId: vault.id
          groupIds: [ 'vault' ]
        }
      }
    ]
  }
}

resource endpointDns 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = {
  parent: endpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'vault'
        properties: { privateDnsZoneId: zone.id }
      }
    ]
  }
  dependsOn: [ newZone ]
}

output consoleSubnetPrefix string = consoleSubnetPrefix
