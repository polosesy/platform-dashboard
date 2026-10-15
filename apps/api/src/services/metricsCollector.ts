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
  const groups = new Map<string, Array<[string, MetricBinding]>>();
  for (const entry of monitor) (groups.get(entry[1].filter ?? "") ?? groups.set(entry[1].filter ?? "", []).get(entry[1].filter ?? "")!).push(entry);
  const values: Record<string, number | null> = {};
  for (const [filter, list] of groups) {
    const query = async (part: Array<[string, MetricBinding]>) => {
      const metricNames = [...new Set(part.map(([, b]) => b.metric!))];
      const aggregations = [...new Set(part.map(([, b]) => monitorAggParam(b.aggregation ?? "avg")))];
      const url =
        `https://management.azure.com${azureResourceId}` +
        `/providers/microsoft.insights/metrics` +
        `?api-version=2024-02-01` +
        `&metricnames=${metricNames.map(encodeURIComponent).join(",")}` +
        `&timespan=PT5M` +
        `&interval=PT1M` +
        `&aggregation=${aggregations.join(",")}` +
        (filter ? `&$filter=${encodeURIComponent(filter)}` : "");
      const resp = await fetcher.fetchJson<MonitorMetricsResponse>(url);
      return (resp.value ?? []).map((mv) => [mv.name.value, mv.timeseries?.[0]?.data ?? []] as const);
    };
    Object.assign(values, await queryMetricsTolerant(list, query, (metric) => {
      const set = unsupportedMetrics.get(azureResourceId) ?? new Set<string>();
      set.add(`${metric}|${filter}`);
      unsupportedMetrics.set(azureResourceId, set);
    }));
  }
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
 * Batch collect metrics for multiple resources (parallel with concurrency limit).
 */
export async function collectBatchMetrics(
  env: Env,
  bearerToken: string,
  resources: Array<{ azureResourceId: string; bindings: Record<string, MetricBinding> }>,
): Promise<Map<string, Record<string, number | null>>> {
  const CONCURRENCY = 6;
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

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  return results;
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
): Promise<Record<string, number | null>> {
  const resourceId = node.azureResourceId;
  if (!resourceId || !Object.values(edge.bindings).some((b) => b.source === "monitor")) return {};

  const prefix = bearerKeyPrefix(bearerToken);
  const cacheKey = `${prefix}:edgemetrics:${edge.id}:${resourceId}`;
  const cached = edgeMetricCache.get(cacheKey);
  if (cached) return cached;

  const fetcher = await getArmFetcher(env, bearerToken);
  const result = await queryResourceMetrics(fetcher, resourceId, edge.bindings);
  edgeMetricCache.set(cacheKey, result);
  return result;
}

/**
 * Batch collect edge monitor metrics (parallel with concurrency limit).
 */
