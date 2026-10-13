import { lookup } from "node:dns/promises";
import type { ClusterContainment } from "@aud/types";
import type { Env } from "../env.js";
import { CacheManager, cachePrefix } from "../infra/cacheManager.js";
import { getArmFetcherAuto } from "../infra/azureClientFactory.js";
import { parseSubscriptionIds } from "../infra/requestParams.js";
import { debug } from "../infra/logger.js";
import type { AzureEndpoint } from "./policyInsights.js";

// ──────────────────────────────────────────────────────────────
// Azure context for policy insights
//
// - The AKS cluster's own settings (local accounts, Entra, outbound type)
// - PaaS endpoints in the allowed subscriptions, resolved to the IPs that
//   Hubble sees as "world" destinations (Resource Graph + DNS)
// Subscription IDs never leave this module — only display names do.
// ──────────────────────────────────────────────────────────────

const endpointCache = new CacheManager<{ endpoints: AzureEndpoint[] }>(10, 600_000);
const clusterCache = new CacheManager<ClusterContext>(10, 300_000);

export type ClusterContext = { containment: ClusterContainment; apiServerIps: string[] };

/** Resource Graph type → [display label, property path of the public host name] */
const PAAS_TYPES: Record<string, [string, (p: Record<string, unknown>) => string | undefined]> = {
  "microsoft.dbforpostgresql/flexibleservers": ["PostgreSQL", (p) => str(p.fullyQualifiedDomainName)],
  "microsoft.dbformysql/flexibleservers": ["MySQL", (p) => str(p.fullyQualifiedDomainName)],
  "microsoft.sql/servers": ["Azure SQL", (p) => str(p.fullyQualifiedDomainName)],
  "microsoft.cache/redis": ["Redis", (p) => str(p.hostName)],
  "microsoft.cache/redisenterprise": ["Redis Enterprise", (p) => str(p.hostName)],
  "microsoft.keyvault/vaults": ["Key Vault", (p) => hostOf(p.vaultUri)],
  "microsoft.containerregistry/registries": ["ACR", (p) => str(p.loginServer)],
  "microsoft.storage/storageaccounts": ["Storage", (p) => hostOf((p.primaryEndpoints as Record<string, unknown> | undefined)?.blob)],
  "microsoft.documentdb/databaseaccounts": ["Cosmos DB", (p) => hostOf(p.documentEndpoint)],
  "microsoft.servicebus/namespaces": ["Service Bus", (p) => hostOf(p.serviceBusEndpoint)],
  "microsoft.eventhub/namespaces": ["Event Hubs", (p) => hostOf(p.serviceBusEndpoint)],
  "microsoft.cognitiveservices/accounts": ["Azure AI", (p) => hostOf(p.endpoint)],
  "microsoft.web/sites": ["App Service", (p) => str(p.defaultHostName)],
};

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}
function hostOf(v: unknown): string | undefined {
  try { return typeof v === "string" && v ? new URL(v).hostname : undefined; } catch { return undefined; }
}

async function resolveAll(host: string): Promise<string[]> {
  try {
    const r = await Promise.race([
      lookup(host, { all: true }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("dns timeout")), 3000)),
    ]);
    return [...new Set(r.map((a) => a.address))];
  } catch {
    return [];
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]!); }
  }));
  return out;
}

const MAX_RESOLVED = 300;

