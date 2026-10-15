// Private Link usage — Azure side: inventory (Resource Graph), diagnostic settings (ARM), access logs and VNet
// flow logs (Log Analytics, resource-centric). The join is pure (privateLinkUsage.ts). Read-only: nothing is
// ever enabled in Azure — the panel shows the command to do it.
import type { DiagramNodeSpec, DiagramSpec, LiveSourceState, PlSourceStatus, PrivateLinkUsageResponse } from "@aud/types";
import type { Env } from "../env.js";
import { CacheManager, cachePrefix } from "../infra/cacheManager.js";
import {
  anonymousSpAllowed,
  getAnonymousArmFetcher,
  getAnonymousLogFetcher,
  getArmFetcher,
  getLogAnalyticsFetcher,
  tableToObjects,
  type ArmFetcher,
  type LogAnalyticsFetcher,
  type LogAnalyticsResponse,
} from "../infra/azureClientFactory.js";
import { kqlString, parseSubscriptionIds } from "../infra/requestParams.js";
import { debug } from "../infra/logger.js";
import { isPrivateV4, joinPrivateLinkUsage, type PluAccessRow, type PluCaller, type PluFlowRow, type PluInput, type PluNic, type PluPe, type PluSubnet } from "./privateLinkUsage.js";

const resultCache = new CacheManager<PrivateLinkUsageResponse>(100, 5 * 60_000);
const inflight = new Map<string, Promise<PrivateLinkUsageResponse>>();
const MAX_TARGETS = 20;
const COMPUTE = new Set(["vm", "vmss", "aks", "appService", "functionApp", "containerApp"]);
/** Kinds whose every IP in a subnet belongs to one resource (a VM has its own NIC IPs instead) */
const SUBNET_OWNERS = new Set(["vmss", "aks", "appService", "functionApp", "containerApp"]);
const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const mask = (s: string) => s.replace(GUID, (g) => `…${g.slice(-4)}`);
const kindOf = (n: DiagramNodeSpec) => n.resourceKind ?? n.icon;

/** Which access log a PaaS kind has, and the diagnostic category that carries caller IPs */
const ACCESS: Record<string, { source: PluAccessRow["source"]; service: string; categories: string[]; groups: string[]; scopes: string[] }> = {
  keyVault: { source: "kvAudit", service: "Key Vault", categories: ["AuditEvent"], groups: ["audit", "allLogs"], scopes: [""] },
  storage: { source: "storageLogs", service: "Storage", categories: ["StorageRead", "StorageWrite"], groups: ["audit", "allLogs"], scopes: ["/blobServices/default", "/fileServices/default", "/queueServices/default", "/tableServices/default"] },
  redis: { source: "redisClients", service: "Redis", categories: ["ConnectedClientList"], groups: ["allLogs"], scopes: [""] },
};

type Scope = {
  vnet: DiagramNodeSpec;
  peerVnetIds: Set<string>;
  pes: Array<PluPe & { armId?: string }>;
  targets: DiagramNodeSpec[];
  callers: PluCaller[];
  subnets: PluSubnet[];
  nodeByArmId: Map<string, string>;
  peerings: Map<string, Set<string>>;
  /** NSGs on the subnets / NICs of the VNet and its peers (flow-log coverage) */
  nsgArmIds: string[];
  /** AKS node / node-pool scale set → its cluster's node (by the cluster ARM id the generator stored) */
  clusterOf: Map<string, string>;
  /** Subnets of other VNets on the diagram: where an out-of-scope address is (never drawn) */
  outerSubnets: PluSubnet[];
  /** Every subnet / VNet prefix of the diagram (addresses inside them are internal, RFC 1918 or not) */
  knownCidrs: string[];
};

