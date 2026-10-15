// Metric labels, units and trend scale for live diagram cards and the detail panel — pure
// (tested in apps/api/test/liveCard.test.ts).
//
// Units follow how the API collects (apps/api/src/services/metricsCollector.ts): 1-minute buckets, the
// latest bucket with a value; "total" metrics are therefore per minute, network bytes are bytes per minute,
// "p95" latency is requested as Average.

import type { HealthRule, MetricBinding } from "@aud/types";

export type MetricUnit = "%" | "perMin" | "bytesPerMin" | "ms" | "count" | "bps";

/** Bound metric keys (NODE_BINDINGS in apps/api/src/services/specGenerator.ts) → label key and unit */
export const METRIC_META: Record<string, { label: string; unit: MetricUnit }> = {
  cpu: { label: "ld.metric.cpu", unit: "%" },
  memory: { label: "ld.metric.memory", unit: "%" },
  dtu: { label: "ld.metric.dtu", unit: "%" },
  ru: { label: "ld.metric.ru", unit: "%" },
  storage: { label: "ld.metric.storage", unit: "%" },
  dataPath: { label: "ld.metric.dataPath", unit: "%" },
  availability: { label: "ld.metric.availability", unit: "%" },
  network: { label: "ld.metric.network", unit: "bytesPerMin" },
  rps: { label: "ld.metric.rps", unit: "perMin" },
  requests: { label: "ld.metric.requests", unit: "perMin" },
  transactions: { label: "ld.metric.transactions", unit: "perMin" },
  connections: { label: "ld.metric.connections", unit: "perMin" },
  executions: { label: "ld.metric.executions", unit: "perMin" },
  errors: { label: "ld.metric.errors", unit: "perMin" },
  latency: { label: "ld.metric.latency", unit: "ms" },
  backend: { label: "ld.metric.backend", unit: "%" },
  errorRate: { label: "ld.metric.errorRate", unit: "%" },
  load: { label: "ld.metric.load", unit: "%" },
  snat: { label: "ld.metric.snat", unit: "%" },
  fwHealth: { label: "ld.metric.fwHealth", unit: "%" },
  vmAvail: { label: "ld.metric.vmAvail", unit: "%" },
  saturation: { label: "ld.metric.saturation", unit: "%" },
  snatFail: { label: "ld.metric.snatFail", unit: "perMin" },
  bytesIn: { label: "ld.metric.bytesIn", unit: "bytesPerMin" },
  bytesOut: { label: "ld.metric.bytesOut", unit: "bytesPerMin" },
  backlog: { label: "ld.metric.backlog", unit: "count" },
  serverErrors: { label: "ld.metric.serverErrors", unit: "perMin" },
  throttled: { label: "ld.metric.throttled", unit: "perMin" },
  inMsgs: { label: "ld.metric.inMsgs", unit: "perMin" },
  queries: { label: "ld.metric.queries", unit: "perMin" },
  replicas: { label: "ld.metric.replicas", unit: "count" },
  ddos: { label: "ld.metric.ddos", unit: "count" },
  throughput: { label: "ld.metric.throughput", unit: "bps" },
  healthyHosts: { label: "ld.metric.healthyHosts", unit: "count" },
  unhealthyHosts: { label: "ld.metric.unhealthyHosts", unit: "count" },
  failedReq: { label: "ld.metric.failedReq", unit: "perMin" },
  http5xx: { label: "ld.metric.http5xx", unit: "perMin" },
  req5xx: { label: "ld.metric.req5xx", unit: "perMin" },
  reqFailed: { label: "ld.metric.reqFailed", unit: "perMin" },
  dbAlive: { label: "ld.metric.dbAlive", unit: "count" },
  healthyTargets: { label: "ld.metric.healthyTargets", unit: "count" },
  beTimeouts: { label: "ld.metric.beTimeouts", unit: "perMin" },
  timeoutRate: { label: "ld.metric.timeoutRate", unit: "%" },
};

/**
 * The two card metrics per kind (cell 0 carries the trend): load / activity first, quality second — CPU +
 * memory for compute, data path + backends for a load balancer, requests + availability for PaaS. Every key is
 * bound by the API (NODE_BINDINGS in apps/api/src/services/specGenerator.ts). An empty list = nothing to measure:
 * the card shows no metric row (never "미측정").
 */
