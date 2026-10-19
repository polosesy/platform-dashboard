// Azure resource types as people see them: the portal service name (i18n `aztype.<lower-case type>` in
// i18nAzureTypes.ts — a curated table, the Azure portal's own names in en-US / ko-KR; Microsoft publishes no API for
// them) and the canonical ARM spelling (from the ARM providers API, which gives casing but no display name).
// A type outside the table falls back to typeLabel ("<namespace> · <type>"). Tested from apps/api/test/azureTypes.test.ts.
import { typeLabel } from "./healthHeatmap";

/** lower-case ARM type → canonical spelling */
export const AZ_TYPES: Record<string, string> = {
  "microsoft.compute/virtualmachines": "Microsoft.Compute/virtualMachines",
  "microsoft.compute/virtualmachinescalesets": "Microsoft.Compute/virtualMachineScaleSets",
  "microsoft.compute/disks": "Microsoft.Compute/disks",
  "microsoft.compute/snapshots": "Microsoft.Compute/snapshots",
  "microsoft.compute/sshpublickeys": "Microsoft.Compute/sshPublicKeys",
  "microsoft.compute/virtualmachines/extensions": "Microsoft.Compute/virtualMachines/extensions",
  "microsoft.compute/galleries/images/versions": "Microsoft.Compute/galleries/images/versions",
  "microsoft.network/loadbalancers": "Microsoft.Network/loadBalancers",
  "microsoft.network/applicationgateways": "Microsoft.Network/applicationGateways",
  "microsoft.network/natgateways": "Microsoft.Network/natGateways",
  "microsoft.network/virtualnetworkgateways": "Microsoft.Network/virtualNetworkGateways",
  "microsoft.network/connections": "Microsoft.Network/connections",
  "microsoft.network/bastionhosts": "Microsoft.Network/bastionHosts",
  "microsoft.network/dnszones": "Microsoft.Network/dnszones",
  "microsoft.network/privatednszones": "Microsoft.Network/privateDnsZones",
  "microsoft.network/privatednszones/virtualnetworklinks": "Microsoft.Network/privateDnsZones/virtualNetworkLinks",
  "microsoft.network/networkinterfaces": "Microsoft.Network/networkInterfaces",
  "microsoft.network/networksecuritygroups": "Microsoft.Network/networkSecurityGroups",
  "microsoft.network/publicipaddresses": "Microsoft.Network/publicIPAddresses",
  "microsoft.network/virtualnetworks": "Microsoft.Network/virtualNetworks",
  "microsoft.network/privateendpoints": "Microsoft.Network/privateEndpoints",
  "microsoft.network/networkwatchers": "Microsoft.Network/networkWatchers",
  "microsoft.network/routetables": "Microsoft.Network/routeTables",
  "microsoft.network/azurefirewalls": "Microsoft.Network/azureFirewalls",
  "microsoft.network/frontdoors": "Microsoft.Network/frontDoors",
  "microsoft.network/trafficmanagerprofiles": "Microsoft.Network/trafficManagerProfiles",
  "microsoft.cdn/profiles": "Microsoft.Cdn/profiles",
  "microsoft.cdn/profiles/afdendpoints": "Microsoft.Cdn/profiles/afdEndpoints",
  "microsoft.operationalinsights/workspaces": "Microsoft.OperationalInsights/workspaces",
  "microsoft.recoveryservices/vaults": "Microsoft.RecoveryServices/vaults",
  "microsoft.dataprotection/backupvaults": "Microsoft.DataProtection/backupVaults",
  "microsoft.insights/metricalerts": "Microsoft.Insights/metricAlerts",
  "microsoft.insights/scheduledqueryrules": "Microsoft.Insights/scheduledQueryRules",
  "microsoft.insights/activitylogalerts": "Microsoft.Insights/activityLogAlerts",
  "microsoft.insights/actiongroups": "Microsoft.Insights/actionGroups",
  "microsoft.insights/components": "Microsoft.Insights/components",
  "microsoft.insights/datacollectionrules": "Microsoft.Insights/dataCollectionRules",
  "microsoft.insights/datacollectionendpoints": "Microsoft.Insights/dataCollectionEndpoints",
  "microsoft.alertsmanagement/prometheusrulegroups": "Microsoft.AlertsManagement/prometheusRuleGroups",
  "microsoft.alertsmanagement/smartdetectoralertrules": "Microsoft.AlertsManagement/smartDetectorAlertRules",
  "microsoft.monitor/accounts": "Microsoft.Monitor/accounts",
  "microsoft.dashboard/grafana": "Microsoft.Dashboard/grafana",
  "microsoft.storage/storageaccounts": "Microsoft.Storage/storageAccounts",
  "microsoft.keyvault/vaults": "Microsoft.KeyVault/vaults",
  "microsoft.cache/redis": "Microsoft.Cache/Redis",
  "microsoft.cache/redisenterprise": "Microsoft.Cache/redisEnterprise",
  "microsoft.cognitiveservices/accounts": "Microsoft.CognitiveServices/accounts",
  "microsoft.dbforpostgresql/flexibleservers": "Microsoft.DBforPostgreSQL/flexibleServers",
  "microsoft.dbformysql/flexibleservers": "Microsoft.DBforMySQL/flexibleServers",
  "microsoft.sql/servers": "Microsoft.Sql/servers",
  "microsoft.sql/servers/databases": "Microsoft.Sql/servers/databases",
  "microsoft.documentdb/databaseaccounts": "Microsoft.DocumentDB/databaseAccounts",
  "microsoft.web/serverfarms": "Microsoft.Web/serverFarms",
  "microsoft.web/sites": "Microsoft.Web/sites",
  "microsoft.web/connections": "Microsoft.Web/connections",
  "microsoft.containerservice/managedclusters": "Microsoft.ContainerService/managedClusters",
  "microsoft.containerregistry/registries": "Microsoft.ContainerRegistry/registries",
  "microsoft.app/containerapps": "Microsoft.App/containerApps",
  "microsoft.app/managedenvironments": "Microsoft.App/managedEnvironments",
  "microsoft.eventhub/namespaces": "Microsoft.EventHub/namespaces",
  "microsoft.servicebus/namespaces": "Microsoft.ServiceBus/namespaces",
  "microsoft.managedidentity/userassignedidentities": "Microsoft.ManagedIdentity/userAssignedIdentities",
  "microsoft.apimanagement/service": "Microsoft.ApiManagement/service",
};

/** i18n key of the portal name, or null when the table does not have the type */
export const typeNameKey = (type: string): string | null => {
  const k = (type ?? "").toLowerCase();
  return k in AZ_TYPES ? `aztype.${k}` : null;
};

/** The ARM type as Azure spells it ("Microsoft.Compute/virtualMachines"), else the fallback label */
export const armType = (type: string): string => AZ_TYPES[(type ?? "").toLowerCase()] ?? typeLabel(type);

/** Portal name in the current language, else the fallback label */
export const typeName = (type: string, t: (key: string) => string): string => {
  const key = typeNameKey(type);
  return key ? t(key) : typeLabel(type);
};