/** PaaS resources in the allowed subscriptions with the IPs their public host names resolve to. */
export async function listAzureEndpoints(env: Env, bearerToken: string | undefined): Promise<{ endpoints: AzureEndpoint[] }> {
  const subs = parseSubscriptionIds(env);
  const cacheKey = `${cachePrefix(bearerToken)}:azure-endpoints:${subs.join(",")}`;
  const cached = endpointCache.get(cacheKey);
  if (cached) return cached;
  if (!subs.length) return { endpoints: [] };

  const arm = await getArmFetcherAuto(env, bearerToken);
  const types = Object.keys(PAAS_TYPES).map((t) => `'${t}'`).join(",");
  const query = `Resources | where type in~ (${types}) | project name, type, resourceGroup, properties | limit 1000`;
  const res = await arm.postJson<{ data?: Array<{ name: string; type: string; resourceGroup: string; properties?: Record<string, unknown> }> }>(
    "https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01",
    { subscriptions: subs, query, options: { resultFormat: "objectArray" } },
    { timeoutMs: 20_000 },
  );
  const rows = (res.data ?? []).map((r): Omit<AzureEndpoint, "ips"> | null => {
    const def = PAAS_TYPES[r.type.toLowerCase()];
    const p = r.properties ?? {};
    const host = def?.[1](p);
    const pna = str(p.publicNetworkAccess) ?? str((p.network as Record<string, unknown> | undefined)?.publicNetworkAccess) ?? null;
    return host && def ? { name: r.name, type: r.type.split("/").pop()!, armType: r.type.toLowerCase(), typeLabel: def[0], resourceGroup: r.resourceGroup, host, publicAccess: pna } : null;
  }).filter((x): x is Omit<AzureEndpoint, "ips"> => !!x).slice(0, MAX_RESOLVED);

  const ips = await mapLimit(rows, 16, (r) => resolveAll(r.host));
  const endpoints = rows.map((r, i) => ({ ...r, ips: ips[i]! })).filter((r) => r.ips.length);
  debug(`[azure-endpoints] ${rows.length} PaaS resources, ${endpoints.length} resolved`);
  const out = { endpoints };
  endpointCache.set(cacheKey, out);
  return out;
}

type ManagedCluster = {
  name: string;
  location: string;
  properties?: {
    currentKubernetesVersion?: string;
    kubernetesVersion?: string;
    fqdn?: string;
    privateFQDN?: string;
    disableLocalAccounts?: boolean;
    aadProfile?: { managed?: boolean; enableAzureRBAC?: boolean } | null;
    networkProfile?: { outboundType?: string };
    apiServerAccessProfile?: { enablePrivateCluster?: boolean; authorizedIPRanges?: string[] } | null;
    agentPoolProfiles?: Array<{ count?: number }>;
  };
};

/** AKS cluster settings, its subscription display name and API server IPs. */
export async function getClusterContext(env: Env, bearerToken: string | undefined, clusterId: string): Promise<ClusterContext> {
  const cacheKey = `${cachePrefix(bearerToken)}:cluster-ctx:${clusterId.toLowerCase()}`;
  const cached = clusterCache.get(cacheKey);
  if (cached) return cached;
  const m = /\/subscriptions\/([^/]+)\/resourcegroups\/([^/]+)\//i.exec(clusterId);
  const arm = await getArmFetcherAuto(env, bearerToken);
  const [mc, sub] = await Promise.all([
    arm.fetchJson<ManagedCluster>(`https://management.azure.com${clusterId}?api-version=2024-09-01`, { timeoutMs: 15_000 }),
    m ? arm.fetchJson<{ displayName?: string }>(`https://management.azure.com/subscriptions/${m[1]}?api-version=2020-01-01`, { timeoutMs: 10_000 }).catch(() => null) : Promise.resolve(null),
  ]);
  const p = mc.properties ?? {};
  const api = p.apiServerAccessProfile ?? undefined;
  const fqdn = p.fqdn ?? p.privateFQDN;
  const ctx: ClusterContext = {
    containment: {
      subscription: sub?.displayName ?? null,
      resourceGroup: m?.[2] ?? "",
      cluster: {
        name: mc.name,
        location: mc.location,
        k8sVersion: p.currentKubernetesVersion ?? p.kubernetesVersion ?? "",
        nodes: (p.agentPoolProfiles ?? []).reduce((s, a) => s + (a.count ?? 0), 0),
        privateCluster: api ? !!api.enablePrivateCluster : false,
        authorizedIpRanges: api?.authorizedIPRanges?.length ?? 0,
        // ARM omits unset properties: no disableLocalAccounts = local accounts on, no aadProfile = no Entra integration
        localAccounts: !p.disableLocalAccounts,
        entraIntegrated: !!p.aadProfile?.managed,
        azureRbac: !!p.aadProfile?.enableAzureRBAC,
        outboundType: p.networkProfile?.outboundType ?? null,
      },
      resources: [],
    },
    apiServerIps: fqdn ? await resolveAll(fqdn) : [],
  };
  clusterCache.set(cacheKey, ctx);
  return ctx;
}
