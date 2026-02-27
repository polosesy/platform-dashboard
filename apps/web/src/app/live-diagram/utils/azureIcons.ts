import type { DiagramIconKind } from "@aud/types";

const ICON_FILE: Record<DiagramIconKind, string> = {
  subscription: "subscription",
  resourceGroup: "resource-group",
  vnet: "virtual-network",
  subnet: "subnet",
  nsg: "nsg",
  nic: "virtual-network",
  vm: "virtual-machine",
  vmss: "vm-scale-sets",
  aks: "aks",
  containerApp: "container-app",
  appGateway: "app-gateway",
  frontDoor: "front-door",
  lb: "load-balancer",
  trafficManager: "traffic-manager",
  storage: "storage",
  sql: "sql",
  cosmosDb: "cosmos-db",
  redis: "redis",
  postgres: "postgres",
  keyVault: "key-vault",
  appInsights: "app-insights",
  logAnalytics: "log-analytics",
  privateEndpoint: "private-endpoint",
  dns: "dns",
  firewall: "firewall",
  waf: "waf",
  functionApp: "function-app",
  appService: "app-service",
  serviceBus: "service-bus",
  eventHub: "event-hub",
  custom: "custom",
};

export function getAzureIconUrl(kind: DiagramIconKind | string): string {
  const file = ICON_FILE[kind as DiagramIconKind] ?? "custom";
  return `/azure-icons/${file}.svg`;
}
