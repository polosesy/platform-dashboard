import type { Env } from "../env.js";
import type { MetricBinding, MetricAggregation, DiagramEdgeSpec, DiagramNodeSpec, PowerState } from "@aud/types";
import { CacheManager, bearerKeyPrefix } from "../infra/cacheManager.js";
import { getArmFetcher, getArmFetcherAuto } from "../infra/azureClientFactory.js";

// ────────────────────────────────────────────
// Azure Monitor Metrics REST client
// Batch-fetches metrics per resource, CacheManager-backed
// ────────────────────────────────────────────

const metricCache = new CacheManager<Record<string, number | null>>(200, 60_000);
/** Metric names Azure Monitor rejected per resource (optional bindings only) — not asked for again */
const unsupportedMetrics = new Map<string, Set<string>>();
const edgeMetricCache = new CacheManager<Record<string, number | null>>(200, 60_000);

type MonitorTimeseriesValue = {
  timeStamp: string;
  average?: number;
  maximum?: number;
  minimum?: number;
  total?: number;
  count?: number;
};

type MonitorMetricValue = {
  name: { value: string };
  timeseries?: Array<{
    data?: MonitorTimeseriesValue[];
  }>;
};

type MonitorMetricsResponse = {
  value?: MonitorMetricValue[];
};

/** Value of one bucket for the requested aggregation */
function bucketValue(b: MonitorTimeseriesValue, agg: MetricAggregation): number | null {
  switch (agg) {
    case "avg": return b.average ?? null;
    case "max": return b.maximum ?? null;
    case "min": return b.minimum ?? null;
    case "total": return b.total ?? null;
    case "count": return b.count ?? null;
    case "rate": return b.count != null && b.count > 0 ? b.count / 60 : null;
    default: return b.average ?? null;
  }
}

/**
 * Latest bucket that has a value. The newest 1-minute bucket is often still empty when Azure Monitor is
 * queried, and reading only that bucket turned measured resources into "미측정".
 */
function pickAggregation(values: MonitorTimeseriesValue[], agg: MetricAggregation): number | null {
  for (let i = values.length - 1; i >= 0; i--) {
    const v = bucketValue(values[i]!, agg);
    if (v != null) return v;
  }
  return null;
}

function monitorAggParam(agg: MetricAggregation): string {
  switch (agg) {
    case "avg": return "Average";
    case "max": return "Maximum";
    case "min": return "Minimum";
    case "total": return "Total";
    case "count": return "Count";
    case "rate": return "Count";
    default: return "Average";
  }
}

type MetricSeries = ReadonlyArray<readonly [string, MonitorTimeseriesValue[]]>;

/**
 * A dimension filter ("Listener eq 'a' or Listener eq 'b'", "BackendServer eq 'ip:80' or …") returns one series
 * per value: buckets at the same time are added (total / count) or averaged over the series that have a value
 * (average / min / max). One series is returned as is. Exported for tests.
 */
export function mergeSeries(series: ReadonlyArray<{ data?: MonitorTimeseriesValue[] }>): MonitorTimeseriesValue[] {
  if (series.length <= 1) return series[0]?.data ?? [];
  const byTime = new Map<string, { total?: number; count?: number; avg: number[]; min: number[]; max: number[] }>();
  for (const s of series) {
    for (const b of s.data ?? []) {
      const k = b.timeStamp;
      const m = byTime.get(k) ?? { avg: [], min: [], max: [] };
      if (b.total != null) m.total = (m.total ?? 0) + b.total;
      if (b.count != null) m.count = (m.count ?? 0) + b.count;
      if (b.average != null) m.avg.push(b.average);
      if (b.minimum != null) m.min.push(b.minimum);
      if (b.maximum != null) m.max.push(b.maximum);
      byTime.set(k, m);
    }
  }
  return [...byTime.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([timeStamp, m]) => ({
    timeStamp,
    ...(m.total != null ? { total: m.total } : {}),
    ...(m.count != null ? { count: m.count } : {}),
    ...(m.avg.length ? { average: m.avg.reduce((x, y) => x + y, 0) / m.avg.length } : {}),
    ...(m.min.length ? { minimum: Math.min(...m.min) } : {}),
    ...(m.max.length ? { maximum: Math.max(...m.max) } : {}),
  }));
}