/** Everything the join needs that the diagram already knows (no Azure call) */
export function scopeFromSpec(spec: DiagramSpec, vnetNodeId: string): Scope | null {
  const byId = new Map(spec.nodes.map((n) => [n.id, n]));
  const vnet = byId.get(vnetNodeId);
  if (!vnet || vnet.icon !== "vnet") return null;
  const vnetOf = (n: DiagramNodeSpec | undefined): string | undefined => {
    const seen = new Set<string>();
    for (let cur = n; cur && !seen.has(cur.id); cur = cur.parentId ? byId.get(cur.parentId) : undefined) {
      seen.add(cur.id);
      if (cur.icon === "vnet" && cur.nodeType === "group") return cur.id;
    }
    return undefined;
  };
  const peerings = new Map<string, Set<string>>();
  for (const v of spec.nodes.filter((n) => n.icon === "vnet")) {
    try {
      const list = JSON.parse(v.metadata?.peerings ?? "[]") as Array<{ id?: string | null }>;
      peerings.set(v.id, new Set(list.map((p) => p.id).filter((x): x is string => !!x)));
    } catch { peerings.set(v.id, new Set()); }
  }
  const peerVnetIds = peerings.get(vnet.id) ?? new Set<string>();
  const inScope = (id: string | undefined) => !!id && (id === vnet.id || peerVnetIds.has(id));

  const pes: Scope["pes"] = [];
  for (const e of spec.edges) {
    if (e.edgeKind !== "privateLink") continue;
    const pe = byId.get(e.source), target = byId.get(e.target);
    if (!pe || !target || kindOf(pe) !== "privateEndpoint" || vnetOf(pe) !== vnet.id) continue;
    // a PE → target pair can appear on more than one line of the spec (both directions, duplicates)
    if (pes.some((p) => p.peNodeId === pe.id && p.targetNodeId === target.id)) continue;
    const ip = pe.subResources?.find((s) => s.kind === "nic" && s.endpoint && isPrivateV4(s.endpoint))?.endpoint ?? (pe.endpoint && isPrivateV4(pe.endpoint) ? pe.endpoint : undefined);
    pes.push({ peNodeId: pe.id, targetNodeId: target.id, vnetId: vnet.id, ...(ip ? { ip } : {}), ...(pe.azureResourceId ? { armId: pe.azureResourceId } : {}) });
  }
  const targets = [...new Map(pes.map((p) => [p.targetNodeId, byId.get(p.targetNodeId)!])).values()].slice(0, MAX_TARGETS);

  const callers: PluCaller[] = [];
  const nodeByArmId = new Map<string, string>();
  for (const n of spec.nodes) {
    if (n.nodeType === "group" || !COMPUTE.has(kindOf(n))) continue;
    if (n.azureResourceId) nodeByArmId.set(n.azureResourceId.toLowerCase(), n.id);
    const v = vnetOf(n);
    if (!inScope(v)) continue;
    const ips = [...(n.subResources ?? []).filter((s) => s.kind === "nic" && s.endpoint).map((s) => s.endpoint!), ...(n.endpoint && isPrivateV4(n.endpoint) ? [n.endpoint] : [])].filter(isPrivateV4);
    callers.push({ nodeId: n.id, ips: [...new Set(ips)], vnetId: v });
  }
  const subnets: PluSubnet[] = [];
  const outerSubnets: PluSubnet[] = [];
  const knownCidrs: string[] = [];
  for (const s of spec.nodes) {
    if (s.icon !== "subnet" || s.nodeType !== "group") continue;
    const v = vnetOf(s);
    const cidr = s.metadata?.prefix ?? s.endpoint;
    if (!v || !cidr || !cidr.includes("/")) continue;
    knownCidrs.push(cidr);
    const owners = spec.nodes.filter((c) => c.parentId === s.id && SUBNET_OWNERS.has(kindOf(c))).map((c) => c.id);
    (inScope(v) ? subnets : outerSubnets).push({ nodeId: s.id, vnetId: v, cidr, owners });
  }
  for (const v of spec.nodes) {
    const space = v.icon === "vnet" ? v.metadata?.addressSpace ?? v.endpoint : undefined;
    if (space && space.includes("/")) knownCidrs.push(space);
  }
  // AKS cluster of each node-pool scale set (aksClusterArmId) — only when that cluster is on the diagram
  const clusterOf = new Map<string, string>();
  for (const n of spec.nodes) {
    if (kindOf(n) === "aks") clusterOf.set(n.id, n.id);
    const arm = n.metadata?.archRole === "aks-vmss" ? n.metadata?.aksClusterArmId?.toLowerCase() : undefined;
    const cluster = arm ? nodeByArmId.get(arm) : undefined;
    if (cluster) clusterOf.set(n.id, cluster);
  }
  const nsgArmIds = spec.nodes.filter((n) => kindOf(n) === "nsg" && n.azureResourceId && inScope(vnetOf(n))).map((n) => n.azureResourceId!);
  return { vnet, peerVnetIds, pes, targets, callers, subnets, nodeByArmId, peerings, nsgArmIds, clusterOf, outerSubnets, knownCidrs: [...new Set(knownCidrs)] };
}

