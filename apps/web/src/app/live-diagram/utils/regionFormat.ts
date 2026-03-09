/** Azure region code → display name (Resource Graph returns lowercase codes e.g. "eastus") */
export function formatAzureRegion(loc: string): string {
  const MAP: Record<string, string> = {
    eastus: "East US", eastus2: "East US 2",
    westus: "West US", westus2: "West US 2", westus3: "West US 3",
    centralus: "Central US",
    northcentralus: "North Central US", southcentralus: "South Central US",
    canadacentral: "Canada Central", canadaeast: "Canada East",
    brazilsouth: "Brazil South",
    northeurope: "North Europe", westeurope: "West Europe",
    uksouth: "UK South", ukwest: "UK West",
    francecentral: "France Central", francesouth: "France South",
    germanywestcentral: "Germany West Central",
    norwayeast: "Norway East", swedencentral: "Sweden Central",
    switzerlandnorth: "Switzerland North",
    eastasia: "East Asia", southeastasia: "Southeast Asia",
    japaneast: "Japan East", japanwest: "Japan West",
    australiaeast: "Australia East", australiasoutheast: "Australia Southeast",
    centralindia: "Central India", southindia: "South India",
    koreacentral: "Korea Central", koreasouth: "Korea South",
    southafricanorth: "South Africa North",
    uaenorth: "UAE North",
  };
  return MAP[loc.toLowerCase()] ?? loc;
}
