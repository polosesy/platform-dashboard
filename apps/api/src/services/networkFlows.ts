// VNet traffic — flow-log sections and coverage for one subscription (optionally one VNet), read through the
// subscription's Azure connection (getArmFetcherAuto / getLogAnalyticsFetcherAuto). Only the requested section is queried.
//
// Which workspaces: a VNet flow log names its own Traffic Analytics workspace, and VNets of one subscription often send
// to different ones — so not one setting but `pickFlowWorkspaces` (readable flow-log settings → the connection's
// `logAnalyticsWorkspaces` → AZURE_LOG_ANALYTICS_WORKSPACE_ID for home), each probed for rows of this subscription
// (`freshnessQuery`, cached); the sections read the workspaces that have rows, in one cross-workspace query.
//
// States instead of fake numbers: disabled (no workspace to read) · noAccess (401/403 on the workspace) ·
// noTable (no Traffic Analytics table) · empty (no rows in range). Connection/permission HttpErrors propagate to the
// route (sendError); anonymous callers get signin_required → sample data at the route.
import type {
  NetCoverageResponse,
  NetDir,
  NetFlowsResponse,
  NetGap,
  NetSection,
  NetSectionState,
  NetTalkerDim,
  NetWorkspaceVia,
} from "@aud/types";
import type { Env } from "../env.js";
import { CacheManager, cachePrefix } from "../infra/cacheManager.js";
import {
  getArmFetcherAuto,
  getLogAnalyticsFetcherAuto,
  tableToObjects,
  type ArmFetcher,
  type LogAnalyticsFetcher,
  type LogAnalyticsResponse,
} from "../infra/azureClientFactory.js";
import { connectionForSubscription, getConnections, homeConnection } from "../infra/connectionRegistry.js";
import { HttpError } from "../infra/requestParams.js";
import {
  binMinutes,
  blockedQuery,
  freshnessQuery,
  internetQuery,
  mapBlocked,
  mapInternet,
  mapOverview,
  mapTalkers,
  mapMap,
  mapQuery,
  overviewQuery,
  snapRange,
  talkersQuery,
  targetVnetKey,
  threatQuery,
  type FlowScope,
} from "./networkQueries.js";
import {
  buildFlowCoverage,
  pickFlowWorkspaces,
  type FlowLogRow,
  type FlowWorkspace,
  type ObservedVnet,
  type VnetRow,
  type WorkspaceRow,
} from "./flowLogCoverage.js";
import { allows, type PermissionSet } from "./connectionCheck.js";

/** Lines on the traffic map by bytes (denied / malicious lines come on top of these) */
export const MAP_TOP = 150;

export type NetFlowParams = { subscriptionId: string; vnet?: string; section: NetSection; range: number; top: number; dim: NetTalkerDim; dir: NetDir };

const flowsCache = new CacheManager<NetFlowsResponse>(200);
const coverageCache = new CacheManager<NetCoverageResponse>(50);
const contextCache = new CacheManager<FlowContext>(50);
const probeCache = new CacheManager<WorkspaceProbe[]>(50);
const inflight = new Map<string, Promise<unknown>>();

