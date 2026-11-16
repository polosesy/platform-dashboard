// 서비스 (APM) › 의존성 — the view model (pure) of the API's per-application dependencies (services/appDependencies.ts):
// outbound HTTP targets, JDBC pools, Kafka consumers as three flat tables. Facts only — a failed request is a count, a
// waiting thread a count, lag a number of records; no colour without a target, ▲ marks a non-zero failure / wait / lag.

import type { AppDependencies, DbPool, KafkaConsumer, OutboundCall } from "@aud/types";

export type OutRow = OutboundCall & { application: string; namespace: string | null; inServiceMap: boolean };
export type PoolRow = DbPool & { application: string; namespace: string | null };
export type ConsumerRow = KafkaConsumer & { application: string; namespace: string | null };

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const hit = (q: string, ...s: Array<string | null | undefined>) => !q || s.some((x) => (x ?? "").toLowerCase().includes(q));

/** Pure: flat rows, filtered by a search (application / target / pool / topic / namespace); idle outbound pairs apart */
export function depsRows(apps: AppDependencies[], search = ""): { out: OutRow[]; idleOut: OutRow[]; pools: PoolRow[]; consumers: ConsumerRow[] } {
  const q = search.trim().toLowerCase();
  const out: OutRow[] = [], idleOut: OutRow[] = [], pools: PoolRow[] = [], consumers: ConsumerRow[] = [];
  for (const a of apps) {
    const base = { application: a.application, namespace: a.namespace };
    for (const o of a.outbound) if (hit(q, a.application, a.namespace, o.target)) (o.requests > 0 ? out : idleOut).push({ ...o, ...base, inServiceMap: a.inServiceMap });
    for (const p of a.pools) if (hit(q, a.application, a.namespace, p.pool)) pools.push({ ...p, ...base });
    for (const c of a.consumers) if (hit(q, a.application, a.namespace, c.topic)) consumers.push({ ...c, ...base });
  }
  out.sort((x, y) => y.failed - x.failed || y.requests - x.requests || cmp(x.application, y.application) || cmp(x.target, y.target));
  idleOut.sort((x, y) => cmp(x.application, y.application) || cmp(x.target, y.target));
  pools.sort((x, y) => (y.pendingPeak ?? 0) - (x.pendingPeak ?? 0) || (y.timeouts ?? 0) - (x.timeouts ?? 0) || cmp(x.application, y.application) || cmp(x.pool, y.pool));
  consumers.sort((x, y) => (y.lagPeak ?? 0) - (x.lagPeak ?? 0) || cmp(x.application, y.application) || cmp(x.topic, y.topic));
  return { out, idleOut, pools, consumers };
}

/** Pure: the headline counts — what needs a look (failures, waits, timeouts, lag) */
export function depsTotals(apps: AppDependencies[]): { apps: number; targets: number; failed: number; failingTargets: number; poolsWaiting: number; timeouts: number; lagging: number } {
  const outs = apps.flatMap((a) => a.outbound), pools = apps.flatMap((a) => a.pools), cons = apps.flatMap((a) => a.consumers);
  return {
    apps: apps.length, targets: outs.filter((o) => o.requests > 0).length,
    failed: outs.reduce((n, o) => n + o.failed, 0), failingTargets: outs.filter((o) => o.failed > 0).length,
    poolsWaiting: pools.filter((p) => (p.pendingPeak ?? 0) > 0).length, timeouts: pools.reduce((n, p) => n + (p.timeouts ?? 0), 0),
    lagging: cons.filter((c) => (c.lagPeak ?? 0) > 0).length,
  };
}

/** Seconds for people: ms below 1 s ("12 ms", "0.4 ms"), else seconds ("1.03 s"); null = "—" */
export function durationText(s: number | null): string {
  if (s === null) return "—";
  if (s < 1) { const ms = s * 1000; return `${ms < 10 ? ms.toFixed(1).replace(/\.0$/, "") : Math.round(ms)} ms`; }
  return `${s < 10 ? s.toFixed(2) : s.toFixed(1)} s`;
}

/** The dependencies of one service-map node (exact application name), for its panel */
export function depsOf(apps: AppDependencies[] | undefined, service: string): AppDependencies | null {
  return apps?.find((a) => a.application === service) ?? null;
}
