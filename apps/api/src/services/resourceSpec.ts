// A resource's specification for the detail panel's "사양" section — SKU / tier / size, version, capacity, high
// availability and the access settings that matter when reading the diagram. Pure: from the Resource Graph row the
// graph already reads (sku, kind, properties); nothing is fetched. Tested from apps/api/test/resourceSpec.test.ts.
// Keys are i18n words on the web (`ld.spec.<k>`); values are Azure's own (SKU names, versions — not translated),
// booleans become yes / no there. A property Azure did not report is left out — never guessed.

export type SpecFact = { k: string; v: string | number | boolean };
type Row = { sku?: unknown; kind?: string; properties?: unknown };

/** Value at a dotted path ("networkProfile.networkPlugin"); undefined when any step is missing */
function at(o: unknown, path: string): unknown {
  let cur = o;
  for (const p of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const bool = (v: unknown) => (typeof v === "boolean" ? v : undefined);
/** "Enabled" / "Disabled" → boolean (other strings kept as they are) */
const onOff = (v: unknown): boolean | string | undefined => {
  const s = str(v);
  if (!s) return bool(v);
  return /^enabled$/i.test(s) ? true : /^disabled$/i.test(s) ? false : s;
};
const last = (id: unknown) => str(id)?.split("/").pop();

/** Facts in display order; undefined values dropped */
function facts(list: Array<[string, string | number | boolean | undefined]>): SpecFact[] {
  return list.filter((x): x is [string, string | number | boolean] => x[1] !== undefined && x[1] !== "").map(([k, v]) => ({ k, v }));
}

export function resourceSpec(armType: string, row: Row): SpecFact[] {
  const t = armType.toLowerCase();
  const p = row.properties ?? {};
  const sku = row.sku;
  const skuName = str(at(sku, "name"));
  const skuTier = str(at(sku, "tier"));
  const skuCap = num(at(sku, "capacity"));
  switch (t) {
    case "microsoft.compute/virtualmachines":
      return facts([
        ["size", str(at(p, "hardwareProfile.vmSize"))],
        ["os", str(at(p, "storageProfile.osDisk.osType"))],
        ["image", [str(at(p, "storageProfile.imageReference.offer")), str(at(p, "storageProfile.imageReference.sku"))].filter(Boolean).join(" ") || undefined],
        ["osDiskGb", num(at(p, "storageProfile.osDisk.diskSizeGB"))],
        ["dataDisks", (at(p, "storageProfile.dataDisks") as unknown[] | undefined)?.length || undefined],
        ["priority", str(at(p, "priority"))],
      ]);
    case "microsoft.compute/virtualmachinescalesets":
      return facts([
        ["size", skuName], ["instances", skuCap], ["orchestration", str(at(p, "orchestrationMode"))],
        ["upgradePolicy", str(at(p, "upgradePolicy.mode"))], ["priority", str(at(p, "virtualMachineProfile.priority"))],
      ]);
    case "microsoft.containerservice/managedclusters": {
      const pools = (at(p, "agentPoolProfiles") as Array<Record<string, unknown>> | undefined) ?? [];
      return facts([
        ["kubernetesVersion", str(at(p, "currentKubernetesVersion")) ?? str(at(p, "kubernetesVersion"))],
        ["tier", skuTier],
        ["pools", pools.length || undefined],
        ["nodes", pools.reduce((n, x) => n + (num(x.count) ?? 0), 0) || undefined],
        ["nodeSizes", [...new Set(pools.map((x) => str(x.vmSize)).filter(Boolean))].join(", ") || undefined],
        ["networkPlugin", [str(at(p, "networkProfile.networkPlugin")), str(at(p, "networkProfile.networkPluginMode"))].filter(Boolean).join(" ") || undefined],
        ["dataplane", str(at(p, "networkProfile.networkDataplane"))],
        ["networkPolicy", str(at(p, "networkProfile.networkPolicy"))],
        ["outboundType", str(at(p, "networkProfile.outboundType"))],
        ["privateCluster", bool(at(p, "apiServerAccessProfile.enablePrivateCluster")) ?? false],
        ["entra", at(p, "aadProfile.managed") === true],
        ["azureRbac", bool(at(p, "aadProfile.enableAzureRBAC"))],
        ["localAccounts", (() => { const d = bool(at(p, "disableLocalAccounts")); return d == null ? undefined : !d; })()],
      ]);
    }
    case "microsoft.dbforpostgresql/flexibleservers":
    case "microsoft.dbformysql/flexibleservers":
      return facts([
        ["sku", skuName], ["tier", skuTier], ["version", str(at(p, "version"))],
        ["storageGb", num(at(p, "storage.storageSizeGB"))],
        ["autoGrow", onOff(at(p, "storage.autoGrow"))],
        ["ha", str(at(p, "highAvailability.mode"))],
        ["backupDays", num(at(p, "backup.backupRetentionDays"))],
        ["geoBackup", onOff(at(p, "backup.geoRedundantBackup"))],
        ["publicAccess", onOff(at(p, "network.publicNetworkAccess"))],
        ["delegatedSubnet", last(at(p, "network.delegatedSubnetResourceId"))],
        ["entraAuth", onOff(at(p, "authConfig.activeDirectoryAuth"))],
      ]);
    case "microsoft.dbforpostgresql/servers":
      return facts([["sku", skuName], ["tier", skuTier], ["version", str(at(p, "version"))], ["storageGb", (() => { const mb = num(at(p, "storageProfile.storageMB")); return mb == null ? undefined : Math.round(mb / 1024); })()], ["publicAccess", onOff(at(p, "publicNetworkAccess"))], ["sslEnforcement", onOff(at(p, "sslEnforcement"))]]);
    case "microsoft.sql/servers":
      return facts([["version", str(at(p, "version"))], ["publicAccess", onOff(at(p, "publicNetworkAccess"))], ["minTls", str(at(p, "minimalTlsVersion"))], ["entraOnly", bool(at(p, "administrators.azureADOnlyAuthentication"))]]);
    case "microsoft.documentdb/databaseaccounts": {
      const caps = ((at(p, "capabilities") as Array<{ name?: string }> | undefined) ?? []).map((c) => c.name);
      return facts([
        ["api", str(row.kind)], ["consistency", str(at(p, "consistencyPolicy.defaultConsistencyLevel"))],
        ["regions", (at(p, "locations") as unknown[] | undefined)?.length || undefined],
        ["serverless", caps.includes("EnableServerless") || undefined],
        ["autoFailover", bool(at(p, "enableAutomaticFailover"))], ["multiWrite", bool(at(p, "enableMultipleWriteLocations"))],
        ["backup", str(at(p, "backupPolicy.type"))], ["publicAccess", onOff(at(p, "publicNetworkAccess"))],
      ]);
    }
    case "microsoft.documentdb/mongoclusters":
      return facts([
        ["version", str(at(p, "serverVersion"))], ["tier", str(at(p, "compute.tier")) ?? str(at(p, "nodeGroupSpecs.0.sku"))],
        ["storageGb", num(at(p, "storage.sizeGb")) ?? num(at(p, "nodeGroupSpecs.0.diskSizeGB"))],
        ["ha", str(at(p, "highAvailability.targetMode")) ?? (bool(at(p, "nodeGroupSpecs.0.enableHa")) === undefined ? undefined : String(at(p, "nodeGroupSpecs.0.enableHa")))],
        ["shards", num(at(p, "sharding.shardCount")) ?? num(at(p, "nodeGroupSpecs.0.nodeCount"))],
        ["publicAccess", onOff(at(p, "publicNetworkAccess"))],
      ]);
    case "microsoft.cache/redis":
      return facts([
        ["sku", [str(at(p, "sku.name")), str(at(p, "sku.family")) && num(at(p, "sku.capacity")) != null ? `${at(p, "sku.family")}${at(p, "sku.capacity")}` : undefined].filter(Boolean).join(" ") || undefined],
        ["version", str(at(p, "redisVersion"))], ["shards", num(at(p, "shardCount"))], ["replicas", num(at(p, "replicasPerMaster"))],
        ["nonSslPort", bool(at(p, "enableNonSslPort"))], ["minTls", str(at(p, "minimumTlsVersion"))], ["publicAccess", onOff(at(p, "publicNetworkAccess"))],
      ]);
    case "microsoft.cache/redisenterprise":
      return facts([["sku", skuName], ["capacity", skuCap], ["minTls", str(at(p, "minimumTlsVersion"))]]);
    case "microsoft.storage/storageaccounts":
      return facts([
        ["sku", skuName], ["kind", str(row.kind)], ["accessTier", str(at(p, "accessTier"))], ["hns", bool(at(p, "isHnsEnabled"))],
        ["blobPublicAccess", bool(at(p, "allowBlobPublicAccess"))], ["sharedKey", bool(at(p, "allowSharedKeyAccess"))],
        ["minTls", str(at(p, "minimumTlsVersion"))], ["publicAccess", onOff(at(p, "publicNetworkAccess"))],
      ]);
    case "microsoft.keyvault/vaults":
      return facts([
        ["sku", str(at(p, "sku.name"))], ["rbac", bool(at(p, "enableRbacAuthorization"))], ["purgeProtection", bool(at(p, "enablePurgeProtection")) ?? false],
        ["softDeleteDays", num(at(p, "softDeleteRetentionInDays"))], ["publicAccess", onOff(at(p, "publicNetworkAccess"))],
      ]);
    case "microsoft.web/sites":
      return facts([
        ["kind", str(row.kind)], ["plan", last(at(p, "serverFarmId"))], ["state", str(at(p, "state"))],
        ["httpsOnly", bool(at(p, "httpsOnly"))], ["publicAccess", onOff(at(p, "publicNetworkAccess"))], ["vnetIntegration", last(at(p, "virtualNetworkSubnetId"))],
      ]);
    case "microsoft.app/containerapps":
      return facts([
        ["environment", last(at(p, "managedEnvironmentId")) ?? last(at(p, "environmentId"))], ["workloadProfile", str(at(p, "workloadProfileName"))],
        ["ingress", at(p, "configuration.ingress") ? (at(p, "configuration.ingress.external") === true ? "external" : "internal") : undefined],
        ["revisionMode", str(at(p, "configuration.activeRevisionsMode"))],
        ["replicas", [num(at(p, "template.scale.minReplicas")), num(at(p, "template.scale.maxReplicas"))].every((x) => x != null) ? `${at(p, "template.scale.minReplicas")}–${at(p, "template.scale.maxReplicas")}` : undefined],
      ]);
    case "microsoft.servicebus/namespaces":
    case "microsoft.eventhub/namespaces":
      return facts([
        ["sku", skuName], ["tier", skuTier !== skuName ? skuTier : undefined], ["capacity", skuCap], ["kafka", bool(at(p, "kafkaEnabled"))],
        ["zoneRedundant", bool(at(p, "zoneRedundant"))], ["autoInflate", bool(at(p, "isAutoInflateEnabled"))], ["minTls", str(at(p, "minimumTlsVersion"))],
        ["publicAccess", onOff(at(p, "publicNetworkAccess"))],
      ]);
    case "microsoft.containerregistry/registries":
      return facts([["sku", skuName], ["adminUser", bool(at(p, "adminUserEnabled"))], ["anonymousPull", bool(at(p, "anonymousPullEnabled"))], ["zoneRedundant", onOff(at(p, "zoneRedundancy"))], ["publicAccess", onOff(at(p, "publicNetworkAccess"))]]);
    case "microsoft.cognitiveservices/accounts":
      return facts([["kind", str(row.kind)], ["sku", skuName], ["localAuth", (() => { const d = bool(at(p, "disableLocalAuth")); return d == null ? undefined : !d; })()], ["publicAccess", onOff(at(p, "publicNetworkAccess"))]]);
    case "microsoft.network/applicationgateways":
      return facts([
        ["sku", str(at(p, "sku.name"))], ["tier", str(at(p, "sku.tier"))], ["capacity", num(at(p, "sku.capacity"))],
        ["autoscale", at(p, "autoscaleConfiguration") ? `${num(at(p, "autoscaleConfiguration.minCapacity")) ?? 0}–${num(at(p, "autoscaleConfiguration.maxCapacity")) ?? "∞"}` : undefined],
        ["http2", bool(at(p, "enableHttp2"))],
      ]);
    case "microsoft.network/loadbalancers":
      return facts([["sku", skuName], ["tier", skuTier]]);
    case "microsoft.network/publicipaddresses":
      return facts([["sku", skuName], ["tier", skuTier], ["allocation", str(at(p, "publicIPAllocationMethod"))], ["ipVersion", str(at(p, "publicIPAddressVersion"))], ["idleTimeout", num(at(p, "idleTimeoutInMinutes"))]]);
    case "microsoft.network/natgateways":
      return facts([["sku", skuName], ["idleTimeout", num(at(p, "idleTimeoutInMinutes"))], ["publicIps", (at(p, "publicIpAddresses") as unknown[] | undefined)?.length]]);
    case "microsoft.network/virtualnetworkgateways":
      return facts([["gatewayType", str(at(p, "gatewayType"))], ["sku", str(at(p, "sku.name"))], ["vpnType", str(at(p, "vpnType"))], ["generation", str(at(p, "vpnGatewayGeneration"))], ["activeActive", bool(at(p, "activeActive"))], ["bgp", bool(at(p, "enableBgp"))]]);
    case "microsoft.network/azurefirewalls":
      return facts([["tier", str(at(p, "sku.tier"))], ["threatIntel", str(at(p, "threatIntelMode"))], ["policy", last(at(p, "firewallPolicy.id"))]]);
    case "microsoft.network/bastionhosts":
      return facts([["sku", skuName], ["scaleUnits", num(at(p, "scaleUnits"))], ["tunneling", bool(at(p, "enableTunneling"))]]);
    case "microsoft.cdn/profiles":
    case "microsoft.network/frontdoors":
      return facts([["sku", skuName]]);
    case "microsoft.operationalinsights/workspaces":
      return facts([["sku", str(at(p, "sku.name"))], ["retentionDays", num(at(p, "retentionInDays"))], ["dailyCapGb", (() => { const q = num(at(p, "workspaceCapping.dailyQuotaGb")); return q == null || q < 0 ? undefined : q; })()]]);
    case "microsoft.insights/components":
      return facts([["kind", str(row.kind)], ["retentionDays", num(at(p, "RetentionInDays"))], ["workspace", last(at(p, "WorkspaceResourceId"))]]);
    case "microsoft.network/virtualnetworks":
      return facts([["ddos", bool(at(p, "enableDdosProtection"))], ["encryption", bool(at(p, "encryption.enabled"))]]);
    default:
      return facts([["sku", skuName], ["tier", skuTier], ["capacity", skuCap]]);
  }
}

/** For the spec (string metadata): at most 16 facts */
export const specJson = (s: SpecFact[]) => JSON.stringify(s.slice(0, 16));