async function graph<T>(arm: ArmFetcher, env: Env, query: string): Promise<T[]> {
  const res = await arm.postJson<{ data?: T[] }>(
    "https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01",
    { subscriptions: parseSubscriptionIds(env), query, options: { resultFormat: "objectArray", $top: 1000 } },
    { timeoutMs: 20_000 },
  );
  return res.data ?? [];
}
const kqlList = (xs: string[]) => xs.map((x) => kqlString(x.toLowerCase())).join(",");
const rows = (r: unknown) => {
  const t = (r as LogAnalyticsResponse).tables?.[0];
  return t ? tableToObjects(t) : [];
};
const str = (v: unknown) => (v == null || v === "" ? undefined : String(v));
const num = (v: unknown) => (v == null || v === "" || Number.isNaN(Number(v)) ? undefined : Number(v));
const iso = (v: unknown) => { const s = str(v); return s ? new Date(s).toISOString() : undefined; };
const arr = (v: unknown): string[] => { try { const a = typeof v === "string" ? JSON.parse(v) : v; return Array.isArray(a) ? a.map(String) : []; } catch { return []; } };

/** KQL per access source: one row per (caller IP, identity) — control-plane calls and this dashboard's own app excluded */
export function accessQuery(source: PluAccessRow["source"], selfAppId: string): string {
  const self = kqlString(selfAppId);
  if (source === "kvAudit") {
    return `let selfApp = ${self};
let ctrl = dynamic(["VaultGet","VaultPut","VaultPatch","VaultDelete","VaultList","VaultListDeleted","VaultGetDeleted","VaultRecover","VaultPurge"]);
union isfuzzy=true
 (AzureDiagnostics | where ResourceProvider == "MICROSOFT.KEYVAULT" and Category == "AuditEvent"
   | project TimeGenerated, Op=OperationName, ip=tostring(split(CallerIPAddress, ":")[0]), Code=toint(column_ifexists("httpStatusCode_d", 0)),
             appid=tostring(column_ifexists("identity_claim_appid_g", "")),
             oid=tostring(column_ifexists("identity_claim_http_schemas_microsoft_com_identity_claims_objectidentifier_g", ""))),
 (AZKVAuditLogs | project TimeGenerated, Op=OperationName, ip=tostring(split(CallerIpAddress, ":")[0]), Code=toint(HttpStatusCode),
             appid=tostring(Identity.claim.appid), oid=tostring(Identity.claim.oid))
| where Op !in (ctrl) and appid != selfApp
| summarize Requests=count(), Failed=countif(Code >= 400), First=min(TimeGenerated), Last=max(TimeGenerated), Ops=make_set(Op, 5) by ip, oid
| top 200 by Requests desc`;
  }
  if (source === "storageLogs") {
    return `let selfApp = ${self};
union isfuzzy=true StorageBlobLogs, StorageFileLogs, StorageQueueLogs, StorageTableLogs
| extend ip = tostring(split(CallerIpAddress, ":")[0]), oid = tostring(RequesterObjectId)
| where isempty(RequesterAppId) or RequesterAppId != selfApp
| summarize Requests=count(), Failed=countif(toint(StatusCode) >= 400), Bytes=sum(tolong(RequestBodySize) + tolong(ResponseBodySize)),
            First=min(TimeGenerated), Last=max(TimeGenerated), Ops=make_set(OperationName, 5) by ip, oid
| top 200 by Requests desc`;
  }
  return `ACRConnectedClientList
| summarize Clients=max(ClientCount), First=min(TimeGenerated), Last=max(TimeGenerated) by ip=tostring(ClientIp)
| top 200 by Clients desc`;
}