/**
 * Runs one metrics query for all bindings and reads each value. An unknown metric name fails the whole Azure
 * Monitor request, so when that happens the required metrics are asked again on their own and every optional
 * one separately: a resource without "Available Memory Percentage" still shows its CPU. Only a 400 (rejected
 * name) is reported to `onRejected`; throttling or timeouts are tried again on the next refresh.
 * Response names are matched without case (Azure echoes its own spelling). Exported for tests.
 */
export async function queryMetricsTolerant(
  list: Array<[string, MetricBinding]>,
  query: (list: Array<[string, MetricBinding]>) => Promise<MetricSeries>,
  onRejected: (metric: string) => void,
): Promise<Record<string, number | null>> {
  const byName = new Map<string, MonitorTimeseriesValue[]>();
  const keep = (series: MetricSeries) => { for (const [name, data] of series) byName.set(name.toLowerCase(), data); };
  try {
    keep(await query(list));
  } catch (err) {
    const optional = list.filter(([, b]) => b.optional);
    if (optional.length === 0) throw err;
    const required = list.filter(([, b]) => !b.optional);
    if (required.length > 0) keep(await query(required));
    await Promise.all(optional.map(async (entry) => {
      try {
        keep(await query([entry]));
      } catch (e) {
        if (/ 400:/.test(String(e))) onRejected(entry[1].metric!);
      }
    }));
  }
  const result: Record<string, number | null> = {};
  for (const [key, binding] of list) {
    let v = pickAggregation(byName.get(binding.metric!.toLowerCase()) ?? [], binding.aggregation ?? "avg");
    // "complement": memory used % from "Available Memory Percentage"; then the unit scale (bytes/min → bit/s, s → ms)
    if (v != null && binding.transform === "complement") v = Math.max(0, Math.min(100, 100 - v));
    if (v != null && binding.scale != null) v *= binding.scale;
    result[key] = v;
  }
  return result;
}

/**
 * Bindings computed from two others of the same node (`source: "derived"`): share = a/(a+b)×100,
 * ratio = a/b×100, sum = a+b. Missing operand or a denominator under `minDenominator` (default 1) → null —
 * no 0 % error rate out of zero requests. Exported for tests.
 */
export function applyDerived(bindings: Record<string, MetricBinding>, values: Record<string, number | null>): Record<string, number | null> {
  const out = { ...values };
  for (const [key, b] of Object.entries(bindings)) {
    if (b.source !== "derived" || !b.derive) continue;
    const [ka, kb] = b.derive.of;
    const a = out[ka], c = out[kb];
    const min = b.derive.minDenominator ?? 1;
    if (a == null || c == null) { out[key] = null; continue; }
    if (b.derive.op === "sum") out[key] = a + c;
    else if (b.derive.op === "share") out[key] = a + c >= min ? (a / (a + c)) * 100 : null;
    else out[key] = c >= min ? (a / c) * 100 : null;
  }
  return out;
}

/** Metrics a resource rejected (optional bindings only), as `metric|filter` per resource — not asked for again */
const rejectedKey = (b: MetricBinding) => `${b.metric}|${b.filter ?? ""}`;

/**
 * All monitor bindings of one resource: one request per dimension filter (Azure Monitor takes one `$filter` per
 * call), each tolerant of unknown optional names, then the derived values. Used for nodes and for edges.
 */
export async function queryResourceMetrics(
  fetcher: { fetchJson<T>(url: string): Promise<T> },
  azureResourceId: string,
  bindings: Record<string, MetricBinding>,
): Promise<Record<string, number | null>> {
  const skip = unsupportedMetrics.get(azureResourceId);
  const monitor = Object.entries(bindings).filter(([, b]) => b.source === "monitor" && b.metric && !(b.optional && skip?.has(rejectedKey(b))));
  // One request per (dimension filter, window). A window binding reads one bucket over the whole window (PE bytes
  // over an hour, NAT data path averaged over 15 minutes) — an empty series stays null, a reported 0 stays 0
  const groups = new Map<string, Array<[string, MetricBinding]>>();
  const groupKey = (b: MetricBinding) => `${b.filter ?? ""}|${b.window ?? ""}`;
  for (const entry of monitor) (groups.get(groupKey(entry[1])) ?? groups.set(groupKey(entry[1]), []).get(groupKey(entry[1]))!).push(entry);
  const values: Record<string, number | null> = {};
  // The groups of one resource are separate requests: send them together
  await Promise.all([...groups.values()].map(async (list) => {
    const filter = list[0]![1].filter ?? "";
    const window = list[0]![1].window;
    const query = async (part: Array<[string, MetricBinding]>) => {
      const metricNames = [...new Set(part.map(([, b]) => b.metric!))];
      const aggregations = [...new Set(part.map(([, b]) => monitorAggParam(b.aggregation ?? "avg")))];
      const url =
        `https://management.azure.com${azureResourceId}` +
        `/providers/microsoft.insights/metrics` +
        `?api-version=2024-02-01` +
        `&metricnames=${metricNames.map(encodeURIComponent).join(",")}` +
        `&timespan=${window ?? "PT5M"}` +
        `&interval=${window ?? "PT1M"}` +
        `&aggregation=${aggregations.join(",")}` +
        (filter ? `&$filter=${encodeURIComponent(filter)}` : "");
      const resp = await fetcher.fetchJson<MonitorMetricsResponse>(url);
      return (resp.value ?? []).map((mv) => [mv.name.value, mergeSeries(mv.timeseries ?? [])] as const);
    };
    Object.assign(values, await queryMetricsTolerant(list, query, (metric) => {
      const set = unsupportedMetrics.get(azureResourceId) ?? new Set<string>();
      set.add(`${metric}|${filter}`);
      unsupportedMetrics.set(azureResourceId, set);
    }));
  }));
  return applyDerived(bindings, values);
}