export async function collectBatchEdgeMetrics(
  env: Env,
  bearerToken: string,
  items: Array<{ edge: DiagramEdgeSpec; node: DiagramNodeSpec }>,
): Promise<Map<string, Record<string, number | null>>> {
  const CONCURRENCY = 6;
  const results = new Map<string, Record<string, number | null>>();
  const queue = [...items];

  async function worker() {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      try {
        const metrics = await collectEdgeMonitorMetrics(env, bearerToken, item.edge, item.node);
        results.set(item.edge.id, metrics);
      } catch {
        results.set(item.edge.id, {});
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  return results;
}

// ────────────────────────────────────────────
// PowerState Collection
//
// Fetches instance power state for compute resources
// (VM, VMSS, AKS, Container App, Function App, App Service).
// Uses ARM instanceView or properties.powerState/state.
// ────────────────────────────────────────────

const powerStateCache = new CacheManager<PowerState>(200, 120_000);

const POWER_STATE_RESOURCE_KINDS = new Set([
  "vm", "vmss", "aks", "containerApp", "functionApp", "appService",
  "postgres", "sql", "redis", "cosmosDb", "storage", "keyVault",
]);

function parsePowerState(code: string): PowerState {
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
  if (lower === "creating" || lower === "resuming" || lower === "updating") return "starting";
  if (lower === "deleting" || lower === "pausing" || lower === "scaling") return "stopping";
  return "unknown";
}

async function collectResourcePowerState(
  env: Env,
  bearerToken: string | undefined,
  azureResourceId: string,
  resourceKind: string,
): Promise<PowerState> {
  const prefix = bearerToken ? bearerKeyPrefix(bearerToken) : "sp";
  const cacheKey = `${prefix}:powerstate:${azureResourceId}`;
  const cached = powerStateCache.get(cacheKey);
  if (cached) return cached;

  let state: PowerState = "unknown";

  try {
    const fetcher = await getArmFetcherAuto(env, bearerToken);
    if (resourceKind === "vm") {
      const resp = await fetcher.fetchJson<{
        statuses?: Array<{ code: string }>;
      }>(`https://management.azure.com${azureResourceId}/instanceView?api-version=2024-07-01`);
      const psStatus = resp.statuses?.find((s) => s.code.startsWith("PowerState/"));
      if (psStatus) state = parsePowerState(psStatus.code);
    } else if (resourceKind === "vmss") {
      // VMSS scale-set-level instanceView doesn't contain PowerState.
      // Query individual VM instances and aggregate their power states.
      const resp = await fetcher.fetchJson<{
        value?: Array<{
          instanceId: string;
          properties?: { instanceView?: { statuses?: Array<{ code: string }> } };
        }>;
      }>(`https://management.azure.com${azureResourceId}/virtualMachines?api-version=2024-07-01&$expand=instanceView`);

      const instances = resp.value ?? [];
      if (instances.length > 0) {
        const instanceStates: PowerState[] = [];
        for (const inst of instances) {
          const ps = inst.properties?.instanceView?.statuses?.find(
            (s) => s.code.startsWith("PowerState/"),
          );
          instanceStates.push(ps ? parsePowerState(ps.code) : "unknown");
        }
        // Aggregate: all same → that state, mixed → worst state wins
        const allSame = instanceStates.every((s) => s === instanceStates[0]);
        if (allSame) {
          state = instanceStates[0]!;
        } else if (instanceStates.some((s) => s === "deallocated")) {
          state = "stopped";
        } else if (instanceStates.some((s) => s === "stopped")) {
          state = "stopped";
        } else if (instanceStates.some((s) => s === "starting" || s === "stopping")) {
          state = "starting";
        } else {
          state = "running";
        }
      }
    } else if (resourceKind === "aks") {
      const resp = await fetcher.fetchJson<{
        properties?: { powerState?: { code: string } };
      }>(`https://management.azure.com${azureResourceId}?api-version=2024-09-01`);
      const code = resp.properties?.powerState?.code;
      if (code) state = parsePowerState(code);
    } else if (resourceKind === "containerApp") {
      const resp = await fetcher.fetchJson<{
        properties?: { runningStatus?: string };
      }>(`https://management.azure.com${azureResourceId}?api-version=2024-03-01`);
      const rs = resp.properties?.runningStatus;
      if (rs) state = parsePowerState(rs);
    } else if (resourceKind === "functionApp" || resourceKind === "appService") {
      const resp = await fetcher.fetchJson<{
        properties?: { state?: string };
      }>(`https://management.azure.com${azureResourceId}?api-version=2023-12-01`);
      const s = resp.properties?.state;
      if (s) state = parsePowerState(s);
    } else if (resourceKind === "postgres") {
      const resp = await fetcher.fetchJson<{
        properties?: { state?: string };
      }>(`https://management.azure.com${azureResourceId}?api-version=2022-12-01`);
      const s = resp.properties?.state;
      if (s) state = parsePowerState(s);
    } else if (resourceKind === "sql") {
      const resp = await fetcher.fetchJson<{
        properties?: { status?: string };
      }>(`https://management.azure.com${azureResourceId}?api-version=2021-11-01`);
      const s = resp.properties?.status;
      if (s) state = parsePowerState(s);
    } else if (resourceKind === "redis") {
      const resp = await fetcher.fetchJson<{
        properties?: { provisioningState?: string };
      }>(`https://management.azure.com${azureResourceId}?api-version=2023-08-01`);
      const s = resp.properties?.provisioningState;
      if (s) state = parsePowerState(s);
    } else if (resourceKind === "cosmosDb") {
      const resp = await fetcher.fetchJson<{
        properties?: { provisioningState?: string };
      }>(`https://management.azure.com${azureResourceId}?api-version=2024-02-15-preview`);
      const s = resp.properties?.provisioningState;
      if (s) state = parsePowerState(s);
    } else if (resourceKind === "storage") {
      const resp = await fetcher.fetchJson<{
        properties?: { statusOfPrimary?: string };
      }>(`https://management.azure.com${azureResourceId}?api-version=2023-05-01`);
      const s = resp.properties?.statusOfPrimary;
      if (s) state = parsePowerState(s);
    } else if (resourceKind === "keyVault") {
      const resp = await fetcher.fetchJson<{
        properties?: { provisioningState?: string };
      }>(`https://management.azure.com${azureResourceId}?api-version=2023-07-01`);
      const s = resp.properties?.provisioningState;
      if (s) state = parsePowerState(s);
    }
  } catch {
    // Non-critical — return "unknown"
  }

  powerStateCache.set(cacheKey, state);
  return state;
}

/**
 * Batch collect power states for compute resources (parallel with concurrency limit).
 */
export async function collectBatchPowerStates(
  env: Env,
  bearerToken: string | undefined,
  nodes: Array<{ azureResourceId: string; resourceKind: string }>,
): Promise<Map<string, PowerState>> {
  const CONCURRENCY = 6;
  const targets = nodes.filter(
    (n) => n.azureResourceId && POWER_STATE_RESOURCE_KINDS.has(n.resourceKind),
  );

  const results = new Map<string, PowerState>();
  const queue = [...targets];

  async function worker() {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      try {
        const state = await collectResourcePowerState(env, bearerToken, item.azureResourceId, item.resourceKind);
        results.set(item.azureResourceId, state);
      } catch {
        results.set(item.azureResourceId, "unknown");
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  return results;
}
