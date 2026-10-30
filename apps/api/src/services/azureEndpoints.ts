import { lookup } from "node:dns/promises";
import type { ClusterContainment, PaasNetworkRules } from "@aud/types";
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
// - PaaS endpoints in the allowed subscriptions with the IPs Hubble sees as "world"
//   destinations: Private Endpoint NIC IPs (Resource Graph) + DNS answers
// - Who else can reach them: public access, IP firewall / network rules, key auth
// Subscription IDs never leave this module — only display names do.
// ──────────────────────────────────────────────────────────────

const endpointCache = new CacheManager<{ endpoints: AzureEndpoint[] }>(10, 600_000);
const clusterCache = new CacheManager<ClusterContext>(10, 300_000);

/**
 * `identity` stays inside the API (workload identity map): the OIDC issuer is compared byte-exact against federated
 * credentials and only ever leaves masked.
 */
export type ClusterContext = {
  containment: ClusterContainment;
  apiServerIps: string[];
  identity: { issuerUrl: string | null; oidcEnabled: boolean | null; wiEnabled: boolean | null; nodeResourceGroup?: string | null };
};

type Props = Record<string, unknown>;

/**
 * Resource Graph type → [display label, public host names]. Types reached only through a Private Endpoint need no
 * host: the PE's network interface gives the private IP (see `privateEndpointIps`).
 */
const PAAS_TYPES: Record<string, [string, (p: Props) => Array<string | undefined>]> = {
  "microsoft.dbforpostgresql/flexibleservers": ["PostgreSQL", (p) => [str(p.fullyQualifiedDomainName)]],
  "microsoft.dbformysql/flexibleservers": ["MySQL", (p) => [str(p.fullyQualifiedDomainName)]],
  "microsoft.sql/servers": ["Azure SQL", (p) => [str(p.fullyQualifiedDomainName)]],
  "microsoft.cache/redis": ["Redis", (p) => [str(p.hostName)]],
  "microsoft.cache/redisenterprise": ["Azure Managed Redis", (p) => [str(p.hostName)]],
  "microsoft.keyvault/vaults": ["Key Vault", (p) => [hostOf(p.vaultUri)]],
  "microsoft.containerregistry/registries": ["ACR", (p) => [str(p.loginServer)]],
  "microsoft.storage/storageaccounts": ["Storage", (p) => {
    const e = (p.primaryEndpoints as Props | undefined) ?? {};
    return [hostOf(e.blob), hostOf(e.queue), hostOf(e.table), hostOf(e.file), hostOf(e.dfs)];
  }],
  "microsoft.documentdb/databaseaccounts": ["Cosmos DB", (p) => [hostOf(p.documentEndpoint)]],
  // vCore: the host is in the connection string (mongodb+srv://<user>:<password>@<host>/…)
  "microsoft.documentdb/mongoclusters": ["Cosmos DB for MongoDB (vCore)", (p) => [/@([^/?@]+)/.exec(str(p.connectionString) ?? "")?.[1]]],
  "microsoft.servicebus/namespaces": ["Service Bus", (p) => [hostOf(p.serviceBusEndpoint)]],
  "microsoft.eventhub/namespaces": ["Event Hubs", (p) => [hostOf(p.serviceBusEndpoint)]],
  "microsoft.cognitiveservices/accounts": ["Azure AI", (p) => [hostOf(p.endpoint)]],
  "microsoft.web/sites": ["App Service", (p) => [str(p.defaultHostName)]],
  // Azure Monitor workspace (managed Prometheus) is queried here; metrics are sent to its data collection endpoint
  "microsoft.monitor/accounts": ["Azure Monitor workspace", (p) => [hostOf((p.metrics as Props | undefined)?.prometheusQueryEndpoint)]],
  "microsoft.insights/datacollectionendpoints": ["Data collection endpoint", (p) => [
    hostOf((p.metricsIngestion as Props | undefined)?.endpoint), hostOf((p.logsIngestion as Props | undefined)?.endpoint), hostOf((p.configurationAccess as Props | undefined)?.endpoint),
  ]],
  "microsoft.operationalinsights/workspaces": ["Log Analytics", (p) => {
    const id = str(p.customerId);
    return id ? [`${id}.ods.opinsights.azure.com`, `${id}.oms.opinsights.azure.com`] : [];
  }],
};

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}
function hostOf(v: unknown): string | undefined {
  try { return typeof v === "string" && v ? new URL(v).hostname : undefined; } catch { return undefined; }
}
const arr = (v: unknown): unknown[] | null => (Array.isArray(v) ? v : null);

