// Which series in an Azure Monitor workspace are one cluster's — pure. One workspace can hold several clusters, and
// two collectors (ama-metrics and a customer's own, e.g. Grafana Alloy) can scrape the same targets — summing both
// doubles every count. Shared by the Hubble metrics view and the workload / node panels (prometheusCollector.ts).

import type { HubbleMetricsSummary } from "@aud/types";
import { HttpError } from "../infra/requestParams.js";

export type Scope = NonNullable<HubbleMetricsSummary["scope"]>;

/** A PromQL string literal — control characters refused (label values come from the workspace or ARM names) */
export function promString(v: string): string {
  if (/[\u0000-\u001f\u007f]/.test(v)) throw new HttpError(400, "invalid_label_value", "Label value with control characters");
  return JSON.stringify(v);
}

/**
 * Which series are this cluster's. One workspace can hold several clusters, and two collectors (ama-metrics and a
 * customer's own, e.g. Grafana Alloy) can scrape the same agents — summing both doubles every count.
 * `rows` = `group by (cluster, job) (hubble_flows_processed_total)`.
 */
export function pickScope(rows: { cluster?: string; job?: string; collector?: string }[], aksName: string): Scope | "ambiguous" | null {
  if (!rows.length) return null;
  const clusters = [...new Set(rows.map((r) => r.cluster ?? ""))];
  let cluster: string | null;
  let basis: Scope["basis"];
  const exact = clusters.find((c) => c === aksName) ?? clusters.find((c) => c.toLowerCase() === aksName.toLowerCase());
  if (exact) { cluster = exact; basis = "exact"; }
  else if (clusters.length === 1 && clusters[0] === "") { cluster = null; basis = "unscoped"; }
  else if (clusters.filter(Boolean).length === 1 && clusters.length === 1) { cluster = clusters[0]!; basis = "alias"; }
  else return "ambiguous";
  const mine = rows.filter((r) => (r.cluster ?? "") === (cluster ?? ""));
  const jobs = [...new Set(mine.map((r) => r.job ?? ""))].filter(Boolean).sort();
  const job = jobs.length > 1 ? jobs.find((j) => /networkobservability|ama-metrics/i.test(j)) ?? jobs[0]! : null;
  // Same job from two collectors: ama-metrics writes no `collector` label (""), Alloy writes collector="alloy"
  const collectors = [...new Set(mine.filter((r) => job === null || r.job === job).map((r) => r.collector ?? ""))].sort();
  const collector = collectors.length > 1 ? collectors[0]! : null;
  return collector === null ? { cluster, job, basis } : { cluster, job, collector, basis };
}

/** Matchers for the scope: hubble series get cluster + job; kube-state-metrics series (another job) cluster only */
export function scopeMatchers(scope: Scope, withJob = true): string {
  const m: string[] = [];
  if (scope.cluster !== null) m.push(`cluster=${promString(scope.cluster)}`);
  if (withJob && scope.job) m.push(`job=${promString(scope.job)}`);
  if (scope.collector !== undefined && scope.collector !== null) m.push(`collector=${promString(scope.collector)}`);
  return m.join(",");
}

