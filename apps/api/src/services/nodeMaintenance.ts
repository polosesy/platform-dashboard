// Node maintenance of one AKS cluster — what Azure did to its nodes, when, by whom, inside which planned window, and
// what the nodes and pods went through (AKS 모니터링 › 노드, 라이브 다이어그램 AKS 패널). Facts only, three sources:
//
//   Activity Log  the operations and their real times: agentPools/upgradeNodeImageVersion (caller
//                 Microsoft.ContainerService = AKS auto-upgrade), managedClusters/agentPools writes, and in the node
//                 resource group the scale-set reimage / upgrade / delete and Resource Health events. 90 days.
//                 (Resource Graph `resourcechanges` is not used for times: it records when a change was *detected* —
//                 stg 2026-10-23 17:00Z upgrade appeared there 2026-10-24 20:57Z.)
//   ARM           auto-upgrade channels, node pools (image, surge, drain), `maintenanceConfigurations` windows.
//   Prometheus    kube-state-metrics per node: cordon (kube_node_spec_unschedulable), Ready, re-registration
//                 (kube_node_created changes — a reimage keeps the name), kernel, surge nodes; pods started in an
//                 episode (kube_pod_start_time). Times at the range step (1 min for 7 days).
//
// Measured on stg 2026-10-23 (KST 10-24 Sat 02:00 = the 4th-Saturday node-OS window): surge 17:03, cordon 17:07–17:13,
// NotReady 17:10–17:17, kernel 6.8.0-1067 → 1070, system pool 17:22–17:30, ~190 pods restarted.
import type { Env } from "../env.js";
import type { NodeMaintEpisode, NodeMaintNode, NodeMaintSourceState, NodeMaintWindow, NodeMaintenanceResponse } from "@aud/types";
import { CacheManager, cachePrefix } from "../infra/cacheManager.js";
import { getArmFetcherAuto, getPrometheusFetcherAuto } from "../infra/azureClientFactory.js";
import { HttpError } from "../infra/requestParams.js";
import { resolvePrometheusTarget } from "./prometheusCollector.js";
import { pickScope, scopeMatchers } from "./promScope.js";

export const NODE_MAINT_DAYS = [1, 7, 14, 30] as const;
const ARM = "https://management.azure.com";
const AKS_API = "2025-05-01";
const MIN = 60_000;
/** Events closer than this belong to one episode */
const GAP_MS = 30 * MIN;

// ── planned-maintenance windows (pure) ──

export type WindowRule = NodeMaintWindow & { startDate: string | null };
type RawSchedule = {
  weekly?: { intervalWeeks?: number; dayOfWeek?: string };
  absoluteMonthly?: { intervalMonths?: number; dayOfMonth?: number };
  relativeMonthly?: { intervalMonths?: number; dayOfWeek?: string; weekIndex?: string };
  daily?: { intervalDays?: number };
};
export type RawMaintConfig = { name?: string; properties?: { maintenanceWindow?: { schedule?: RawSchedule; durationHours?: number; utcOffset?: string; startDate?: string; startTime?: string } } };

const DOW = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WEEK_INDEX: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, last: -1 };

export function parseWindows(list: RawMaintConfig[], now = Date.now()): WindowRule[] {
  return list.map((c): WindowRule => {
    const w = c.properties?.maintenanceWindow;
    const s = w?.schedule ?? {};
    const schedule: WindowRule["schedule"] = s.weekly ? { kind: "weekly", interval: s.weekly.intervalWeeks ?? 1, dayOfWeek: s.weekly.dayOfWeek }
      : s.relativeMonthly ? { kind: "relativeMonthly", interval: s.relativeMonthly.intervalMonths ?? 1, dayOfWeek: s.relativeMonthly.dayOfWeek, weekIndex: s.relativeMonthly.weekIndex }
      : s.absoluteMonthly ? { kind: "absoluteMonthly", interval: s.absoluteMonthly.intervalMonths ?? 1, dayOfMonth: s.absoluteMonthly.dayOfMonth }
      : s.daily ? { kind: "daily", interval: s.daily.intervalDays ?? 1 }
      : { kind: "other", interval: 1 };
    const rule: WindowRule = {
      name: c.name ?? "", schedule, startTime: w?.startTime ?? null, durationHours: w?.durationHours ?? null,
      utcOffset: w?.utcOffset ?? null, startDate: w?.startDate ?? null, next: null,
    };
    return { ...rule, next: nextWindowStart(rule, now) };
  }).sort((a, b) => (a.name < b.name ? -1 : 1));
}

