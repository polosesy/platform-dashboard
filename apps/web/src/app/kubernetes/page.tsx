"use client";

import { useEffect, useState, useMemo, useCallback } from "react";
import styles from "./styles.module.css";
import type {
  KubernetesClustersResponse,
  KubernetesClusterOverview,
  KubernetesClusterInfo,
  KubernetesObjectKind,
} from "@aud/types";
import { apiBaseUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiToken } from "@/lib/useApiToken";

const ALL_KINDS: KubernetesObjectKind[] = [
  "Node", "Namespace", "Pod", "Deployment", "ReplicaSet",
  "StatefulSet", "DaemonSet", "Service", "Ingress",
  "ConfigMap", "Secret", "PersistentVolumeClaim", "Job", "CronJob",
];

function relativeAge(iso: string): string {
  if (!iso) return "-";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "just now";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const days = Math.floor(hr / 24);
  return `${days}d`;
}

export default function KubernetesPage() {
  const [clusters, setClusters] = useState<KubernetesClusterInfo[]>([]);
  const [clustersNote, setClustersNote] = useState<string | undefined>();
  const [selectedClusterId, setSelectedClusterId] = useState<string>("");
  const [overview, setOverview] = useState<KubernetesClusterOverview | null>(null);
  const [kindFilter, setKindFilter] = useState<KubernetesObjectKind | "All">("All");
  const [namespaceFilter, setNamespaceFilter] = useState<string>("All");
  const [loading, setLoading] = useState(true);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const getApiToken = useApiToken();

  // Load clusters
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getApiToken()
      .then((token) =>
        fetchJsonWithBearer<KubernetesClustersResponse>(
          `${apiBaseUrl()}/api/kubernetes/clusters`,
          token,
        ),
      )
      .then((data) => {
        if (cancelled) return;
        setClusters(data.clusters);
        setClustersNote(data.note);
        if (data.clusters.length > 0 && !selectedClusterId) {
          setSelectedClusterId(data.clusters[0]!.id);
        }
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Failed to load clusters");
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [getApiToken]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load cluster overview when selection changes
  const loadOverview = useCallback(
    async (clusterId: string) => {
      if (!clusterId) return;
      setOverviewLoading(true);
      setOverview(null);
      try {
        const token = await getApiToken();
        const encoded = btoa(clusterId)
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/, "");
        const data = await fetchJsonWithBearer<KubernetesClusterOverview>(
          `${apiBaseUrl()}/api/kubernetes/cluster/${encoded}/overview`,
          token,
        );
        setOverview(data);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "Failed to load cluster overview");
      } finally {
        setOverviewLoading(false);
      }
    },
    [getApiToken],
  );

  useEffect(() => {
    if (selectedClusterId) {
      loadOverview(selectedClusterId);
    }
  }, [selectedClusterId, loadOverview]);

  // Derive unique namespaces from overview
  const namespaces = useMemo(() => {
    if (!overview) return [];
    const ns = new Set<string>();
    for (const obj of overview.objects) {
      if (obj.namespace) ns.add(obj.namespace);
    }
    return Array.from(ns).sort();
  }, [overview]);

  // Derive visible kinds from overview
  const visibleKinds = useMemo(() => {
    if (!overview) return [];
    const kinds = new Set<KubernetesObjectKind>();
    for (const obj of overview.objects) kinds.add(obj.kind);
    return ALL_KINDS.filter((k) => kinds.has(k));
  }, [overview]);

  // Filtered objects
  const filteredObjects = useMemo(() => {
    if (!overview) return [];
    return overview.objects.filter((obj) => {
      if (kindFilter !== "All" && obj.kind !== kindFilter) return false;
      if (namespaceFilter !== "All" && obj.namespace !== namespaceFilter) return false;
      return true;
    });
  }, [overview, kindFilter, namespaceFilter]);

  const selectedCluster = clusters.find((c) => c.id === selectedClusterId);

  return (
    <div className={styles.page}>
      {/* Header */}
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <div className={styles.title}>Kubernetes</div>
          <div className={styles.subTitle}>
            {selectedCluster
              ? `${selectedCluster.name} — ${selectedCluster.location} — v${selectedCluster.kubernetesVersion}`
              : "Select a cluster"}
          </div>
        </div>
        <div className={styles.controls}>
          <select
            className={styles.select}
            value={selectedClusterId}
            onChange={(e) => {
              setSelectedClusterId(e.target.value);
              setKindFilter("All");
              setNamespaceFilter("All");
            }}
          >
            {clusters.length === 0 && <option value="">No clusters</option>}
            {clusters.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.location})
              </option>
            ))}
          </select>
          {namespaces.length > 0 && (
            <select
              className={styles.select}
              value={namespaceFilter}
              onChange={(e) => setNamespaceFilter(e.target.value)}
            >
              <option value="All">All Namespaces</option>
              {namespaces.map((ns) => (
                <option key={ns} value={ns}>
                  {ns}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      {/* Notes */}
      {clustersNote && <div className={styles.note}>{clustersNote}</div>}
      {overview?.note && <div className={styles.note}>{overview.note}</div>}

      {error && <div className={styles.error}>{error}</div>}

      {loading && <div className={styles.loading}>Loading clusters...</div>}

      {/* Summary cards */}
      {overview && (
        <div className={styles.summaryStrip}>
          <div className={styles.summaryCard}>
            <div className={styles.summaryLabel}>Nodes</div>
            <div className={styles.summaryValue}>{overview.summary.nodeCount}</div>
          </div>
          <div className={styles.summaryCard}>
            <div className={styles.summaryLabel}>Pods</div>
            <div className={styles.summaryValue}>{overview.summary.podTotal}</div>
          </div>
          <div className={styles.summaryCard}>
            <div className={styles.summaryLabel}>Running</div>
            <div className={styles.summaryValue} data-accent="running">
              {overview.summary.podRunning}
            </div>
          </div>
          <div className={styles.summaryCard}>
            <div className={styles.summaryLabel}>Pending</div>
            <div className={styles.summaryValue} data-accent="pending">
              {overview.summary.podPending}
            </div>
          </div>
          <div className={styles.summaryCard}>
            <div className={styles.summaryLabel}>Failed</div>
            <div className={styles.summaryValue} data-accent="failed">
              {overview.summary.podFailed}
            </div>
          </div>
          <div className={styles.summaryCard}>
            <div className={styles.summaryLabel}>Deployments</div>
            <div className={styles.summaryValue}>{overview.summary.deploymentCount}</div>
          </div>
          <div className={styles.summaryCard}>
            <div className={styles.summaryLabel}>Services</div>
            <div className={styles.summaryValue}>{overview.summary.serviceCount}</div>
          </div>
        </div>
      )}

      {/* Kind filter */}
      {overview && (
        <div className={styles.kindFilter}>
          <button
            type="button"
            className={`${styles.kindBtn} ${kindFilter === "All" ? styles.kindBtnActive : ""}`}
            onClick={() => setKindFilter("All")}
          >
            All ({overview.objects.length})
          </button>
          {visibleKinds.map((kind) => {
            const count = overview.objects.filter((o) => o.kind === kind).length;
            return (
              <button
                key={kind}
                type="button"
                className={`${styles.kindBtn} ${kindFilter === kind ? styles.kindBtnActive : ""}`}
                onClick={() => setKindFilter(kind)}
              >
                {kind} ({count})
              </button>
            );
          })}
        </div>
      )}

      {/* Objects table */}
      {overviewLoading && <div className={styles.loading}>Loading cluster objects...</div>}
      {overview && !overviewLoading && (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Name</th>
                <th>Namespace</th>
                <th>Kind</th>
                <th>Status</th>
                <th>Ready</th>
                <th>Restarts</th>
                <th>Age</th>
              </tr>
            </thead>
            <tbody>
              {filteredObjects.map((obj, i) => (
                <tr key={`${obj.kind}-${obj.namespace}-${obj.name}-${i}`}>
                  <td>
                    <span className={styles.objectName}>{obj.name}</span>
                  </td>
                  <td className={styles.mono}>{obj.namespace || "-"}</td>
                  <td>
                    <span className={styles.kindBadge}>{obj.kind}</span>
                  </td>
                  <td>
                    <span className={styles.statusBadge} data-status={obj.status}>
                      {obj.status}
                    </span>
                  </td>
                  <td className={styles.mono}>{obj.ready ?? obj.replicas ?? "-"}</td>
                  <td className={styles.mono}>
                    {obj.restarts !== undefined ? obj.restarts : "-"}
                  </td>
                  <td className={styles.mono}>{relativeAge(obj.createdAt)}</td>
                </tr>
              ))}
              {filteredObjects.length === 0 && (
                <tr>
                  <td colSpan={7}>
                    <div className={styles.tableHint}>No objects match the current filters</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
