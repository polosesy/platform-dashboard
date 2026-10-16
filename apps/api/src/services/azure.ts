import { ResourceGraphClient } from "@azure/arm-resourcegraph";
import type { Env } from "../env.js";
import { CacheManager, cachePrefix } from "../infra/cacheManager.js";
import {
  anonymousSpAllowed,
  callerSubscriptions,
  connectionCredentialGroups,
  getAnonymousSPCredential,
  getArmFetcherAuto,
  signinRequired,
} from "../infra/azureClientFactory.js";
import { connectionForSubscription } from "../infra/connectionRegistry.js";
import { debug } from "../infra/logger.js";
import { relEdge } from "./relationships.js";
import { buildAddressIndex, parseFrontends, parsePools, resolveMember, type AddressEntry, type Frontend } from "./backendMembers.js";
import { internetInboundExposure, mostExposed, routesWidenVnetTag, type NsgInput } from "./nsgExposure.js";
import { agcFacts, resolveAgcCluster, type AgcChildRow } from "./agc.js";
import { resolveAgwWaf } from "./agwWaf.js";
import { resourceSpec } from "./resourceSpec.js";
import { activeRoutes, fetchFrontDoorConfig, resolveAfdOrigins, resolveAfdWaf, wafPolicyFacts } from "./frontDoorConfig.js";
import type { ArchitectureEdge, ArchitectureGraph, ArchitectureNode, AzureSubscriptionOption, GraphNodeKind, InboundExposure } from "@aud/types";

