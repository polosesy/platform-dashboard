// Relationship registry — every edge the graph builder derives cites a row of
// docs/architecture/azure-resource-relationships.md (the catalog, sourced from Microsoft documentation).
// A new derived relationship = a catalog row first, then an entry here, then the code (relEdge).
// apps/api/test/relationshipCatalog.test.ts checks that every id here is a catalog row, that the graph builder
// creates edges only through relEdge, and that each `spec` (the ARM type + property path that SETS the relationship —
// the authoritative side) exists in docs/architecture/relationships/catalog.json, extracted from the Azure REST API
// specs (scripts/relationships). Rows without `spec` are containment by ARM id, a name (nodeResourceGroup) or a rule.
import type { ArchitectureEdge, EdgeKind } from "@aud/types";

export const REL = {
  // §0 Hierarchy
  "HIER-01": { kind: "contains", what: "subscription ⊃ resource group" },
  "HIER-02": { kind: "contains", what: "resource group ⊃ resource" },
  // §1 Containment and placement
  "CT-01": { kind: "contains", what: "VNet ⊃ subnet" },
  "CT-02": { kind: "attached-to", what: "subnet ← NIC ip configuration", spec: { type: "microsoft.network/networkinterfaces", path: "ipConfigurations[].subnet" } },
  "CT-03": { kind: "bound-to", what: "NIC → VM (networkProfile.networkInterfaces)", spec: { type: "microsoft.compute/virtualmachines", path: "networkProfile.networkInterfaces[]" } },
  "CT-04": { kind: "connects", what: "subnet ← Application Gateway (gatewayIPConfigurations)", spec: { type: "microsoft.network/applicationgateways", path: "gatewayIPConfigurations[].subnet" } },
  "CT-05": { kind: "connects", what: "subnet ← Load Balancer private frontend", spec: { type: "microsoft.network/loadbalancers", path: "frontendIPConfigurations[].subnet" } },
  "CT-06": { kind: "network", what: "subnet ← Private Endpoint", spec: { type: "microsoft.network/privateendpoints", path: "subnet" } },
  "CT-07": { kind: "connects", what: "dedicated subnet ← VPN/ER gateway · Bastion (ipConfigurations[].subnet)", spec: { type: "microsoft.network/virtualnetworkgateways", path: "ipConfigurations[].subnet" } },
  "CT-09": { kind: "network", what: "subnet ← resource (property scan fallback)" },
  // §2 Security
  "SEC-01": { kind: "network", what: "NSG → subnet / NIC", spec: { type: "microsoft.network/networkinterfaces", path: "networkSecurityGroup" } },
  // §3 Public IP
  "PIP-02": { kind: "network", what: "NAT gateway → public IP", spec: { type: "microsoft.network/natgateways", path: "publicIpAddresses[]" } },
  // §4 Load Balancer
  "LB-02": { kind: "routes", what: "LB backend pool → NIC ip configuration (or the Uniform VMSS behind it)", spec: { type: "microsoft.network/networkinterfaces", path: "ipConfigurations[].loadBalancerBackendAddressPools[]" } },
  "LB-03": { kind: "routes", what: "LB backend pool → IP address in a VNet (current holder)", spec: { type: "microsoft.network/loadbalancers", path: "backendAddressPools[].loadBalancerBackendAddresses[].virtualNetwork" } },
  "LB-06": { kind: "routes", what: "backend → LB outbound rule (SNAT, NIC-based pools)", spec: { type: "microsoft.network/loadbalancers", path: "outboundRules[].backendAddressPool" } },
  // §5 Application Gateway
  "AGW-03": { kind: "routes", what: "AGW backend pool → NIC ip configuration", spec: { type: "microsoft.network/networkinterfaces", path: "ipConfigurations[].applicationGatewayBackendAddressPools[]" } },
  "AGW-04": { kind: "routes", what: "AGW backend pool → IP address (current holder)" },
  "AGW-05": { kind: "routes", what: "AGW backend pool → FQDN (App Service / Container App host name)" },
  // §5a Application Gateway for Containers
  "AGC-01": { kind: "connects", what: "delegated subnet ← AGC association", spec: { type: "microsoft.servicenetworking/trafficcontrollers/associations", path: "subnet" } },
  "AGC-04": { kind: "routes", what: "AGC → AKS cluster (node resource group, or the only cluster in the association VNet)" },
  // §6 VMSS
  "VMSS-02": { kind: "network", what: "subnet ← VMSS model NIC configuration", spec: { type: "microsoft.compute/virtualmachinescalesets", path: "virtualMachineProfile.networkProfile.networkInterfaceConfigurations[].ipConfigurations[].subnet" } },
  "VMSS-03": { kind: "member-of", what: "Flexible-mode VM → its scale set (properties.virtualMachineScaleSet)", spec: { type: "microsoft.compute/virtualmachines", path: "virtualMachineScaleSet" } },
  "VMSS-04": { kind: "routes", what: "LB / AGW pool ← VMSS model reference (Uniform)", spec: { type: "microsoft.compute/virtualmachinescalesets", path: "virtualMachineProfile.networkProfile.networkInterfaceConfigurations[].ipConfigurations[].loadBalancerBackendAddressPools[]" } },
  // §7 AKS
  "AKS-01": { kind: "connects", what: "subnet ← AKS agent pool (vnetSubnetID)", spec: { type: "microsoft.containerservice/managedclusters", path: "agentPoolProfiles[].vnetSubnetID" } },
  "AKS-02": { kind: "connects", what: "AKS → node-pool VMSS (node resource group)" },
  // §8 Edge and transit
  "EDGE-01": { kind: "network", what: "subnet → NAT gateway", spec: { type: "microsoft.network/virtualnetworks/subnets", path: "natGateway" } },
  "EDGE-02": { kind: "peering", what: "VNet ↔ VNet peering", spec: { type: "microsoft.network/virtualnetworks", path: "virtualNetworkPeerings[].remoteVirtualNetwork" } },
  "EDGE-04": { kind: "routes", what: "Front Door origin → resource by host name (exactly one holder)" },
  "EDGE-05": { kind: "routes", what: "Front Door origin → owner of the public IP the origin names" },
  "EDGE-06": { kind: "routes", what: "Front Door origin → Azure resource it was picked from", spec: { type: "microsoft.cdn/profiles/origingroups/origins", path: "azureOrigin" } },
  "EDGE-07": { kind: "privateLink", what: "Front Door Premium origin → Private Link target", spec: { type: "microsoft.cdn/profiles/origingroups/origins", path: "sharedPrivateLinkResource.privateLink" } },
  // §9 Private Link
  "PL-01": { kind: "privateLink", what: "Private Endpoint → target resource", spec: { type: "microsoft.network/privateendpoints", path: "privateLinkServiceConnections[].privateLinkServiceId" } },
  // §10 PaaS network modes, logging
  "PAAS-01": { kind: "network", what: "App Service / Functions → integration subnet (outbound only)", spec: { type: "microsoft.web/sites", path: "virtualNetworkSubnetId" } },
  "PAAS-02": { kind: "network", what: "subnet (delegated) ← PostgreSQL / MySQL Flexible Server, private access", spec: { type: "microsoft.dbforpostgresql/flexibleservers", path: "network.delegatedSubnetResourceId" } },
  "PAAS-04": { kind: "network", what: "subnet ← Azure Cache for Redis (VNet injection, Premium)", spec: { type: "microsoft.cache/redis", path: "subnetId" } },
  "LOG-01": { kind: "logging", what: "diagnostic setting → Log Analytics / Storage", spec: { type: "microsoft.insights/diagnosticsettings", path: "workspaceId" } },
  "LOG-02": { kind: "logging", what: "Application Insights → Log Analytics workspace", spec: { type: "microsoft.insights/components", path: "WorkspaceResourceId" } },
} as const satisfies Record<string, { kind: EdgeKind; what: string; spec?: { type: string; path: string } }>;

export type RelId = keyof typeof REL;

/** An edge for a catalog relationship: kind from the registry, `metadata.rel` = the catalog row */
export function relEdge(
  rel: RelId,
  id: string,
  source: string,
  target: string,
  metadata?: Omit<NonNullable<ArchitectureEdge["metadata"]>, "rel">,
): ArchitectureEdge {
  return { id, source, target, kind: REL[rel].kind, metadata: { ...(metadata ?? {}), rel } };
}