/** One request per key at a time (Log Analytics has a shared concurrency quota) */
function singleFlight<T>(key: string, run: () => Promise<T>): Promise<T> {
  const hit = inflight.get(key) as Promise<T> | undefined;
  if (hit) return hit;
  const p = run().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** Log Analytics failures that are a state of the workspace, not an error of this request */
export function laState(e: unknown): NetSectionState | null {
  if (e instanceof HttpError) return null;
  const m = e instanceof Error ? e.message : String(e);
  if (/^LogAnalytics 40[13]:/.test(m)) return "noAccess";
  // A fuzzy union whose tables all are missing: "Operator source expression should be table or column"
  if (/^LogAnalytics 400:/.test(m) && /resolve table|could not be resolved.*(NTANetAnalytics|NTAIpDetails)|PathNotFoundError|source expression should be table or column/i.test(m)) return "noTable";
  return null;
}

/** Connection-level refusals (role, credential, sign-in) are the request's answer, never a gap */
const isRefusal = (e: unknown) => e instanceof HttpError && /^(connection_|no_platform_role|signin_required)/.test(e.code);

async function rows(la: LogAnalyticsFetcher, workspaceId: string, kql: string, more?: string[]): Promise<Record<string, unknown>[]> {
  const json = (await la.query(workspaceId, kql, more?.length ? { workspaces: more } : undefined)) as LogAnalyticsResponse;
  const table = json.tables?.[0];
  return table ? tableToObjects(table) : [];
}

// ── the subscription's flow-log settings and the workspaces to read ──

type FlowContext = {
  flowLogs: FlowLogRow[];
  vnetRows: VnetRow[];
  workspaces: WorkspaceRow[];
  flowLogsRead: boolean;
  watcherRegions: Set<string> | null;
  subscriptionReadable: boolean | null;
  read: FlowWorkspace[];
  unlisted: string[];
  gaps: NetGap[];
};

type ArgPage<T> = { data?: T[]; $skipToken?: string };
const ARG_URL = "https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01";

async function argAll<T>(arm: ArmFetcher, query: string, subscriptions?: string[]): Promise<T[]> {
  const out: T[] = [];
  let skip: string | undefined;
  for (let page = 0; page < 10; page++) {
    const body = { ...(subscriptions ? { subscriptions } : {}), query, options: { $top: 1000, ...(skip ? { $skipToken: skip } : {}) } };
    const r = await arm.postJson<ArgPage<T>>(ARG_URL, body);
    out.push(...(r.data ?? []));
    if (!r.$skipToken) break;
    skip = r.$skipToken;
  }
  return out;
}

const FLOW_LOGS_KQL = `resources
| where type =~ 'microsoft.network/networkwatchers/flowlogs'
| extend fa = properties.flowAnalyticsConfiguration.networkWatcherFlowAnalyticsConfiguration
| project t = tolower(tostring(properties.targetResourceId)), location, enabled = tobool(properties.enabled), ta = tobool(fa.enabled),
    interval = toint(fa.trafficAnalyticsInterval), ws = tolower(tostring(fa.workspaceResourceId)), retention = toint(properties.retentionPolicy.days),
    retentionOn = tobool(properties.retentionPolicy.enabled)`;
const VNETS_KQL = `resources
| where type =~ 'microsoft.network/virtualnetworks'
| extend subs = iff(array_length(properties.subnets) > 0, properties.subnets, dynamic([{}]))
| mv-expand s = subs
| project vnet = tolower(id), name, resourceGroup, location, subnet = tolower(tostring(s.id)), nsg = tolower(tostring(s.properties.networkSecurityGroup.id))`;
const WORKSPACES_KQL = `resources
| where type =~ 'microsoft.operationalinsights/workspaces'
| project id = tolower(id), name, customerId = tolower(tostring(properties.customerId))`;
const WATCHERS_KQL = `resources
| where type =~ 'microsoft.network/networkwatchers'
| distinct location = tolower(location)`;
const FLOW_LOG_READ = "Microsoft.Network/networkWatchers/flowLogs/read";

const gapReason = (e: unknown): NetGap["reason"] => (e instanceof HttpError && e.status === 403) || /^(ARM|LogAnalytics) 40[13]:/.test(e instanceof Error ? e.message : "") ? "noAccess" : "failed";

/**
 * Resource Graph returns nothing — not an error — for what the connection cannot read: flow logs live in Network
 * Watcher's resource group, so "no flow log rows" is only "none" when the settings are visible (a Network Watcher in the
 * VNet's region is visible, or the connection may read flow logs at the subscription scope).
 */
async function flowContext(env: Env, bearerToken: string | undefined, subscriptionId: string): Promise<FlowContext> {
  const arm = await getArmFetcherAuto(env, bearerToken); // anonymous without the dev switch → signin_required
  const key = `${cachePrefix(bearerToken)}:netctx:${subscriptionId}`;
  const cached = contextCache.get(key);
  if (cached) return cached;
  return singleFlight(key, async () => {
    const gaps: NetGap[] = [];
    const part = async <T>(name: NetGap["part"] | null, run: () => Promise<T>, fallback: T): Promise<T> => {
      try { return await run(); } catch (e) {
        if (isRefusal(e)) throw e;
        if (name) gaps.push({ part: name, reason: gapReason(e) });
        return fallback;
      }
    };
    const subs = [subscriptionId];
    const [flowLogs, vnetRows, workspaces, watchers, perms] = await Promise.all([
      part<FlowLogRow[] | null>("flowLogs", () => argAll<FlowLogRow>(arm, FLOW_LOGS_KQL, subs), null),
      part("vnets", () => argAll<VnetRow>(arm, VNETS_KQL, subs), [] as VnetRow[]),
      part("workspaces", () => argAll<WorkspaceRow>(arm, WORKSPACES_KQL), [] as WorkspaceRow[]),
      part<{ location: string }[] | null>(null, () => argAll<{ location: string }>(arm, WATCHERS_KQL, subs), null),
      part<PermissionSet[] | null>(null, async () => (await arm.fetchJson<{ value?: PermissionSet[] }>(
        `https://management.azure.com/subscriptions/${encodeURIComponent(subscriptionId)}/providers/Microsoft.Authorization/permissions?api-version=2022-04-01`)).value ?? [], null),
    ]);
    const home = homeConnection(env);
    const conn = connectionForSubscription(env, subscriptionId) ?? home;
    const pick = pickFlowWorkspaces({
      flowLogs: flowLogs ?? [],
      workspaces,
      listed: conn.logAnalyticsWorkspaces,
      listedElsewhere: new Set(getConnections(env).filter((c) => c.key !== conn.key).flatMap((c) => c.logAnalyticsWorkspaces)),
      homeReads: conn.key === home?.key,
      envWorkspace: env.AZURE_LOG_ANALYTICS_WORKSPACE_ID,
    });
    const out: FlowContext = {
      flowLogs: flowLogs ?? [],
      vnetRows,
      workspaces,
      flowLogsRead: flowLogs !== null,
      watcherRegions: watchers ? new Set(watchers.map((w) => (w.location ?? "").toLowerCase())) : null,
      subscriptionReadable: perms ? allows(perms, { action: FLOW_LOG_READ }) : null,
      read: pick.read,
      unlisted: pick.unlisted,
      gaps,
    };
    contextCache.set(key, out, env.AZURE_NETWORK_COVERAGE_TTL_MS);
    return out;
  });
}

type WorkspaceProbe = {
  id: string;
  name: string;
  via: NetWorkspaceVia;
  /** null = the probe failed (a gap) */
  state: NetSectionState | null;
  rows7d: number | null;
  lastRow: string | null;
  legacyRows7d: number | null;
  targets: { tgt: string; rows: number; last: string | null }[];
};

/** Each workspace once (cached): does it hold this subscription's rows, from which flow-log targets, how fresh */
async function probeWorkspaces(env: Env, bearerToken: string | undefined, subscriptionId: string, ctx: FlowContext): Promise<WorkspaceProbe[]> {
  const key = `${cachePrefix(bearerToken)}:netprobe:${subscriptionId}`;
  const cached = probeCache.get(key);
  if (cached) return cached;
  return singleFlight(key, async () => {
    const la = await getLogAnalyticsFetcherAuto(env, bearerToken);
    const kql = freshnessQuery(env.AZURE_LOG_ANALYTICS_TABLE, { subscriptionId });
    const out: WorkspaceProbe[] = [];
    // Three at a time: the Log Analytics concurrency quota is per caller
    for (let i = 0; i < ctx.read.length; i += 3) {
      out.push(...await Promise.all(ctx.read.slice(i, i + 3).map(async (w): Promise<WorkspaceProbe> => {
        const base = { id: w.id, name: w.name, via: w.via, rows7d: null, lastRow: null, legacyRows7d: null, targets: [] };
        try {
          const r = await rows(la, w.id, kql);
          const targets = r.filter((x) => x.K === "vnet").map((x) => ({ tgt: String(x.Tgt ?? ""), rows: Number(x.Rows ?? 0), last: x.Last ? String(x.Last) : null }));
          const legacy = r.find((x) => x.K === "legacy");
          const n = targets.reduce((s, x) => s + x.rows, 0);
          const last = targets.map((x) => x.last).filter((x): x is string => !!x).sort().pop() ?? null;
          const table = r.some((x) => x.K === "table");
          return { ...base, state: n > 0 ? "ok" : table ? "empty" : "noTable", rows7d: table ? n : null, lastRow: last, legacyRows7d: legacy ? Number(legacy.Rows ?? 0) : null, targets };
        } catch (e) {
          if (isRefusal(e)) throw e;
          return { ...base, state: laState(e) };
        }
      })));
    }
    probeCache.set(key, out, env.AZURE_NETWORK_COVERAGE_TTL_MS);
    return out;
  });
}

/** The workspaces the sections read: those with this subscription's rows; none has rows → the first that answered */
export function sectionWorkspaces(probes: { id: string; state: NetSectionState | null; rows7d: number | null }[]): string[] {
  const withRows = probes.filter((p) => (p.rows7d ?? 0) > 0).map((p) => p.id);
  if (withRows.length) return withRows;
  const first = probes.find((p) => p.state !== null) ?? probes[0];
  return first ? [first.id] : [];
}

export async function getNetFlows(env: Env, bearerToken: string | undefined, p: NetFlowParams): Promise<NetFlowsResponse> {
  const range = snapRange(p.range);
  const base: NetFlowsResponse = {
    generatedAt: new Date().toISOString(), source: "live", section: p.section, state: "ok", lookbackMinutes: range, binMinutes: binMinutes(range), gaps: [],
  };
  const la = await getLogAnalyticsFetcherAuto(env, bearerToken); // anonymous without the dev switch → signin_required
  const ctx = await flowContext(env, bearerToken, p.subscriptionId);
  if (!ctx.read.length) return { ...base, state: "disabled" };

  const variant = p.section === "talkers" ? p.dim : p.section === "internet" ? p.dir : "-";
  const key = `${cachePrefix(bearerToken)}:net:${p.section}:${p.subscriptionId}:${p.vnet ?? "*"}:${range}:${variant}:${p.top}`;
  const cached = flowsCache.get(key);
  if (cached) return cached;

  return singleFlight(key, async () => {
    const [primary, ...more] = sectionWorkspaces(await probeWorkspaces(env, bearerToken, p.subscriptionId, ctx));
    const table = env.AZURE_LOG_ANALYTICS_TABLE;
    const scope: FlowScope = { subscriptionId: p.subscriptionId, vnet: p.vnet };
    const q = (kql: string) => rows(la, primary!, kql, more);
    let out: NetFlowsResponse;
    try {
      if (p.section === "map") {
        const map = mapMap(await q(mapQuery(table, range, scope, MAP_TOP)));
        out = { ...base, state: map.edges.length || map.unplaced.records ? "ok" : "empty", map };
      } else if (p.section === "overview") {
        const overview = mapOverview(await q(overviewQuery(table, range, scope)));
        out = { ...base, state: overview.totals.records ? "ok" : "empty", overview };
      } else if (p.section === "talkers") {
        const list = mapTalkers(await q(talkersQuery(table, range, scope, p.dim, p.top)), p.dim);
        out = { ...base, state: list.length ? "ok" : "empty", talkers: { dim: p.dim, rows: list } };
      } else if (p.section === "blocked") {
        const list = mapBlocked(await q(blockedQuery(table, range, scope, p.top)));
        out = { ...base, state: list.length ? "ok" : "empty", blocked: list };
      } else {
        const raw = await q(internetQuery(table, range, scope, p.dir, p.top));
        const gaps: NetGap[] = [];
        const threats = new Map<string, { threat?: string; detail?: string; location?: string }>();
        const ips = raw.map((r) => String(r.Ip ?? "")).filter(Boolean);
        if (ips.length) {
          try {
            for (const r of await q(threatQuery(range, ips))) {
              threats.set(String(r.Ip), { threat: String(r.Threat ?? "") || undefined, detail: String(r.Detail ?? "") || undefined, location: String(r.Loc ?? "") || undefined });
            }
          } catch (e) {
            const st = laState(e);
            gaps.push({ part: "threatIntel", reason: st === "noAccess" ? "noAccess" : st === "noTable" ? "noTable" : "failed" });
          }
        }
        const list = mapInternet(raw, p.dir, threats);
        out = { ...base, state: list.length ? "ok" : "empty", gaps, internet: { direction: p.dir, rows: list } };
      }
    } catch (e) {
      const st = laState(e);
      if (!st) throw e;
      out = { ...base, state: st };
    }
    flowsCache.set(key, out, env.AZURE_LOG_ANALYTICS_CACHE_TTL_MS);
    return out;
  });
}

/** Probe rows → per VNet ("rg/vnet"): rows, last row, whether a VNet-level flow log sent them, which workspaces */
export function observedByVnet(probes: Pick<WorkspaceProbe, "name" | "targets">[]): Map<string, ObservedVnet> {
  const out = new Map<string, ObservedVnet>();
  for (const p of probes) {
    for (const t of p.targets) {
      const k = targetVnetKey(t.tgt);
      if (!k) continue;
      const o = out.get(k) ?? { rows7d: 0, lastRow: null, vnetLevel: false, workspaces: [] };
      o.rows7d += t.rows;
      if (t.last && (!o.lastRow || t.last > o.lastRow)) o.lastRow = t.last;
      if (t.tgt.split("/").length === 3) o.vnetLevel = true;
      if (!o.workspaces.includes(p.name)) o.workspaces.push(p.name);
      out.set(k, o);
    }
  }
  return out;
}

export async function getNetCoverage(env: Env, bearerToken: string | undefined, subscriptionId: string): Promise<NetCoverageResponse> {
  const ctx = await flowContext(env, bearerToken, subscriptionId); // anonymous without the dev switch → signin_required
  const key = `${cachePrefix(bearerToken)}:netcov:${subscriptionId}`;
  const cached = coverageCache.get(key);
  if (cached) return cached;

  return singleFlight(key, async () => {
    const gaps = [...ctx.gaps];
    const probes = ctx.read.length ? await probeWorkspaces(env, bearerToken, subscriptionId, ctx) : [];
    if (probes.some((p) => p.state === null)) gaps.push({ part: "freshness", reason: "failed" });
    const answered = probes.filter((p) => p.state === "ok" || p.state === "empty");
    const cov = buildFlowCoverage({
      flowLogs: ctx.flowLogs,
      vnetRows: ctx.vnetRows,
      workspaces: ctx.workspaces,
      readWorkspaceIds: ctx.read.map((w) => w.id),
      flowLogsRead: ctx.flowLogsRead,
      watcherRegions: ctx.watcherRegions,
      subscriptionReadable: ctx.subscriptionReadable,
      observed: answered.length ? observedByVnet(answered) : null,
    });
    const sum = (xs: (number | null)[]) => (xs.some((x) => x !== null) ? xs.reduce<number>((s, x) => s + (x ?? 0), 0) : null);
    const state: NetSectionState = !probes.length ? "disabled"
      : probes.some((p) => p.state === "ok") ? "ok"
      : probes.some((p) => p.state === "empty") ? "empty"
      : probes.find((p) => p.state)?.state ?? "empty";
    const workspace: NetCoverageResponse["workspace"] = {
      state,
      lastRow: probes.map((p) => p.lastRow).filter((x): x is string => !!x).sort().pop() ?? null,
      rows7d: sum(probes.map((p) => p.rows7d)),
      legacyFlowRows7d: sum(probes.map((p) => p.legacyRows7d)),
      read: probes.map((p) => ({ name: p.name, via: p.via, rows7d: p.rows7d })),
      unlisted: ctx.unlisted,
    };
    const out: NetCoverageResponse = { generatedAt: new Date().toISOString(), source: "live", vnets: cov.vnets, unmappedFlowLogs: cov.unmappedFlowLogs, workspace, gaps };
    coverageCache.set(key, out, env.AZURE_NETWORK_COVERAGE_TTL_MS);
    return out;
  });
}