type AzureResourceRow = {
  id: string;
  name?: string;
  type?: string;
  kind?: string;
  location?: string;
  resourceGroup?: string;
  subscriptionId?: string;
  tags?: Record<string, string>;
  sku?: { name?: string; capacity?: number };
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

const graphCache = new CacheManager<ArchitectureGraph>(20);
const subsCache = new CacheManager<AzureSubscriptionOption[]>(20);

/** Clear the in-memory Azure Resource Graph cache. Call before generate to ensure fresh data. */
export function clearGraphCache(): void {
  graphCache.clear();
}

type RGClientBundle = { groups: Array<{ client: ResourceGraphClient; subscriptions: string[] }>; subscriptions: string[]; pageSize: number };

/**
 * Resource Graph clients — one per credential of the Azure connections behind the subscriptions (platform identity,
 * a customer's service principal, or a delegated connection's OBO); anonymous dev mode: the platform credential.
 */
function createResourceGraphClient(env: Env, bearerToken: string | undefined, only?: string[]): RGClientBundle {
  // The managed subscriptions this caller may read (home + customer connections the caller's role reaches)
  const subscriptions = only ?? callerSubscriptions(env, bearerToken);
  if (subscriptions.length === 0) {
    throw new Error("No managed subscriptions for this caller");
  }
  const groups = bearerToken
    ? connectionCredentialGroups(env, bearerToken, subscriptions).map((g) => ({ client: new ResourceGraphClient(g.credential), subscriptions: g.subscriptions }))
    : [{ client: new ResourceGraphClient(getAnonymousSPCredential(env)), subscriptions }];
  return { groups, subscriptions, pageSize: env.AZURE_RESOURCE_GRAPH_PAGE_SIZE };
}

/** Private Link targets without a kind of their own — drawn as a generic PaaS card so PL-01 lines have an end */
const PE_PAAS_TYPES = new Set([
  "microsoft.containerregistry/registries", "microsoft.cognitiveservices/accounts", "microsoft.cache/redisenterprise",
  "microsoft.documentdb/mongoclusters",
]);

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
  if (t === "microsoft.network/natgateways") return "natGateway";
  if (t === "microsoft.servicenetworking/trafficcontrollers") return "agc";
  if (t === "microsoft.network/virtualnetworkgateways") return "vnetGateway";
  if (t === "microsoft.network/bastionhosts") return "bastion";
  // Front Door Standard/Premium; other CDN SKUs are skipped when the node is built
  if (t === "microsoft.cdn/profiles") return "frontDoor";
  if (PE_PAAS_TYPES.has(t)) return "paas";
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

/**
 * Top-level resource that owns a child ID, lowercased:
 * ".../networkInterfaces/nic1/ipConfigurations/ipc" → ".../networkinterfaces/nic1"
 * (a VMSS instance NIC resolves to the scale set).
 */
export function ownerResourceId(childId: string): string | undefined {
  const parts = childId.trim().toLowerCase().split("/");
  // ["", "subscriptions", s, "resourcegroups", rg, "providers", ns, type, name, ...]
  if (parts.length < 9 || parts[1] !== "subscriptions" || parts[3] !== "resourcegroups" || parts[5] !== "providers") return undefined;
  return parts.slice(0, 9).join("/");
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

  // NAT Gateway — resolve first attached public IP address via publicIpAddresses[0].id
  // (actual IP lookup is done in post-processing via publicIpById map)
  if (t === "microsoft.network/natgateways") {
    const pips = (p.publicIpAddresses ?? []) as Array<{ id?: string }>;
    return safeId(pips[0]?.id);
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

  // Subnet — addressPrefix (single) or addressPrefixes[0] (array, newer subnets)
  if (t === "microsoft.network/virtualnetworks/subnets") {
    const single = safeString(p.addressPrefix);
    if (single) return single;
    const arr = p.addressPrefixes;
    if (Array.isArray(arr) && arr.length > 0) return safeString(arr[0]);
    return undefined;
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

function getSubnetIdsFromVmssProps(properties: unknown): string[] {
  if (!properties || typeof properties !== "object") return [];
  const vmProfile = (properties as { virtualMachineProfile?: { networkProfile?: { networkInterfaceConfigurations?: unknown } } }).virtualMachineProfile;
  const nicConfigs = vmProfile?.networkProfile?.networkInterfaceConfigurations;
  if (!Array.isArray(nicConfigs)) return [];

  const ids: string[] = [];
  for (const nic of nicConfigs) {
    const ipConfigs = (nic as { properties?: { ipConfigurations?: unknown } }).properties?.ipConfigurations;
    if (!Array.isArray(ipConfigs)) continue;
    for (const ipCfg of ipConfigs) {
      const subnetId = (ipCfg as { properties?: { subnet?: { id?: unknown } } }).properties?.subnet?.id;
      const s = safeId(subnetId);
      if (s) ids.push(s);
    }
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

/** Every page of a query, across the bundle's credential groups */
/**
 * One Resource Graph query over the caller's subscriptions (or `only` of them), split by credential and merged —
 * for collectors outside the topology (Resource Health). Throws when the caller has no subscription.
 */
export async function queryResourceGraph<T>(env: Env, bearerToken: string | undefined, query: string, only?: string[]): Promise<T[]> {
  return resourceGraphQueryAll<T>(createResourceGraphClient(env, bearerToken, only), query);
}

async function resourceGraphQueryAll<T>(bundle: RGClientBundle, query: string): Promise<T[]> {
  const parts = await Promise.all(bundle.groups.map((g) => resourceGraphQueryOne<T>(g.client, g.subscriptions, query, bundle.pageSize)));
  return parts.flat();
}

async function resourceGraphQueryOne<T>(
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

async function fetchTopologyFromResourceGraph(env: Env, bearerToken: string | undefined, only?: string[]): Promise<ArchitectureGraph> {
  const bundle = createResourceGraphClient(env, bearerToken, only);

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
    "'microsoft.network/publicipaddresses'," +
    "'microsoft.network/natgateways'," +
    "'microsoft.servicenetworking/trafficcontrollers'," +
    "'microsoft.network/virtualnetworkgateways'," +
    "'microsoft.network/bastionhosts'," +
    "'microsoft.cdn/profiles'," +
    [...PE_PAAS_TYPES].map((t) => `'${t}'`).join(",") +
    ") | project id, name, type, kind, location, resourceGroup, subscriptionId, tags, sku, properties";

  // Query 4: Diagnostic Settings (separate resource type)
  const diagQuery =
    "resources | where type =~ 'microsoft.insights/diagnosticsettings'" +
    " | project id, name, type, kind, location, resourceGroup, subscriptionId, tags, properties";

  // Inputs of the public-IP exposure verdict only (not graph nodes): subnet route tables (a route outside private
  // space widens the VirtualNetwork tag) and Virtual Network Managers (security admin rules run before NSGs)
  const exposureQuery =
    "resources | where type in~ ('microsoft.network/routetables','microsoft.network/networkmanagers')" +
    " | project id, type, properties";

  // AGC child resources (AGC-02): folded into the traffic controller, not nodes
  const agcChildQuery =
    "resources | where type in~ ('microsoft.servicenetworking/trafficcontrollers/associations'," +
    "'microsoft.servicenetworking/trafficcontrollers/frontends','microsoft.servicenetworking/trafficcontrollers/securitypolicies')" +
    " | project id, type, properties";
  // S2S: connections and local network gateways — folded into the VNet gateway (EDGE-08), the on-premises end
  // (EDGE-09) drawn by the live diagram as a site card. Not graph nodes.
  const hybridQuery =
    "resources | where type in~ ('microsoft.network/connections','microsoft.network/localnetworkgateways')" +
    " | project id, name, type, properties";
  // WAF policies (EDGE-10) — mode, state, rule sets; folded into the Front Door that a security policy links them
  // to, not nodes. The Application Gateway policy type is read for the same vocabulary later (not drawn yet).
  const wafPolicyQuery =
    "resources | where type in~ ('microsoft.network/frontdoorwebapplicationfirewallpolicies','microsoft.network/applicationgatewaywebapplicationfirewallpolicies')" +
    " | project id, name, type, sku, properties";
  // Every type in the subscriptions, to list what no diagram draws
  const typeCountQuery = "resources | summarize count = count() by type = tolower(type)";

  type WafRow = { id?: string; name?: string; type?: string; sku?: { name?: string } | null; properties?: Record<string, unknown> };
  const [subRows, rgRows, resRows, diagRows, exposureRows, agcRows, typeRows, hybridRows, wafFirst] = await Promise.all([
    resourceGraphQueryAll<AzureSubscriptionRow>(bundle, subsQuery),
    resourceGraphQueryAll<AzureResourceGroupRow>(bundle, rgQuery),
    resourceGraphQueryAll<AzureResourceRow>(bundle, resQuery),
    resourceGraphQueryAll<AzureResourceRow>(bundle, diagQuery).catch(() => [] as AzureResourceRow[]),
    resourceGraphQueryAll<AzureResourceRow>(bundle, exposureQuery).catch(() => null),
    resourceGraphQueryAll<AgcChildRow>(bundle, agcChildQuery).catch(() => [] as AgcChildRow[]),
    resourceGraphQueryAll<{ type: string; count: number }>(bundle, typeCountQuery).catch(() => [] as Array<{ type: string; count: number }>),
    resourceGraphQueryAll<AzureResourceRow>(bundle, hybridQuery).catch(() => [] as AzureResourceRow[]),
    // null = not readable: every Front Door domain under a WAF is then "unknown", never "none"
    resourceGraphQueryAll<WafRow>(bundle, wafPolicyQuery).catch(() => null),
  ]);
  // Nine queries at once can be throttled: one more try on its own before the WAF facts count as unreadable
  const wafRows = wafFirst ?? await resourceGraphQueryAll<WafRow>(bundle, wafPolicyQuery).catch(() => null);
  const wafById = wafRows ? new Map(wafRows.filter((r) => r.id).map((r) => [r.id!.toLowerCase(), wafPolicyFacts(r)])) : null;
  for (const r of agcRows) if (r.id) r.id = r.id.toLowerCase();
  const agcByController = agcFacts(agcRows);

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
  for (const subId of bundle.subscriptions) {
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
      edges.push(relEdge("HIER-01", `e:sub->rg:${rg.subscriptionId}:${rg.id}`, `sub:${rg.subscriptionId}`, rg.id));
    }
  }

  // Build publicIpById map: resource id → IP address properties (for resolving publicIPAddress references)
  const publicIpById = new Map<string, Record<string, unknown>>();
  for (const r of resRows) {
    if (!r.id) continue;
    if ((r.type ?? "").toLowerCase() === "microsoft.network/publicipaddresses") {
      publicIpById.set(r.id.toLowerCase(), (r.properties ?? {}) as Record<string, unknown>);
    }
  }

  // Pre-pass: AKS nodeResourceGroup → AKS resource ID mapping
  // AKS clusters expose `nodeResourceGroup` (the MC_* RG) — any VMSS in that RG is a node pool VM
  const aksNodeRgToId = new Map<string, string>(); // nodeResourceGroup.lower() → aksId
  for (const r of resRows) {
    if (!r.id) continue;
    if ((r.type ?? "").toLowerCase() !== "microsoft.containerservice/managedclusters") continue;
    const nodeRg = safeString((r.properties as Record<string, unknown>)?.nodeResourceGroup);
    if (nodeRg) aksNodeRgToId.set(nodeRg.toLowerCase(), r.id);
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
    const rtype = (r.type ?? "").toLowerCase();
    const skuName = safeString((r.sku as { name?: unknown } | undefined)?.name);
    if (rtype === "microsoft.cdn/profiles" && !/azurefrontdoor$/i.test(skuName ?? "")) continue; // a CDN profile, not Front Door
    const endpoint = extractEndpoint(r.type, r.name, r.properties);
    const nodeMetadata: Record<string, unknown> = {};
    const rprops = (r.properties ?? {}) as Record<string, unknown>;
    // Provisioning state: the configuration fact the health evidence ladder starts from (healthEvidence.ts)
    const prov = safeString(rprops.provisioningState);
    if (prov) nodeMetadata.provisioningState = prov;
    if (kind === "frontDoor") {
      if (rtype === "microsoft.cdn/profiles") nodeMetadata.tier = skuName;
      else nodeMetadata.classic = true; // retires 2027-03-31
    }
    if (kind === "paas") nodeMetadata.armType = rtype;
    // Specification for the panel's "사양" section (SKU, version, capacity, HA, access settings) — resourceSpec.ts
    const specFacts = resourceSpec(rtype, r);
    if (specFacts.length) nodeMetadata.spec = specFacts;
    // This VNet's own side of every peering (EDGE-02) — including peerings to VNets this graph cannot see. Each side
    // has its own flags: the hub allows gateway transit, a spoke uses the remote gateway.
    if (kind === "vnet") {
      const list = safePropArray(rprops, "virtualNetworkPeerings").map((pe) => {
        const pp = ((pe as Record<string, unknown>).properties ?? {}) as Record<string, unknown>;
        const remoteId = safeId((pp.remoteVirtualNetwork as { id?: unknown } | undefined)?.id);
        const prefixes = (v: unknown) => { const a = (v as { addressPrefixes?: unknown } | undefined)?.addressPrefixes; return Array.isArray(a) ? a.map(String).slice(0, 20) : null; };
        // A flag ARM did not return stays null — never a default
        const flag = (v: unknown) => (typeof v === "boolean" ? v : null);
        const names = (v: unknown) => (Array.isArray(v) && v.length ? v.map(String).slice(0, 20) : undefined);
        return {
          name: safeString((pe as Record<string, unknown>).name) ?? "",
          remoteId: remoteId ?? null,
          remoteName: remoteId?.split("/").pop() ?? "",
          state: safeString(pp.peeringState) ?? "Unknown",
          sync: safeString(pp.peeringSyncLevel) ?? null,
          provisioning: safeString(pp.provisioningState) ?? null,
          access: flag(pp.allowVirtualNetworkAccess),
          forwarded: flag(pp.allowForwardedTraffic),
          gatewayTransit: flag(pp.allowGatewayTransit),
          useRemoteGateways: flag(pp.useRemoteGateways),
          remoteSpace: prefixes(pp.remoteAddressSpace) ?? [],
          remoteCurrentSpace: prefixes(pp.remoteVirtualNetworkAddressSpace),
          complete: flag(pp.peerCompleteVnets),
          ...(names(pp.localSubnetNames) ? { localSubnets: names(pp.localSubnetNames) } : {}),
          ...(names(pp.remoteSubnetNames) ? { remoteSubnets: names(pp.remoteSubnetNames) } : {}),
        };
      });
      if (list.length) nodeMetadata.vnetPeerings = list;
    }
    if (kind === "vnetGateway") {
      const gt = safeString(rprops.gatewayType);
      if (gt) nodeMetadata.gatewayType = gt;
      const sku = safeString((rprops.sku as { name?: unknown } | undefined)?.name);
      if (sku) nodeMetadata.sku = sku;
      if (safeString(rprops.vpnType)) nodeMetadata.vpnType = safeString(rprops.vpnType);
      if (typeof rprops.activeActive === "boolean") nodeMetadata.activeActive = rprops.activeActive;
      if (typeof rprops.enableBgp === "boolean") nodeMetadata.enableBgp = rprops.enableBgp;
    }
    // Private Endpoint: every connection's approval state (only Approved carries traffic — private-endpoint-overview)
    if (kind === "privateEndpoint") {
      const conns = [...safePropArray(rprops, "privateLinkServiceConnections"), ...safePropArray(rprops, "manualPrivateLinkServiceConnections")];
      nodeMetadata.connections = conns.map((c) => {
        const cp = ((c as Record<string, unknown>).properties ?? c) as Record<string, unknown>;
        return {
          targetId: safeString(cp.privateLinkServiceId)?.toLowerCase(),
          status: safeString((cp.privateLinkServiceConnectionState as { status?: unknown } | undefined)?.status) ?? "Unknown",
        };
      });
    }

    // Public IP — mark as absorbed (attached) or unused (not attached), and record the owner
    // (NIC / LB / App Gateway via its ip configuration, or a NAT Gateway)
    if (kind === "publicIP") {
      const props = (r.properties ?? {}) as Record<string, unknown>;
      const ipConfig = props.ipConfiguration as Record<string, unknown> | undefined;
      const natGatewayId = safeId((props.natGateway as Record<string, unknown> | undefined)?.id);
      if (ipConfig?.id) {
        nodeMetadata.absorbed = true;
        const owner = ownerResourceId(String(ipConfig.id));
        if (owner) nodeMetadata.attachedTo = owner;
      } else if (natGatewayId) {
        nodeMetadata.attachedTo = natGatewayId;
      } else {
        nodeMetadata.unused = true; // allocated but not attached to any resource
      }
    }

    // Subnet — store defaultOutboundAccess for outbound flow visualization
    if (kind === "subnet") {
      const props = (r.properties ?? {}) as Record<string, unknown>;
      if (props.defaultOutboundAccess != null) {
        nodeMetadata.defaultOutboundAccess = String(props.defaultOutboundAccess);
      }
      // Debug: log what property keys we have for subnets so we can verify CIDR extraction
      debug(`[azure] Subnet "${r.name}" props keys=[${Object.keys(props).join(",")}] addressPrefix=${safeString(props.addressPrefix)} endpoint=${extractEndpoint(r.type, r.name, r.properties)}`);
    }

    // AKS — store rich metadata for 3-plane diagram (접속면/실행면/노출면)
    if (kind === "aks") {
      const props = (r.properties ?? {}) as Record<string, unknown>;
      const accessProfile = props.apiServerAccessProfile as Record<string, unknown> | undefined;
      nodeMetadata.isPrivateCluster = !!accessProfile?.enablePrivateCluster;
      const privateFqdn = safeString(props.privateFQDN);
      if (privateFqdn) nodeMetadata.privateFqdn = privateFqdn;
      const fqdn = safeString(props.fqdn);
      if (fqdn) nodeMetadata.fqdn = fqdn;

      // API server access profile details
      if (accessProfile?.authorizedIPRanges) {
        nodeMetadata.authorizedIpRanges = accessProfile.authorizedIPRanges;
      }
      if (accessProfile?.enablePrivateClusterPublicFQDN != null) {
        nodeMetadata.enablePrivateClusterPublicFqdn = accessProfile.enablePrivateClusterPublicFQDN;
      }
      if (accessProfile?.privateDNSZone) {
        nodeMetadata.privateDnsZone = accessProfile.privateDNSZone;
      }

      // Agent pool profiles (실행면)
      const agentPools = props.agentPoolProfiles as Array<Record<string, unknown>> | undefined;
      if (agentPools && Array.isArray(agentPools)) {
        nodeMetadata.agentPoolProfiles = agentPools.map((ap) => ({
          name: safeString(ap.name),
          mode: safeString(ap.mode) || "User",
          vmSize: safeString(ap.vmSize),
          count: typeof ap.count === "number" ? ap.count : 0,
          minCount: typeof ap.minCount === "number" ? ap.minCount : undefined,
          maxCount: typeof ap.maxCount === "number" ? ap.maxCount : undefined,
          enableAutoScaling: !!ap.enableAutoScaling,
          osType: safeString(ap.osType) || "Linux",
          osSKU: safeString(ap.osSKU),
          orchestratorVersion: safeString(ap.orchestratorVersion),
          powerState: safeString((ap.powerState as Record<string, unknown>)?.code) || "Running",
          provisioningState: safeString(ap.provisioningState) || "Succeeded",
          availabilityZones: Array.isArray(ap.availabilityZones) ? ap.availabilityZones.map(String) : undefined,
          vnetSubnetId: safeString(ap.vnetSubnetID),
        }));
      }

      // Network profile (노출면)
      const netProfile = props.networkProfile as Record<string, unknown> | undefined;
      if (netProfile) {
        nodeMetadata.networkProfile = {
          networkPlugin: safeString(netProfile.networkPlugin) || "azure",
          networkPolicy: safeString(netProfile.networkPolicy) || undefined,
          serviceCidr: safeString(netProfile.serviceCidr),
          dnsServiceIp: safeString(netProfile.dnsServiceIP),
          podCidr: safeString(netProfile.podCidr),
          outboundType: safeString(netProfile.outboundType) || "loadBalancer",
          loadBalancerSku: safeString(netProfile.loadBalancerSku),
        };
      }

      // Node resource group (MC_* RG)
      const nodeRgName = safeString(props.nodeResourceGroup);
      if (nodeRgName) nodeMetadata.nodeResourceGroup = nodeRgName;

      // Kubernetes version
      const k8sVersion = safeString(props.kubernetesVersion);
      if (k8sVersion) nodeMetadata.kubernetesVersion = k8sVersion;
    }

    // Inbound rule count — backend-pool membership alone (e.g. the AKS outbound SNAT pool) is not an inbound path.
    // Left unset when the properties do not list rules, so callers can tell "0" from "unknown".
    // AGW: only listeners on a PUBLIC frontend that a routing rule uses count (catalog AGW-01, AGW-02) — private
    // listeners take traffic from inside the network, not from the Internet.
    if (kind === "lb" || kind === "appGateway") {
      const props = (r.properties ?? {}) as Record<string, unknown>;
      const frontends: Frontend[] = parseFrontends(kind, props, (id) => safeString(publicIpById.get(id)?.ipAddress));
      if (frontends.length) nodeMetadata.frontends = frontends;
      if (kind === "lb") {
        const lists = ["loadBalancingRules", "inboundNatRules", "inboundNatPools"].map((k) => props[k]);
        if (lists.some(Array.isArray)) nodeMetadata.inboundRules = lists.reduce<number>((n, l) => n + (Array.isArray(l) ? l.length : 0), 0);
        if (Array.isArray(props.outboundRules)) nodeMetadata.outboundRules = props.outboundRules.length;
        // Created by AKS (cloud provider) — the tag or the cluster's node resource group, never the name (AKS-03)
        if ((r.tags && r.tags["aks-managed-cluster-name"]) || (r.resourceGroup && aksNodeRgToId.has(r.resourceGroup.toLowerCase()))) nodeMetadata.managedBy = "aks";
      } else if (Array.isArray(props.httpListeners) || Array.isArray(props.listeners)) {
        const ruleBound = frontends.filter((f) => f.ruleBound);
        nodeMetadata.inboundRules = ruleBound.filter((f) => f.kind === "public").reduce((n, f) => n + f.listeners.length, 0);
        nodeMetadata.privateListeners = ruleBound.filter((f) => f.kind === "private").reduce((n, f) => n + f.listeners.length, 0);
        // AGW-08: WAF per rule-bound listener (path > listener > gateway policy, or the v1 configuration) — badge + panel
        const waf = resolveAgwWaf(props, wafById);
        if (waf) nodeMetadata.waf = waf;
      }
    }
    // Scale set: orchestration mode (Uniform instances are child resources, Flexible instances are ordinary VMs),
    // capacity, and whether AKS owns it (VMSS-01/03, AKS-02)
    if (kind === "vmss") {
      const props = (r.properties ?? {}) as Record<string, unknown>;
      const mode = safeString(props.orchestrationMode);
      if (mode) nodeMetadata.orchestrationMode = mode;
      const cap = r.sku?.capacity;
      if (typeof cap === "number") nodeMetadata.capacity = cap;
      if (r.resourceGroup && aksNodeRgToId.has(r.resourceGroup.toLowerCase())) nodeMetadata.managedBy = "aks";
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
        edges.push(relEdge("HIER-02", `e:rg->res:${rg}:${r.id}`, rg, r.id));
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
  // Resource Graph may return ipConfigurations in two formats:
  //   ARM format:      ipConfigurations[].properties.publicIPAddress.id
  //   RG flat format:  ipConfigurations[].publicIPAddress.id
  // Every ip configuration is read (a secondary one may hold the public IP). PIP-01: the NIC ip configuration names
  // the public IP; PIP-04: whether the Internet may connect through it — subnet NSG then NIC NSG (nsgExposure.ts).
  const cfgProp = (cfg: Record<string, unknown>, key: string): unknown =>
    (cfg.properties as Record<string, unknown> | undefined)?.[key] ?? cfg[key];
  const nsgById = new Map<string, NsgInput>();
  const subnetNet = new Map<string, { nsg: string | null; routeTable: string | null }>();
  for (const r of resRows) {
    const t = (r.type ?? "").toLowerCase();
    if (t === "microsoft.network/networksecuritygroups" && r.id) nsgById.set(r.id, (r.properties ?? {}) as NsgInput);
    const subnets = t === "microsoft.network/virtualnetworks" ? safePropArray(r.properties, "subnets")
      : t === "microsoft.network/virtualnetworks/subnets" ? [{ id: r.id, properties: r.properties }] : [];
    for (const sn of subnets as Array<Record<string, unknown>>) {
      const id = safeId(sn.id);
      if (!id) continue;
      subnetNet.set(id, {
        nsg: safeId((cfgProp(sn, "networkSecurityGroup") as { id?: unknown } | undefined)?.id) ?? null,
        routeTable: safeId((cfgProp(sn, "routeTable") as { id?: unknown } | undefined)?.id) ?? null,
      });
    }
  }
  const widenedRouteTables = new Set<string>();
  for (const r of exposureRows ?? []) {
    if ((r.type ?? "").toLowerCase() === "microsoft.network/routetables" && r.id && routesWidenVnetTag(safePropArray(r.properties, "routes"))) {
      widenedRouteTables.add(r.id.toLowerCase());
    }
  }
  const avnmPresent = (exposureRows ?? []).some((r) => (r.type ?? "").toLowerCase() === "microsoft.network/networkmanagers");
  const pipSku = new Map<string, string>();
  for (const r of resRows) {
    if ((r.type ?? "").toLowerCase() !== "microsoft.network/publicipaddresses" || !r.id) continue;
    const sku = safeString((r.sku as { name?: unknown } | undefined)?.name);
    if (sku) pipSku.set(r.id.toLowerCase(), sku);
  }
  /** NSG document, null = none associated, undefined = associated but not readable */
  const nsgDoc = (id: string | null | undefined): NsgInput => (id == null ? null : nsgById.get(id) ?? undefined);
  const vmExposures = new Map<string, InboundExposure[]>();

  for (const node of nodes) {
    if (node.kind !== "nic") continue;
    const r = nicById.get(node.id);
    if (!r) continue;
    const props = (r.properties ?? {}) as Record<string, unknown>;
    const ipCfgs = (props.ipConfigurations ?? []) as Array<Record<string, unknown>>;
    const nicNsgId = safeId((props.networkSecurityGroup as { id?: unknown } | undefined)?.id) ?? null;
    const publicIPs: Array<{ id: string; sku?: string }> = [];
    const exposures: InboundExposure[] = [];
    for (const cfg of ipCfgs) {
      const pubRef = safeId((cfgProp(cfg, "publicIPAddress") as { id?: unknown } | undefined)?.id);
      if (!pubRef) continue;
      publicIPs.push({ id: pubRef, ...(pipSku.has(pubRef) ? { sku: pipSku.get(pubRef) } : {}) });
      const subnetId = safeId((cfgProp(cfg, "subnet") as { id?: unknown } | undefined)?.id);
      const sn = subnetId ? subnetNet.get(subnetId) : undefined;
      const asgs = cfgProp(cfg, "applicationSecurityGroups");
      exposures.push(internetInboundExposure(sn ? nsgDoc(sn.nsg) : undefined, nsgDoc(nicNsgId), {
        privateIp: safeString(cfgProp(cfg, "privateIPAddress")),
        asgIds: (Array.isArray(asgs) ? asgs : []).map((x) => safeId((x as { id?: unknown }).id)).filter((x): x is string => !!x),
        pipSku: pipSku.get(pubRef),
        vnetTagWidened: !!(sn?.routeTable && widenedRouteTables.has(sn.routeTable)),
        // Route tables / managers could not be read: the verdict cannot rule them out
        avnmPresent: avnmPresent || exposureRows === null,
      }));
    }
    const pubRef = publicIPs[0]?.id;
    if (!pubRef) continue;
    const pubIp = safeString(publicIpById.get(pubRef)?.ipAddress);
    const exposure = mostExposed(exposures);
    // Always record the ARM ID reference so specGenerator can absorb this NIC into the PIP card.
    // pubIp may be absent for dynamic/unallocated PIPs — that's fine, we still need the link.
    node.metadata = {
      ...node.metadata, publicIPAzureId: pubRef, publicIPs, ...(pubIp ? { publicIP: pubIp } : {}),
      ...(exposure ? { inboundExposure: exposure } : {}),
    };
    const vmId = safeId((props.virtualMachine as { id?: unknown } | undefined)?.id);
    if (vmId && exposure) (vmExposures.get(vmId) ?? vmExposures.set(vmId, []).get(vmId)!).push(exposure);
    debug(`[azure] NIC "${node.name}" → PIP ref=${pubRef.split("/").pop()} ip=${pubIp || "(unallocated)"} exposure=${exposure?.state ?? "-"}`);
  }
  for (const node of nodes) {
    const list = node.kind === "vm" ? vmExposures.get(node.id) : undefined;
    const e = list ? mostExposed(list) : undefined;
    if (e) node.metadata = { ...node.metadata, inboundExposure: e };
  }

  // NAT Gateway: resolve actual public IP from publicIpById, then create subnet→natGateway edges
  for (const node of nodes) {
    if (node.kind !== "natGateway") continue;
    const r = resourceById.get(node.id);
    if (!r) continue;
    const props = (r.properties ?? {}) as Record<string, unknown>;

    // Resolve the first public IP address from the attached publicIpAddresses list
    const pips = (props.publicIpAddresses ?? []) as Array<{ id?: string }>;
    if (pips.length > 0) {
      const pipId = safeId(pips[0]?.id);
      const resolvedIp = pipId ? safeString(publicIpById.get(pipId)?.ipAddress) : undefined;
      if (resolvedIp) node.endpoint = resolvedIp;
      // Store pip count as metadata
      node.metadata = { ...node.metadata, publicIpCount: pips.length };
    }

    // Create subnet → natGateway edges for each subnet attached to this NAT GW
    const attachedSubnets = (props.subnets ?? []) as Array<{ id?: string }>;
    for (const sub of attachedSubnets) {
      const subnetId = safeId(sub.id);
      if (!subnetId) continue;
      edges.push(relEdge("EDGE-01", `e:subnet->natgw:${subnetId}:${node.id}`, subnetId, node.id));
    }

    // Create natGateway → publicIP edges (pip becomes sub-resource in diagram)
    for (const pip of pips) {
      const pipId = safeId(pip.id);
      if (!pipId) continue;
      edges.push(relEdge("PIP-02", `e:natgw->pip:${node.id}:${pipId}`, node.id, pipId));
    }
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
    debug(`[azure] VNet "${r.name}" (${r.id.split("/").pop()}) has ${vnetSubnetsArr.length} embedded subnets`);
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
        const subPropsObj = subProps as Record<string, unknown> | undefined;
        const subMeta: Record<string, unknown> = {};
        if (subPropsObj?.defaultOutboundAccess != null) {
          subMeta.defaultOutboundAccess = String(subPropsObj.defaultOutboundAccess);
        }
        nodes.push({
          id: subId,
          kind: "subnet",
          name: subName,
          azureId: subId,
          location: r.location,
          endpoint,
          resourceGroup: r.resourceGroup,
          health: "unknown",
          ...(Object.keys(subMeta).length > 0 ? { metadata: subMeta } : {}),
        });
      }

      // Ensure VNet→Subnet contains edge exists
      const edgeId = `e:vnet->subnet:${r.id}:${subId}`;
      if (!edgeIdSet.has(edgeId)) {
        edgeIdSet.add(edgeId);
        edges.push(relEdge("CT-01", edgeId, r.id, subId));
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
      debug(`[azure]   Subnet "${subLabel}" has ${subnetIpConfigs.length} ipConfigurations (props=${!!subObj.properties}, flat=${Array.isArray(subObj.ipConfigurations)})`);
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
          edges.push(relEdge("CT-02", nicEdgeId, subId, nicId));
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
      edges.push(relEdge("CT-01", edgeId, parentVnetId, r.id));
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
      debug(`[azure] NIC "${firstNic.name}" ipConfigurations[0] keys: [${keys.join(", ")}]`);
      // Check which format: nested (.properties.subnet.id) or flat (.subnet.id)
      const hasNestedProps = first.properties != null;
      const hasFlatSubnet = first.subnet != null;
      debug(`[azure] NIC format: hasNestedProperties=${hasNestedProps}, hasFlatSubnet=${hasFlatSubnet}`);
      if (hasNestedProps) {
        const nested = first.properties as Record<string, unknown>;
        debug(`[azure] NIC .properties keys: [${Object.keys(nested).join(", ")}]`);
      }
    } else {
      debug(`[azure] NIC "${firstNic.name}" has no ipConfigurations array`);
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
        edges.push(relEdge("CT-02", nicEdgeId, subnetId, nic.id));
        nicSubnetEdgeCount++;
        // Check if the subnet node actually exists in graph
        const subnetExists = nodes.some(n => n.id === subnetId);
        debug(`[azure] NIC→Subnet: "${nic.name}" → subnet "${subnetId.split("/").pop()}" (subnetInGraph=${subnetExists})`);
      }
    } else {
      nicSubnetMissCount++;
      debug(`[azure] NIC "${nic.name}" has NO subnet reference in properties`);
    }
  }
  debug(`[azure] NIC→Subnet edges: ${nicSubnetEdgeCount} created, ${nicSubnetMissCount} missing subnet ref`);

  // ── Who holds an address: NIC / PE / LB frontend private IPs (with their VNet), public IPs (their owner), and
  // App Service / Container App host names — for backend-pool members named by IP or FQDN (AGW-04/05, LB-03)
  const vnetOfSubnet = (subnetId: string | undefined) => (subnetId && subnetId.includes("/subnets/") ? subnetId.slice(0, subnetId.indexOf("/subnets/")).toLowerCase() : undefined);
  const addressEntries: AddressEntry[] = [];
  const nicPrimaryIp = new Map<string, string>();
  for (const nic of nicById.values()) {
    const np = (nic.properties ?? {}) as Record<string, unknown>;
    const pe = safeId((np.privateEndpoint as { id?: unknown } | undefined)?.id);
    for (const c of safePropArray(np, "ipConfigurations")) {
      const cp = ((c as Record<string, unknown>).properties ?? c) as Record<string, unknown>;
      const ip = safeString(cp.privateIPAddress);
      if (!ip) continue;
      if (!nicPrimaryIp.has(nic.id)) nicPrimaryIp.set(nic.id, ip);
      const vnetId = vnetOfSubnet(safeId((cp.subnet as { id?: unknown } | undefined)?.id));
      addressEntries.push(pe && resourceById.has(pe) ? { address: ip, targetId: pe, vnetId, source: "pe" } : { address: ip, targetId: nic.id, vnetId, source: "nic" });
    }
  }
  for (const r of resRows) {
    if (!r.id) continue;
    const t = (r.type ?? "").toLowerCase();
    const rp = (r.properties ?? {}) as Record<string, unknown>;
    if (t === "microsoft.network/loadbalancers") {
      for (const fe of safePropArray(rp, "frontendIPConfigurations")) {
        const fp = ((fe as Record<string, unknown>).properties ?? fe) as Record<string, unknown>;
        const ip = safeString(fp.privateIPAddress);
        if (ip) addressEntries.push({ address: ip, targetId: r.id, vnetId: vnetOfSubnet(safeId((fp.subnet as { id?: unknown } | undefined)?.id)), source: "lbFrontend" });
      }
    } else if (t === "microsoft.network/publicipaddresses") {
      const ip = safeString(rp.ipAddress);
      const owner = safeId((rp.ipConfiguration as { id?: unknown } | undefined)?.id);
      const ownerId = owner ? ownerResourceId(owner) : undefined;
      if (ip && ownerId) addressEntries.push({ address: ip, targetId: ownerId, source: "pip" });
      const fqdn = safeString((rp.dnsSettings as { fqdn?: unknown } | undefined)?.fqdn);
      if (fqdn && ownerId) addressEntries.push({ address: fqdn.toLowerCase(), targetId: ownerId, source: "pipFqdn" });
    } else if (t === "microsoft.servicenetworking/trafficcontrollers") {
      for (const fe of agcByController.get(r.id)?.frontends ?? []) if (fe.fqdn) addressEntries.push({ address: fe.fqdn, targetId: r.id, source: "agcFrontend" });
    } else if (t === "microsoft.web/sites") {
      const names = new Set([safeString(rp.defaultHostName), ...((Array.isArray(rp.hostNames) ? rp.hostNames : []) as unknown[]).map(safeString)].filter((x): x is string => !!x));
      for (const n of names) addressEntries.push({ address: n.toLowerCase(), targetId: r.id, source: "site" });
    } else if (t === "microsoft.app/containerapps") {
      const fqdn = safeString((rp.configuration as { ingress?: { fqdn?: unknown } } | undefined)?.ingress?.fqdn);
      if (fqdn) addressEntries.push({ address: fqdn.toLowerCase(), targetId: r.id, source: "containerApp" });
    }
  }
  const addressIndex = buildAddressIndex(addressEntries);
  const knownIds = new Set(resourceById.keys());

  // ── CT-07: VPN/ER gateway and Bastion in their dedicated subnet (their public IPs fold in by PIP-01) ──
  for (const r of resRows) {
    const t = (r.type ?? "").toLowerCase();
    if (!r.id || (t !== "microsoft.network/virtualnetworkgateways" && t !== "microsoft.network/bastionhosts")) continue;
    const sn = safePropArray(r.properties, "ipConfigurations")
      .map((c) => safeId((((c as Record<string, unknown>).properties ?? c) as { subnet?: { id?: unknown } }).subnet?.id))
      .find((x): x is string => !!x);
    if (sn && resourceById.has(sn)) edges.push(relEdge("CT-07", `e:subnet->gw:${sn}:${r.id}`, sn, r.id));
  }

  // ── S2S connections → VNet gateway (EDGE-08) with their local network gateway (EDGE-09) ──
  {
    const lngById = new Map(hybridRows.filter((r) => (r.type ?? "").toLowerCase() === "microsoft.network/localnetworkgateways" && r.id).map((r) => [r.id.toLowerCase(), r]));
    const byGateway = new Map<string, unknown[]>();
    for (const c of hybridRows) {
      if ((c.type ?? "").toLowerCase() !== "microsoft.network/connections" || !c.id) continue;
      const cp = (c.properties ?? {}) as Record<string, unknown>;
      if (safeString(cp.connectionType) !== "IPsec") continue; // VNet-to-VNet / ExpressRoute: next scope
      const gw = safeId((cp.virtualNetworkGateway1 as { id?: unknown } | undefined)?.id);
      const lngId = safeId((cp.localNetworkGateway2 as { id?: unknown } | undefined)?.id);
      if (!gw) continue;
      const lng = lngId ? lngById.get(lngId) : undefined;
      const lp = (lng?.properties ?? {}) as Record<string, unknown>;
      const prefixes = (lp.localNetworkAddressSpace as { addressPrefixes?: unknown } | undefined)?.addressPrefixes;
      const tunnels = Array.isArray(cp.tunnelConnectionStatus)
        ? (cp.tunnelConnectionStatus as Array<Record<string, unknown>>).map((t) => ({ tunnel: safeString(t.tunnel) ?? "", status: safeString(t.connectionStatus) ?? "Unknown", lastConnected: safeString(t.lastConnectionEstablishedUtcTime) }))
        : null;
      const nat = (Array.isArray(cp.ingressNatRules) && cp.ingressNatRules.length > 0) || (Array.isArray(cp.egressNatRules) && cp.egressNatRules.length > 0);
      const list = byGateway.get(gw) ?? byGateway.set(gw, []).get(gw)!;
      list.push({
        connectionId: c.id, name: c.name ?? c.id.split("/").pop(), type: "IPsec",
        // read when the topology was read (Resource Graph) — not live
        status: safeString(cp.connectionStatus) ?? "Unknown", protocol: safeString(cp.connectionProtocol) ?? null,
        enableBgp: cp.enableBgp === true, policyBased: cp.usePolicyBasedTrafficSelectors === true,
        connectionMode: safeString(cp.connectionMode) ?? null, dpd: typeof cp.dpdTimeoutSeconds === "number" ? cp.dpdTimeoutSeconds : null,
        ingressBytes: typeof cp.ingressBytesTransferred === "number" ? cp.ingressBytesTransferred : null,
        egressBytes: typeof cp.egressBytesTransferred === "number" ? cp.egressBytesTransferred : null,
        tunnels, nat,
        lng: lng ? {
          id: lng.id, name: lng.name ?? lng.id.split("/").pop(),
          prefixes: Array.isArray(prefixes) ? prefixes.map(String) : [],
          peerIp: safeString(lp.gatewayIpAddress) ?? null, fqdn: safeString(lp.fqdn) ?? null,
          bgp: !!lp.bgpSettings || cp.enableBgp === true,
        } : null,
      });
    }
    for (const n of nodes) {
      const list = n.kind === "vnetGateway" ? byGateway.get(n.id) : undefined;
      if (list?.length) n.metadata = { ...n.metadata, s2s: list };
    }
  }

  // ── Application Gateway for Containers: children folded in (AGC-02), delegated subnet (AGC-01), cluster (AGC-04) ──
  const clusterFacts = resRows
    .filter((r) => r.id && (r.type ?? "").toLowerCase() === "microsoft.containerservice/managedclusters")
    .map((r) => ({
      id: r.id,
      nodeResourceGroup: safeString((r.properties as Record<string, unknown> | undefined)?.nodeResourceGroup),
      vnetIds: new Set(safePropArray(r.properties, "agentPoolProfiles").map((ap) => vnetOfSubnet(safeString((ap as { vnetSubnetID?: unknown }).vnetSubnetID)?.toLowerCase())).filter((x): x is string => !!x)),
    }));
  for (const n of nodes) {
    if (n.kind !== "agc") continue;
    const f = agcByController.get(n.id) ?? { associations: [], frontends: [] };
    const publicFrontends = f.frontends.filter((fe) => fe.public && (!fe.state || fe.state === "Succeeded")).length;
    n.metadata = {
      ...n.metadata, associations: f.associations, frontends: f.frontends, publicFrontends,
      ...(f.wafPolicyId ? { wafPolicyId: f.wafPolicyId } : {}),
    };
    if (!n.endpoint) n.endpoint = f.frontends.find((fe) => fe.fqdn)?.fqdn;
    const vnetIds = new Set<string>();
    for (const a of f.associations) {
      if (!a.subnetId) continue;
      const v = vnetOfSubnet(a.subnetId);
      if (v) vnetIds.add(v);
      if (resourceById.has(a.subnetId)) edges.push(relEdge("AGC-01", `e:subnet->agc:${a.subnetId}:${n.id}`, a.subnetId, n.id));
    }
    const cluster = resolveAgcCluster({ resourceGroup: n.resourceGroup ?? "", vnetIds }, clusterFacts);
    if ("targetId" in cluster) edges.push(relEdge("AGC-04", `e:agc->aks:${n.id}:${cluster.targetId}`, n.id, cluster.targetId, { evidence: cluster.evidence, direction: "inbound" }));
    else n.metadata = { ...n.metadata, clusterCandidates: cluster.candidates };
  }

  // ── Front Door Standard/Premium: routes and origins (ARM children), origins → resources: EDGE-07 Private Link,
  // EDGE-06 azureOrigin, EDGE-05 public IP owner, EDGE-04 host name (frontDoorConfig.ts resolveAfdOrigins) ──
  const nodeName = (id: string) => nodes.find((n) => n.id === id)?.name ?? id.split("/").pop() ?? id;
  const afdProfiles = nodes.filter((n) => n.kind === "frontDoor" && /\/providers\/microsoft\.cdn\/profiles\//i.test(n.id));
  if (afdProfiles.length) {
    const vmOfNic = (id: string) => safeId(((nicById.get(id)?.properties ?? {}) as { virtualMachine?: { id?: unknown } }).virtualMachine?.id) ?? id;
    const fetcher = await getArmFetcherAuto(env, bearerToken).catch(() => null);
    const key = bearerToken ? cachePrefix(bearerToken) : "anon";
    await Promise.all(afdProfiles.map(async (fd) => {
      try {
        if (!fetcher) throw new Error("no fetcher");
        const cfg = await fetchFrontDoorConfig(fetcher, fd.azureId ?? fd.id, key);
        const res = resolveAfdOrigins(cfg, addressIndex, knownIds, vmOfNic);
        for (const l of res.links) {
          edges.push(relEdge(l.rel, `e:afd->origin:${fd.id}:${l.group}:${l.origin}:${l.targetId}`, fd.id, l.targetId, { evidence: l.evidence, pool: l.group, origin: l.origin, direction: "inbound", ...(l.status ? { status: l.status } : {}) }));
        }
        fd.metadata = {
          ...fd.metadata, endpoints: cfg.endpoints.length, activeRoutes: activeRoutes(cfg).length,
          // EDGE-10 / EDGE-11: WAF per served domain (security policy → WAF policy); chip + panel, not a node
          waf: resolveAfdWaf(fd.azureId ?? fd.id, cfg, wafById),
          origins: cfg.origins.length, externalOrigins: res.external, ambiguousOrigins: res.ambiguous,
          endpointHosts: cfg.endpoints.filter((e) => e.enabled).map((e) => e.hostName).slice(0, 10),
          // Every origin by name for the panel: its group, host, state and the resource it was matched to (if any)
          originList: cfg.origins.slice(0, 100).map((o) => {
            const link = res.links.find((l) => l.origin === o.name && l.group === o.group);
            const used = cfg.routes.some((r) => r.enabled && r.originGroup === o.group);
            return {
              name: o.name, group: o.group, host: o.hostName,
              state: !o.enabled ? "disabled" : !used ? "unrouted" : link ? "linked" : "external",
              ...(link ? { target: nodeName(link.targetId), rel: link.rel } : {}),
            };
          }),
        };
      } catch (e) {
        fd.metadata = { ...fd.metadata, configUnreadable: true };
        debug(`[afd] config of ${fd.name} not read: ${String(e).slice(0, 120)}`);
      }
    }));
  }
  // VNets a gateway's private backends may sit in: its own and the peers in state Connected (AGW-04)
  const connectedPeers = new Map<string, Set<string>>();
  for (const r of resRows) {
    if (!r.id || (r.type ?? "").toLowerCase() !== "microsoft.network/virtualnetworks") continue;
    for (const pe of safePropArray(r.properties, "virtualNetworkPeerings")) {
      if ((safePropString(pe, "properties", "peeringState") ?? "").toLowerCase() !== "connected") continue;
      const remote = safePropString(pe, "properties", "remoteVirtualNetwork", "id")?.toLowerCase();
      if (!remote) continue;
      (connectedPeers.get(r.id) ?? connectedPeers.set(r.id, new Set()).get(r.id)!).add(remote);
    }
  }
  const scopeOf = (subnetIds: string[]) => {
    const out = new Set<string>();
    for (const sid of subnetIds) {
      const v = vnetOfSubnet(sid);
      if (!v) continue;
      out.add(v);
      for (const peer of connectedPeers.get(v) ?? []) out.add(peer);
    }
    return out;
  };
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  type Unresolved = { pool: string; address: string; reason: string };
  const noteUnresolved = (gwId: string, u: Unresolved) => {
    const n = nodeById.get(gwId);
    if (!n) return;
    const list = ((n.metadata ??= {}).unresolvedBackends ?? []) as Unresolved[];
    list.push(u);
    n.metadata.unresolvedBackends = list;
  };
  // Pool members → edges; one edge per (gateway, pool, target), a NIC reference wins over an address match
  const backendEdges = new Map<string, ArchitectureEdge>();
  /** `${gateway}|${pool lowercase}` → rules sending traffic IN to the pool (0 = none; absent = unknown) */
  const poolInbound = new Map<string, number>();
  const addBackend = (gwKind: "appGateway" | "lb", gwId: string, pool: string, ports: number[], member: Parameters<typeof resolveMember>[0], scope: Set<string>) => {
    const res = resolveMember(member, scope, addressIndex, knownIds);
    if ("unresolved" in res) {
      noteUnresolved(gwId, { pool, address: member.address ?? member.ref?.split("/").pop() ?? "", reason: res.unresolved });
      return;
    }
    const rel = gwKind === "appGateway" ? (member.via === "nic" ? "AGW-03" : member.via === "ip" ? "AGW-04" : "AGW-05") : (member.via === "nic" ? "LB-02" : "LB-03");
    const key = `${gwId}|${pool}|${res.targetId}`;
    const prev = backendEdges.get(key);
    if (prev && prev.metadata?.via === "nic") return;
    const address = member.address ?? (member.ref ? nicPrimaryIp.get(member.ref) : undefined);
    backendEdges.set(key, relEdge(rel, `e:be:${gwId}:${pool}:${res.targetId}`, gwId, res.targetId, {
      via: member.via, pool, evidence: res.evidence, direction: "inbound",
      ...(address ? { address } : {}), ...(ports.length ? { ports } : {}), ...(gwKind === "lb" ? { protocol: "TCP" } : {}),
    }));
  };

  let nicVmEdgeCount = 0;
  for (const r of resRows) {
    if (!r.id) continue;
    const t = (r.type ?? "").toLowerCase();
    if (t === "microsoft.compute/virtualmachines") {
      const nicIds = getNicIdsFromVmProps(r.properties);
      for (const nicId of nicIds) {
        if (!nicById.has(nicId)) {
          debug(`[azure] VM "${r.name}" references NIC "${nicId.split("/").pop()}" but NIC not in graph`);
          continue;
        }
        edges.push(relEdge("CT-03", `e:nic->vm:${nicId}:${r.id}`, nicId, r.id));
        nicVmEdgeCount++;
        debug(`[azure] NIC→VM: "${nicId.split("/").pop()}" → VM "${r.name}"`);
      }
      if (nicIds.length === 0) {
        debug(`[azure] VM "${r.name}" has NO NIC references in properties`);
      }
      // Flexible orchestration: the instance is an ordinary VM that names its scale set (VMSS-03)
      const scaleSet = safeId(((r.properties ?? {}) as { virtualMachineScaleSet?: { id?: unknown } }).virtualMachineScaleSet?.id);
      if (scaleSet && resourceById.has(scaleSet)) edges.push(relEdge("VMSS-03", `e:vm->vmss:${r.id}:${scaleSet}`, r.id, scaleSet));
    }
    if (t === "microsoft.containerservice/managedclusters") {
      for (const subnetId of getSubnetIdsFromAksProps(r.properties)) {
        edges.push(relEdge("AKS-01", `e:subnet->aks:${subnetId}:${r.id}`, subnetId, r.id));
      }
    }
    if (t === "microsoft.compute/virtualmachinescalesets") {
      for (const subnetId of getSubnetIdsFromVmssProps(r.properties)) {
        edges.push(relEdge("VMSS-02", `e:subnet->vmss:${subnetId}:${r.id}`, subnetId, r.id));
      }
      // Uniform: the scale-set MODEL references LB / AGW pools — instances not yet upgraded to the model may be
      // missing from the pool, so this is weaker than the pool's own member list (VMSS-04). Flexible: membership
      // is on each instance NIC, read from the pool (LB-02 / AGW-03).
      const vp = (r.properties ?? {}) as Record<string, unknown>;
      if (safeString(vp.orchestrationMode)?.toLowerCase() !== "flexible") {
        const nicCfgs = safePropArray((vp.virtualMachineProfile as Record<string, unknown> | undefined)?.networkProfile, "networkInterfaceConfigurations");
        for (const nc of nicCfgs) {
          const ncp = ((nc as Record<string, unknown>).properties ?? nc) as Record<string, unknown>;
          for (const ic of safePropArray(ncp, "ipConfigurations")) {
            const icp = ((ic as Record<string, unknown>).properties ?? ic) as Record<string, unknown>;
            for (const k of ["loadBalancerBackendAddressPools", "applicationGatewayBackendAddressPools"]) {
              for (const pool of safePropArray(icp, k)) {
                const poolId = safeId((pool as { id?: unknown }).id);
                const gw = poolId ? ownerResourceId(poolId) : undefined;
                if (!gw || !resourceById.has(gw)) continue;
                const poolName = poolId!.split("/").pop() ?? "";
                const key = `${gw}|${poolName}|${r.id}`;
                if (!backendEdges.has(key)) backendEdges.set(key, relEdge("VMSS-04", `e:be:${gw}:${poolName}:${r.id}`, gw, r.id, { via: "vmssModel", pool: poolName, evidence: "cfg", direction: "inbound" }));
              }
            }
          }
        }
      }
      // AKS → VMSS ownership: VMSS in the AKS nodeResourceGroup (MC_*) belongs to the cluster
      const aksOwner = r.resourceGroup ? aksNodeRgToId.get(r.resourceGroup.toLowerCase()) : undefined;
      if (aksOwner) {
        edges.push(relEdge("AKS-02", `e:aks->vmss:${aksOwner}:${r.id}`, aksOwner, r.id));
      }
    }
    if (t === "microsoft.network/applicationgateways") {
      const gwSubnets = getSubnetIdsFromAppGatewayProps(r.properties);
      for (const subnetId of gwSubnets) {
        edges.push(relEdge("CT-04", `e:subnet->appgw:${subnetId}:${r.id}`, subnetId, r.id));
      }
      // Backend pools: NIC references, IP addresses and FQDNs (AGW-03/04/05); only pools a rule uses carry traffic
      const scope = scopeOf(gwSubnets);
      for (const pool of parsePools("appGateway", r.properties)) {
        poolInbound.set(`${r.id}|${pool.name.toLowerCase()}`, pool.inboundRuleRefs ?? 0);
        if (pool.inboundRuleRefs === 0) continue;
        for (const m of pool.members) addBackend("appGateway", r.id, pool.name, pool.ports, m, scope);
      }
    }
    if (t === "microsoft.network/loadbalancers") {
      const lbSubnets = getSubnetIdsFromLoadBalancerProps(r.properties);
      for (const subnetId of lbSubnets) {
        edges.push(relEdge("CT-05", `e:subnet->lb:${subnetId}:${r.id}`, subnetId, r.id));
      }
      // Pools: inbound lines only for pools a load-balancing / inbound NAT rule uses (LB-04) — the AKS "kubernetes"
      // pool used only by an outbound rule is not an inbound path. SNAT (backend → LB) only for NIC-based pools with
      // an outbound rule (LB-06; IP-based pools use default outbound access).
      const lbScope = scopeOf(lbSubnets);
      const lbInbound = nodeById.get(r.id)?.metadata?.inboundRules;
      const snatSeen = new Set<string>();
      for (const pool of parsePools("lb", r.properties)) {
        // Resource Graph omits empty rule arrays: an unknown pool count falls back to the LB's own (0 → none)
        const inbound = pool.inboundRuleRefs ?? (lbInbound === 0 ? 0 : null);
        if (inbound != null) poolInbound.set(`${r.id}|${pool.name.toLowerCase()}`, inbound);
        if (inbound !== 0) for (const m of pool.members) addBackend("lb", r.id, pool.name, [], m, lbScope);
        if ((pool.outboundRuleRefs ?? 0) > 0) {
          for (const m of pool.members) {
            if (m.via !== "nic") continue;
            const res = resolveMember(m, lbScope, addressIndex, knownIds);
            if ("unresolved" in res || snatSeen.has(`${res.targetId}|${pool.name}`)) continue;
            snatSeen.add(`${res.targetId}|${pool.name}`);
            edges.push(relEdge("LB-06", `e:snat:${res.targetId}:${r.id}:${pool.name}`, res.targetId, r.id, { protocol: "SNAT", pool: pool.name, via: "nic", evidence: "cfg", direction: "outbound" }));
          }
        }
      }
    }
    if (t === "microsoft.network/privateendpoints") {
      const subnetId = getSubnetIdFromPrivateEndpointProps(r.properties);
      if (subnetId) {
        edges.push(relEdge("CT-06", `e:subnet->pe:${subnetId}:${r.id}`, subnetId, r.id));
      }

      for (const targetId of getPrivateLinkTargetIdsFromPrivateEndpointProps(r.properties)) {
        if (!resourceById.has(targetId)) continue;
        edges.push(relEdge("PL-01", `e:pe->target:${r.id}:${targetId}`, r.id, targetId));
      }
    }
  }

  debug(`[azure] NIC→VM edges: ${nicVmEdgeCount} created`);
  // A scale-set model reference to a pool no rule uses is not an inbound path either (VMSS-04 + LB-04)
  edges.push(...[...backendEdges.values()].filter((e) => !(e.metadata?.via === "vmssModel" && poolInbound.get(`${e.source}|${(e.metadata.pool ?? "").toLowerCase()}`) === 0)));

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
          // Only add one direction (lower ID → higher ID) to avoid duplicates; each side's state is kept and the
          // line carries the worse one (a peering works only when both sides are Connected)
          if (r.id < remoteId) {
            const back = safePropArray(resourceById.get(remoteId)?.properties, "virtualNetworkPeerings")
              .find((x) => safePropString(x, "properties", "remoteVirtualNetwork", "id")?.toLowerCase() === r.id);
            const stateB = back ? safePropString(back, "properties", "peeringState") ?? "Unknown" : undefined;
            const rank = (x?: string) => (x === "Connected" ? 0 : x === "Initiated" ? 1 : x === "Disconnected" ? 2 : 3);
            const worse = stateB != null && rank(stateB) > rank(peerState) ? stateB : peerState;
            edges.push(relEdge("EDGE-02", edgeId, r.id, remoteId, { peeringState: worse, stateA: peerState, ...(stateB != null ? { stateB } : {}) }));
          }
        }
      }
    }

    // 14. App Service / Function App → Subnet (VNet Integration)
    if (t === "microsoft.web/sites") {
      const vnetSubnetId = safePropString(r.properties, "virtualNetworkSubnetId")?.toLowerCase();
      if (vnetSubnetId && resourceById.has(vnetSubnetId)) {
        edges.push(relEdge("PAAS-01", `e:site->subnet:${r.id}:${vnetSubnetId}`, vnetSubnetId, r.id));
      }
    }

    // PaaS inside a subnet only through an explicit placement property (not service-endpoint rules):
    // PostgreSQL / MySQL Flexible private access = a delegated subnet (PAAS-02), Redis Premium injection (PAAS-04)
    if (t === "microsoft.dbforpostgresql/flexibleservers" || t === "microsoft.dbformysql/flexibleservers") {
      const sid = safePropString(r.properties, "network", "delegatedSubnetResourceId")?.toLowerCase();
      if (sid && resourceById.has(sid)) edges.push(relEdge("PAAS-02", `e:subnet->flex:${sid}:${r.id}`, sid, r.id));
    }
    if (t === "microsoft.cache/redis") {
      const sid = safePropString(r.properties, "subnetId")?.toLowerCase();
      if (sid && resourceById.has(sid)) edges.push(relEdge("PAAS-04", `e:subnet->redis:${sid}:${r.id}`, sid, r.id));
    }

    // 15–16. NSG → Subnet / NIC associations
    if (t === "microsoft.network/networksecuritygroups") {
      const nsgSubnets = safePropArray(r.properties, "subnets");
      for (const s of nsgSubnets) {
        const subnetRef = safeId(typeof s === "object" && s !== null ? (s as Record<string, unknown>).id : undefined);
        if (subnetRef && resourceById.has(subnetRef)) {
          edges.push(relEdge("SEC-01", `e:nsg->subnet:${r.id}:${subnetRef}`, r.id, subnetRef));
        }
      }
      const nsgNics = safePropArray(r.properties, "networkInterfaces");
      for (const n of nsgNics) {
        const nicRef = safeId(typeof n === "object" && n !== null ? (n as Record<string, unknown>).id : undefined);
        if (nicRef && nicById.has(nicRef)) {
          edges.push(relEdge("SEC-01", `e:nsg->nic:${r.id}:${nicRef}`, r.id, nicRef));
        }
      }
    }

    // 17. App Insights → Log Analytics Workspace
    if (t === "microsoft.insights/components") {
      const workspaceId = (safePropString(r.properties, "WorkspaceResourceId")
        ?? safePropString(r.properties, "workspaceResourceId"))?.toLowerCase();
      if (workspaceId && resourceById.has(workspaceId)) {
        edges.push(relEdge("LOG-02", `e:ai->la:${r.id}:${workspaceId}`, r.id, workspaceId));
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
        edges.push(relEdge("LOG-01", `e:diag->la:${sourceResourceId}:${workspaceId}:${ds.name}`, sourceResourceId, workspaceId, { diagnosticCategory: category }));
      }
      if (storageId && resourceById.has(storageId)) {
        edges.push(relEdge("LOG-01", `e:diag->sa:${sourceResourceId}:${storageId}:${ds.name}`, sourceResourceId, storageId, { diagnosticCategory: "Archive" }));
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
  debug(`[subnet-discovery] Source (a) NIC properties: ${discoveredSubnetIds.size} subnet IDs`);

  // ── Source (b): VNet.properties.subnets[].id ──
  // Also capture addressPrefix so discovered subnet nodes get their CIDR displayed.
  const subnetAddressPrefix = new Map<string, string>(); // subnet ARM id (lower) → CIDR
  const preNicCount = discoveredSubnetIds.size;
  for (const r of resRows) {
    if (!r.id) continue;
    const t = (r.type ?? "").toLowerCase();
    if (t !== "microsoft.network/virtualnetworks") continue;
    const arr = safePropArray(r.properties, "subnets");
    for (const sub of arr) {
      if (!sub || typeof sub !== "object") continue;
      const obj = sub as Record<string, unknown>;
      const id = safeId(obj.id);
      if (!id) continue;
      discoveredSubnetIds.add(id);
      // addressPrefix may be nested under .properties (ARM) or flat (Resource Graph)
      const props = obj.properties as Record<string, unknown> | undefined;
      const prefix = safeString(props?.addressPrefix ?? obj.addressPrefix);
      if (prefix) subnetAddressPrefix.set(id.toLowerCase(), prefix);
    }
  }
  debug(`[subnet-discovery] Source (b) VNet embedded: +${discoveredSubnetIds.size - preNicCount} (total ${discoveredSubnetIds.size}, ${subnetAddressPrefix.size} with CIDR)`);

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
  debug(`[subnet-discovery] Source (c) ID parsing: +${discoveredSubnetIds.size - preEdgeCount} (total ${discoveredSubnetIds.size})`);

  // ── Patch existing subnet nodes that have no CIDR but have a discovered prefix ──
  // Subnets from resRows may have been created without addressPrefix if RG returned empty properties.
  for (const node of nodes) {
    if (node.kind !== "subnet" || node.endpoint) continue;
    const prefix = subnetAddressPrefix.get(node.id.toLowerCase());
    if (prefix) {
      node.endpoint = prefix;
      debug(`[subnet-discovery] Patched CIDR for existing subnet "${node.name}": ${prefix}`);
    }
  }

  // ── Create subnet nodes for ALL discovered IDs ──
  let createdSubnets = 0;
  for (const subnetId of discoveredSubnetIds) {
    if (nodes.some(n => n.id.toLowerCase() === subnetId.toLowerCase() && n.kind === "subnet")) continue; // Already exists

    const subName = subnetId.split("/").pop() ?? "unknown-subnet";
    const vnetIdx = subnetId.lastIndexOf("/subnets/");
    const parentVnetId = vnetIdx > 0 ? subnetId.slice(0, vnetIdx) : undefined;
    const vnetRow = parentVnetId ? resourceById.get(parentVnetId) : undefined;
    // Fall back to NIC's location/RG if VNet not found
    const anyNicForSubnet = [...nicById.values()].find(nic => getSubnetIdFromNicProps(nic.properties) === subnetId);

    const discoveredPrefix = subnetAddressPrefix.get(subnetId.toLowerCase());
    const subRow: AzureResourceRow = {
      id: subnetId,
      name: subName,
      type: "Microsoft.Network/virtualNetworks/subnets",
      location: vnetRow?.location ?? anyNicForSubnet?.location,
      resourceGroup: vnetRow?.resourceGroup ?? anyNicForSubnet?.resourceGroup,
      properties: discoveredPrefix ? { addressPrefix: discoveredPrefix } : undefined,
    };
    resourceById.set(subnetId, subRow);
    nodes.push({
      id: subnetId,
      kind: "subnet",
      name: subName,
      azureId: subnetId,
      endpoint: discoveredPrefix, // CIDR — shown as subtitle in GroupNode
      location: subRow.location,
      resourceGroup: subRow.resourceGroup,
      health: "unknown",
    });
    createdSubnets++;
    debug(`[subnet-discovery] Created subnet: "${subName}" (VNet: ${parentVnetId ? vnetNodeIds.has(parentVnetId) ? "found" : "MISSING" : "N/A"})`);
  }
  debug(`[subnet-discovery] Result: ${discoveredSubnetIds.size} total subnets, ${createdSubnets} newly created`);

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
      edges.push(relEdge("CT-01", eid, parentVnetId, subId));
      containsCreated++;
    }
  }
  if (containsCreated > 0) {
    debug(`[subnet-discovery] Created ${containsCreated} VNet→Subnet contains edges`);
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
      edges.push(relEdge("CT-02", eid, subnetId, nic.id));
      nicEdgesCreated++;
    }
  }
  if (nicEdgesCreated > 0) {
    debug(`[subnet-discovery] Created ${nicEdgesCreated} Subnet→NIC edges`);
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
        edges.push(relEdge("CT-09", edgeId, subnetRef, r.id));
        genericSubnetEdges++;
      }
    }
  }
  if (genericSubnetEdges > 0) {
    debug(`[subnet-discovery] Generic scanner: ${genericSubnetEdges} additional subnet→resource edges`);
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
  debug(`[azure] Graph built: ${nodes.length} nodes, ${edges.length} edges`);
  debug(`[azure] Node kinds: ${JSON.stringify(Object.fromEntries(kindCount))}`);
  debug(`[azure] Edge kinds: ${JSON.stringify(Object.fromEntries(edgeKindCount))}`);

  // ── Diagnostic: containment edge counts (using final subnet set) ──
  const vnetToSubnet = edges.filter(e => e.kind === "contains" && finalSubnetNodeIds.has(e.target)).length;
  const subnetToResource = edges.filter(e =>
    finalSubnetNodeIds.has(e.source) &&
    e.kind !== "contains" &&
    !finalSubnetNodeIds.has(e.target),
  ).length;
  debug(`[azure] Containment edges: ${vnetToSubnet} vnet→subnet, ${subnetToResource} subnet→resource`);

  // Types no diagram draws (count only): absorbed children and the types read above are drawn
  const DRAWN = new Set([
    ...[...resQuery.matchAll(/'(microsoft\.[^']+)'/g)].map((m) => m[1]!),
    ...PE_PAAS_TYPES,
    "microsoft.servicenetworking/trafficcontrollers/associations", "microsoft.servicenetworking/trafficcontrollers/frontends",
    "microsoft.servicenetworking/trafficcontrollers/securitypolicies", "microsoft.cdn/profiles/afdendpoints",
    "microsoft.insights/diagnosticsettings", "microsoft.network/connections", "microsoft.network/localnetworkgateways",
    // shown on the Front Door it protects (EDGE-10) — the Application Gateway policy type is not shown yet
    "microsoft.network/frontdoorwebapplicationfirewallpolicies", "microsoft.cdn/profiles/securitypolicies",
  ]);
  const undrawnTypes = typeRows.filter((t) => t.type && !DRAWN.has(t.type)).sort((a, b) => b.count - a.count);

  return {
    generatedAt: new Date().toISOString(),
    undrawnTypes,
    nodes,
    edges
  };
}

/** A signed-in user, or anonymous dev mode — anonymous otherwise is "sign in" (routes answer with sample data) */
function hasCredentials(env: Env, bearerToken: string | undefined): boolean {
  if (bearerToken) return true;
  if (!anonymousSpAllowed(env)) throw signinRequired();
  return !!(env.AZURE_AD_TENANT_ID && env.AZURE_AD_CLIENT_ID && env.AZURE_AD_CLIENT_SECRET);
}

export async function tryListAzureSubscriptionsFromAzure(
  env: Env,
  bearerToken: string | undefined,
): Promise<AzureSubscriptionOption[] | null> {
  if (!hasCredentials(env, bearerToken)) return null;
  const all = callerSubscriptions(env, bearerToken);
  if (!all.length) return null;

  const cacheKey = `${cachePrefix(bearerToken)}:${all.join(",")}`;
  const cached = subsCache.get(cacheKey);
  if (cached) return cached;

  const bundle = createResourceGraphClient(env, bearerToken, all);
  const { subscriptions } = bundle;
  const subsQuery = "resourcecontainers | where type == 'microsoft.resources/subscriptions' | project subscriptionId, name";
  const rows = await resourceGraphQueryAll<AzureSubscriptionRow>(bundle, subsQuery);

  const nameById = new Map<string, string>();
  for (const r of rows) {
    if (r.subscriptionId && r.name) nameById.set(r.subscriptionId.toLowerCase(), r.name);
  }

  const out: AzureSubscriptionOption[] = subscriptions.map((subscriptionId) => {
    const conn = connectionForSubscription(env, subscriptionId);
    return {
      subscriptionId,
      name: nameById.get(subscriptionId.toLowerCase()),
      ...(conn ? { connectionKey: conn.key, connectionName: conn.displayName } : {}),
    };
  });

  subsCache.set(cacheKey, out, env.AZURE_RESOURCE_GRAPH_CACHE_TTL_MS);
  return out;
}

export async function tryGetArchitectureGraphFromAzure(
  env: Env,
  bearerToken: string | undefined,
  opts?: { subscriptionId?: string },
): Promise<ArchitectureGraph | null> {
  if (!hasCredentials(env, bearerToken)) return null;
  const all = callerSubscriptions(env, bearerToken);
  if (!all.length) return null;

  // Optional narrowing to a single subscription (must be a managed one)
  let subs = all;
  if (opts?.subscriptionId) {
    const wanted = opts.subscriptionId.toLowerCase();
    if (!all.some((s) => s.toLowerCase() === wanted)) {
      throw new Error("subscriptionId is not a managed subscription");
    }
    subs = [opts.subscriptionId];
  }

  const cacheKey = `${cachePrefix(bearerToken)}:${subs.join(",")}`;
  const cached = graphCache.get(cacheKey);
  if (cached) return cached;

  const graph = await fetchTopologyFromResourceGraph(env, bearerToken, subs);
  graphCache.set(cacheKey, graph, env.AZURE_RESOURCE_GRAPH_CACHE_TTL_MS);
  return graph;
}