/**
 * Fetches Azure Monitor metrics for a single resource.
 * Returns a map of binding key → value.
 */
export async function collectResourceMetrics(
  env: Env,
  bearerToken: string,
  azureResourceId: string,
  bindings: Record<string, MetricBinding>,
): Promise<Record<string, number | null>> {
  const prefix = bearerKeyPrefix(bearerToken);
  const cacheKey = `${prefix}:metrics:${azureResourceId}`;
  const cached = metricCache.get(cacheKey);
  if (cached) return cached;
  if (!Object.values(bindings).some((b) => b.source === "monitor")) return {};

  const fetcher = await getArmFetcher(env, bearerToken);
  const result = await queryResourceMetrics(fetcher, azureResourceId, bindings);
  metricCache.set(cacheKey, result);
  return result;
}

/**
 * All workers done, or the deadline — whichever comes first. At the deadline the caller gets a copy of what has
 * arrived (the rest stays "not measured" this round); unfinished requests keep running and fill the caches for
 * the next poll, so a large VNet fills in instead of timing out. Exported for tests.
 */
export async function untilDeadline<T>(all: Promise<unknown>, results: Map<string, T>, deadlineMs?: number): Promise<Map<string, T>> {
  if (!deadlineMs) { await all; return results; }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((r) => { timer = setTimeout(() => r("late"), deadlineMs); });
  const done = await Promise.race([all.then(() => "done" as const), late]);
  if (timer) clearTimeout(timer);
  if (done === "late") { all.catch(() => undefined); return new Map(results); }
  return results;
}

/**
 * Batch collect metrics for multiple resources (parallel with concurrency limit).
 */
export async function collectBatchMetrics(
  env: Env,
  bearerToken: string,
  resources: Array<{ azureResourceId: string; bindings: Record<string, MetricBinding> }>,
  /** Resolve with what has arrived by then; requests still running finish into the per-resource cache */
  deadlineMs?: number,
): Promise<Map<string, Record<string, number | null>>> {
  const CONCURRENCY = 10;
  const results = new Map<string, Record<string, number | null>>();
  const queue = [...resources];

  async function worker() {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      try {
        const metrics = await collectResourceMetrics(env, bearerToken, item.azureResourceId, item.bindings);
        results.set(item.azureResourceId, metrics);
      } catch {
        results.set(item.azureResourceId, {});
      }
    }
  }

  return untilDeadline(Promise.all(Array.from({ length: CONCURRENCY }, () => worker())), results, deadlineMs);
}

// ────────────────────────────────────────────
// Edge Metric Collection
//
// Resolves edge bindings (source: "monitor") by
// fetching metrics from the edge's source node's
// Azure resource. Maps binding keys to edge metrics
// (throughputBps, latencyMs, errorRate).
// ────────────────────────────────────────────

/**
 * Monitor bindings of an edge, read from one end's Azure resource (`node: "target"` on a binding → the target,
 * e.g. the Internet → public LB line reads the LB). Same query path as nodes (filters, scale, derived values).
 */
