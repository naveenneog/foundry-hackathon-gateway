// Reader on a Foundry account in another resource group (P63, ADR-0021, UNKNOWNS U60). A role
// assignment can only target a resource in its own deployment's scope, so liteAPIM's templates
// deploy this module into the Foundry's resource group. The name is the one the same-group
// assignment uses, guid(foundry.id, <app id>, Reader), so either path yields one assignment.

@description('Existing Foundry (AIServices) account in this resource group.')
param foundryAccountName string

@description('Object id of liteAPIM\'s system-assigned identity.')
param principalId string

@description('Resource id of the app that holds that identity; seeds the assignment name.')
param principalResourceId string

var reader = 'acdd72a7-3385-48ef-bd42-f606fba81ae7'

resource foundry 'Microsoft.CognitiveServices/accounts@2024-10-01' existing = {
  name: foundryAccountName
}

resource foundryReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: foundry
  name: guid(foundry.id, principalResourceId, reader)
  properties: {
    principalId: principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', reader)
  }
}
