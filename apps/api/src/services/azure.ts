import { createHash } from "crypto";
import { OnBehalfOfCredential, ClientSecretCredential } from "@azure/identity";
import { ResourceGraphClient } from "@azure/arm-resourcegraph";
import type { Env } from "../env";
import type { ArchitectureEdge, ArchitectureGraph, ArchitectureNode, AzureSubscriptionOption, GraphNodeKind } from "../types";

type AzureResourceRow = {
  id: string;
  name?: string;
  type?: string;
  kind?: string;
  location?: string;
  resourceGroup?: string;
  subscriptionId?: string;
  tags?: Record<string, string>;
  properties?: unknown;
};

type AzureResourceGroupRow = {
  id: string;
  name?: string;
  location?: string;
  subscriptionId?: string;
  tags?: Record<string, string>;
};

type AzureSubscriptionRow = {
  subscriptionId?: string;
  name?: string;
};

let cache:
  | {
      key: string;
      expiresAt: number;
      graph: ArchitectureGraph;
    }
  | undefined;

let subsCache:
  | {
      key: string;
      expiresAt: number;
      subscriptions: AzureSubscriptionOption[];
    }
  | undefined;

/** Clear the in-memory Azure Resource Graph cache. Call before generate to ensure fresh data. */
export function clearGraphCache(): void {
  cache = undefined;
}

