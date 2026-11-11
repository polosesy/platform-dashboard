// AKS 모니터링 › 로그 › 로그 지표 — view helpers (pure) for the counts the API reads from Loki
// (services/lokiLogs.ts getLogInsights): bars for ERROR lines over time, and which pod to open for a workload.

import type { LogInsightsResponse } from "@aud/types";

export type TimelineBar = { start: string; end: string; count: number; /** 0–100, of the tallest bucket (a non-zero count is at least 4 so it stays visible) */ height: number };

/** Pure: the timeline's buckets as bars — heights relative to the tallest bucket; no data = no bars */
export function timelineBars(tl: LogInsightsResponse["timeline"]): TimelineBar[] {
  if (!tl) return [];
  const max = Math.max(0, ...tl.buckets);
  const t0 = Date.parse(tl.start);
  return tl.buckets.map((count, i) => ({
    start: new Date(t0 + i * tl.stepSeconds * 1000).toISOString(),
    end: new Date(t0 + (i + 1) * tl.stepSeconds * 1000).toISOString(),
    count,
    height: max > 0 && count > 0 ? Math.max(4, Math.round((count / max) * 100)) : 0,
  }));
}

/** Pure: the bucket with the most ERROR lines (the first of equals); null when nothing was counted */
export function peakBucket(bars: TimelineBar[]): TimelineBar | null {
  let best: TimelineBar | null = null;
  for (const b of bars) if (b.count > 0 && (!best || b.count > best.count)) best = b;
  return best;
}

const HASH = "[bcdfghjklmnpqrstvwxz2456789]";
/** Pure: whether a pod name is one of a workload's (Deployment · StatefulSet · DaemonSet / Job shapes — the API's workloadOfPod) */
export function podOfWorkload(pod: string, workload: string): boolean {
  if (!pod.startsWith(`${workload}-`)) return false;
  const rest = pod.slice(workload.length + 1);
  return new RegExp(`^(${HASH}{6,10}-${HASH}{5}|[0-9]+|${HASH}{5})$`).test(rest);
}

/** Pure: the pod to open for a workload — the first of its pods in the list, else null (it has none running now) */
export function firstPodOf(pods: string[], workload: string): string | null {
  return pods.find((p) => podOfWorkload(p, workload)) ?? (pods.includes(workload) ? workload : null);
}

/** Pure: a workload's share of the ERROR lines (0–100), for the row bars */
export function shareOf(errors: number, total: number | null): number {
  return total && total > 0 ? Math.round((errors / total) * 100) : 0;
}