export async function collectEdgeMonitorMetrics(
  env: Env,
  bearerToken: string,
  edge: DiagramEdgeSpec,
  node: DiagramNodeSpec,
  /** Resources to read instead of the node (a VM's public IPs, `on: "publicIp"`) — values are summed */
  resourceIds?: string[],
): Promise<Record<string, number | null>> {
  const ids = resourceIds ?? (node.azureResourceId ? [node.azureResourceId] : []);
  if (!ids.length || !Object.values(edge.bindings).some((b) => b.source === "monitor")) return {};

  const prefix = bearerKeyPrefix(bearerToken);
  const cacheKey = `${prefix}:edgemetrics:${edge.id}:${ids.join(",")}`;
  const cached = edgeMetricCache.get(cacheKey);
  if (cached) return cached;

  const fetcher = await getArmFetcher(env, bearerToken);
  const parts = await Promise.all(ids.map((id) => queryResourceMetrics(fetcher, id, edge.bindings)));
  const result = sumMetricRecords(parts);
  edgeMetricCache.set(cacheKey, result);
  return result;
}

/** Key-wise sum of several resources' values; null only when no resource reported the key */
export function sumMetricRecords(parts: Array<Record<string, number | null>>): Record<string, number | null> {
  if (parts.length === 1) return parts[0]!;
  const out: Record<string, number | null> = {};
  for (const p of parts) {
    for (const [k, v] of Object.entries(p)) {
      if (v == null) { if (!(k in out)) out[k] = null; continue; }
      out[k] = (out[k] ?? 0) + v;
    }
  }
  return out;
}

/**
 * Batch collect edge monitor metrics (parallel with concurrency limit).
 */
export async function collectBatchEdgeMetrics(
  env: Env,
  bearerToken: string,
  items: Array<{ edge: DiagramEdgeSpec; node: DiagramNodeSpec; resourceIds?: string[] }>,
  deadlineMs?: number,
): Promise<Map<string, Record<string, number | null>>> {
  const CONCURRENCY = 10;
  const results = new Map<string, Record<string, number | null>>();
  const queue = [...items];

  async function worker() {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      try {
        const metrics = await collectEdgeMonitorMetrics(env, bearerToken, item.edge, item.node, item.resourceIds);
        results.set(item.edge.id, metrics);
      } catch {
        results.set(item.edge.id, {});
      }
    }
  }

  return untilDeadline(Promise.all(Array.from({ length: CONCURRENCY }, () => worker())), results, deadlineMs);
}

// ────────────────────────────────────────────
// Live read: power state + the resource's own state, read on every poll (cached briefly)
//
// One ARM GET per resource (the same call that gives the power state) also carries provisioningState, the
// service's own state (PostgreSQL / MySQL Flexible `state`, SQL `status`, …) and the SKU — the spec stored at
// generation time is not refreshed, so these are what the card and the panel must show "as of now". A scale set's
// instance list (`/virtualMachines`) is the actual instance count; its own GET gives the target (`sku.capacity`)
// and whether a scale operation is running (`provisioningState`).
// ────────────────────────────────────────────

/** Instances of a scale set as ARM lists them right now (Deleting ones are on their way out — not counted) */
export type VmssInstanceSummary = { actual: number; byProvisioning: Record<string, number>; byPower: Record<string, number> };

export type LiveRead = {
  power: PowerState;
  /** properties.provisioningState as ARM returns it (Succeeded, Updating, Creating, Deleting, Failed, …) */
  provisioningState?: string;
  /** The service's own state (PostgreSQL / MySQL Flexible `state`, SQL `status`, App Service `state`, AKS power) */
  state?: string;
  sku?: { name?: string; tier?: string; capacity?: number };
  instances?: VmssInstanceSummary;
  /** The resource body as read (sku + properties) — the panel's spec facts are rebuilt from it (resourceSpec) */
  row?: { sku?: Record<string, unknown>; kind?: string; properties?: Record<string, unknown> };
  /** ISO time of the read */
  asOf: string;
};

/** A read that shows something in progress is kept 20 s instead of 120 s, so the end of a scale shows soon */
const SETTLED_TTL_MS = 120_000;
const MOVING_TTL_MS = 20_000;
const liveReadCache = new CacheManager<LiveRead>(400, SETTLED_TTL_MS);

const POWER_STATE_RESOURCE_KINDS = new Set([
  "vm", "vmss", "aks", "containerApp", "functionApp", "appService",
  "postgres", "sql", "redis", "cosmosDb", "storage", "keyVault",
]);

/**
 * Power from a state word. Updating / scaling / upgrading are operations, not power: they map to "unknown" so the
 * card keeps its health colour and the lifecycle chip says what is going on (a scaling Redis is not "stopping").
 */