/** VNet flow logs (Traffic Analytics) to the Private Endpoint IPs; both directions of a pair counted once (max) */
export function flowQuery(peIps: string[]): string {
  return `let peIps = dynamic([${peIps.map(kqlString).join(",")}]);
NTANetAnalytics
| where SubType == "FlowLog" and DestIp in (peIps)
| summarize Bytes=sum(tolong(BytesSrcToDest) + tolong(BytesDestToSrc)), Flows=count(),
            Allowed=countif(FlowStatus == "Allowed"), Denied=countif(FlowStatus == "Denied"),
            First=min(FlowStartTime), Last=max(FlowEndTime), Ports=make_set(DestPort, 5)
  by SrcIp, DestIp, FlowDirection
| summarize Bytes=max(Bytes), Flows=max(Flows), Allowed=max(Allowed), Denied=max(Denied), First=min(First), Last=max(Last),
            Ports=make_set(Ports, 5) by SrcIp, DestIp
| top 300 by Bytes desc`;
}

type DiagSetting = { properties?: { workspaceId?: string; logs?: Array<{ category?: string; categoryGroup?: string; enabled?: boolean }> } };

/** Is the caller-IP category of this service sent to a Log Analytics workspace? */
export function diagState(settings: DiagSetting[], def: (typeof ACCESS)[string]): { state: LiveSourceState; reason?: PlSourceStatus["reason"] } {
  if (!settings.length) return { state: "disabled", reason: "noDiagSetting" };
  const toWs = settings.filter((s) => !!s.properties?.workspaceId);
  if (!toWs.length) return { state: "disabled", reason: "notToWorkspace" };
  const on = toWs.some((s) => (s.properties?.logs ?? []).some((l) => l.enabled && ((l.category && def.categories.includes(l.category)) || (l.categoryGroup && def.groups.includes(l.categoryGroup)))));
  return on ? { state: "ok" } : { state: "disabled", reason: "categoryOff" };
}

/**
 * Who uses the Private Endpoints of one VNet. Cached per user (cachePrefix) for AZURE_PL_USAGE_CACHE_TTL_MS;
 * identical concurrent requests share one run.
 */