/** `/subscriptions/…/virtualNetworks/<vnet>/subnets/<subnet>` → `vnet/subnet` (names only, no subscription) */
export function subnetName(id: unknown): string | null {
  const m = /\/virtualnetworks\/([^/]+)\/subnets\/([^/]+)/i.exec(typeof id === "string" ? id : "");
  return m ? `${m[1]}/${m[2]}` : null;
}
const subnetsOf = (rules: unknown, pick: (r: Props) => unknown): string[] =>
  (arr(rules) ?? []).map((r) => subnetName(pick(r as Props))).filter((x): x is string => !!x).slice(0, 10);

/** Rules with defaultAction / ipRules / virtualNetworkRules (Storage · Key Vault · Azure AI · ACR · Event Hubs network rule set) */
function aclRules(o: unknown, source: string, subnetOf: (r: Props) => unknown = (r) => r.id): PaasNetworkRules | null {
  if (!o || typeof o !== "object") return null;
  const a = o as Props;
  const da = str(a.defaultAction);
  return { defaultAction: da === "Allow" || da === "Deny" ? da : null, ipRules: arr(a.ipRules)?.length ?? 0, vnetRules: subnetsOf(a.virtualNetworkRules, subnetOf), source };
}

/**
 * Pure: network rules that are part of the resource body. null = they live in a child resource (firewall rules,
 * network rule set) — read separately by `readChildRules`.
 */
export function networkRulesOf(armType: string, p: Props): PaasNetworkRules | null {
  switch (armType) {
    case "microsoft.storage/storageaccounts":
    case "microsoft.keyvault/vaults":
    case "microsoft.cognitiveservices/accounts":
      return aclRules(p.networkAcls, "networkAcls");
    case "microsoft.containerregistry/registries":
      return aclRules(p.networkRuleSet, "networkRuleSet");
    case "microsoft.documentdb/databaseaccounts": {
      // Cosmos DB: no IP rule and no VNet filter = every network
      const ip = arr(p.ipRules)?.length ?? 0;
      return { defaultAction: ip || p.isVirtualNetworkFilterEnabled === true ? "Deny" : "Allow", ipRules: ip, vnetRules: subnetsOf(p.virtualNetworkRules, (r) => r.id), source: "ipRules · isVirtualNetworkFilterEnabled" };
    }
    case "microsoft.cache/redisenterprise":
      // Azure Managed Redis has no IP firewall rules: with public access on, any address reaches the endpoint
      return { defaultAction: "Allow", ipRules: null, vnetRules: null, noIpFirewall: true, source: "Azure Managed Redis" };
    default:
      return null;
  }
}

/** Pure: key / shared-key / local auth. null = not part of the body or not applicable */
export function keyAuthOf(armType: string, p: Props): "on" | "off" | null {
  switch (armType) {
    case "microsoft.storage/storageaccounts": return p.allowSharedKeyAccess === false ? "off" : "on"; // unset = allowed
    case "microsoft.eventhub/namespaces":
    case "microsoft.servicebus/namespaces":
    case "microsoft.documentdb/databaseaccounts":
    case "microsoft.cognitiveservices/accounts": return p.disableLocalAuth === true ? "off" : "on";
    case "microsoft.cache/redis": return p.disableAccessKeyAuthentication === true ? "off" : "on";
    case "microsoft.containerregistry/registries": return p.adminUserEnabled === true ? "on" : "off";
    default: return null;
  }
}

/** Pure: server firewall rules (PostgreSQL · MySQL · SQL · Mongo vCore · Redis) → rules */
export function firewallRules(armType: string, rules: Array<{ properties?: { startIpAddress?: string; endIpAddress?: string } }>): PaasNetworkRules {
  const all = rules.some((r) => r.properties?.startIpAddress === "0.0.0.0" && r.properties?.endIpAddress === "255.255.255.255");
  // Azure Cache for Redis: no rule = every address; the others: no rule = no public client
  const noneMeansAll = armType === "microsoft.cache/redis";
  return { defaultAction: all || (noneMeansAll && rules.length === 0) ? "Allow" : "Deny", ipRules: rules.length, vnetRules: null, source: "firewallRules" };
}