const offsetMinutes = (o: string | null): number => {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(o ?? "+00:00");
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
};
const dayIndex = (y: number, m: number, d: number) => Math.floor(Date.UTC(y, m, d) / 86_400_000);

/** Does the window recur on this local date (y, month 0-11, d)? */
export function occursOn(w: WindowRule, y: number, m: number, d: number): boolean {
  const s = w.schedule;
  if (s.kind === "other") return false;
  let since = { days: 0, months: 0 };
  if (w.startDate) {
    const [sy, sm, sd] = w.startDate.split("-").map(Number) as [number, number, number];
    const days = dayIndex(y, m, d) - dayIndex(sy, sm - 1, sd);
    if (days < 0) return false;
    since = { days, months: (y - sy) * 12 + (m - (sm - 1)) };
  }
  const dow = new Date(Date.UTC(y, m, d)).getUTCDay();
  const dim = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const isDow = (name?: string) => !!name && DOW[dow] === name.toLowerCase();
  if (s.kind === "daily") return since.days % s.interval === 0;
  if (s.kind === "weekly") return isDow(s.dayOfWeek) && Math.floor(since.days / 7) % s.interval === 0;
  if (since.months % s.interval !== 0) return false;
  if (s.kind === "absoluteMonthly") return d === s.dayOfMonth;
  const n = WEEK_INDEX[(s.weekIndex ?? "").toLowerCase()];
  if (!isDow(s.dayOfWeek) || n === undefined) return false;
  return n === -1 ? d + 7 > dim : Math.floor((d - 1) / 7) + 1 === n;
}

/** UTC start (ms) of the window on a local date, or null */
function startOn(w: WindowRule, y: number, m: number, d: number): number | null {
  if (!occursOn(w, y, m, d) || !w.startTime || !/^\d{2}:\d{2}$/.test(w.startTime)) return null;
  const [hh, mm] = w.startTime.split(":").map(Number) as [number, number];
  return Date.UTC(y, m, d, hh, mm) - offsetMinutes(w.utcOffset) * MIN;
}
const localDate = (w: WindowRule, ms: number) => {
  const t = new Date(ms + offsetMinutes(w.utcOffset) * MIN);
  return [t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()] as const;
};