export async function collectPrivateLinkUsage(env: Env, bearerToken: string | undefined, spec: DiagramSpec, vnetNodeId: string): Promise<PrivateLinkUsageResponse | null> {
  const scope = scopeFromSpec(spec, vnetNodeId);
  if (!scope) return null;
  const windowHours = env.AZURE_PL_USAGE_WINDOW_H;
  const base = { generatedAt: new Date().toISOString(), windowHours };
  if (spec.id !== "prod-infra" && !spec.id.startsWith("auto-")) return { ...base, dataSource: "azure", endpoints: [], usages: [], unresolved: [], publicAccess: [], sources: [] };
  if (!spec.id.startsWith("auto-")) {
    // Sample diagram: nothing real to read
    return { ...base, dataSource: "mock", endpoints: scope.pes.map((p) => ({ peNodeId: p.peNodeId, targetNodeId: p.targetNodeId, activity: "unknown" })), usages: [], unresolved: [], publicAccess: [], sources: [] };
  }
  // Access logs name callers: signed-in users only, anonymous only in dev mode with this feature's own opt-in too
  const signedOut = !bearerToken && !anonymousSpAllowed(env, env.AZURE_PL_USAGE_SP_FALLBACK);
  if (signedOut || !env.AZURE_PL_USAGE_ENABLED) {
    const state: LiveSourceState = signedOut ? "signin" : "disabled";
    const sources: PlSourceStatus[] = [
      ...scope.targets.filter((t) => ACCESS[kindOf(t)]).map((t) => ({ source: ACCESS[kindOf(t)]!.source, targetNodeId: t.id, state, service: ACCESS[kindOf(t)]!.service })),
      { source: "vnetFlow", state },
    ];
    return { ...base, dataSource: "azure", endpoints: scope.pes.map((p) => ({ peNodeId: p.peNodeId, targetNodeId: p.targetNodeId, activity: "unknown" })), usages: [], unresolved: [], publicAccess: [], sources };
  }

  const key = `${cachePrefix(bearerToken)}:plu:${spec.id}:${vnetNodeId}:${windowHours}`;
  const cached = resultCache.get(key);
  if (cached) return cached;
  const running = inflight.get(key);
  if (running) return running;
  const run = (async () => {
    const arm = bearerToken ? await getArmFetcher(env, bearerToken) : await getAnonymousArmFetcher(env, env.AZURE_PL_USAGE_SP_FALLBACK);
    const la = bearerToken ? await getLogAnalyticsFetcher(env, bearerToken) : await getAnonymousLogFetcher(env, env.AZURE_PL_USAGE_SP_FALLBACK);
    const out = await collectWith(env, arm, la, spec, scope, windowHours);
    const res: PrivateLinkUsageResponse = { ...base, dataSource: "azure", ...out };
    resultCache.set(key, res, env.AZURE_PL_USAGE_CACHE_TTL_MS);
    return res;
  })();
  inflight.set(key, run);
  try {
    return await run;
  } finally {
    inflight.delete(key);
  }
}