export function parsePowerState(code: string): PowerState {
  const lower = code.toLowerCase();
  // Compute states
  if (lower.includes("running")) return "running";
  if (lower.includes("deallocat")) return "deallocated";
  if (lower.includes("stopped")) return "stopped";
  if (lower.includes("starting")) return "starting";
  if (lower.includes("stopping")) return "stopping";
  // PaaS operational states
  if (lower === "ready" || lower === "online" || lower === "succeeded" || lower === "available") return "running";
  if (lower === "disabled" || lower === "offline" || lower === "paused" || lower === "dropped") return "stopped";
  if (lower === "creating" || lower === "resuming") return "starting";
  if (lower === "deleting" || lower === "pausing" || lower === "dropping") return "stopping";
  return "unknown";
}

type VmssVmRow = { instanceId?: string; properties?: { provisioningState?: string; instanceView?: { statuses?: Array<{ code: string }> } } };

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Count a scale set's instances by provisioning state and power (pure; tested in lifecycle.test.ts) */
export function summarizeVmssInstances(rows: readonly VmssVmRow[]): VmssInstanceSummary {
  const byProvisioning: Record<string, number> = {};
  const byPower: Record<string, number> = {};
  let actual = 0;
  for (const r of rows) {
    const prov = cap(r.properties?.provisioningState ?? r.properties?.instanceView?.statuses?.find((s) => s.code.startsWith("ProvisioningState/"))?.code.split("/")[1] ?? "Unknown");
    byProvisioning[prov] = (byProvisioning[prov] ?? 0) + 1;
    const ps = r.properties?.instanceView?.statuses?.find((s) => s.code.startsWith("PowerState/"));
    const power = ps ? parsePowerState(ps.code) : "unknown";
    byPower[power] = (byPower[power] ?? 0) + 1;
    if (prov.toLowerCase() !== "deleting") actual++;
  }
  return { actual, byProvisioning, byPower };
}

/** Power of a scale set from its instances: all the same → that, mixed → the least running one */
function vmssPower(sum: VmssInstanceSummary): PowerState {
  const states = Object.keys(sum.byPower) as PowerState[];
  if (!states.length) return "unknown";
  if (states.length === 1) return states[0]!;
  if (states.includes("deallocated") || states.includes("stopped")) return "stopped";
  if (states.includes("starting") || states.includes("stopping")) return "starting";
  return "running";
}

const inProgress = (r: LiveRead) =>
  (!!r.provisioningState && r.provisioningState.toLowerCase() !== "succeeded") ||
  (!!r.state && /updating|scaling|upgrading|starting|stopping|creating|deleting|dropping/i.test(r.state)) ||
  (r.instances != null && r.sku?.capacity != null && r.instances.actual !== r.sku.capacity);

type ArmBody = { sku?: { name?: string; tier?: string; capacity?: number }; kind?: string; properties?: Record<string, unknown> };
const strOf = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const skuOf = (b: ArmBody | undefined) =>
  b?.sku ? { ...(b.sku.name ? { name: b.sku.name } : {}), ...(b.sku.tier ? { tier: b.sku.tier } : {}), ...(typeof b.sku.capacity === "number" ? { capacity: b.sku.capacity } : {}) } : undefined;

/** api-version and the property that carries the service's own state, per kind (one GET each) */
const KIND_GET: Record<string, { api: string; state?: (p: Record<string, unknown>) => string | undefined }> = {
  aks: { api: "2024-09-01", state: (p) => strOf((p.powerState as { code?: string } | undefined)?.code) },
  containerApp: { api: "2024-03-01", state: (p) => strOf(p.runningStatus) },
  functionApp: { api: "2023-12-01", state: (p) => strOf(p.state) },
  appService: { api: "2023-12-01", state: (p) => strOf(p.state) },
  postgres: { api: "2022-12-01", state: (p) => strOf(p.state) },
  sql: { api: "2021-11-01", state: (p) => strOf(p.status) },
  redis: { api: "2023-08-01" },
  cosmosDb: { api: "2024-02-15-preview" },
  storage: { api: "2023-05-01", state: (p) => strOf(p.statusOfPrimary) },
  keyVault: { api: "2023-07-01" },
};

