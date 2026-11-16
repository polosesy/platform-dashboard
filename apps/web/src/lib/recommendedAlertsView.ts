// AKS 모니터링 › 경고 신호 — the view model (pure) of Microsoft's recommended Kubernetes alert rules evaluated in this
// cluster's workspace (API services/k8sRecommendedAlerts.ts): what fires now first, then what cannot be evaluated here and
// why (a metric not in the workspace · the expression errors here · several clusters), then what is clear.

import type { RecommendedAlertRule } from "@aud/types";

export const STATE_ORDER: Record<RecommendedAlertRule["state"], number> = { firing: 0, failed: 1, noData: 2, ambiguous: 3, clear: 4 };

/** Pure: rules in reading order — state, then the template's severity (lower = worse), then name */
export function orderRules(rules: RecommendedAlertRule[]): RecommendedAlertRule[] {
  return [...rules].sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.severity - b.severity || (a.alert < b.alert ? -1 : a.alert > b.alert ? 1 : 0));
}

export type RaSummary = { total: number; firing: number; objects: number; clear: number; noData: number; failed: number; ambiguous: number; evaluated: number };
/** Pure: the counts — "evaluated" = rules that could run here (firing + clear) */
export function summarize(rules: RecommendedAlertRule[]): RaSummary {
  const n = (s: RecommendedAlertRule["state"]) => rules.filter((r) => r.state === s).length;
  return {
    total: rules.length, firing: n("firing"), objects: rules.reduce((k, r) => k + r.firing.length, 0), clear: n("clear"),
    noData: n("noData"), failed: n("failed"), ambiguous: n("ambiguous"), evaluated: n("firing") + n("clear"),
  };
}

const OBJECT_ORDER = ["namespace", "controller", "deployment", "statefulset", "daemonset", "horizontalpodautoscaler", "job_name", "persistentvolumeclaim", "persistentvolume", "pod", "container", "node", "instance", "mountpoint", "reason"];
/** Pure: an object as one line ("ns / controller / container") — labels in a fixed order, empty = the cluster */
export function objectText(object: Record<string, string>): string {
  return OBJECT_ORDER.filter((k) => object[k]).map((k) => object[k]).join(" / ");
}

/** Azure Monitor severity name (the template's number) */
export const SEVERITY_NAME = ["Sev0", "Sev1", "Sev2", "Sev3", "Sev4"] as const;