async function collectWith(env: Env, arm: ArmFetcher, la: LogAnalyticsFetcher, spec: DiagramSpec, scope: Scope, windowHours: number) {
  const timespan = `PT${windowHours}H`;
  const byId = new Map(spec.nodes.map((n) => [n.id, n]));
  const vnetArmIds = [scope.vnet, ...[...scope.peerVnetIds].map((id) => byId.get(id))].map((v) => v?.azureResourceId).filter((x): x is string => !!x);
  const sources: PlSourceStatus[] = [];
  const settle = async <T>(p: Promise<T>, fallback: T, label: string): Promise<T> => {
    try { return await p; } catch (e) { debug(`[plu] ${label} failed: ${mask(String(e)).slice(0, 200)}`); return fallback; }
  };

  // ── (b) Private Endpoints: IP and connection state ──
  const peArm = scope.pes.map((p) => p.armId).filter((x): x is string => !!x);
  const peRows = peArm.length ? await settle(graph<{ peId: string; state?: string; ip?: string }>(arm, env, `Resources | where type =~ 'microsoft.network/privateendpoints' and tolower(id) in~ (${kqlList(peArm)})
| extend c = coalesce(properties.privateLinkServiceConnections[0], properties.manualPrivateLinkServiceConnections[0])
| mv-expand nic = properties.networkInterfaces
| project peId=tolower(id), nicId=tolower(tostring(nic.id)), state=tostring(c.properties.privateLinkServiceConnectionState.status)
| join kind=leftouter (Resources | where type =~ 'microsoft.network/networkinterfaces' | mv-expand ipc = properties.ipConfigurations
    | project nicId=tolower(id), ip=tostring(ipc.properties.privateIPAddress)) on nicId
| project peId, state, ip`), [], "pe inventory") : [];
  const STATES = new Set(["Approved", "Pending", "Rejected", "Disconnected"]);
  for (const p of scope.pes) {
    const hit = peRows.filter((r) => r.peId === p.armId?.toLowerCase());
    const ip = hit.map((r) => r.ip).find((x) => x && isPrivateV4(x));
    if (ip) p.ip = ip;
    const st = hit.map((r) => r.state).find((s) => s && STATES.has(s));
    if (st) p.state = st as PluPe["state"];
  }

  // ── (c) NICs of the VNet and its peers (who owns an IP) ──
  const nicRows = vnetArmIds.length ? await settle(graph<{ ip: string; nicName: string; vmId?: string; peId?: string }>(arm, env, `Resources | where type =~ 'microsoft.network/networkinterfaces'
| mv-expand ipc = properties.ipConfigurations
| extend subnetId = tolower(tostring(ipc.properties.subnet.id))
| where subnetId has_any (${kqlList(vnetArmIds)})
| project ip=tostring(ipc.properties.privateIPAddress), nicName=name, vmId=tolower(tostring(properties.virtualMachine.id)), peId=tolower(tostring(properties.privateEndpoint.id))`), [], "nic inventory") : [];
  const nics: PluNic[] = nicRows.filter((r) => r.ip && isPrivateV4(r.ip)).map((r) => ({ ip: r.ip, nicName: mask(r.nicName), ...(r.vmId ? { vmArmId: r.vmId } : {}), ...(r.peId ? { peArmId: r.peId } : {}) }));

  // ── (d) managed identities → resource (names only leave this function) ──
  const idRows = await settle(graph<{ id: string; name: string; sys?: string; kubelet?: string; ua?: string }>(arm, env, `Resources | where type in~ ('microsoft.compute/virtualmachines','microsoft.compute/virtualmachinescalesets','microsoft.web/sites','microsoft.app/containerapps','microsoft.containerservice/managedclusters')
| extend sys=tostring(identity.principalId), kubelet=tostring(properties.identityProfile.kubeletidentity.objectId), uas=identity.userAssignedIdentities
| mv-expand bagexpansion=array uas
| project id=tolower(id), name, sys, kubelet, ua=tostring(uas[1].principalId)`), [], "identities");
  const identities = new Map<string, Array<{ armId: string; name: string }>>();
  for (const r of idRows) for (const oid of [r.sys, r.kubelet, r.ua]) {
    if (!oid) continue;
    const list = identities.get(oid.toLowerCase()) ?? [];
    if (!list.some((x) => x.armId === r.id)) list.push({ armId: r.id, name: mask(r.name) });
    identities.set(oid.toLowerCase(), list);
  }

  // ── (e)–(h) access logs, only where the caller-IP category reaches a workspace ──
  const access: PluAccessRow[] = [];
  await Promise.all(scope.targets.map(async (t) => {
    const def = ACCESS[kindOf(t)];
    if (!def || !t.azureResourceId) return;
    const settings = (await Promise.all(def.scopes.map((s) => settle(arm.fetchJson<{ value?: DiagSetting[] }>(`https://management.azure.com${t.azureResourceId}${s}/providers/Microsoft.Insights/diagnosticSettings?api-version=2021-05-01-preview`).then((r) => r.value ?? []), [] as DiagSetting[], "diagnostic settings")))).flat();
    const d = diagState(settings, def);
    const status: PlSourceStatus = { source: def.source, targetNodeId: t.id, state: d.state, service: def.service, category: def.categories.join(" / "), ...(d.reason ? { reason: d.reason } : {}) };
    if (d.state === "ok") {
      try {
        const res = rows(await la.queryResource(t.azureResourceId, accessQuery(def.source, env.AZURE_AD_CLIENT_ID ?? ""), timespan));
        status.state = res.length ? "ok" : "empty";
        for (const r of res) access.push({
          targetNodeId: t.id, source: def.source, ip: str(r.ip), oid: str(r.oid), requests: num(r.Requests), failed: num(r.Failed),
          clients: num(r.Clients), bytes: num(r.Bytes), first: iso(r.First), last: iso(r.Last), ops: arr(r.Ops),
        });
      } catch (e) {
        status.state = "failed";
        if (/ 40[13]:/.test(String(e))) { status.state = "disabled"; status.reason = "noAccess"; }
        debug(`[plu] access log ${def.source} failed: ${mask(String(e)).slice(0, 200)}`);
      }
    }
    sources.push(status);
  }));

  // ── (i) flow coverage on the caller side, (j) flows to the PE IPs ──
  type FlowLog = { t: string; targetType: string; enabled?: boolean; ta?: boolean; interval?: number; ws?: string };
  const flowLogs = vnetArmIds.length ? await settle(graph<FlowLog>(arm, env, `Resources | where type =~ 'microsoft.network/networkwatchers/flowlogs'
| extend t = tolower(tostring(properties.targetResourceId)), fa = properties.flowAnalyticsConfiguration.networkWatcherFlowAnalyticsConfiguration
| where t has_any (${kqlList(vnetArmIds)})${scope.nsgArmIds.length ? ` or t in~ (${kqlList(scope.nsgArmIds)})` : ""}
| project t, targetType=tostring(split(t, '/')[7]), enabled=tobool(properties.enabled), ta=tobool(fa.enabled), interval=toint(fa.trafficAnalyticsInterval), ws=tostring(fa.workspaceResourceId)`), [] as FlowLog[], "flow logs") : [];
  const vnetSide = flowLogs.filter((f) => f.targetType !== "networksecuritygroups" && vnetArmIds.some((v) => f.t.startsWith(v.toLowerCase())) && f.enabled !== false);
  const nsgOnly = !vnetSide.length && flowLogs.some((f) => f.targetType === "networksecuritygroups" && f.enabled !== false);
  const withTa = vnetSide.filter((f) => f.ta && f.ws);
  const flow: PlSourceStatus = { source: "vnetFlow", state: "disabled" };
  const flows: PluFlowRow[] = [];
  const peIps = scope.pes.map((p) => p.ip).filter((x): x is string => !!x);
  if (withTa.length) {
    flow.state = "ok";
    flow.intervalMin = Math.max(...withTa.map((f) => f.interval ?? 60));
    flow.workspaceName = mask(withTa[0]!.ws!.split("/").pop() ?? "");
    for (const ws of [...new Set(withTa.map((f) => f.ws!))]) {
      if (!peIps.length) break;
      try {
        for (const r of rows(await la.queryResource(ws, flowQuery(peIps), timespan))) {
          const src = str(r.SrcIp), dst = str(r.DestIp);
          if (!src || !dst) continue;
          flows.push({ srcIp: src, destIp: dst, bytes: num(r.Bytes) ?? 0, flows: num(r.Flows) ?? 0, allowed: num(r.Allowed) ?? 0, denied: num(r.Denied) ?? 0, first: iso(r.First), last: iso(r.Last), ports: arr(r.Ports).map(Number).filter(Number.isFinite) });
        }
      } catch (e) {
        flow.state = "failed";
        if (/ 40[13]:/.test(String(e))) { flow.state = "disabled"; flow.reason = "noAccess"; }
        debug(`[plu] flow query failed: ${mask(String(e)).slice(0, 200)}`);
      }
    }
    if (flow.state === "ok" && !flows.length) flow.state = "empty";
  } else {
    flow.reason = vnetSide.length ? "noTrafficAnalytics" : nsgOnly ? "nsgFlowLogOnly" : "noFlowLog";
  }
  sources.push(flow);
  sources.sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0) || ((a.targetNodeId ?? "") < (b.targetNodeId ?? "") ? -1 : 1));

  const input: PluInput = {
    callers: scope.callers, subnets: scope.subnets, pes: scope.pes.map((p) => ({ peNodeId: p.peNodeId, targetNodeId: p.targetNodeId, vnetId: p.vnetId, ...(p.ip ? { ip: p.ip } : {}), ...(p.state ? { state: p.state } : {}) })), nics, nodeByArmId: scope.nodeByArmId,
    identities, peerings: scope.peerings, access, flows, peBytes: new Map(), sources,
    clusterOf: scope.clusterOf, outerSubnets: scope.outerSubnets, knownCidrs: scope.knownCidrs,
  };
  return { ...joinPrivateLinkUsage(input), sources };
}