/** The window whose occurrence contains this instant (a window may start the local day before) */
export function windowAt(windows: WindowRule[], ms: number): WindowRule | null {
  for (const w of windows) {
    if (!w.durationHours) continue;
    const [y, m, d] = localDate(w, ms);
    for (const back of [0, 1]) {
      const day = new Date(Date.UTC(y, m, d - back));
      const s = startOn(w, day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
      if (s !== null && ms >= s && ms < s + w.durationHours * 60 * MIN) return w;
    }
  }
  return null;
}

/** The next start (an ongoing window counts), within 400 days */
export function nextWindowStart(w: WindowRule, now: number): string | null {
  if (!w.durationHours) return null;
  const [y, m, d] = localDate(w, now);
  for (let i = -1; i < 400; i++) {
    const day = new Date(Date.UTC(y, m, d + i));
    const s = startOn(w, day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
    if (s !== null && s + w.durationHours * 60 * MIN > now) return new Date(s).toISOString();
  }
  return null;
}

// ── episodes (pure) ──

export type ActEvent = { time: string; op: string; status: string; resource: string; caller: string; category: string };
/** kube-state-metrics per node over the range: [unix seconds, value] points */
export type NodeTrack = {
  node: string;
  ready: [number, number][];
  cordon: [number, number][];
  created: [number, number][];
  kernels: { kernel: string; first: number; last: number }[];
  kubelets: { version: string; first: number; last: number }[];
};

/** AKS names nodes `aks-<pool>-<n>-vmss<instance>` (display only) */
export const poolOfNode = (node: string): string | null => /^aks-([a-z0-9]+)-\d+-vmss[0-9a-z]+$/.exec(node)?.[1] ?? null;

type Span = { start: number; end: number | null };
/** Spans where the value is `on` (consecutive samples); a span still on at the last sample before the range end is open */
function spans(points: [number, number][], on: (v: number) => boolean, rangeEnd: number, step: number): Span[] {
  const out: Span[] = [];
  let cur: Span | null = null;
  let last = 0;
  for (const [t, v] of points) {
    if (cur && t - last > step * 1.5) { cur.end = last + step; out.push(cur); cur = null; } // a gap = the series left
    if (on(v)) { if (!cur) cur = { start: t, end: null }; } else if (cur) { cur.end = t; out.push(cur); cur = null; }
    last = t;
  }
  if (cur) { cur.end = last >= rangeEnd - step * 2 ? null : last + step; out.push(cur); }
  return out;
}

/** Facts of one node: when it appeared / left, re-registered, was cordoned, not Ready, changed kernel */
export function nodeFacts(t: NodeTrack, rangeStart: number, rangeEnd: number, step: number) {
  const seen = [...t.ready, ...t.cordon, ...t.created].map((p) => p[0]);
  const firstSeen = seen.length ? Math.min(...seen) : null;
  const lastSeen = seen.length ? Math.max(...seen) : null;
  const createdValues = [...new Set(t.created.map((p) => p[1]))].sort((a, b) => a - b);
  const appeared = firstSeen !== null && firstSeen > rangeStart + step * 2 && createdValues[0] !== undefined && createdValues[0] >= rangeStart ? createdValues[0] : null;
  const reRegistered = createdValues.filter((v) => v >= rangeStart && v !== appeared);
  const removed = lastSeen !== null && lastSeen < rangeEnd - step * 2 ? lastSeen : null;
  const kernels = [...t.kernels].sort((a, b) => a.first - b.first);
  const kubelets = [...(t.kubelets ?? [])].sort((a, b) => a.first - b.first);
  return {
    appeared, removed, reRegistered,
    cordons: spans(t.cordon, (v) => v >= 1, rangeEnd, step),
    notReady: spans(t.ready, (v) => v < 1, rangeEnd, step),
    kernel: kernels.length > 1 ? { from: kernels[0]!.kernel, to: kernels[kernels.length - 1]!.kernel, at: kernels[kernels.length - 1]!.first } : null,
    kubelet: kubelets.length > 1 ? { from: kubelets[0]!.version, to: kubelets[kubelets.length - 1]!.version, at: kubelets[kubelets.length - 1]!.first } : null,
  };
}

/**
 * Operations that change the cluster or its nodes. Reads and access are not maintenance — stg's Activity Log is
 * mostly listClusterUserCredential / runCommand / effectiveRouteTable from people and this dashboard.
 */
export const isChangeOp = (op: string): boolean =>
  /\/(write|delete)$/i.test(op) ||
  /\/(upgradenodeimageversion|reimage|reimageall|manualupgrade|restart|start|stop|poweroff|deallocate|redeploy|performmaintenance|rotateclustercertificates|abort|delete|scale|upgrade)\/action$/i.test(op) ||
  /^microsoft\.resourcehealth\//i.test(op);

const iso = (s: number) => new Date(s * 1000).toISOString();
const isoMs = (ms: number) => new Date(ms).toISOString();
const lower = (s: string) => s.toLowerCase();

/** Short operation name: drop the provider and resource-type prefix Azure repeats on every row */
export function shortOp(op: string): string {
  return lower(op).replace(/^microsoft\.containerservice\/managedclusters\//, "").replace(/^microsoft\.compute\/virtualmachinescalesets\//, "vmss/")
    .replace(/^microsoft\.containerservice\//, "").replace(/^microsoft\.compute\//, "");
}
/** The resource an operation acted on, by name: the node pool or the scale set */
function targetOf(resource: string): string {
  const r = lower(resource);
  return /\/agentpools\/([^/]+)/.exec(r)?.[1] ?? /\/virtualmachinescalesets\/([^/]+)/.exec(r)?.[1] ?? /\/managedclusters\/([^/]+)/.exec(r)?.[1] ?? r.split("/").pop() ?? "";
}
const initiatorOf = (callers: string[]): NodeMaintEpisode["initiator"] => {
  if (callers.some((c) => lower(c) === "microsoft.containerservice")) return "aks";
  if (callers.some((c) => c.includes("@"))) return "user";
  if (callers.some((c) => /^[0-9a-f-]{36}$/i.test(c))) return "app";
  return "unknown";
};

export function buildMaintenance(input: {
  clusterId: string;
  nodeResourceGroup: string | null;
  events: ActEvent[] | null;
  tracks: NodeTrack[] | null;
  rangeStart: number;
  rangeEnd: number;
  step: number;
  windows: WindowRule[] | null;
  now: number;
}): { episodes: NodeMaintEpisode[]; unplanned: NodeMaintenanceResponse["unplanned"] } {
  const cid = lower(input.clusterId);
  const nodeRg = input.nodeResourceGroup ? `/resourcegroups/${lower(input.nodeResourceGroup)}/` : null;
  const evs = (input.events ?? [])
    // The cluster's own operations (role / policy assignments on it are no node maintenance) and the node resource
    // group's scale sets and Resource Health
    .filter((e) => {
      const r = lower(e.resource), op = lower(e.op);
      const onCluster = (r.startsWith(`${cid}/`) || r === cid) && op.startsWith("microsoft.containerservice/");
      const onNodes = !!nodeRg && r.includes(nodeRg) && (op.startsWith("microsoft.compute/virtualmachinescalesets/") || /^resourcehealth$/i.test(e.category));
      return (onCluster || onNodes) && /^(administrative|resourcehealth)$/i.test(e.category) && isChangeOp(e.op);
    })
    .map((e) => ({ ...e, ms: Date.parse(e.time), cluster: lower(e.resource).startsWith(cid) }))
    .filter((e) => Number.isFinite(e.ms))
    .sort((a, b) => a.ms - b.ms);
  const facts = (input.tracks ?? []).map((t) => ({ node: t.node, ...nodeFacts(t, input.rangeStart, input.rangeEnd, input.step) }));

  // Change points: Azure operations (not Resource Health alone) and node lifecycle facts — NotReady alone is no maintenance
  const points: { ms: number }[] = [
    ...evs.filter((e) => !/^resourcehealth$/i.test(e.category)),
    ...facts.flatMap((f) => [f.appeared, f.removed, ...f.reRegistered, ...f.cordons.map((c) => c.start)].filter((x): x is number => x !== null).map((s) => ({ ms: s * 1000 }))),
  ].sort((a, b) => a.ms - b.ms);
  const groups: { start: number; end: number }[] = [];
  for (const p of points) {
    const g = groups[groups.length - 1];
    if (g && p.ms - g.end <= GAP_MS) g.end = Math.max(g.end, p.ms);
    else groups.push({ start: p.ms, end: p.ms });
  }

  const attached = new Set<string>();
  const episodes = groups.map((g): NodeMaintEpisode => {
    const lo = g.start - 15 * MIN, hi = g.end + 30 * MIN;
    const inG = (ms: number) => ms >= lo && ms <= hi;
    const mine = evs.filter((e) => e.ms >= g.start - MIN && e.ms <= g.end + MIN);
    const cluster = mine.filter((e) => e.cluster && !/^resourcehealth$/i.test(e.category));
    const nodes: NodeMaintNode[] = [];
    let first = g.start, last = g.end;
    for (const f of facts) {
      const n: NodeMaintNode = { node: f.node, pool: poolOfNode(f.node) };
      if (f.appeared !== null && inG(f.appeared * 1000)) n.surge = { created: iso(f.appeared), removed: f.removed !== null && inG(f.removed * 1000) ? iso(f.removed) : null };
      // Every span inside the episode belongs to it (a reimaged node can go NotReady twice): first start → last end, times
      const merge = (list: Span[]) => {
        const xs = list.filter((c) => inG(c.start * 1000));
        if (!xs.length) return null;
        const end = xs.some((x) => x.end === null) ? null : Math.max(...xs.map((x) => x.end!));
        return { start: xs[0]!.start, end, times: xs.length, all: xs };
      };
      const cord = merge(f.cordons);
      if (cord) n.cordoned = { start: iso(cord.start), end: cord.end === null ? null : iso(cord.end), times: cord.times };
      const nr = merge(f.notReady);
      if (nr) {
        n.notReady = { start: iso(nr.start), end: nr.end === null ? null : iso(nr.end), times: nr.times };
        for (const x of nr.all) attached.add(`${f.node}@${x.start}`);
      }
      const rr = f.reRegistered.find((v) => inG(v * 1000));
      if (rr !== undefined) n.reRegistered = iso(rr);
      if (f.kernel && inG(f.kernel.at * 1000)) n.kernel = { from: f.kernel.from, to: f.kernel.to };
      if (f.kubelet && inG(f.kubelet.at * 1000)) n.kubelet = { from: f.kubelet.from, to: f.kubelet.to };
      if (n.surge || n.cordoned || n.notReady || n.reRegistered || n.kernel || n.kubelet) {
        nodes.push(n);
        for (const s of [cord?.start, nr?.start, f.appeared].filter((x): x is number => typeof x === "number" && inG(x * 1000))) first = Math.min(first, s * 1000);
        for (const e of [cord?.end, nr?.end, n.surge && f.removed].filter((x): x is number => typeof x === "number" && inG(x * 1000))) last = Math.max(last, e * 1000);
      }
    }
    const upgrade = cluster.some((e) => /upgradenodeimageversion/i.test(e.op));
    // Kubernetes upgrade = the nodes' kubelet version changed in the episode (a fact, not the channel setting)
    const kubeletChanged = nodes.some((n) => n.kubelet);
    const kind: NodeMaintEpisode["kind"] = upgrade ? "nodeImageUpgrade" : kubeletChanged ? "kubernetesUpgrade" : cluster.length ? "clusterUpdate" : "nodeChange";
    const statuses = cluster.map((e) => lower(e.status));
    const lastCluster = cluster[cluster.length - 1];
    const status: NodeMaintEpisode["status"] = statuses.includes("failed") ? "failed"
      : statuses.includes("succeeded") && !(lastCluster && /^(started|accepted)$/.test(lower(lastCluster.status)) && input.now - lastCluster.ms < 3 * 60 * MIN) ? "succeeded"
      : statuses.length && input.now - g.end < 3 * 60 * MIN ? "inProgress" : "unknown";
    const ops = new Map<string, NodeMaintEpisode["operations"][number]>();
    for (const e of mine.filter((x) => !/^resourcehealth$/i.test(x.category))) {
      const op = shortOp(e.op), target = targetOf(e.resource), st = e.status;
      const k = `${op}|${st}|${target}`;
      const o = ops.get(k) ?? { time: e.time, op, status: st, target, count: 0 };
      o.count++;
      ops.set(k, o);
    }
    const pools = [...new Set([...cluster.map((e) => /\/agentpools\/([^/]+)/i.exec(e.resource)?.[1]).filter((x): x is string => !!x).map(lower), ...nodes.map((n) => n.pool).filter((x): x is string => !!x)])].sort();
    const startMs = Math.min(first, g.start);
    const inWindow = input.windows ? windowAt(input.windows, startMs)?.name ?? null : undefined;
    return {
      id: `${kind}:${isoMs(startMs)}`,
      kind, start: isoMs(startMs), end: status === "inProgress" ? null : isoMs(Math.max(last, g.end)), status,
      initiator: cluster.length ? initiatorOf(cluster.map((e) => e.caller)) : "unknown",
      ...(inWindow !== undefined ? { inWindow } : {}),
      pools,
      operations: [...ops.values()].sort((a, b) => (a.time < b.time ? -1 : 1)).slice(0, 30),
      failedOps: mine.filter((e) => lower(e.status) === "failed").length,
      resourceHealth: mine.filter((e) => /^resourcehealth$/i.test(e.category) && /activated/i.test(e.op)).length,
      nodes: nodes.sort((a, b) => (a.node < b.node ? -1 : 1)),
      podsRestarted: null,
      basis: [...(mine.length ? ["activityLog" as const] : []), ...(nodes.length ? ["metrics" as const] : [])],
    };
  // Scale-set model writes alone (tags, instance protection) changed no node: not an episode
  }).filter((e) => e.nodes.length || e.kind !== "nodeChange" || e.operations.some((o) => !/^vmss\/(write|virtualmachines\/write)$/.test(o.op)));

  const unplanned = facts.flatMap((f) => f.notReady.filter((s) => !attached.has(`${f.node}@${s.start}`)).map((s) => ({ node: f.node, start: iso(s.start), end: s.end === null ? null : iso(s.end) })))
    .sort((a, b) => (a.start < b.start ? 1 : -1)).slice(0, 50);
  return { episodes: episodes.sort((a, b) => (a.start < b.start ? 1 : -1)).slice(0, 20), unplanned };
}

/** One value's first/last sample, merged across series that differ only in another label */
function mergeSpan<K extends string>(list: ({ [k in K]: string } & { first: number; last: number })[], key: K, value: string, span: { first: number; last: number }) {
  const hit = list.find((x) => x[key] === value);
  if (hit) { hit.first = Math.min(hit.first, span.first); hit.last = Math.max(hit.last, span.last); }
  else list.push({ [key]: value, ...span } as { [k in K]: string } & { first: number; last: number });
}

// ── collection ──

type ArmCluster = {
  properties?: {
    nodeResourceGroup?: string;
    autoUpgradeProfile?: { upgradeChannel?: string; nodeOSUpgradeChannel?: string };
    agentPoolProfiles?: { name?: string; mode?: string; count?: number; nodeImageVersion?: string; upgradeSettings?: { maxSurge?: string; maxUnavailable?: string; drainTimeoutInMinutes?: number; undrainableNodeBehavior?: string } }[];
  };
};
type RawActEvent = { eventTimestamp?: string; operationName?: { value?: string }; status?: { value?: string }; resourceId?: string; caller?: string; category?: { value?: string } };
type RangeResp = { status?: string; error?: string; data?: { result?: { metric?: Record<string, string>; values?: [number, string][] }[] } };

const stateOf = (e: unknown): NodeMaintSourceState => (/ 40[13]:/.test(e instanceof Error ? e.message : "") || (e instanceof HttpError && e.status === 403) ? "forbidden" : "failed");
const RG_NAME = /^[-\w._()]{1,90}$/;

/** Range step: 1 min up to 7 days, coarser beyond (Prometheus answers ≤ 11 000 points a series) */
export const stepFor = (days: number) => Math.max(60, Math.ceil((days * 86_400) / 11_000 / 60) * 60);

const cache = new CacheManager<NodeMaintenanceResponse>(30, 5 * 60_000);
const inflight = new Map<string, Promise<NodeMaintenanceResponse>>();

export async function getNodeMaintenance(env: Env, bearerToken: string | undefined, clusterId: string, days: number): Promise<NodeMaintenanceResponse> {
  const key = `${cachePrefix(bearerToken)}:node-maint:${lower(clusterId)}:${days}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const running = inflight.get(key);
  if (running) return running;
  const job = collect(env, bearerToken, clusterId, days).then((r) => { cache.set(key, r); return r; }).finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

async function collect(env: Env, bearerToken: string | undefined, clusterId: string, days: number): Promise<NodeMaintenanceResponse> {
  const arm = await getArmFetcherAuto(env, bearerToken); // anonymous without the dev switch → signin_required
  const now = Date.now();
  const step = stepFor(days);
  const rangeEnd = Math.floor(now / 1000 / step) * step;
  const rangeStart = rangeEnd - days * 86_400;
  const sources: NodeMaintenanceResponse["sources"] = { config: "ok", activityLog: "ok", metrics: "ok" };
  let activityPartial = false;
  const sub = /^\/subscriptions\/([^/]+)\/resourcegroups\/([^/]+)\//i.exec(clusterId);

  // ARM: cluster + windows
  let cluster: ArmCluster | null = null;
  let windows: WindowRule[] | null = null;
  try {
    cluster = await arm.fetchJson<ArmCluster>(`${ARM}${clusterId}?api-version=${AKS_API}`);
  } catch (e) {
    if (e instanceof HttpError && e.code === "signin_required") throw e;
    sources.config = stateOf(e);
  }
  if (cluster) {
    try {
      windows = parseWindows((await arm.fetchJson<{ value?: RawMaintConfig[] }>(`${ARM}${clusterId}/maintenanceConfigurations?api-version=${AKS_API}`)).value ?? [], now);
    } catch { windows = null; }
  }
  const nodeRg = cluster?.properties?.nodeResourceGroup && RG_NAME.test(cluster.properties.nodeResourceGroup) ? cluster.properties.nodeResourceGroup : null;

  // Activity Log: the cluster's resource group (rows under the cluster) and the node resource group. Reads and
  // credential lists (this dashboard's own among them) make it long — stg: 3,282 rows / 17 pages in 30 days — so the
  // range is read in day chunks side by side; a chunk that hits its page cap marks the read partial.
  let events: ActEvent[] | null = null;
  if (sub) {
    try {
      const collected: ActEvent[] = [];
      const chunkDays = Math.max(1, Math.ceil(days / 6));
      const jobs: { rg: string; from: number; to: number }[] = [];
      for (const rg of [sub[2]!, ...(nodeRg ? [nodeRg] : [])]) {
        for (let f = rangeStart * 1000; f < now; f += chunkDays * 86_400_000) jobs.push({ rg, from: f, to: Math.min(now, f + chunkDays * 86_400_000) });
      }
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(6, jobs.length) }, async () => {
        while (next < jobs.length) {
          const j = jobs[next++]!;
          const filter = `eventTimestamp ge '${new Date(j.from).toISOString()}' and eventTimestamp le '${new Date(j.to).toISOString()}' and resourceGroupName eq '${j.rg.replace(/'/g, "''")}'`;
          let url: string | undefined = `${ARM}/subscriptions/${sub[1]}/providers/Microsoft.Insights/eventtypes/management/values?api-version=2015-04-01&$filter=${encodeURIComponent(filter)}&$select=${encodeURIComponent("eventTimestamp,operationName,status,resourceId,caller,category")}`;
          let page = 0;
          for (; url && page < 20; page++) {
            const r: { value?: RawActEvent[]; nextLink?: string } = await arm.fetchJson(url);
            for (const e of r.value ?? []) {
              collected.push({ time: e.eventTimestamp ?? "", op: e.operationName?.value ?? "", status: e.status?.value ?? "", resource: e.resourceId ?? "", caller: e.caller ?? "", category: e.category?.value ?? "" });
            }
            url = r.nextLink && r.nextLink.startsWith(`${ARM}/`) ? r.nextLink : undefined;
          }
          if (url) activityPartial = true;
        }
      }));
      events = collected;
      if (!events.length) sources.activityLog = "empty";
    } catch (e) {
      if (e instanceof HttpError && e.code === "signin_required") throw e;
      sources.activityLog = stateOf(e);
      events = null;
    }
  } else sources.activityLog = "failed";

  // Prometheus: node tracks over the range
  let tracks: NodeTrack[] | null = null;
  let podsAt: ((s: number, e: number) => Promise<number | null>) | null = null;
  const target = await resolvePrometheusTarget(env, bearerToken, clusterId).catch(() => ({ state: "failed" as const }));
  if (target.state !== "ok") sources.metrics = target.state === "noWorkspace" ? "notConfigured" : target.state === "forbidden" ? "forbidden" : "failed";
  else {
    try {
      const fetcher = await getPrometheusFetcherAuto(env, bearerToken, clusterId);
      const inst = (await fetcher.query(target.endpoint, "group by (cluster) (up)")) as { data?: { result?: { metric?: Record<string, string> }[] } };
      const scope = pickScope((inst.data?.result ?? []).map((r) => ({ cluster: r.metric?.cluster })), clusterId.split("/").pop() ?? "");
      if (scope === null || scope === "ambiguous") sources.metrics = "notConfigured";
      else {
        const C = scopeMatchers(scope, false);
        const range = async (q: string) => {
          const r = (await fetcher.queryRange(target.endpoint, q, String(rangeStart), String(rangeEnd), String(step))) as RangeResp;
          if (r.status && r.status !== "success") throw new Error(`Prometheus query failed: ${r.error ?? r.status}`);
          return (r.data?.result ?? []).map((x) => ({ metric: x.metric ?? {}, values: (x.values ?? []).map(([t, v]) => [Number(t), Number(v)] as [number, number]) }));
        };
        const w = `[${step}s]`;
        const [ready, cordon, created, info] = await Promise.all([
          range(`max by (node) (min_over_time(kube_node_status_condition{${C}, condition="Ready", status="true"}${w}))`),
          range(`max by (node) (max_over_time(kube_node_spec_unschedulable{${C}}${w}))`),
          range(`max by (node) (kube_node_created{${C}})`),
          range(`max by (node, kernel_version, kubelet_version) (kube_node_info{${C}})`),
        ]);
        const byNode = new Map<string, NodeTrack>();
        const track = (node: string) => byNode.get(node) ?? byNode.set(node, { node, ready: [], cordon: [], created: [], kernels: [], kubelets: [] }).get(node)!;
        for (const s of ready) if (s.metric.node) track(s.metric.node).ready.push(...s.values);
        for (const s of cordon) if (s.metric.node) track(s.metric.node).cordon.push(...s.values);
        for (const s of created) if (s.metric.node) track(s.metric.node).created.push(...s.values);
        for (const s of info) if (s.metric.node && s.values.length) {
          const span = { first: s.values[0]![0], last: s.values[s.values.length - 1]![0] };
          const t = track(s.metric.node);
          if (s.metric.kernel_version) mergeSpan(t.kernels, "kernel", s.metric.kernel_version, span);
          if (s.metric.kubelet_version) mergeSpan(t.kubelets, "version", s.metric.kubelet_version, span);
        }
        tracks = [...byNode.values()];
        if (!tracks.length) sources.metrics = "empty";
        podsAt = async (s, e) => {
          const at = Math.min(e + 30 * 60, Math.floor(now / 1000));
          const r = (await fetcher.query(target.endpoint, `count(kube_pod_start_time{${C}} > ${s} < ${e})`, String(at))) as { data?: { result?: { value?: [number, string] }[] } };
          const v = r.data?.result?.[0]?.value?.[1];
          return v === undefined ? 0 : Number(v);
        };
      }
    } catch (e) {
      if (e instanceof HttpError && e.code === "signin_required") throw e;
      sources.metrics = stateOf(e);
    }
  }

  const built = buildMaintenance({ clusterId, nodeResourceGroup: nodeRg, events, tracks, rangeStart, rangeEnd, step, windows, now });
  if (podsAt) {
    await Promise.all(built.episodes.slice(0, 5).map(async (ep) => {
      try { ep.podsRestarted = await podsAt!(Math.floor(Date.parse(ep.start) / 1000), Math.floor(Date.parse(ep.end ?? new Date(now).toISOString()) / 1000)); } catch { /* not measured */ }
    }));
  }
  const p = cluster?.properties;
  return {
    clusterId, generatedAt: new Date(now).toISOString(), days, stepMinutes: step / 60, sources,
    ...(activityPartial ? { activityLogPartial: true } : {}),
    config: p ? {
      upgradeChannel: p.autoUpgradeProfile?.upgradeChannel ?? null,
      nodeOSUpgradeChannel: p.autoUpgradeProfile?.nodeOSUpgradeChannel ?? null,
      pools: (p.agentPoolProfiles ?? []).map((a) => ({
        name: a.name ?? "", mode: a.mode ?? null, count: a.count ?? null, nodeImageVersion: a.nodeImageVersion ?? null,
        maxSurge: a.upgradeSettings?.maxSurge ?? null, maxUnavailable: a.upgradeSettings?.maxUnavailable ?? null,
        drainTimeoutMinutes: a.upgradeSettings?.drainTimeoutInMinutes ?? null, undrainableNodeBehavior: a.upgradeSettings?.undrainableNodeBehavior ?? null,
      })),
      windows: (windows ?? []).map(({ startDate: _s, ...w }) => w),
    } : null,
    episodes: built.episodes,
    unplanned: built.unplanned,
  };
}
