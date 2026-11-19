// 수집 상태 › 수집기 신호 — pure view helpers for the API's collector signals (services/collectorTrends.ts): which
// charts a collector gets (by what it carries), how a value reads in its unit, the y-axis top. Tested in
// collectorTrends.test.ts.
import type { CollectorPipeline, CollectorRow, CollectorSignal } from "@aud/types";

/** A chart: its lines in a fixed order (colour = position, never rank); `limit` = a dashed ceiling, `threshold` = a rule */
export type ChartDef = { id: string; lines: string[]; limit?: string; threshold?: number };
export const CHARTS: Record<CollectorPipeline | "resources", ChartDef[]> = {
  metrics: [
    { id: "rwFlow", lines: ["rwIn", "rwSent"] },
    { id: "rwErrors", lines: ["rwFailed", "rwRetried", "rwDropped"] },
    { id: "rwLag", lines: ["rwLag"], threshold: 120 },
    { id: "rwShards", lines: ["rwShards", "rwShardsDesired"], limit: "rwShardsMax" },
    { id: "rwPending", lines: ["rwPending"] },
  ],
  logs: [
    { id: "logFlow", lines: ["logSent", "logDropped"] },
    { id: "logP95", lines: ["logP95"] },
    { id: "logRetries", lines: ["logRetries"] },
  ],
  traces: [
    { id: "spanFlow", lines: ["spanIn", "spanOut"] },
    { id: "spanErrors", lines: ["spanRefused", "spanFailed"] },
    { id: "queue", lines: ["queueSize"], limit: "queueCap" },
  ],
  profiles: [
    { id: "profFlow", lines: ["profBytes"] },
    { id: "profDropped", lines: ["profDropped"] },
  ],
  resources: [
    { id: "cpu", lines: ["cpu"], limit: "cpuLimit" },
    { id: "mem", lines: ["mem"], limit: "memLimit" },
    { id: "restarts", lines: ["restarts"] },
  ],
};

/** Pure: the charts for a collector — its pipelines' then resources; a chart none of whose series exists is kept (says "not measured") */
export function chartsOf(c: Pick<CollectorRow, "pipelines">): Array<{ group: CollectorPipeline | "resources"; chart: ChartDef }> {
  return [...c.pipelines, "resources" as const].flatMap((g) => CHARTS[g].map((chart) => ({ group: g, chart })));
}

const KIB = 1024;
const trim = (n: number, d: number) => Number(n.toFixed(d)).toString();

/** Pure: a value in its unit — short, the precision a chart reads at */
export function valueText(v: number | null, unit: CollectorSignal["unit"]): string {
  if (v === null || !Number.isFinite(v)) return "—";
  const big = (n: number) => (Math.abs(n) >= 1e6 ? `${trim(n / 1e6, 2)}M` : Math.abs(n) >= 1e3 ? `${trim(n / 1e3, 1)}k` : Math.abs(n) >= 10 ? trim(n, 0) : trim(n, 2));
  switch (unit) {
    case "perSecond": return `${big(v)}/s`;
    case "count": return big(v);
    case "ratio": return `${trim(v * 100, 1)}%`;
    case "seconds": return Math.abs(v) < 1 ? `${trim(v * 1000, 0)} ms` : `${trim(v, Math.abs(v) >= 100 ? 0 : 1)} s`;
    case "cores": return Math.abs(v) < 1 ? `${trim(v * 1000, 0)}m` : trim(v, 2);
    case "bytes":
    case "bytesPerSecond": {
      const suffix = unit === "bytesPerSecond" ? "/s" : "";
      const units = ["B", "KiB", "MiB", "GiB", "TiB"];
      let n = Math.abs(v), i = 0;
      while (n >= KIB && i < units.length - 1) { n /= KIB; i++; }
      return `${v < 0 ? "-" : ""}${trim(n, n >= 100 ? 0 : 1)} ${units[i]}${suffix}`;
    }
  }
}

/**
 * Pure: a round top for the y-axis — 1 · 2 · 2.5 · 5 × 10ⁿ at or over the largest value (and the threshold); bytes in
 * 1024 steps (512 MiB · 1 GiB, not 954 MiB); 1 when all are 0
 */
export function niceMax(max: number, unit?: CollectorSignal["unit"]): number {
  if (!(max > 0)) return 1;
  // bytes: the next power of two (600 MiB → 1 GiB, 1.5 GiB → 2 GiB) — halves read 512 MiB, 1 GiB
  if (unit === "bytes" || unit === "bytesPerSecond") return max < 1 ? 1 : 2 ** Math.ceil(Math.log2(max) - 1e-9);
  const p = 10 ** Math.floor(Math.log10(max));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= max - 1e-9) return m * p;
  return 10 * p;
}

/** How far above the data a limit may sit and still set the axis — beyond it the limit is said in numbers, not drawn
 *  (shards max 50 over 2 shards flattened the line to the floor) */
export const LIMIT_ON_AXIS = 4;
/** Pure: whether a limit is drawn on the chart's axis */
export const limitOnAxis = (dataMax: number, limit: number | null) => limit !== null && limit > 0 && (dataMax <= 0 || limit <= dataMax * LIMIT_ON_AXIS);

/** Pure: a scrape job's state from its up ratio and targets down now */
export function jobState(j: { upRatio: number | null; down: number }): "ok" | "warn" | "danger" | "unknown" {
  if (j.upRatio === null) return "unknown";
  if (j.upRatio === 0) return "danger";
  return j.down > 0 || j.upRatio < 1 ? "warn" : "ok";
}
