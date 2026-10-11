// P37 proof of concept: where the key scripts run when the vault accepts only private traffic.
// In the test subscription, public network access on a new vault is turned off by a control
// outside this project, so the scripts and Claude Code run inside the virtual network.
//
// Adds to an existing virtual network: a private endpoint and privatelink DNS zone for the
// vault, a small subnet whose only way out is a NAT gateway, and a Linux VM with a managed
// identity, driven through Run Command. Nothing reaches the VM from the internet: its NIC has no
// public IP and the subnet's NSG has only Azure's default rules. Inside the virtual network
// port 22 is reachable under the default AllowVnetInBound rule, but there is no login: password
// login is off and the SSH key is discarded at deployment. Anyone with Run Command on the VM can
// act as its identity, so the runner is removed after a run (Remove-Poc.ps1 -Runner).

param vnetName string
param vaultName string
param apimName string

@description('Unused range inside the virtual network, for the runner subnet.')
param runnerSubnetPrefix string = '10.61.4.0/27'

param privateEndpointSubnetName string = 'snet-pe'

@description('The VM requires an SSH key. No inbound port is open; Run Command is used instead.')
param sshPublicKey string

param vmSize string = 'Standard_B2s'
param location string = resourceGroup().location

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' existing = {
  name: vnetName
}

resource peSubnet 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' existing = {
  parent: vnet
  name: privateEndpointSubnetName
}

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: vaultName
}

resource apim 'Microsoft.ApiManagement/service@2024-05-01' existing = {
  name: apimName
}

// --- The vault, privately --------------------------------------------------------------------

resource vaultZone 'Microsoft.Network/privateDnsZones@2020-06-01' = {
  name: 'privatelink.vaultcore.azure.net'
  location: 'global'
}

resource vaultZoneLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = {
  parent: vaultZone
  name: 'link-${vnetName}'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: vnet.id
    }
  }
}

resource vaultEndpoint 'Microsoft.Network/privateEndpoints@2024-05-01' = {
  name: 'pe-${vaultName}'
  location: location
  properties: {
    subnet: {
      id: peSubnet.id
    }
    privateLinkServiceConnections: [
      {
        name: 'vault'
        properties: {
          privateLinkServiceId: vault.id
          groupIds: [
            'vault'
          ]
        }
      }
    ]
  }
}

resource vaultEndpointDns 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = {
  parent: vaultEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'vault'
        properties: {
          privateDnsZoneId: vaultZone.id
        }
      }
    ]
  }
}

// --- The runner's subnet: outbound through a NAT gateway only --------------------------------

resource natIp 'Microsoft.Network/publicIPAddresses@2024-05-01' = {
  name: 'pip-poc-runner-nat'
  location: location
  sku: {
    name: 'Standard'
  }
  properties: {
    publicIPAllocationMethod: 'Static'
  }
}

resource nat 'Microsoft.Network/natGateways@2024-05-01' = {
  name: 'nat-poc-runner'
  location: location
  sku: {
    name: 'Standard'
  }
  properties: {
    publicIpAddresses: [
      {
        id: natIp.id
      }
    ]
  }
}

resource nsg 'Microsoft.Network/networkSecurityGroups@2024-05-01' = {
  name: 'nsg-poc-runner'
  location: location
  properties: {
    securityRules: []
  }
}

resource runnerSubnet 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' = {
  parent: vnet
  name: 'snet-poc-runner'
  properties: {
    addressPrefix: runnerSubnetPrefix
    natGateway: {
      id: nat.id
    }
    networkSecurityGroup: {
      id: nsg.id
    }
    defaultOutboundAccess: false
  }
}

// --- The runner -----------------------------------------------------------------------------

resource nic 'Microsoft.Network/networkInterfaces@2024-05-01' = {
  name: 'nic-poc-runner'
  location: location
  properties: {
    ipConfigurations: [
      {
        name: 'ipconfig1'
        properties: {
          subnet: {
            id: runnerSubnet.id
          }
          privateIPAllocationMethod: 'Dynamic'
        }
      }
    ]
  }
}

resource vm 'Microsoft.Compute/virtualMachines@2024-07-01' = {
  name: 'vm-poc-runner'
  location: location
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    hardwareProfile: {
      vmSize: vmSize
    }
    osProfile: {
      computerName: 'poc-runner'
      adminUsername: 'pocadmin'
      linuxConfiguration: {
        disablePasswordAuthentication: true
        ssh: {
          publicKeys: [
            {
              path: '/home/pocadmin/.ssh/authorized_keys'
              keyData: sshPublicKey
            }
          ]
        }
      }
    }
    securityProfile: {
      securityType: 'TrustedLaunch'
      uefiSettings: {
        secureBootEnabled: true
        vTpmEnabled: true
      }
    }
    storageProfile: {
      imageReference: {
        publisher: 'Canonical'
        offer: 'ubuntu-24_04-lts'
        sku: 'server'
        version: 'latest'
      }
      osDisk: {
        createOption: 'FromImage'
        deleteOption: 'Delete'
        managedDisk: {
          storageAccountType: 'StandardSSD_LRS'
        }
      }
    }
    networkProfile: {
      networkInterfaces: [
        {
          id: nic.id
          properties: {
            deleteOption: 'Delete'
          }
        }
      ]
    }
  }
}

// The runner reads and writes keys in the vault, and creates, regenerates and lists keys on the
// instance. API Management Service Contributor is broader than that; a production job would use
// a custom role with only the subscription actions it calls.
var keyVaultSecretsOfficer = 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'
var apiManagementServiceContributor = '312a565d-c81f-4fd8-895a-4e21e48d571c'

resource runnerVaultRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, vm.id, keyVaultSecretsOfficer)
  scope: vault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsOfficer)
    principalId: vm.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource runnerApimRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(apim.id, vm.id, apiManagementServiceContributor)
  scope: apim
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', apiManagementServiceContributor)
    principalId: vm.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

output vmName string = vm.name
