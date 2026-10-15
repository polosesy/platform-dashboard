// VNet traffic — flow-log sections and coverage for one subscription (optionally one VNet), read through the
// caller's Azure connection (getArmFetcherAuto / getLogAnalyticsFetcherAuto). Only the requested section is queried.
//
// States instead of fake numbers: disabled (no workspace configured) · noAccess (401/403 on the workspace) ·
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
  overviewQuery,
  scopePrefix,
  snapRange,
  talkersQuery,
  threatQuery,
} from "./networkQueries.js";
import { buildFlowCoverage, type FlowLogRow, type VnetRow, type WorkspaceRow } from "./flowLogCoverage.js";

export type NetFlowParams = { subscriptionId: string; vnet?: string; section: NetSection; range: number; top: number; dim: NetTalkerDim; dir: NetDir };

const flowsCache = new CacheManager<NetFlowsResponse>(200);
const coverageCache = new CacheManager<NetCoverageResponse>(50);
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
  if (/^LogAnalytics 400:/.test(m) && /resolve table|could not be resolved.*(NTANetAnalytics|NTAIpDetails)|PathNotFoundError/i.test(m)) return "noTable";
  return null;
}

async function rows(la: LogAnalyticsFetcher, workspaceId: string, kql: string): Promise<Record<string, unknown>[]> {
  const json = (await la.query(workspaceId, kql)) as LogAnalyticsResponse;
  const table = json.tables?.[0];
  return table ? tableToObjects(table) : [];
}

export async function getNetFlows(env: Env, bearerToken: string | undefined, p: NetFlowParams): Promise<NetFlowsResponse> {
  const range = snapRange(p.range);
  const base: NetFlowsResponse = {
    generatedAt: new Date().toISOString(), source: "live", section: p.section, state: "ok", lookbackMinutes: range, binMinutes: binMinutes(range), gaps: [],
  };
  const workspaceId = env.AZURE_LOG_ANALYTICS_WORKSPACE_ID;
  const la = await getLogAnalyticsFetcherAuto(env, bearerToken); // anonymous without the dev switch → signin_required
  if (!workspaceId) return { ...base, state: "disabled" };

  const variant = p.section === "talkers" ? p.dim : p.section === "internet" ? p.dir : "-";
  const key = `${cachePrefix(bearerToken)}:net:${p.section}:${p.subscriptionId}:${p.vnet ?? "*"}:${range}:${variant}:${p.top}`;
  const cached = flowsCache.get(key);
  if (cached) return cached;

  return singleFlight(key, async () => {
    const table = env.AZURE_LOG_ANALYTICS_TABLE;
    const prefix = scopePrefix(p.subscriptionId, p.vnet);
    let out: NetFlowsResponse;
    try {
      if (p.section === "overview") {
        const overview = mapOverview(await rows(la, workspaceId, overviewQuery(table, range, prefix)));
        out = { ...base, state: overview.totals.records ? "ok" : "empty", overview };
      } else if (p.section === "talkers") {
        const list = mapTalkers(await rows(la, workspaceId, talkersQuery(table, range, prefix, p.dim, p.top)), p.dim);
        out = { ...base, state: list.length ? "ok" : "empty", talkers: { dim: p.dim, rows: list } };
      } else if (p.section === "blocked") {
        const list = mapBlocked(await rows(la, workspaceId, blockedQuery(table, range, prefix, p.top)));
        out = { ...base, state: list.length ? "ok" : "empty", blocked: list };
      } else {
        const raw = await rows(la, workspaceId, internetQuery(table, range, prefix, p.dir, p.top));
        const gaps: NetGap[] = [];
        const threats = new Map<string, { threat?: string; detail?: string; location?: string }>();
        const ips = raw.map((r) => String(r.Ip ?? "")).filter(Boolean);
        if (ips.length) {
          try {
            for (const r of await rows(la, workspaceId, threatQuery(range, ips))) {
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

const gapReason = (e: unknown): NetGap["reason"] => (e instanceof HttpError && e.status === 403) || /^(ARM|LogAnalytics) 40[13]:/.test(e instanceof Error ? e.message : "") ? "noAccess" : "failed";

export async function getNetCoverage(env: Env, bearerToken: string | undefined, subscriptionId: string): Promise<NetCoverageResponse> {
  const arm = await getArmFetcherAuto(env, bearerToken); // anonymous without the dev switch → signin_required
  const key = `${cachePrefix(bearerToken)}:netcov:${subscriptionId}`;
  const cached = coverageCache.get(key);
  if (cached) return cached;

  return singleFlight(key, async () => {
    const gaps: NetGap[] = [];
    const part = async <T>(name: NetGap["part"], run: () => Promise<T>, fallback: T): Promise<T> => {
      try { return await run(); } catch (e) {
        // Connection-level refusals (role, credential) are the request's answer, not a gap
        if (e instanceof HttpError && /^(connection_|no_platform_role|signin_required)/.test(e.code)) throw e;
        gaps.push({ part: name, reason: gapReason(e) });
        return fallback;
      }
    };
    const [flowLogs, vnetRows, workspaces] = await Promise.all([
      part("flowLogs", () => argAll<FlowLogRow>(arm, FLOW_LOGS_KQL, [subscriptionId]), []),
      part("vnets", () => argAll<VnetRow>(arm, VNETS_KQL, [subscriptionId]), []),
      part("workspaces", () => argAll<WorkspaceRow>(arm, WORKSPACES_KQL), []),
    ]);
    const cov = buildFlowCoverage({ flowLogs, vnetRows, workspaces, configuredWorkspaceId: env.AZURE_LOG_ANALYTICS_WORKSPACE_ID });

    const workspaceId = env.AZURE_LOG_ANALYTICS_WORKSPACE_ID;
    let workspace: NetCoverageResponse["workspace"] = { state: "disabled", lastRow: null, rows7d: null, legacyFlowRows7d: null };
    if (workspaceId) {
      try {
        const la = await getLogAnalyticsFetcherAuto(env, bearerToken);
        const r = await rows(la, workspaceId, freshnessQuery(env.AZURE_LOG_ANALYTICS_TABLE, scopePrefix(subscriptionId)));
        const vnet = r.find((x) => x.K === "vnet"), legacy = r.find((x) => x.K === "legacy");
        const n = Number(vnet?.Rows ?? 0);
        workspace = {
          state: n > 0 ? "ok" : vnet ? "empty" : "noTable",
          lastRow: n > 0 && vnet?.Last ? String(vnet.Last) : null,
          rows7d: vnet ? n : null,
          legacyFlowRows7d: legacy ? Number(legacy.Rows ?? 0) : null,
        };
      } catch (e) {
        if (e instanceof HttpError && /^(connection_|no_platform_role|signin_required)/.test(e.code)) throw e;
        const st = laState(e);
        workspace = { state: st ?? "empty", lastRow: null, rows7d: null, legacyFlowRows7d: null };
        if (!st) gaps.push({ part: "freshness", reason: "failed" });
      }
    }
    const out: NetCoverageResponse = { generatedAt: new Date().toISOString(), source: "live", vnets: cov.vnets, unmappedFlowLogs: cov.unmappedFlowLogs, workspace, gaps };
    coverageCache.set(key, out, env.AZURE_NETWORK_COVERAGE_TTL_MS);
    return out;
  });
}
