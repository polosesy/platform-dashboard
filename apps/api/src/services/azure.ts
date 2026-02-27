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
  if (t === "microsoft.web/sites") {
    const k = (resourceKind ?? "").toLowerCase();
    return k.includes("functionapp") ? "functionApp" : "appService";
  }
  return "unknown";
}

function rgId(subscriptionId: string, resourceGroup: string): string {
  return `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}`;
}

function safeString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

function getSubnetIdFromNicProps(properties: unknown): string | undefined {
  if (!properties || typeof properties !== "object") return undefined;
  const ipConfigs = (properties as { ipConfigurations?: unknown }).ipConfigurations;
  if (!Array.isArray(ipConfigs)) return undefined;
  for (const c of ipConfigs) {
    const subnet = (c as { properties?: { subnet?: { id?: unknown } } }).properties?.subnet;
    const id = subnet?.id;
    const s = safeString(id);
    if (s) return s;
  }
  return undefined;
}

function getSubnetIdFromPrivateEndpointProps(properties: unknown): string | undefined {
  if (!properties || typeof properties !== "object") return undefined;
  const subnetId = (properties as { subnet?: { id?: unknown } }).subnet?.id;
  return safeString(subnetId);
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
    const s = safeString(subnetId);
    if (s) ids.push(s);
  }
  return [...new Set(ids)];
}

function getSubnetIdsFromAppGatewayProps(properties: unknown): string[] {
  if (!properties || typeof properties !== "object") return [];
  const configs = (properties as { gatewayIPConfigurations?: unknown }).gatewayIPConfigurations;
  if (!Array.isArray(configs)) return [];
  const ids = configs
    .map((c) => safeString((c as { properties?: { subnet?: { id?: unknown } } }).properties?.subnet?.id))
    .filter((x): x is string => Boolean(x));
  return [...new Set(ids)];
}

function getSubnetIdsFromLoadBalancerProps(properties: unknown): string[] {
  if (!properties || typeof properties !== "object") return [];
  const configs = (properties as { frontendIPConfigurations?: unknown }).frontendIPConfigurations;
  if (!Array.isArray(configs)) return [];
  const ids = configs
    .map((c) => safeString((c as { properties?: { subnet?: { id?: unknown } } }).properties?.subnet?.id))
    .filter((x): x is string => Boolean(x));
  return [...new Set(ids)];
}

function getBackendNicIdsFromLoadBalancerProps(properties: unknown): string[] {
  if (!properties || typeof properties !== "object") return [];
  const pools = (properties as { backendAddressPools?: unknown }).backendAddressPools;
  if (!Array.isArray(pools)) return [];

  const ipConfigs: unknown[] = [];
  for (const p of pools) {
    const cfgs = (p as { properties?: { backendIPConfigurations?: unknown } }).properties?.backendIPConfigurations;
    if (Array.isArray(cfgs)) ipConfigs.push(...cfgs);
  }

  const nicIds = ipConfigs
    .map((x) => safeString((x as { id?: unknown }).id))
    .filter((x): x is string => Boolean(x))
    .map((id) => {
      const idx = id.toLowerCase().indexOf("/ipconfigurations/");
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
    const cfgs = (p as { properties?: { backendIPConfigurations?: unknown } }).properties?.backendIPConfigurations;
    if (Array.isArray(cfgs)) ipConfigs.push(...cfgs);
  }

  const nicIds = ipConfigs
    .map((x) => safeString((x as { id?: unknown }).id))
    .filter((x): x is string => Boolean(x))
    .map((id) => {
      const idx = id.toLowerCase().indexOf("/ipconfigurations/");
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
    .map((c) => safeString((c as { properties?: { privateLinkServiceId?: unknown } }).properties?.privateLinkServiceId))
    .filter((x): x is string => Boolean(x));
  return [...new Set(ids)];
}

function getNicIdsFromVmProps(properties: unknown): string[] {
  if (!properties || typeof properties !== "object") return [];
  const nis = (properties as { networkProfile?: { networkInterfaces?: unknown } }).networkProfile?.networkInterfaces;
  if (!Array.isArray(nis)) return [];
  const ids = nis
    .map((x) => safeString((x as { id?: unknown }).id))
    .filter((x): x is string => Boolean(x));
  return [...new Set(ids)];
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
    "'microsoft.eventhub/namespaces'" +
    ") | project id, name, type, kind, location, resourceGroup, subscriptionId, tags, properties";

  const [subRows, rgRows, resRows] = await Promise.all([
    resourceGraphQueryAll<AzureSubscriptionRow>(client, subscriptions, subsQuery, pageSize),
    resourceGraphQueryAll<AzureResourceGroupRow>(client, subscriptions, rgQuery, pageSize),
    resourceGraphQueryAll<AzureResourceRow>(client, subscriptions, resQuery, pageSize)
  ]);

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
    nodes.push({
      id: r.id,
      kind,
      name: r.name ?? r.id,
      azureId: r.id,
      location: r.location,
      tags: r.tags,
      health: "unknown"
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

  // derived edges: vnet -> subnet
  for (const r of resRows) {
    if (!r.id) continue;
    const t = (r.type ?? "").toLowerCase();
    if (t !== "microsoft.network/virtualnetworks/subnets") continue;
    const parts = r.id.toLowerCase().split("/subnets/");
    if (parts.length !== 2) continue;
    const parentVnetId = r.id.slice(0, r.id.toLowerCase().indexOf("/subnets/"));
    if (!resourceById.has(parentVnetId)) continue;
    edges.push({
      id: `e:vnet->subnet:${parentVnetId}:${r.id}`,
      source: parentVnetId,
      target: r.id,
      kind: "contains"
    });
  }

  // derived edges: subnet -> nic, nic -> vm
  for (const nic of nicById.values()) {
    const subnetId = getSubnetIdFromNicProps(nic.properties);
    if (subnetId) {
      edges.push({
        id: `e:subnet->nic:${subnetId}:${nic.id}`,
        source: subnetId,
        target: nic.id,
        kind: "connects"
      });
    }
  }

  for (const r of resRows) {
    if (!r.id) continue;
    const t = (r.type ?? "").toLowerCase();
    if (t === "microsoft.compute/virtualmachines") {
      for (const nicId of getNicIdsFromVmProps(r.properties)) {
        if (!nicById.has(nicId)) continue;
        edges.push({
          id: `e:nic->vm:${nicId}:${r.id}`,
          source: nicId,
          target: r.id,
          kind: "connects"
        });
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
          kind: "connects"
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
          kind: "connects"
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
          kind: "connects"
        });
      }

      for (const targetId of getPrivateLinkTargetIdsFromPrivateEndpointProps(r.properties)) {
        if (!resourceById.has(targetId)) continue;
        edges.push({
          id: `e:pe->target:${r.id}:${targetId}`,
          source: r.id,
          target: targetId,
          kind: "connects"
        });
      }
    }
  }

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