export const CARD_CELLS: Record<string, readonly string[]> = {
  vm: ["cpu", "memory"], vmss: ["cpu", "memory"], aks: ["cpu", "memory"],
  lb: ["dataPath", "backend"], appGateway: ["requests", "backend"], frontDoor: ["requests", "backend"],
  trafficManager: ["queries"], firewall: ["fwHealth", "snat"], natGateway: ["dataPath", "snatFail"],
  publicIP: ["bytesIn", "ddos"], privateEndpoint: ["bytesIn", "bytesOut"],
  storage: ["transactions", "availability"], keyVault: ["requests", "availability"],
  redis: ["load", "memory"], postgres: ["cpu", "memory"], sql: ["cpu", "memory"],
  cosmosDb: ["requests", "ru"], appService: ["requests", "errorRate"], functionApp: ["requests", "errorRate"],
  containerApp: ["requests", "replicas"], serviceBus: ["backlog", "serverErrors"], eventHub: ["inMsgs", "serverErrors"],
  appInsights: ["requests", "errorRate"],
  agc: ["requests", "healthyTargets"], dns: ["queries"],
  // Front Door Standard/Premium binding set (the card kind is frontDoor)
  frontDoorAfd: ["requests", "backend"],
  nsg: [], nic: [], logAnalytics: [], vnetGateway: [], bastion: [], paas: [],
};

export const isPercent = (key: string) => METRIC_META[key]?.unit === "%";