function parseSubscriptionIds(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function bearerKey(bearerToken: string): string {
  return createHash("sha256").update(bearerToken).digest("hex").slice(0, 16);
}

type RGClientBundle = { client: ResourceGraphClient; subscriptions: string[]; pageSize: number };

function createOBOClient(env: Env, bearerToken: string): RGClientBundle {
  const tenantId = env.AZURE_AD_TENANT_ID;
  const clientId = env.AZURE_AD_CLIENT_ID;
  const clientSecret = env.AZURE_AD_CLIENT_SECRET;
  const subRaw = env.AZURE_SUBSCRIPTION_IDS;

  if (!tenantId || !clientId || !clientSecret || !subRaw) {
    throw new Error("Azure OBO not configured (AZURE_AD_* and AZURE_SUBSCRIPTION_IDS required)");
  }

  const subscriptions = parseSubscriptionIds(subRaw);
  if (subscriptions.length === 0) {
    throw new Error("AZURE_SUBSCRIPTION_IDS is empty");
  }

  const credential = new OnBehalfOfCredential({
    tenantId,
    clientId,
    clientSecret,
    userAssertionToken: bearerToken,
  });

  return { client: new ResourceGraphClient(credential), subscriptions, pageSize: env.AZURE_RESOURCE_GRAPH_PAGE_SIZE };
}

/** Fallback: use service principal credentials directly (no user token needed). */
function createServicePrincipalClient(env: Env): RGClientBundle {
  const tenantId = env.AZURE_AD_TENANT_ID;
  const clientId = env.AZURE_AD_CLIENT_ID;
  const clientSecret = env.AZURE_AD_CLIENT_SECRET;
  const subRaw = env.AZURE_SUBSCRIPTION_IDS;

  if (!tenantId || !clientId || !clientSecret || !subRaw) {
    throw new Error("Azure SP not configured (AZURE_AD_TENANT_ID, AZURE_AD_CLIENT_ID, AZURE_AD_CLIENT_SECRET, AZURE_SUBSCRIPTION_IDS required)");
  }

  const subscriptions = parseSubscriptionIds(subRaw);
  if (subscriptions.length === 0) {
    throw new Error("AZURE_SUBSCRIPTION_IDS is empty");
  }

  const credential = new ClientSecretCredential(tenantId, clientId, clientSecret);
  return { client: new ResourceGraphClient(credential), subscriptions, pageSize: env.AZURE_RESOURCE_GRAPH_PAGE_SIZE };
}

function mapKind(type: string | undefined, resourceKind?: string): GraphNodeKind {
  const t = (type ?? "").toLowerCase();
  if (t === "microsoft.network/virtualnetworks") return "vnet";
  if (t === "microsoft.network/virtualnetworks/subnets") return "subnet";
  if (t === "microsoft.network/networkinterfaces") return "nic";
  if (t === "microsoft.network/networksecuritygroups") return "nsg";
  if (t === "microsoft.compute/virtualmachines") return "vm";
  if (t === "microsoft.compute/virtualmachinescalesets") return "vmss";
  if (t === "microsoft.network/applicationgateways") return "appGateway";
  if (t === "microsoft.network/loadbalancers") return "lb";
  if (t === "microsoft.network/frontdoors") return "frontDoor";
  if (t === "microsoft.network/trafficmanagerprofiles") return "trafficManager";
  if (t === "microsoft.containerservice/managedclusters") return "aks";
  if (t === "microsoft.app/containerapps") return "containerApp";
  if (t === "microsoft.network/privateendpoints") return "privateEndpoint";
  if (t === "microsoft.storage/storageaccounts") return "storage";
  if (t === "microsoft.sql/servers" || t === "microsoft.sql/servers/databases") return "sql";
  if (t === "microsoft.documentdb/databaseaccounts") return "cosmosDb";
  if (t === "microsoft.cache/redis") return "redis";
  if (t === "microsoft.dbforpostgresql/flexibleservers" || t === "microsoft.dbforpostgresql/servers") return "postgres";
  if (t === "microsoft.keyvault/vaults") return "keyVault";
  if (t === "microsoft.insights/components") return "appInsights";
  if (t === "microsoft.operationalinsights/workspaces") return "logAnalytics";
  if (t === "microsoft.network/azurefirewalls") return "firewall";
  if (t === "microsoft.servicebus/namespaces") return "serviceBus";
  if (t === "microsoft.eventhub/namespaces") return "eventHub";
  if (t === "microsoft.network/dnszones" || t === "microsoft.network/privatednszones") return "dns";
  if (t === "microsoft.network/publicipaddresses") return "publicIP";
  if (t === "microsoft.web/sites") {
    const k = (resourceKind ?? "").toLowerCase();
    return k.includes("functionapp") ? "functionApp" : "appService";
  }
  return "unknown";
}

function rgId(subscriptionId: string, resourceGroup: string): string {
  return `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}`.toLowerCase();
}

function safeString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

/** Like safeString, but also lowercases — for Azure resource IDs which are case-insensitive. */
function safeId(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim().toLowerCase() : undefined;
}

/** Extract the full subnet resource ID from any Azure resource ID containing /subnets/ */
function extractSubnetIdFromResourceId(rid: string): string | undefined {
  const lower = rid.toLowerCase();
  const idx = lower.indexOf("/subnets/");
  if (idx <= 0) return undefined;
  const afterSubnets = lower.slice(idx + "/subnets/".length);
  const subnetName = afterSubnets.split("/")[0];
  if (!subnetName) return undefined;
  return lower.slice(0, idx + "/subnets/".length + subnetName.length);
}

/** Safely traverse nested unknown properties and return a string leaf. */
function safePropString(obj: unknown, ...path: string[]): string | undefined {
  let cur: unknown = obj;
  for (const key of path) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === "string" && cur.trim() ? cur : undefined;
}

/** Safely traverse to an array property. */
function safePropArray(obj: unknown, key: string): unknown[] {
  if (!obj || typeof obj !== "object") return [];
  const val = (obj as Record<string, unknown>)[key];
  return Array.isArray(val) ? val : [];
}

/**
 * Extract a displayable endpoint (IP or FQDN) from resource properties.
 * Returns the most relevant endpoint based on resource type.
 */
function extractEndpoint(type: string | undefined, name: string | undefined, properties: unknown): string | undefined {
  if (!type || !properties || typeof properties !== "object") return undefined;
  const t = type.toLowerCase();
  const p = properties as Record<string, unknown>;

  // VM — extract private IP from NIC configs
  if (t === "microsoft.compute/virtualmachines") {
    const nicProfile = p.networkProfile as { networkInterfaces?: Array<{ properties?: { ipConfigurations?: Array<{ properties?: { privateIPAddress?: string } }> } }> } | undefined;
    const firstIp = nicProfile?.networkInterfaces?.[0]?.properties?.ipConfigurations?.[0]?.properties?.privateIPAddress;
    return safeString(firstIp);
  }

  // NIC — extract private IP
  if (t === "microsoft.network/networkinterfaces") {
    const ipConfigs = (p.ipConfigurations ?? []) as Array<{ properties?: { privateIPAddress?: string } }>;
    return safeString(ipConfigs[0]?.properties?.privateIPAddress);
  }

  // App Service / Function App — defaultHostName
  if (t === "microsoft.web/sites") {
    return safeString(p.defaultHostName);
  }

  // Storage Account — primaryEndpoints.blob or name-based FQDN
  if (t === "microsoft.storage/storageaccounts") {
    const endpoints = p.primaryEndpoints as { blob?: string } | undefined;
    if (endpoints?.blob) return endpoints.blob.replace(/\/$/, "").replace(/^https?:\/\//, "");
    return name ? `${name}.blob.core.windows.net` : undefined;
  }

  // SQL Server — fullyQualifiedDomainName
  if (t === "microsoft.sql/servers") {
    return safeString(p.fullyQualifiedDomainName);
  }

  // CosmosDB — documentEndpoint
  if (t === "microsoft.documentdb/databaseaccounts") {
    const ep = safeString(p.documentEndpoint);
    return ep ? ep.replace(/\/$/, "").replace(/^https?:\/\//, "") : undefined;
  }

  // Redis — hostName
  if (t === "microsoft.cache/redis") {
    return safeString(p.hostName);
  }

  // PostgreSQL — fullyQualifiedDomainName
  if (t.startsWith("microsoft.dbforpostgresql/")) {
    return safeString(p.fullyQualifiedDomainName);
  }

  // Key Vault — vaultUri
  if (t === "microsoft.keyvault/vaults") {
    const uri = safeString(p.vaultUri);
    return uri ? uri.replace(/\/$/, "").replace(/^https?:\/\//, "") : undefined;
  }

  // AKS — fqdn
  if (t === "microsoft.containerservice/managedclusters") {
    return safeString(p.fqdn) ?? safeString(p.privateFQDN);
  }

  // Public IP address — ipAddress
  if (t === "microsoft.network/publicipaddresses") {
    return safeString(p.ipAddress);
  }

  // Container App — configuration.ingress.fqdn or latestRevisionFqdn
  if (t === "microsoft.app/containerapps") {
    const config = p.configuration as { ingress?: { fqdn?: string } } | undefined;
    return safeString(config?.ingress?.fqdn) ?? safeString(p.latestRevisionFqdn);
  }

  // Application Gateway — frontendIPConfigurations private IP or public IP
  if (t === "microsoft.network/applicationgateways") {
    const feConfigs = (p.frontendIPConfigurations ?? []) as Array<{ properties?: { privateIPAddress?: string } }>;
    return safeString(feConfigs[0]?.properties?.privateIPAddress);
  }

  // Load Balancer — frontendIPConfigurations private IP
  if (t === "microsoft.network/loadbalancers") {
    const feConfigs = (p.frontendIPConfigurations ?? []) as Array<{ properties?: { privateIPAddress?: string } }>;
    return safeString(feConfigs[0]?.properties?.privateIPAddress);
  }

  // Firewall — ipConfigurations private IP
  if (t === "microsoft.network/azurefirewalls") {
    const ipConfigs = (p.ipConfigurations ?? []) as Array<{ properties?: { privateIPAddress?: string } }>;
    return safeString(ipConfigs[0]?.properties?.privateIPAddress);
  }

  // Service Bus / Event Hub — serviceBusEndpoint
  if (t === "microsoft.servicebus/namespaces" || t === "microsoft.eventhub/namespaces") {
    const ep = safeString(p.serviceBusEndpoint);
    return ep ? ep.replace(/\/$/, "").replace(/^https?:\/\//, "") : undefined;
  }

  // VNet — addressSpace prefixes
  if (t === "microsoft.network/virtualnetworks") {
    const space = p.addressSpace as { addressPrefixes?: string[] } | undefined;
    return space?.addressPrefixes?.[0];
  }

  // Subnet — addressPrefix
  if (t === "microsoft.network/virtualnetworks/subnets") {
    return safeString(p.addressPrefix);
  }

  return undefined;
}

function getSubnetIdFromNicProps(properties: unknown): string | undefined {
  if (!properties || typeof properties !== "object") return undefined;
  const ipConfigs = (properties as { ipConfigurations?: unknown }).ipConfigurations;
  if (!Array.isArray(ipConfigs)) return undefined;
  for (const c of ipConfigs) {
    if (!c || typeof c !== "object") continue;
    const obj = c as Record<string, unknown>;
    // ARM API format: ipConfigurations[].properties.subnet.id
    const nested = (obj.properties as { subnet?: { id?: unknown } } | undefined)?.subnet?.id;
    const s1 = safeId(nested);
    if (s1) return s1;
    // Resource Graph flattened format: ipConfigurations[].subnet.id
    const flat = (obj.subnet as { id?: unknown } | undefined)?.id;
    const s2 = safeId(flat);
    if (s2) return s2;
  }
  return undefined;
}

function getSubnetIdFromPrivateEndpointProps(properties: unknown): string | undefined {
  if (!properties || typeof properties !== "object") return undefined;
  const subnetId = (properties as { subnet?: { id?: unknown } }).subnet?.id;
  return safeId(subnetId);
}

function getSubnetIdsFromAksProps(properties: unknown): string[] {
  if (!properties || typeof properties !== "object") return [];
  const agentPools = (properties as { agentPoolProfiles?: unknown }).agentPoolProfiles;
  if (!Array.isArray(agentPools)) return [];

  const ids: string[] = [];
  for (const p of agentPools) {
    const subnetId =
      (p as { vnetSubnetId?: unknown; vnetSubnetID?: unknown }).vnetSubnetId ??
      (p as { vnetSubnetID?: unknown }).vnetSubnetID;
    const s = safeId(subnetId);
    if (s) ids.push(s);
  }
  return [...new Set(ids)];
}

function getSubnetIdsFromAppGatewayProps(properties: unknown): string[] {
  if (!properties || typeof properties !== "object") return [];
  const configs = (properties as { gatewayIPConfigurations?: unknown }).gatewayIPConfigurations;
  if (!Array.isArray(configs)) return [];
  const ids = configs
    .map((c) => {
      if (!c || typeof c !== "object") return undefined;
      const obj = c as Record<string, unknown>;
      // ARM API: .properties.subnet.id  |  Resource Graph flattened: .subnet.id
      return safeId((obj.properties as { subnet?: { id?: unknown } } | undefined)?.subnet?.id)
        ?? safeId((obj.subnet as { id?: unknown } | undefined)?.id);
    })
    .filter((x): x is string => Boolean(x));
  return [...new Set(ids)];
}

function getSubnetIdsFromLoadBalancerProps(properties: unknown): string[] {
  if (!properties || typeof properties !== "object") return [];
  const configs = (properties as { frontendIPConfigurations?: unknown }).frontendIPConfigurations;
  if (!Array.isArray(configs)) return [];
  const ids = configs
    .map((c) => {
      if (!c || typeof c !== "object") return undefined;
      const obj = c as Record<string, unknown>;
      return safeId((obj.properties as { subnet?: { id?: unknown } } | undefined)?.subnet?.id)
        ?? safeId((obj.subnet as { id?: unknown } | undefined)?.id);
    })
    .filter((x): x is string => Boolean(x));
  return [...new Set(ids)];
}

function getBackendNicIdsFromLoadBalancerProps(properties: unknown): string[] {
  if (!properties || typeof properties !== "object") return [];
  const pools = (properties as { backendAddressPools?: unknown }).backendAddressPools;
  if (!Array.isArray(pools)) return [];

  const ipConfigs: unknown[] = [];
  for (const p of pools) {
    if (!p || typeof p !== "object") continue;
    const obj = p as Record<string, unknown>;
    // ARM API: .properties.backendIPConfigurations  |  RG flattened: .backendIPConfigurations
    const cfgs = (obj.properties as { backendIPConfigurations?: unknown } | undefined)?.backendIPConfigurations
      ?? obj.backendIPConfigurations;
    if (Array.isArray(cfgs)) ipConfigs.push(...cfgs);
  }

  const nicIds = ipConfigs
    .map((x) => safeId((x as { id?: unknown }).id))
    .filter((x): x is string => Boolean(x))
    .map((id) => {
      const idx = id.indexOf("/ipconfigurations/");
      return idx > 0 ? id.slice(0, idx) : id;
    });
  return [...new Set(nicIds)];
}

function getBackendNicIdsFromAppGatewayProps(properties: unknown): string[] {
  if (!properties || typeof properties !== "object") return [];
  const pools = (properties as { backendAddressPools?: unknown }).backendAddressPools;
  if (!Array.isArray(pools)) return [];

  const ipConfigs: unknown[] = [];
  for (const p of pools) {
    if (!p || typeof p !== "object") continue;
    const obj = p as Record<string, unknown>;
    const cfgs = (obj.properties as { backendIPConfigurations?: unknown } | undefined)?.backendIPConfigurations
      ?? obj.backendIPConfigurations;
    if (Array.isArray(cfgs)) ipConfigs.push(...cfgs);
  }

  const nicIds = ipConfigs
    .map((x) => safeId((x as { id?: unknown }).id))
    .filter((x): x is string => Boolean(x))
    .map((id) => {
      const idx = id.indexOf("/ipconfigurations/");
      return idx > 0 ? id.slice(0, idx) : id;
    });
  return [...new Set(nicIds)];
}

function getPrivateLinkTargetIdsFromPrivateEndpointProps(properties: unknown): string[] {
  if (!properties || typeof properties !== "object") return [];
  const conns = (properties as { privateLinkServiceConnections?: unknown }).privateLinkServiceConnections;
  const manual = (properties as { manualPrivateLinkServiceConnections?: unknown }).manualPrivateLinkServiceConnections;
  const all = [...(Array.isArray(conns) ? conns : []), ...(Array.isArray(manual) ? manual : [])];
  const ids = all
    .map((c) => {
      if (!c || typeof c !== "object") return undefined;
      const obj = c as Record<string, unknown>;
      return safeId((obj.properties as { privateLinkServiceId?: unknown } | undefined)?.privateLinkServiceId)
        ?? safeId(obj.privateLinkServiceId);
    })
    .filter((x): x is string => Boolean(x));
  return [...new Set(ids)];
}

function getNicIdsFromVmProps(properties: unknown): string[] {
  if (!properties || typeof properties !== "object") return [];
  const nis = (properties as { networkProfile?: { networkInterfaces?: unknown } }).networkProfile?.networkInterfaces;
  if (!Array.isArray(nis)) return [];
  const ids = nis
    .map((x) => safeId((x as { id?: unknown }).id))
    .filter((x): x is string => Boolean(x));
  return [...new Set(ids)];
}

/**
 * Generic scanner: check common property paths for subnet ID references.
 * Returns the first matching subnet ID that exists in the graph, or undefined.
 */
function findSubnetReferenceInProps(
  properties: unknown,
  knownSubnetIds: Set<string>,
): string | undefined {
  if (!properties || typeof properties !== "object") return undefined;
  const p = properties as Record<string, unknown>;

  // Direct subnet.id reference (e.g., Private Endpoints, some PaaS)
  const directSubnet = safeId((p.subnet as Record<string, unknown> | undefined)?.id);
  if (directSubnet && knownSubnetIds.has(directSubnet)) return directSubnet;

  // virtualNetworkSubnetId (App Service / Function App VNet integration)
  const vnetSubnetId = safeId(p.virtualNetworkSubnetId);
  if (vnetSubnetId && knownSubnetIds.has(vnetSubnetId)) return vnetSubnetId;

  // ipConfigurations[].properties.subnet.id (NICs, Firewalls, etc.)
  const ipConfigs = Array.isArray(p.ipConfigurations) ? p.ipConfigurations : [];
  for (const cfg of ipConfigs) {
    const subId = safeId(
      (cfg as { properties?: { subnet?: { id?: unknown } } })?.properties?.subnet?.id,
    );
    if (subId && knownSubnetIds.has(subId)) return subId;
  }

  // gatewayIPConfigurations[].properties.subnet.id (App Gateway)
  const gwConfigs = Array.isArray(p.gatewayIPConfigurations) ? p.gatewayIPConfigurations : [];
  for (const cfg of gwConfigs) {
    const subId = safeId(
      (cfg as { properties?: { subnet?: { id?: unknown } } })?.properties?.subnet?.id,
    );
    if (subId && knownSubnetIds.has(subId)) return subId;
  }

  // frontendIPConfigurations[].properties.subnet.id (Load Balancers)
  const feConfigs = Array.isArray(p.frontendIPConfigurations) ? p.frontendIPConfigurations : [];
  for (const cfg of feConfigs) {
    const subId = safeId(
      (cfg as { properties?: { subnet?: { id?: unknown } } })?.properties?.subnet?.id,
    );
    if (subId && knownSubnetIds.has(subId)) return subId;
  }

  // agentPoolProfiles[].vnetSubnetId / vnetSubnetID (AKS)
  const agentPools = Array.isArray(p.agentPoolProfiles) ? p.agentPoolProfiles : [];
  for (const pool of agentPools) {
    const subId = safeId(
      (pool as { vnetSubnetId?: unknown; vnetSubnetID?: unknown }).vnetSubnetId ??
      (pool as { vnetSubnetID?: unknown }).vnetSubnetID,
    );
    if (subId && knownSubnetIds.has(subId)) return subId;
  }

  // Deep scan: recursively look for any string value matching a known subnet ID
  const found = deepScanForSubnetId(properties, knownSubnetIds, 0);
  if (found) return found;

  return undefined;
}

/** Recursively scan an object for string values that match known subnet IDs. Max depth 5. */
function deepScanForSubnetId(
  obj: unknown,
  knownSubnetIds: Set<string>,
  depth: number,
): string | undefined {
  if (depth > 5 || !obj || typeof obj !== "object") return undefined;

  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = deepScanForSubnetId(item, knownSubnetIds, depth + 1);
      if (found) return found;
    }
    return undefined;
  }

  for (const value of Object.values(obj as Record<string, unknown>)) {
    if (typeof value === "string") {
      const lower = value.toLowerCase().trim();
      if (knownSubnetIds.has(lower)) return lower;
    } else if (typeof value === "object" && value !== null) {
      const found = deepScanForSubnetId(value, knownSubnetIds, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

async function resourceGraphQueryAll<T>(
  client: ResourceGraphClient,
  subscriptions: string[],
  query: string,
  pageSize: number
): Promise<T[]> {
  const all: T[] = [];
  let skipToken: string | undefined;
  for (;;) {
    const resp = await client.resources({
      subscriptions,
      query,
      options: {
        resultFormat: "objectArray",
        top: pageSize,
        skipToken
      }
    });
    const data = (resp.data ?? []) as T[];
    all.push(...data);
    if (!resp.skipToken) break;
    skipToken = resp.skipToken;
  }
  return all;
}

function createResourceGraphClient(env: Env, bearerToken: string | undefined): RGClientBundle {
  if (bearerToken) {
    try {
      return createOBOClient(env, bearerToken);
    } catch {
      // OBO failed — fall through to SP
    }
  }
  return createServicePrincipalClient(env);
}

async function fetchTopologyFromResourceGraph(env: Env, bearerToken: string | undefined): Promise<ArchitectureGraph> {
  const { client, subscriptions, pageSize } = createResourceGraphClient(env, bearerToken);

  const subsQuery =
    "resourcecontainers | where type == 'microsoft.resources/subscriptions' | project subscriptionId, name";
  const rgQuery =
    "resourcecontainers | where type == 'microsoft.resources/subscriptions/resourcegroups' | project id, name, location, subscriptionId, tags";
  const resQuery =
    "resources | where type in~ (" +
    "'microsoft.network/virtualnetworks'," +
    "'microsoft.network/virtualnetworks/subnets'," +
    "'microsoft.network/networkinterfaces'," +
    "'microsoft.network/networksecuritygroups'," +
    "'microsoft.compute/virtualmachines'," +
    "'microsoft.compute/virtualmachinescalesets'," +
    "'microsoft.containerservice/managedclusters'," +
    "'microsoft.app/containerapps'," +
    "'microsoft.network/applicationgateways'," +
    "'microsoft.network/loadbalancers'," +
    "'microsoft.network/frontdoors'," +
    "'microsoft.network/trafficmanagerprofiles'," +
    "'microsoft.network/privateendpoints'," +
    "'microsoft.network/azurefirewalls'," +
    "'microsoft.network/dnszones'," +
    "'microsoft.network/privatednszones'," +
    "'microsoft.storage/storageaccounts'," +
    "'microsoft.sql/servers'," +
    "'microsoft.documentdb/databaseaccounts'," +
    "'microsoft.cache/redis'," +
    "'microsoft.dbforpostgresql/flexibleservers'," +
    "'microsoft.dbforpostgresql/servers'," +
    "'microsoft.keyvault/vaults'," +
    "'microsoft.insights/components'," +
    "'microsoft.operationalinsights/workspaces'," +
    "'microsoft.web/sites'," +
    "'microsoft.servicebus/namespaces'," +
    "'microsoft.eventhub/namespaces'," +
    "'microsoft.network/publicipaddresses'" +
    ") | project id, name, type, kind, location, resourceGroup, subscriptionId, tags, properties";

  // Query 4: Diagnostic Settings (separate resource type)
  const diagQuery =
    "resources | where type =~ 'microsoft.insights/diagnosticsettings'" +
    " | project id, name, type, kind, location, resourceGroup, subscriptionId, tags, properties";

  const [subRows, rgRows, resRows, diagRows] = await Promise.all([
    resourceGraphQueryAll<AzureSubscriptionRow>(client, subscriptions, subsQuery, pageSize),
    resourceGraphQueryAll<AzureResourceGroupRow>(client, subscriptions, rgQuery, pageSize),
    resourceGraphQueryAll<AzureResourceRow>(client, subscriptions, resQuery, pageSize),
    resourceGraphQueryAll<AzureResourceRow>(client, subscriptions, diagQuery, pageSize).catch(() => [] as AzureResourceRow[]),
  ]);

  // Normalize Azure resource IDs to lowercase — Azure resource IDs are
  // case-insensitive but different API responses may use different casing
  for (const rg of rgRows) { if (rg.id) rg.id = rg.id.toLowerCase(); }
  for (const r of resRows) { if (r.id) r.id = r.id.toLowerCase(); }
  for (const d of diagRows) { if (d.id) d.id = d.id.toLowerCase(); }

  const subNameById = new Map<string, string>();
  for (const s of subRows) {
    if (s.subscriptionId && s.name) subNameById.set(s.subscriptionId, s.name);
  }

  const nodes: ArchitectureNode[] = [];
  const edges: ArchitectureEdge[] = [];

  // subscriptions
  for (const subId of subscriptions) {
    nodes.push({
      id: `sub:${subId}`,
      kind: "subscription",
      name: subNameById.get(subId) ?? subId,
      azureId: `/subscriptions/${subId}`,
      health: "unknown"
    });
  }

  // resource groups
  const rgById = new Map<string, AzureResourceGroupRow>();
  for (const rg of rgRows) {
    if (!rg.id) continue;
    rgById.set(rg.id, rg);
    nodes.push({
      id: rg.id,
      kind: "resourceGroup",
      name: rg.name ?? rg.id,
      azureId: rg.id,
      location: rg.location,
      tags: rg.tags,
      health: "unknown"
    });
    if (rg.subscriptionId) {
      edges.push({
        id: `e:sub->rg:${rg.subscriptionId}:${rg.id}`,
        source: `sub:${rg.subscriptionId}`,
        target: rg.id,
        kind: "contains"
      });
    }
  }

  // Build publicIpById map: resource id → IP address properties (for resolving publicIPAddress references)
  const publicIpById = new Map<string, Record<string, unknown>>();
  for (const r of resRows) {
    if (!r.id) continue;
    if ((r.type ?? "").toLowerCase() === "microsoft.network/publicipaddresses") {
      publicIpById.set(r.id, (r.properties ?? {}) as Record<string, unknown>);
    }
  }

  // resources
  const resourceById = new Map<string, AzureResourceRow>();
  const nicById = new Map<string, AzureResourceRow>();
  for (const r of resRows) {
    if (!r.id) continue;
    resourceById.set(r.id, r);
    if ((r.type ?? "").toLowerCase() === "microsoft.network/networkinterfaces") {
      nicById.set(r.id, r);
    }

    const kind = mapKind(r.type, r.kind);
    const endpoint = extractEndpoint(r.type, r.name, r.properties);
    const nodeMetadata: Record<string, unknown> = {};

    // Public IP — mark as absorbed if attached to another resource (has ipConfiguration)
    if (kind === "publicIP") {
      const props = (r.properties ?? {}) as Record<string, unknown>;
      const ipConfig = props.ipConfiguration as Record<string, unknown> | undefined;
      if (ipConfig?.id) nodeMetadata.absorbed = true;
    }

    // AKS — store private cluster flag and privateFqdn for diagram representation
    if (kind === "aks") {
      const props = (r.properties ?? {}) as Record<string, unknown>;
      const accessProfile = props.apiServerAccessProfile as Record<string, unknown> | undefined;
      nodeMetadata.isPrivateCluster = !!accessProfile?.enablePrivateCluster;
      const privateFqdn = safeString(props.privateFQDN);
      if (privateFqdn) nodeMetadata.privateFqdn = privateFqdn;
    }

    nodes.push({
      id: r.id,
      kind,
      name: r.name ?? r.id,
      azureId: r.id,
      location: r.location,
      endpoint,
      resourceGroup: r.resourceGroup,
      tags: r.tags,
      health: "unknown",
      ...(Object.keys(nodeMetadata).length > 0 ? { metadata: nodeMetadata } : {}),
    });

    if (r.subscriptionId && r.resourceGroup) {
      const rg = rgId(r.subscriptionId, r.resourceGroup);
      if (rgById.has(rg)) {
        edges.push({
          id: `e:rg->res:${rg}:${r.id}`,
          source: rg,
          target: r.id,
          kind: "contains"
        });
      }
    }
  }

  // ── Post-process: resolve public IPs for LBs and NICs ──

  // LBs without a private-IP endpoint may have a public IP referenced in frontendIPConfigurations
  for (const node of nodes) {
    if (node.kind !== "lb" || node.endpoint) continue;
    const r = resRows.find(row => row.id === node.id);
    if (!r) continue;
    const feConfigs = ((r.properties as Record<string, unknown>)?.frontendIPConfigurations ?? []) as Array<{
      properties?: { publicIPAddress?: { id?: string } };
    }>;
    for (const fe of feConfigs) {
      const pubIpId = fe.properties?.publicIPAddress?.id?.toLowerCase();
      if (!pubIpId) continue;
      const ip = safeString(publicIpById.get(pubIpId)?.ipAddress);
      if (ip) { node.endpoint = ip; break; }
    }
  }

  // NICs with a public IP reference — store in metadata for specGenerator to use as sub-resource
  for (const node of nodes) {
    if (node.kind !== "nic") continue;
    const r = nicById.get(node.id);
    if (!r) continue;
    const ipCfgs = ((r.properties as Record<string, unknown>)?.ipConfigurations ?? []) as Array<{
      properties?: { publicIPAddress?: { id?: string } };
    }>;
    const pubRef = ipCfgs[0]?.properties?.publicIPAddress?.id?.toLowerCase();
    if (!pubRef) continue;
    const pubIp = safeString(publicIpById.get(pubRef)?.ipAddress);
    if (pubIp) node.metadata = { ...node.metadata, publicIP: pubIp };
  }

  // ── Ensure subnets are in the graph ──
  // Azure Resource Graph may not always return subnets as separate resources.
  // Extract subnets from VNet properties as a fallback.
  const edgeIdSet = new Set<string>(edges.map(e => e.id));
  for (const r of resRows) {
    if (!r.id) continue;
    const t = (r.type ?? "").toLowerCase();
    if (t !== "microsoft.network/virtualnetworks") continue;

    const vnetSubnetsArr = safePropArray(r.properties, "subnets");
    console.log(`[azure] VNet "${r.name}" (${r.id.split("/").pop()}) has ${vnetSubnetsArr.length} embedded subnets`);
    for (const sub of vnetSubnetsArr) {
      if (!sub || typeof sub !== "object") continue;
      const subObj = sub as Record<string, unknown>;
      const subId = safeId(subObj.id);
      if (!subId) continue;

      // Create subnet node if not already in the graph
      if (!resourceById.has(subId)) {
        const subName = safeString(subObj.name) ?? subId.split("/").pop() ?? subId;
        const subProps = subObj.properties;
        const endpoint = extractEndpoint("microsoft.network/virtualnetworks/subnets", subName, subProps);

        const subRow: AzureResourceRow = {
          id: subId,
          name: subName,
          type: "Microsoft.Network/virtualNetworks/subnets",
          location: r.location,
          resourceGroup: r.resourceGroup,
          subscriptionId: r.subscriptionId,
          properties: subProps,
        };
        resourceById.set(subId, subRow);
        nodes.push({
          id: subId,
          kind: "subnet",
          name: subName,
          azureId: subId,
          location: r.location,
          endpoint,
          resourceGroup: r.resourceGroup,
          health: "unknown",
        });
      }

      // Ensure VNet→Subnet contains edge exists
      const edgeId = `e:vnet->subnet:${r.id}:${subId}`;
      if (!edgeIdSet.has(edgeId)) {
        edgeIdSet.add(edgeId);
        edges.push({
          id: edgeId,
          source: r.id,
          target: subId,
          kind: "contains",
        });
      }

      // Extract NIC→Subnet bindings from subnet ipConfigurations
      // Handle both nested format (subObj.properties.ipConfigurations) and
      // Resource Graph flattened format (subObj.ipConfigurations directly)
      const subnetIpConfigs: unknown[] = (() => {
        // Try nested format first
        if (subObj.properties && typeof subObj.properties === "object") {
          const nested = safePropArray(subObj.properties, "ipConfigurations");
          if (nested.length > 0) return nested;
        }
        // Fallback: flattened format (ipConfigurations directly on subnet object)
        const flat = safePropArray(subObj, "ipConfigurations");
        return flat;
      })();
      const subLabel = safeString(subObj.name) ?? subId.split("/").pop();
      console.log(`[azure]   Subnet "${subLabel}" has ${subnetIpConfigs.length} ipConfigurations (props=${!!subObj.properties}, flat=${Array.isArray(subObj.ipConfigurations)})`);
      for (const cfg of subnetIpConfigs) {
        if (!cfg || typeof cfg !== "object") continue;
        const nicConfigId = safeId((cfg as Record<string, unknown>).id);
        if (!nicConfigId) continue;
        const nicIdx = nicConfigId.indexOf("/ipconfigurations/");
        if (nicIdx <= 0) continue;
        const nicId = nicConfigId.slice(0, nicIdx);
        if (!nicById.has(nicId)) continue;
        const nicEdgeId = `e:subnet->nic:${subId}:${nicId}`;
        if (!edgeIdSet.has(nicEdgeId)) {
          edgeIdSet.add(nicEdgeId);
          edges.push({
            id: nicEdgeId,
            source: subId,
            target: nicId,
            kind: "attached-to",
          });
        }
      }
    }
  }

  // derived edges: vnet -> subnet (from separate subnet resources — may overlap with above)
  for (const r of resRows) {
    if (!r.id) continue;
    const t = (r.type ?? "").toLowerCase();
    if (t !== "microsoft.network/virtualnetworks/subnets") continue;
    const parts = r.id.split("/subnets/");
    if (parts.length !== 2) continue;
    const parentVnetId = r.id.slice(0, r.id.indexOf("/subnets/"));
    if (!resourceById.has(parentVnetId)) continue;
    const edgeId = `e:vnet->subnet:${parentVnetId}:${r.id}`;
    if (!edgeIdSet.has(edgeId)) {
      edgeIdSet.add(edgeId);
      edges.push({
        id: edgeId,
        source: parentVnetId,
        target: r.id,
        kind: "contains",
      });
    }
  }

  // derived edges: subnet -> nic, nic -> vm
  // Dump first NIC's raw ipConfigurations structure for debugging
  const firstNic = nicById.values().next().value;
  if (firstNic) {
    const p = firstNic.properties as Record<string, unknown> | undefined;
    const ipCfgs = p?.ipConfigurations;
    if (Array.isArray(ipCfgs) && ipCfgs.length > 0) {
      const first = ipCfgs[0] as Record<string, unknown>;
      const keys = Object.keys(first);
      console.log(`[azure] NIC "${firstNic.name}" ipConfigurations[0] keys: [${keys.join(", ")}]`);
      // Check which format: nested (.properties.subnet.id) or flat (.subnet.id)
      const hasNestedProps = first.properties != null;
      const hasFlatSubnet = first.subnet != null;
      console.log(`[azure] NIC format: hasNestedProperties=${hasNestedProps}, hasFlatSubnet=${hasFlatSubnet}`);
      if (hasNestedProps) {
        const nested = first.properties as Record<string, unknown>;
        console.log(`[azure] NIC .properties keys: [${Object.keys(nested).join(", ")}]`);
      }
    } else {
      console.log(`[azure] NIC "${firstNic.name}" has no ipConfigurations array`);
    }
  }

  let nicSubnetEdgeCount = 0;
  let nicSubnetMissCount = 0;
  for (const nic of nicById.values()) {
    const subnetId = getSubnetIdFromNicProps(nic.properties);
    if (subnetId) {
      const nicEdgeId = `e:subnet->nic:${subnetId}:${nic.id}`;
      if (!edgeIdSet.has(nicEdgeId)) {
        edgeIdSet.add(nicEdgeId);
        edges.push({
          id: nicEdgeId,
          source: subnetId,
          target: nic.id,
          kind: "attached-to",
        });
        nicSubnetEdgeCount++;
        // Check if the subnet node actually exists in graph
        const subnetExists = nodes.some(n => n.id === subnetId);
        console.log(`[azure] NIC→Subnet: "${nic.name}" → subnet "${subnetId.split("/").pop()}" (subnetInGraph=${subnetExists})`);
      }
    } else {
      nicSubnetMissCount++;
      console.log(`[azure] NIC "${nic.name}" has NO subnet reference in properties`);
    }
  }
  console.log(`[azure] NIC→Subnet edges: ${nicSubnetEdgeCount} created, ${nicSubnetMissCount} missing subnet ref`);

  let nicVmEdgeCount = 0;
  for (const r of resRows) {
    if (!r.id) continue;
    const t = (r.type ?? "").toLowerCase();
    if (t === "microsoft.compute/virtualmachines") {
      const nicIds = getNicIdsFromVmProps(r.properties);
      for (const nicId of nicIds) {
        if (!nicById.has(nicId)) {
          console.log(`[azure] VM "${r.name}" references NIC "${nicId.split("/").pop()}" but NIC not in graph`);
          continue;
        }
        edges.push({
          id: `e:nic->vm:${nicId}:${r.id}`,
          source: nicId,
          target: r.id,
          kind: "bound-to"
        });
        nicVmEdgeCount++;
        console.log(`[azure] NIC→VM: "${nicId.split("/").pop()}" → VM "${r.name}"`);
      }
      if (nicIds.length === 0) {
        console.log(`[azure] VM "${r.name}" has NO NIC references in properties`);
      }
    }
    if (t === "microsoft.containerservice/managedclusters") {
      for (const subnetId of getSubnetIdsFromAksProps(r.properties)) {
        edges.push({
          id: `e:subnet->aks:${subnetId}:${r.id}`,
          source: subnetId,
          target: r.id,
          kind: "connects"
        });
      }
    }
    if (t === "microsoft.network/applicationgateways") {
      for (const subnetId of getSubnetIdsFromAppGatewayProps(r.properties)) {
        edges.push({
          id: `e:subnet->appgw:${subnetId}:${r.id}`,
          source: subnetId,
          target: r.id,
          kind: "connects"
        });
      }

      for (const nicId of getBackendNicIdsFromAppGatewayProps(r.properties)) {
        if (!nicById.has(nicId)) continue;
        edges.push({
          id: `e:appgw->nic:${r.id}:${nicId}`,
          source: r.id,
          target: nicId,
          kind: "routes"
        });
      }
    }
    if (t === "microsoft.network/loadbalancers") {
      for (const subnetId of getSubnetIdsFromLoadBalancerProps(r.properties)) {
        edges.push({
          id: `e:subnet->lb:${subnetId}:${r.id}`,
          source: subnetId,
          target: r.id,
          kind: "connects"
        });
      }

      for (const nicId of getBackendNicIdsFromLoadBalancerProps(r.properties)) {
        if (!nicById.has(nicId)) continue;
        edges.push({
          id: `e:lb->nic:${r.id}:${nicId}`,
          source: r.id,
          target: nicId,
          kind: "routes"
        });
      }
    }
    if (t === "microsoft.network/privateendpoints") {
      const subnetId = getSubnetIdFromPrivateEndpointProps(r.properties);
      if (subnetId) {
        edges.push({
          id: `e:subnet->pe:${subnetId}:${r.id}`,
          source: subnetId,
          target: r.id,
          kind: "network"
        });
      }

      for (const targetId of getPrivateLinkTargetIdsFromPrivateEndpointProps(r.properties)) {
        if (!resourceById.has(targetId)) continue;
        edges.push({
          id: `e:pe->target:${r.id}:${targetId}`,
          source: r.id,
          target: targetId,
          kind: "privateLink"
        });
      }
    }
  }

  console.log(`[azure] NIC→VM edges: ${nicVmEdgeCount} created`);

  // ── New relationship parsers ──

  for (const r of resRows) {
    if (!r.id) continue;
    const t = (r.type ?? "").toLowerCase();

    // 13. VNet Peering
    if (t === "microsoft.network/virtualnetworks") {
      const peerings = safePropArray(r.properties, "virtualNetworkPeerings");
      for (const p of peerings) {
        const remoteId = safePropString(p, "properties", "remoteVirtualNetwork", "id")?.toLowerCase();
        if (remoteId && resourceById.has(remoteId)) {
          const peerState = safePropString(p, "properties", "peeringState") ?? "Unknown";
          const edgeId = `e:peering:${r.id}:${remoteId}`;
          // Only add one direction (lower ID → higher ID) to avoid duplicates
          if (r.id < remoteId) {
            edges.push({
              id: edgeId,
              source: r.id,
              target: remoteId,
              kind: "peering",
              metadata: { peeringState: peerState },
            });
          }
        }
      }
    }

    // 14. App Service / Function App → Subnet (VNet Integration)
    if (t === "microsoft.web/sites") {
      const vnetSubnetId = safePropString(r.properties, "virtualNetworkSubnetId")?.toLowerCase();
      if (vnetSubnetId && resourceById.has(vnetSubnetId)) {
        edges.push({
          id: `e:site->subnet:${r.id}:${vnetSubnetId}`,
          source: vnetSubnetId,
          target: r.id,
          kind: "network",
        });
      }
    }

    // 15–16. NSG → Subnet / NIC associations
    if (t === "microsoft.network/networksecuritygroups") {
      const nsgSubnets = safePropArray(r.properties, "subnets");
      for (const s of nsgSubnets) {
        const subnetRef = safeId(typeof s === "object" && s !== null ? (s as Record<string, unknown>).id : undefined);
        if (subnetRef && resourceById.has(subnetRef)) {
          edges.push({
            id: `e:nsg->subnet:${r.id}:${subnetRef}`,
            source: r.id,
            target: subnetRef,
            kind: "network",
          });
        }
      }
      const nsgNics = safePropArray(r.properties, "networkInterfaces");
      for (const n of nsgNics) {
        const nicRef = safeId(typeof n === "object" && n !== null ? (n as Record<string, unknown>).id : undefined);
        if (nicRef && nicById.has(nicRef)) {
          edges.push({
            id: `e:nsg->nic:${r.id}:${nicRef}`,
            source: r.id,
            target: nicRef,
            kind: "network",
          });
        }
      }
    }

    // 17. App Insights → Log Analytics Workspace
    if (t === "microsoft.insights/components") {
      const workspaceId = (safePropString(r.properties, "WorkspaceResourceId")
        ?? safePropString(r.properties, "workspaceResourceId"))?.toLowerCase();
      if (workspaceId && resourceById.has(workspaceId)) {
        edges.push({
          id: `e:ai->la:${r.id}:${workspaceId}`,
          source: r.id,
          target: workspaceId,
          kind: "logging",
        });
      }
    }
  }

  // 18. Diagnostic Settings → target workspace/storage
  for (const ds of diagRows) {
    if (!ds.id || !ds.properties) continue;
    // Diagnostic settings resourceId format: {sourceResourceId}/providers/microsoft.insights/diagnosticSettings/{name}
    // Extract the source resource that this diagnostic setting belongs to (ds.id already lowercase)
    const providerIdx = ds.id.indexOf("/providers/microsoft.insights/diagnosticsettings/");
    const sourceResourceId = providerIdx > 0 ? ds.id.slice(0, providerIdx) : undefined;

    const workspaceId = safePropString(ds.properties, "workspaceId")?.toLowerCase();
    const storageId = safePropString(ds.properties, "storageAccountId")?.toLowerCase();

    if (sourceResourceId && resourceById.has(sourceResourceId)) {
      if (workspaceId && resourceById.has(workspaceId)) {
        const category = safePropString(ds.properties, "logs", "0", "category") ?? "Logs";
        edges.push({
          id: `e:diag->la:${sourceResourceId}:${workspaceId}:${ds.name}`,
          source: sourceResourceId,
          target: workspaceId,
          kind: "logging",
          metadata: { diagnosticCategory: category },
        });
      }
      if (storageId && resourceById.has(storageId)) {
        edges.push({
          id: `e:diag->sa:${sourceResourceId}:${storageId}:${ds.name}`,
          source: sourceResourceId,
          target: storageId,
          kind: "logging",
          metadata: { diagnosticCategory: "Archive" },
        });
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // ██ COMPREHENSIVE SUBNET DISCOVERY ██
  // Ensures subnet nodes ALWAYS exist. Subnet count must NEVER be 0
  // when VNets or NICs exist. Collects subnet IDs from ALL sources.
  // ══════════════════════════════════════════════════════════════════

  const discoveredSubnetIds = new Set<string>();
  const vnetNodeIds = new Set(nodes.filter(n => n.kind === "vnet").map(n => n.id));

  // ── Source (a): NIC.properties.ipConfigurations[].subnet.id ──
  for (const nic of nicById.values()) {
    const subnetId = getSubnetIdFromNicProps(nic.properties);
    if (subnetId) discoveredSubnetIds.add(subnetId);
  }
  console.log(`[subnet-discovery] Source (a) NIC properties: ${discoveredSubnetIds.size} subnet IDs`);

  // ── Source (b): VNet.properties.subnets[].id ──
  const preNicCount = discoveredSubnetIds.size;
  for (const r of resRows) {
    if (!r.id) continue;
    const t = (r.type ?? "").toLowerCase();
    if (t !== "microsoft.network/virtualnetworks") continue;
    const arr = safePropArray(r.properties, "subnets");
    for (const sub of arr) {
      if (!sub || typeof sub !== "object") continue;
      const id = safeId((sub as Record<string, unknown>).id);
      if (id) discoveredSubnetIds.add(id);
    }
  }
  console.log(`[subnet-discovery] Source (b) VNet embedded: +${discoveredSubnetIds.size - preNicCount} (total ${discoveredSubnetIds.size})`);

  // ── Source (c): Resource ID / edge ID parsing for /subnets/ pattern ──
  const preEdgeCount = discoveredSubnetIds.size;
  for (const edge of edges) {
    for (const rid of [edge.source, edge.target]) {
      const subId = extractSubnetIdFromResourceId(rid);
      if (subId) discoveredSubnetIds.add(subId);
    }
  }
  for (const n of nodes) {
    const subId = extractSubnetIdFromResourceId(n.id);
    if (subId) discoveredSubnetIds.add(subId);
  }
  console.log(`[subnet-discovery] Source (c) ID parsing: +${discoveredSubnetIds.size - preEdgeCount} (total ${discoveredSubnetIds.size})`);

  // ── Create subnet nodes for ALL discovered IDs ──
  let createdSubnets = 0;
  for (const subnetId of discoveredSubnetIds) {
    if (nodes.some(n => n.id === subnetId && n.kind === "subnet")) continue; // Already exists

    const subName = subnetId.split("/").pop() ?? "unknown-subnet";
    const vnetIdx = subnetId.lastIndexOf("/subnets/");
    const parentVnetId = vnetIdx > 0 ? subnetId.slice(0, vnetIdx) : undefined;
    const vnetRow = parentVnetId ? resourceById.get(parentVnetId) : undefined;
    // Fall back to NIC's location/RG if VNet not found
    const anyNicForSubnet = [...nicById.values()].find(nic => getSubnetIdFromNicProps(nic.properties) === subnetId);

    const subRow: AzureResourceRow = {
      id: subnetId,
      name: subName,
      type: "Microsoft.Network/virtualNetworks/subnets",
      location: vnetRow?.location ?? anyNicForSubnet?.location,
      resourceGroup: vnetRow?.resourceGroup ?? anyNicForSubnet?.resourceGroup,
    };
    resourceById.set(subnetId, subRow);
    nodes.push({
      id: subnetId,
      kind: "subnet",
      name: subName,
      azureId: subnetId,
      location: subRow.location,
      resourceGroup: subRow.resourceGroup,
      health: "unknown",
    });
    createdSubnets++;
    console.log(`[subnet-discovery] Created subnet: "${subName}" (VNet: ${parentVnetId ? vnetNodeIds.has(parentVnetId) ? "found" : "MISSING" : "N/A"})`);
  }
  console.log(`[subnet-discovery] Result: ${discoveredSubnetIds.size} total subnets, ${createdSubnets} newly created`);

  // ── Ensure VNet→Subnet contains edges exist for ALL subnets ──
  const finalSubnetNodeIds = new Set(nodes.filter(n => n.kind === "subnet").map(n => n.id));
  let containsCreated = 0;
  for (const subId of finalSubnetNodeIds) {
    const hasContains = edges.some(e => e.kind === "contains" && e.target === subId && vnetNodeIds.has(e.source));
    if (hasContains) continue;

    const vnetIdx = subId.lastIndexOf("/subnets/");
    if (vnetIdx <= 0) continue;
    const parentVnetId = subId.slice(0, vnetIdx);
    if (!vnetNodeIds.has(parentVnetId)) continue;

    const eid = `e:vnet->subnet-disc:${parentVnetId}:${subId}`;
    if (!edgeIdSet.has(eid)) {
      edgeIdSet.add(eid);
      edges.push({ id: eid, source: parentVnetId, target: subId, kind: "contains" });
      containsCreated++;
    }
  }
  if (containsCreated > 0) {
    console.log(`[subnet-discovery] Created ${containsCreated} VNet→Subnet contains edges`);
  }

  // ── Ensure Subnet→NIC edges exist for ALL NICs ──
  let nicEdgesCreated = 0;
  for (const nic of nicById.values()) {
    const hasSubnetEdge = edges.some(e => e.target === nic.id && finalSubnetNodeIds.has(e.source));
    if (hasSubnetEdge) continue;

    const subnetId = getSubnetIdFromNicProps(nic.properties);
    if (!subnetId || !finalSubnetNodeIds.has(subnetId)) continue;

    const eid = `e:subnet->nic-disc:${subnetId}:${nic.id}`;
    if (!edgeIdSet.has(eid)) {
      edgeIdSet.add(eid);
      edges.push({ id: eid, source: subnetId, target: nic.id, kind: "attached-to" });
      nicEdgesCreated++;
    }
  }
  if (nicEdgesCreated > 0) {
    console.log(`[subnet-discovery] Created ${nicEdgesCreated} Subnet→NIC edges`);
  }

  // ── Generic fallback: scan ALL resource properties for subnet references ──
  // NOTE: PaaS services (storage, SQL, Redis, CosmosDB, etc.) are excluded because their
  // networkAcls.virtualNetworkRules reference subnets via SERVICE ENDPOINTS — not physical
  // placement. Showing them inside the subnet would misrepresent the architecture.
  const PAAS_KINDS_NO_SUBNET = new Set([
    "storage", "sql", "cosmosDb", "redis", "postgres", "keyVault",
    "serviceBus", "eventHub", "appInsights", "logAnalytics", "dns",
  ]);
  let genericSubnetEdges = 0;
  for (const r of resRows) {
    if (!r.id || !r.properties) continue;
    const kind = mapKind(r.type, r.kind);
    if (kind === "vnet" || kind === "subnet" || kind === "nic" || kind === "nsg") continue;
    // Skip PaaS services — service endpoint rules ≠ physical subnet containment
    if (PAAS_KINDS_NO_SUBNET.has(kind)) continue;
    const hasSubnetEdge = edges.some(e =>
      (e.target === r.id && finalSubnetNodeIds.has(e.source)) ||
      (e.source === r.id && finalSubnetNodeIds.has(e.target)),
    );
    if (hasSubnetEdge) continue;
    const subnetRef = findSubnetReferenceInProps(r.properties, finalSubnetNodeIds);
    if (subnetRef) {
      const edgeId = `e:subnet->res-generic:${subnetRef}:${r.id}`;
      if (!edgeIdSet.has(edgeId)) {
        edgeIdSet.add(edgeId);
        edges.push({ id: edgeId, source: subnetRef, target: r.id, kind: "network" });
        genericSubnetEdges++;
      }
    }
  }
  if (genericSubnetEdges > 0) {
    console.log(`[subnet-discovery] Generic scanner: ${genericSubnetEdges} additional subnet→resource edges`);
  }

  // ── Diagnostic: graph summary ──
  const kindCount = new Map<string, number>();
  for (const n of nodes) {
    kindCount.set(n.kind, (kindCount.get(n.kind) ?? 0) + 1);
  }
  const edgeKindCount = new Map<string, number>();
  for (const e of edges) {
    edgeKindCount.set(e.kind, (edgeKindCount.get(e.kind) ?? 0) + 1);
  }
  console.log(`[azure] Graph built: ${nodes.length} nodes, ${edges.length} edges`);
  console.log(`[azure] Node kinds: ${JSON.stringify(Object.fromEntries(kindCount))}`);
  console.log(`[azure] Edge kinds: ${JSON.stringify(Object.fromEntries(edgeKindCount))}`);

  // ── Diagnostic: containment edge counts (using final subnet set) ──
  const vnetToSubnet = edges.filter(e => e.kind === "contains" && finalSubnetNodeIds.has(e.target)).length;
  const subnetToResource = edges.filter(e =>
    finalSubnetNodeIds.has(e.source) &&
    e.kind !== "contains" &&
    !finalSubnetNodeIds.has(e.target),
  ).length;
  console.log(`[azure] Containment edges: ${vnetToSubnet} vnet→subnet, ${subnetToResource} subnet→resource`);

  return {
    generatedAt: new Date().toISOString(),
    nodes,
    edges
  };
}

export async function tryListAzureSubscriptionsFromAzure(
  env: Env,
  bearerToken: string | undefined
): Promise<AzureSubscriptionOption[] | null> {
  if (!env.AZURE_SUBSCRIPTION_IDS) return null;
  // Require either bearer token or SP credentials
  if (!bearerToken && !(env.AZURE_AD_TENANT_ID && env.AZURE_AD_CLIENT_ID && env.AZURE_AD_CLIENT_SECRET)) return null;

  const tokenKey = bearerToken ? bearerKey(bearerToken) : "sp";
  const cacheKey = `${tokenKey}:${env.AZURE_SUBSCRIPTION_IDS}`;
  const now = Date.now();
  if (subsCache && subsCache.key === cacheKey && subsCache.expiresAt > now) return subsCache.subscriptions;

  const { client, subscriptions, pageSize } = createResourceGraphClient(env, bearerToken);
  const subsQuery = "resourcecontainers | where type == 'microsoft.resources/subscriptions' | project subscriptionId, name";
  const rows = await resourceGraphQueryAll<AzureSubscriptionRow>(client, subscriptions, subsQuery, pageSize);

  const nameById = new Map<string, string>();
  for (const r of rows) {
    if (r.subscriptionId && r.name) nameById.set(r.subscriptionId, r.name);
  }

  const out: AzureSubscriptionOption[] = subscriptions.map((subscriptionId) => ({
    subscriptionId,
    name: nameById.get(subscriptionId),
  }));

  subsCache = { key: cacheKey, expiresAt: now + env.AZURE_RESOURCE_GRAPH_CACHE_TTL_MS, subscriptions: out };
  return out;
}

export async function tryGetArchitectureGraphFromAzure(
  env: Env,
  bearerToken: string | undefined,
  opts?: { subscriptionId?: string }
): Promise<ArchitectureGraph | null> {
  if (!env.AZURE_SUBSCRIPTION_IDS) return null;
  // Require either bearer token or SP credentials
  if (!bearerToken && !(env.AZURE_AD_TENANT_ID && env.AZURE_AD_CLIENT_ID && env.AZURE_AD_CLIENT_SECRET)) return null;

  // Optional narrowing to a single subscription (must be in the allow-list env)
  if (opts?.subscriptionId) {
    const allowed = parseSubscriptionIds(env.AZURE_SUBSCRIPTION_IDS);
    if (!allowed.includes(opts.subscriptionId)) {
      throw new Error("subscriptionId is not in AZURE_SUBSCRIPTION_IDS allow-list");
    }
    env = { ...env, AZURE_SUBSCRIPTION_IDS: opts.subscriptionId };
  }

  const tokenKey = bearerToken ? bearerKey(bearerToken) : "sp";
  const cacheKey = `${tokenKey}:${env.AZURE_SUBSCRIPTION_IDS}`;

  const now = Date.now();
  if (cache && cache.key === cacheKey && cache.expiresAt > now) return cache.graph;

  const graph = await fetchTopologyFromResourceGraph(env, bearerToken);
  cache = { key: cacheKey, expiresAt: now + env.AZURE_RESOURCE_GRAPH_CACHE_TTL_MS, graph };
  return graph;
}
