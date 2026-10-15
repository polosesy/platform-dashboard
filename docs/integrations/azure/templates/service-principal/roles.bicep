// Read-only roles for the platform's Azure connection on one subscription (docs/integrations/azure/permissions.md).
// Deploy in the CUSTOMER tenant at subscription scope:
//   az deployment sub create --location koreacentral --template-file roles.bicep --parameters principalId=<SP_OBJECT_ID>
targetScope = 'subscription'

@description('Object id of the service principal that reads for the platform (customer SP for mode servicePrincipal)')
param principalId string

@description('Built-in role definition ids — remove what the features you use do not need')
param roleDefinitionIds array = [
  'acdd72a7-3385-48ef-bd42-f606fba81ae7' // Reader
  '43d0d8ad-25c7-4714-9337-8ba259a9fe05' // Monitoring Reader
  '73c42c96-874c-492b-b04d-ab87d138a893' // Log Analytics Reader
  '39bc4728-0917-49c7-9d2c-d95423bc2eb4' // Security Reader
  '72fafb9e-0641-4937-9268-a91bfd8191a3' // Cost Management Reader
]

resource assignments 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for roleId in roleDefinitionIds: {
  name: guid(subscription().id, principalId, roleId)
  properties: {
    principalId: principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleId)
  }
}]
