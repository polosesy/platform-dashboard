"use client";

import { useState, useMemo } from "react";
import styles from "./styles.module.css";
import type { KubernetesClusterOverview, KubernetesObjectKind } from "@aud/types";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiQuery } from "@/lib/useApiQuery";
import { useAksClusters } from "@/lib/useAksClusters";
import { ErrorNotice, LoadingState, Notice, PageHeader, Select, Stat } from "@/components/ui";
import { useI18n } from "@/lib/i18n";

/** base64url of the cluster's ARM resource ID (path segment for the overview API). */
function encodeClusterId(id: string): string {
  return btoa(id).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const ALL_KINDS: KubernetesObjectKind[] = [
  "Node", "Namespace", "Pod", "Deployment", "ReplicaSet",
  "StatefulSet", "DaemonSet", "Service", "Ingress",
  "ConfigMap", "Secret", "PersistentVolumeClaim", "Job", "CronJob",
];

function relativeAge(iso: string): string {
  if (!iso) return "-";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "0s";
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
  const { t } = useI18n();
  const {
    clusters,
    clusterId: selectedClusterId,
    setClusterId: setSelectedClusterId,
    note: clustersNote,
    loading,
    error: clustersError,
  } = useAksClusters();
  const [kindFilter, setKindFilter] = useState<KubernetesObjectKind | "All">("All");
  const [namespaceFilter, setNamespaceFilter] = useState<string>("All");

  const overviewQuery = useApiQuery(selectedClusterId ? `k8s-overview:${selectedClusterId}` : null, (token) =>
    fetchJsonWithBearer<KubernetesClusterOverview>(apiUrl(`/api/kubernetes/cluster/${encodeClusterId(selectedClusterId)}/overview`), token),
  );
  // Never show the previous cluster's objects while the new selection loads
  const overview = overviewQuery.loading ? null : (overviewQuery.data ?? null);
  const overviewLoading = overviewQuery.loading;
  const error = clustersError ?? overviewQuery.error;

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
      <PageHeader
        meta={selectedCluster ? <span>{selectedCluster.name} · {selectedCluster.location} · Kubernetes v{selectedCluster.kubernetesVersion}</span> : null}
        actions={
          <>
            <Select
              label={t("common.cluster")}
              value={selectedClusterId}
              onChange={(v) => {
                setSelectedClusterId(v);
                setKindFilter("All");
                setNamespaceFilter("All");
              }}
              placeholder={loading ? t("common.loading") : t("pol.noCluster")}
              options={clusters.map((c) => ({ value: c.id, label: `${c.name} (${c.location})` }))}
            />
            {namespaces.length > 0 ? (
              <Select
                label={t("k8s.namespace")}
                value={namespaceFilter}
                onChange={setNamespaceFilter}
                options={[{ value: "All", label: t("k8s.allNamespaces") }, ...namespaces.map((ns) => ({ value: ns, label: ns }))]}
              />
            ) : null}
          </>
        }
      />

      {clustersNote ? <Notice tone="info">{clustersNote}</Notice> : null}
      {overview?.note ? <Notice tone="info">{overview.note}</Notice> : null}
      <ErrorNotice error={error} />
      {loading ? <LoadingState /> : null}

      {/* Summary cards */}
      {overview && (
        <div className={styles.summaryStrip}>
          <Stat label={t("k8s.nodes")} value={overview.summary.nodeCount} />
          <Stat label={t("k8s.pods")} value={overview.summary.podTotal} />
          <Stat label={t("k8s.running")} value={overview.summary.podRunning} tone="success" />
          <Stat label={t("k8s.pending")} value={overview.summary.podPending} tone={overview.summary.podPending ? "medium" : undefined} />
          <Stat label={t("k8s.failed")} value={overview.summary.podFailed} tone={overview.summary.podFailed ? "high" : undefined} />
          <Stat label="Deployment" value={overview.summary.deploymentCount} />
          <Stat label="Service" value={overview.summary.serviceCount} />
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
            {t("common.all")} ({overview.objects.length})
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
      {overviewLoading ? <LoadingState /> : null}
      {overview && !overviewLoading && (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>{t("k8s.col.name")}</th>
                <th>{t("k8s.namespace")}</th>
                <th>{t("k8s.col.kind")}</th>
                <th>{t("k8s.col.status")}</th>
                <th>{t("k8s.col.ready")}</th>
                <th>{t("k8s.col.restarts")}</th>
                <th>{t("k8s.col.age")}</th>
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
                    <div className={styles.tableHint}>{t("k8s.noMatch")}</div>
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
