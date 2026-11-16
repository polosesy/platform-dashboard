// This dashboard's corrections to Microsoft's recommended Kubernetes alert rules (msRecommendedAlerts.ts stays verbatim).
// Each one answers a fact measured on stg 2026-11-16 and is evaluated in the workspace like the original — a correction
// is used only where the original cannot evaluate. The deployable template (k8sRecommendedAlerts.ts ruleGroupTemplate)
// also sets every job matcher to the job the workspace actually has.

export type RuleFix = {
  why: "metricMissing" | "duplicateMatch";
  /** written like Microsoft's (job matchers included) so the same scoping applies */
  expression: string;
};

export const MS_RULE_FIXES: Readonly<Record<string, RuleFix>> = {
  // `kube_job_failed` (the Job's Failed condition) is not in the workspace — `kube_job_status_failed` (failed pods) is.
  // Failed pods alone also count a Job that retried and then succeeded, so: failed pods, and none succeeded or running.
  KubeJobFailed: {
    why: "metricMissing",
    expression: '(kube_job_status_failed{job="kube-state-metrics"} > 0) and on(namespace, job_name, cluster) (kube_job_status_succeeded{job="kube-state-metrics"} == 0) and on(namespace, job_name, cluster) (kube_job_status_active{job="kube-state-metrics"} == 0)',
  },
  // kubelet_volume_stats_* carry namespace + persistentvolumeclaim — no pod, no container. Microsoft's
  // `on(namespace,cluster,pod,container)` therefore matches every volume of a namespace with every other: "found
  // duplicate series for the match group" as soon as a namespace has two PVCs. Matched per PVC instead.
  KubePVUsageHigh: {
    why: "duplicateMatch",
    expression: 'max by (namespace, persistentvolumeclaim, cluster) (kubelet_volume_stats_used_bytes{job="kubelet"} / on(namespace, persistentvolumeclaim, cluster, instance, job) kubelet_volume_stats_capacity_bytes{job="kubelet"}) > .8',
  },
};