const CHILD_RULES: Record<string, string> = {
  "microsoft.dbforpostgresql/flexibleservers": "/firewallRules?api-version=2022-12-01",
  "microsoft.dbformysql/flexibleservers": "/firewallRules?api-version=2023-12-30",
  "microsoft.sql/servers": "/firewallRules?api-version=2021-11-01",
  "microsoft.cache/redis": "/firewallRules?api-version=2024-03-01",
  "microsoft.documentdb/mongoclusters": "/firewallRules?api-version=2024-07-01",
  "microsoft.eventhub/namespaces": "/networkRuleSets/default?api-version=2024-01-01",
  "microsoft.servicebus/namespaces": "/networkRuleSets/default?api-version=2022-10-01-preview",
};
const MAX_CHILD_READS = 40;

type Fetcher = { fetchJson: <T>(url: string, opts?: { timeoutMs?: number }) => Promise<T> };

async function readChildRules(arm: Fetcher, id: string, armType: string): Promise<{ network: PaasNetworkRules | null; keyAuth?: "on" | "off" | null }> {
  if (armType === "microsoft.cache/redisenterprise") {
    // Key access lives on the database, not the cluster
    const db = await arm.fetchJson<{ properties?: { accessKeysAuthentication?: string } }>(`https://management.azure.com${id}/databases/default?api-version=2024-10-01`, { timeoutMs: 8_000 });
    const k = db.properties?.accessKeysAuthentication;
    return { network: null, keyAuth: k === "Disabled" ? "off" : k === "Enabled" ? "on" : null };
  }
  const path = CHILD_RULES[armType];
  if (!path) return { network: null };
  const body = await arm.fetchJson<{ value?: Array<{ properties?: { startIpAddress?: string; endIpAddress?: string } }>; properties?: Props }>(`https://management.azure.com${id}${path}`, { timeoutMs: 8_000 });
  if (path.includes("networkRuleSets")) return { network: aclRules(body.properties, "networkRuleSets/default", (r) => (r.subnet as Props | undefined)?.id) };
  return { network: firewallRules(armType, body.value ?? []) };
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

export async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]!); }
  }));
  return out;
}

const MAX_RESOLVED = 300;
const ARG = "https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01";

type ArgRow = Record<string, unknown>;

/**
 * Pure: target resource (lowercase ARM ID) → private IPs of its Private Endpoints. Both sides are ARM configuration:
 * the PE's `privateLinkServiceConnections` and the NIC that carries `privateEndpoint.id`.
 */
export function privateEndpointIps(pes: ArgRow[], nics: ArgRow[]): Map<string, string[]> {
  const ipsByPe = new Map<string, Set<string>>();
  for (const n of nics) {
    const pe = String(n.pe ?? "").toLowerCase();
    const ip = str(n.ip);
    if (!pe || !ip) continue;
    ipsByPe.set(pe, (ipsByPe.get(pe) ?? new Set()).add(ip));
  }
  const out = new Map<string, string[]>();
  for (const pe of pes) {
    const target = String(pe.target ?? "").toLowerCase();
    const ips = ipsByPe.get(String(pe.peId ?? "").toLowerCase());
    if (!target || !ips) continue;
    out.set(target, [...new Set([...(out.get(target) ?? []), ...ips])].sort());
  }
  return out;
}

/**
 * PaaS resources in the allowed subscriptions with the IPs the cluster may reach them on: Private Endpoint NIC IPs
 * (configuration) and the DNS answers for their host names (inside the cluster a private DNS zone answers with the
 * PE IP). Network rules and key auth say who else can reach them.
 */