async function collectResourceLiveRead(
  env: Env,
  bearerToken: string | undefined,
  azureResourceId: string,
  resourceKind: string,
): Promise<LiveRead> {
  const prefix = bearerToken ? bearerKeyPrefix(bearerToken) : "sp";
  const cacheKey = `${prefix}:liveread:${azureResourceId}`;
  const cached = liveReadCache.get(cacheKey);
  if (cached) return cached;

  const read: LiveRead = { power: "unknown", asOf: new Date().toISOString() };
  try {
    const fetcher = await getArmFetcherAuto(env, bearerToken);
    if (resourceKind === "vm") {
      const resp = await fetcher.fetchJson<{ statuses?: Array<{ code: string }> }>(`https://management.azure.com${azureResourceId}/instanceView?api-version=2024-07-01`);
      const ps = resp.statuses?.find((s) => s.code.startsWith("PowerState/"));
      if (ps) read.power = parsePowerState(ps.code);
      const prov = resp.statuses?.find((s) => s.code.startsWith("ProvisioningState/"))?.code.split("/")[1];
      if (prov) read.provisioningState = cap(prov);
    } else if (resourceKind === "vmss") {
      // The scale set (target capacity, scale operation running) and its instances (the actual count, power)
      const [self, list] = await Promise.all([
        fetcher.fetchJson<ArmBody>(`https://management.azure.com${azureResourceId}?api-version=2024-07-01`).catch(() => undefined),
        fetcher.fetchJson<{ value?: VmssVmRow[] }>(`https://management.azure.com${azureResourceId}/virtualMachines?api-version=2024-07-01&$expand=instanceView`),
      ]);
      const sku = skuOf(self);
      if (sku) read.sku = sku;
      if (self) read.row = { ...(self.sku ? { sku: self.sku as Record<string, unknown> } : {}), ...(self.properties ? { properties: self.properties } : {}) };
      const prov = strOf(self?.properties?.provisioningState);
      if (prov) read.provisioningState = prov;
      // Flexible orchestration lists no instances here — then only the target is known (never shown as actual)
      const rows = list.value ?? [];
      if (rows.length || strOf(self?.properties?.orchestrationMode) !== "Flexible") {
        read.instances = summarizeVmssInstances(rows);
        read.power = vmssPower(read.instances);
      }
    } else if (KIND_GET[resourceKind]) {
      const def = KIND_GET[resourceKind]!;
      const resp = await fetcher.fetchJson<ArmBody>(`https://management.azure.com${azureResourceId}?api-version=${def.api}`);
      const p = resp.properties ?? {};
      const prov = strOf(p.provisioningState);
      if (prov) read.provisioningState = prov;
      const st = def.state?.(p);
      if (st) read.state = st;
      const sku = skuOf(resp);
      if (sku) read.sku = sku;
      read.row = { ...(resp.sku ? { sku: resp.sku as Record<string, unknown> } : {}), ...(resp.kind ? { kind: resp.kind } : {}), properties: p };
      // Power: the service's state when it has one, else the provisioning state (Redis, Cosmos DB, Key Vault)
      const word = st ?? prov;
      if (word) read.power = parsePowerState(word);
    }
  } catch {
    // Non-critical — power "unknown", nothing else read
  }

  liveReadCache.set(cacheKey, read, inProgress(read) ? MOVING_TTL_MS : SETTLED_TTL_MS);
  return read;
}

/** Live reads for the diagram's resources (parallel, concurrency 10, within the snapshot budget) */
export async function collectBatchLiveReads(
  env: Env,
  bearerToken: string | undefined,
  nodes: Array<{ azureResourceId: string; resourceKind: string }>,
  deadlineMs?: number,
): Promise<Map<string, LiveRead>> {
  const CONCURRENCY = 10;
  const targets = nodes.filter((n) => n.azureResourceId && POWER_STATE_RESOURCE_KINDS.has(n.resourceKind));
  const results = new Map<string, LiveRead>();
  const queue = [...targets];
  async function worker() {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      try {
        results.set(item.azureResourceId, await collectResourceLiveRead(env, bearerToken, item.azureResourceId, item.resourceKind));
      } catch {
        results.set(item.azureResourceId, { power: "unknown", asOf: new Date().toISOString() });
      }
    }
  }
  return untilDeadline(Promise.all(Array.from({ length: CONCURRENCY }, () => worker())), results, deadlineMs);
}

/** Power states only (callers that need nothing else) */
export async function collectBatchPowerStates(
  env: Env,
  bearerToken: string | undefined,
  nodes: Array<{ azureResourceId: string; resourceKind: string }>,
  deadlineMs?: number,
): Promise<Map<string, PowerState>> {
  const reads = await collectBatchLiveReads(env, bearerToken, nodes, deadlineMs);
  return new Map([...reads].map(([id, r]) => [id, r.power] as const));
}