/** 9.36 → "9.4", 412.7 → "413", 12345 → "12.3K" (at most 4–5 characters) */
export function formatNumber(v: number): string {
  const a = Math.abs(v);
  if (a < 10) return (Math.round(v * 10) / 10).toString();
  if (a < 1000) return Math.round(v).toString();
  if (a < 1e6) return `${(v / 1e3).toFixed(1).replace(/\.0$/, "")}K`;
  if (a < 1e9) return `${(v / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
  return `${(v / 1e9).toFixed(1).replace(/\.0$/, "")}G`;
}

/**
 * Number and unit of a metric value. `unitKey` is an i18n key when the unit has words ("/분"), with
 * `unitPrefix` in front of it ("KB" + "/분").
 */
export function formatMetric(key: string, v: number): { value: string; unit: string; unitKey?: string } {
  const unit = METRIC_META[key]?.unit;
  // Percentages keep one decimal below 100: availability 99.6 % must not read as 100 %
  if (unit === "%") return { value: Math.abs(v) < 100 ? (Math.round(v * 10) / 10).toFixed(1).replace(/.0$/, "") : formatNumber(v), unit: "%" };
  if (unit === "ms") return { value: formatNumber(v), unit: "ms" };
  if (unit === "bytesPerMin") {
    const units = ["B", "KB", "MB", "GB", "TB"];
    let x = Math.max(0, v);
    let i = 0;
    while (x >= 1024 && i < units.length - 1) { x /= 1024; i++; }
    return { value: formatNumber(x), unit: units[i]!, unitKey: "ld.unit.perMin" };
  }
  if (unit === "perMin") return { value: formatNumber(v), unit: "", unitKey: "ld.unit.perMin" };
  if (unit === "count") return { value: formatNumber(v), unit: "" };
  if (unit === "bps") {
    const units = ["bps", "Kbps", "Mbps", "Gbps"];
    let x = Math.max(0, v);
    let i = 0;
    while (x >= 1000 && i < units.length - 1) { x /= 1000; i++; }
    return { value: formatNumber(x), unit: units[i]! };
  }
  return { value: formatNumber(v), unit: "" };
}

/** 1, 2, 5 × 10ⁿ at or above x */
function niceCeil(x: number): number {
  if (x <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(x)));
  for (const m of [1, 2, 5, 10]) if (m * p >= x - 1e-9) return m * p;
  return 10 * p;
}

/**
 * Trend scale starting at 0, so a flat 9 % CPU stays flat instead of being stretched into waves by a
 * min–max scale. Percentages get at least 0–10.
 */
/** Availability-like metrics sit at 100 %: a 0–100 scale would hide a dip to 97 % */
const NEAR_FULL = new Set(["dataPath", "backend", "availability", "fwHealth", "vmAvail"]);

export function sparkDomain(key: string, values: readonly number[]): [number, number] {
  const max = values.length ? Math.max(...values) : 0;
  if (NEAR_FULL.has(key)) return [Math.min(95, Math.floor((values.length ? Math.min(...values) : 100) - 1)), 100];
  if (isPercent(key)) return [0, Math.max(10, niceCeil(max * 1.25))];
  return [0, max > 0 ? max * 1.1 : 1];
}

export type MetricCell =
  | { state: "value"; key: string; value: string; unit: string; unitKey?: string }
  | { state: "unmeasured"; key: string };

// ── Compute usage pair (CPU or DTU + memory) ──

/** Utilisation metrics: a gauge on the card, orange at the health rule's threshold */
export const USAGE_KEYS: ReadonlySet<string> = new Set(["cpu", "memory", "dtu", "ru", "storage", "load", "snat"]);
/** Threshold when the kind has no health rule for the metric (VM memory) */
export const USAGE_DEFAULT_THRESHOLD = 85;

/** The card shows a usage pair when memory is bound next to CPU (or DTU) — VM, VMSS, AKS, Redis, PostgreSQL, SQL */
export function pairPrimary(bound: readonly string[]): "cpu" | "dtu" | undefined {
  if (!bound.includes("memory")) return undefined;
  if (bound.includes("cpu")) return "cpu";
  if (bound.includes("dtu")) return "dtu";
  return undefined;
}

/** Cell order: usage pair first (primary, memory, rest in binding order); otherwise the trend metric first */
export function cardMetricOrder(bound: readonly string[], trendKey?: string): string[] {
  const primary = pairPrimary(bound);
  if (primary) return [primary, "memory", ...bound.filter((k) => k !== primary && k !== "memory")];
  return trendKey && bound.includes(trendKey) ? [trendKey, ...bound.filter((k) => k !== trendKey)] : [...bound];
}

/** "warn" at or above the threshold, "ok" below; undefined for non-usage metrics or no value */
export function usageTone(key: string, v: number | null | undefined, threshold = USAGE_DEFAULT_THRESHOLD): "ok" | "warn" | undefined {
  if (!USAGE_KEYS.has(key) || v == null) return undefined;
  return v >= threshold ? "warn" : "ok";
}

/**
 * Warning thresholds from the kind's health rules ("cpu < 85" warning → cpu: 85; the critical rule is the higher
 * line) — the same line the status pill uses. Several → the lowest.
 */
export function usageThresholds(bindings: Record<string, MetricBinding> | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of bindings?.health?.rules ?? []) {
    if (r.op !== "<" || !USAGE_KEYS.has(r.metric) || r.level === "critical") continue;
    out[r.metric] = Math.min(out[r.metric] ?? Infinity, r.threshold);
  }
  return out;
}

const passes = (v: number, r: HealthRule) => {
  switch (r.op) {
    case "<": return v < r.threshold;
    case ">": return v > r.threshold;
    case "<=": return v <= r.threshold;
    case ">=": return v >= r.threshold;
    default: return v === r.threshold;
  }
};

/**
 * Tone of one card value from the kind's leveled rules on that metric (the same rules that set the status, with
 * their low-sample guard): "crit" / "warn" / "ok"; undefined when it has no value or no rule. Usage metrics
 * without a leveled rule fall back to the threshold (`usageTone`).
 */
export function cellTone(key: string, metrics: Record<string, number | null>, rules: readonly HealthRule[] | undefined, threshold?: number): "crit" | "warn" | "ok" | undefined {
  const v = metrics[key];
  if (v == null) return undefined;
  const mine = (rules ?? []).filter((r) => r.metric === key && r.level);
  if (!mine.length) return usageTone(key, v, threshold);
  let tone: "crit" | "warn" | "ok" = "ok";
  let judged = false;
  for (const r of mine) {
    if (r.when) { const g = metrics[r.when.metric]; if (g == null || g < r.when.atLeast) continue; }
    judged = true;
    if (passes(v, r)) continue;
    if (r.level === "critical") tone = "crit";
    else if (tone === "ok") tone = "warn";
  }
  // every rule waited for more samples: not judged
  return judged ? tone : undefined;
}

/** The card's cells: the kind's table, else (unknown kinds) a usage pair or the bound metrics with the trend first */
export function cardCells(kind: string, bound: readonly string[], trendKey?: string): string[] {
  const table = CARD_CELLS[kind];
  // The table applies when the spec binds its metrics (diagrams from Azure are normalised by the API); the sample
  // diagram keeps its own keys
  if (table && (table.length === 0 || table.some((k) => bound.includes(k)))) return [...table];
  const primary = pairPrimary(bound);
  return primary ? [primary, "memory"] : cardMetricOrder(bound, trendKey).slice(0, 2);
}

/** Both cells are utilisation (%) — gauges in the key line, two meter rows at the summary zoom */
export const isUsagePair = (cells: readonly string[]) => cells.length === 2 && cells.every((k) => USAGE_KEYS.has(k));

/** Card percent: one decimal below 10 ("7.4"), whole numbers above ("63"), capped at "100" */
export function compactPercent(v: number): string {
  if (v >= 100) return "100";
  if (v < 10) return (Math.round(v * 10) / 10).toFixed(1).replace(/.0$/, "");
  return Math.round(v).toString();
}

/** Cells for bound metrics in card order (usage pair, or the trend metric first, then binding order) */
export function metricCells(bound: readonly string[], metrics: Record<string, number | null>, trendKey?: string): MetricCell[] {
  const order = cardMetricOrder(bound, trendKey);
  return order.map((key) => {
    const v = metrics[key];
    return v == null ? { state: "unmeasured", key } : { state: "value", key, ...formatMetric(key, v) };
  });
}