export async function listAzureEndpoints(env: Env, bearerToken: string | undefined): Promise<{ endpoints: AzureEndpoint[] }> {
  const subs = parseSubscriptionIds(env);
  const cacheKey = `${cachePrefix(bearerToken)}:azure-endpoints:${subs.join(",")}`;
  const cached = endpointCache.get(cacheKey);
  if (cached) return cached;
  if (!subs.length) return { endpoints: [] };

  const arm = await getArmFetcherAuto(env, bearerToken);
  const q = <T>(query: string) => arm.postJson<{ data?: T[] }>(ARG, { subscriptions: subs, query, options: { resultFormat: "objectArray" } }, { timeoutMs: 20_000 }).then((r) => r.data ?? []);
  // A failed PE read only loses the PE match (DNS still answers) — not the whole list
  const [pes, nics] = await Promise.all([
    q<ArgRow>(`Resources | where type =~ 'microsoft.network/privateendpoints'
      | mv-expand c = array_concat(properties.privateLinkServiceConnections, properties.manualPrivateLinkServiceConnections)
      | project peId = tolower(id), target = tolower(tostring(c.properties.privateLinkServiceId)) | limit 2000`).catch(() => [] as ArgRow[]),
    q<ArgRow>(`Resources | where type =~ 'microsoft.network/networkinterfaces' and isnotempty(properties.privateEndpoint.id)
      | mv-expand ipc = properties.ipConfigurations
      | project pe = tolower(tostring(properties.privateEndpoint.id)), ip = tostring(ipc.properties.privateIPAddress) | limit 4000`).catch(() => [] as ArgRow[]),
  ]);
  const peIps = privateEndpointIps(pes, nics);
  const targets = [...peIps.keys()].slice(0, 400).map((t) => `'${t.replace(/'/g, "")}'`).join(",");
  const types = Object.keys(PAAS_TYPES).map((t) => `'${t}'`).join(",");
  const found = await q<{ id: string; name: string; type: string; resourceGroup: string; properties?: Props }>(
    `Resources | where type in~ (${types})${targets ? ` or tolower(id) in (${targets})` : ""} | project id, name, type, resourceGroup, properties | limit 1500`,
  );
  const rows = found.map((r) => {
    const armType = r.type.toLowerCase();
    const def = PAAS_TYPES[armType];
    const p = r.properties ?? {};
    const hosts = [...new Set((def?.[1](p) ?? []).filter((h): h is string => !!h))];
    const pe = peIps.get(r.id.toLowerCase()) ?? [];
    if (!hosts.length && !pe.length) return null;
    const pna = str(p.publicNetworkAccess) ?? str((p.network as Props | undefined)?.publicNetworkAccess) ?? null;
    return {
      id: r.id, name: r.name, type: r.type.split("/").pop()!, armType, typeLabel: def?.[0] ?? r.type.split("/").slice(-2).join("/"),
      resourceGroup: r.resourceGroup, host: hosts[0] ?? "", hosts, publicAccess: pna, peIps: pe,
      network: networkRulesOf(armType, p), keyAuth: keyAuthOf(armType, p),
    };
  }).filter((x): x is NonNullable<typeof x> => !!x).slice(0, MAX_RESOLVED);

  // Rules kept in child resources — only where the public endpoint may be on (a closed endpoint needs no rules)
  const needRules = rows.filter((r) => r.publicAccess !== "Disabled" && ((!r.network && CHILD_RULES[r.armType]) || r.armType === "microsoft.cache/redisenterprise")).slice(0, MAX_CHILD_READS);
  await mapLimit(needRules, 6, async (r) => {
    try {
      const got = await readChildRules(arm, r.id, r.armType);
      if (got.network) r.network = got.network;
      if (got.keyAuth !== undefined) r.keyAuth = got.keyAuth;
    } catch (e) {
      debug(`[azure-endpoints] rules of ${r.name}: ${e instanceof Error ? e.message.slice(0, 120) : e}`);
    }
  });

  const dns = await mapLimit(rows, 16, async (r) => [...new Set((await Promise.all(r.hosts.map(resolveAll))).flat())]);
  const endpoints: AzureEndpoint[] = rows
    .map(({ id, ...r }, i) => ({ ...r, armId: id, ips: [...new Set([...r.peIps, ...dns[i]!])] }))
    .filter((r) => r.ips.length);
  debug(`[azure-endpoints] ${rows.length} PaaS resources (${peIps.size} PE targets), ${endpoints.length} with IPs, rules read for ${needRules.length}`);
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
    oidcIssuerProfile?: { enabled?: boolean; issuerURL?: string } | null;
    nodeResourceGroup?: string;
    securityProfile?: { workloadIdentity?: { enabled?: boolean } | null } | null;
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
    // ARM omits unset profiles: absent = off (the api-version returns both when set)
    identity: {
      issuerUrl: p.oidcIssuerProfile?.issuerURL ?? null,
      oidcEnabled: !!p.oidcIssuerProfile?.enabled,
      wiEnabled: !!p.securityProfile?.workloadIdentity?.enabled,
      nodeResourceGroup: p.nodeResourceGroup ?? null,
    },
  };
  clusterCache.set(cacheKey, ctx);
  return ctx;
}
