import type { DiagramIconKind } from "@aud/types";

const ICON_FILE: Record<DiagramIconKind, string> = {
  subscription: "subscription",
  resourceGroup: "resource-group",
  vnet: "virtual-network",
  subnet: "subnet",
  nsg: "virtual-network",
  nic: "virtual-network",
  vm: "virtual-machine",
  vmss: "virtual-machine",
  aks: "aks",
  containerApp: "app-service",
  appGateway: "app-gateway",
  frontDoor: "app-gateway",
  lb: "load-balancer",
  trafficManager: "load-balancer",
  storage: "storage",
  sql: "sql",
  cosmosDb: "cosmos-db",
  redis: "redis",
  postgres: "sql",
  keyVault: "key-vault",
  appInsights: "app-service",
  logAnalytics: "subscription",
  privateEndpoint: "private-endpoint",
  dns: "virtual-network",
  firewall: "firewall",
  waf: "firewall",
  functionApp: "function-app",
  appService: "app-service",
  serviceBus: "storage",
  eventHub: "storage",
  custom: "custom",
};

export function getAzureIconUrl(kind: DiagramIconKind | string): string {
  const file = ICON_FILE[kind as DiagramIconKind] ?? "custom";
  return `/azure-icons/${file}.svg`;
}
