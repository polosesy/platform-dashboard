"use client";

import { useState, useMemo } from "react";
import styles from "./styles.module.css";
import type { KubernetesClusterAccess, KubernetesClusterOverview, KubernetesObjectKind } from "@aud/types";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiQuery } from "@/lib/useApiQuery";
import { useAksClusters } from "@/lib/useAksClusters";
import { Badge, Cell, Chip, ErrorNotice, Grid, LoadingState, Notice, PageHeader, Panel, Select, Stat, useNoteText, type ChipLevel } from "@/components/ui";
import { useI18n } from "@/lib/i18n";
import { useOnChange } from "@/lib/useOnChange";

/** base64url of the cluster's ARM resource ID (path segment for the overview API). */
function encodeClusterId(id: string): string {
  return btoa(id).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** How the platform reaches and signs in to the cluster (docs/integrations/azure/aks.md) */
function AccessBadges({ access }: { access?: KubernetesClusterAccess }) {
  const { t } = useI18n();
  if (!access) return null;
  return (
    <>
      {" "}
      <Badge tone={access.private ? "info" : "neutral"} title={t(access.private ? "k8s.access.privateHint" : "k8s.access.publicHint")}>
        {t(access.private ? "k8s.access.private" : "k8s.access.public")}
      </Badge>{" "}
      {access.entra
        ? <Badge tone="success" title={t("k8s.access.entraHint")}>Entra ID</Badge>
        : <Badge tone="medium" title={t("k8s.access.localHint")}>{t("k8s.access.local")}</Badge>}
    </>
  );
}

const ALL_KINDS: KubernetesObjectKind[] = [
  "Node", "Namespace", "Pod", "Deployment", "ReplicaSet",
  "StatefulSet", "DaemonSet", "Service", "Ingress",
  "ConfigMap", "Secret", "PersistentVolumeClaim", "Job", "CronJob",
];

/** A Kubernetes status word → the platform's state grammar (the word itself is shown; nothing is guessed from it beyond this) */
const STATUS_OK = new Set(["Running", "Ready", "Active", "Bound", "Succeeded", "Complete", "Completed", "Available"]);
const STATUS_WARN = new Set(["Pending", "ContainerCreating", "Terminating", "Unknown", "Suspended"]);
const STATUS_DANGER = new Set(["Failed", "CrashLoopBackOff", "Error", "NotReady", "ImagePullBackOff", "ErrImagePull", "Lost", "OOMKilled"]);
function statusLevel(status: string | undefined): ChipLevel {
  if (!status) return "plain";
  if (STATUS_OK.has(status)) return "ok";
  if (STATUS_DANGER.has(status)) return "danger";
  if (STATUS_WARN.has(status)) return "warn";
  return "plain";
}

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
  const noteText = useNoteText();
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
  // The cluster comes from the scope bar (shared by every AKS screen); a new cluster starts with no filters
  useOnChange(selectedClusterId, () => { setKindFilter("All"); setNamespaceFilter("All"); });

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
        meta={selectedCluster ? <span>{selectedCluster.name} · {selectedCluster.location} · Kubernetes v{selectedCluster.kubernetesVersion}<AccessBadges access={selectedCluster.access} /></span> : null}
      />

      {clustersNote ? <Notice tone="info">{noteText(clustersNote)}</Notice> : null}
      {/* The list and the overview both carry "signin_required" for a signed-out visitor — say it once */}
      {overview?.note && noteText(overview.note) !== noteText(clustersNote) ? <Notice tone="info">{noteText(overview.note)}</Notice> : null}
      <ErrorNotice error={error} />
      {loading ? <LoadingState /> : null}

      {/* 12 columns: four cards × 3, the objects table 12 (design-system.md · 8) */}
      {overview && (
        <Grid>
          <Cell span={3}><Stat label={t("k8s.nodes")} value={overview.summary.nodeCount} /></Cell>
          <Cell span={3}>
            <Stat label={t("k8s.podsRunning")} value={`${overview.summary.podRunning} / ${overview.summary.podTotal}`}
              tone={overview.summary.podFailed ? "high" : overview.summary.podPending ? "medium" : "success"}
              hint={t("k8s.podsHint", { pending: overview.summary.podPending, failed: overview.summary.podFailed })} />
          </Cell>
          <Cell span={3}><Stat label="Deployment" value={overview.summary.deploymentCount} /></Cell>
          <Cell span={3}><Stat label="Service" value={overview.summary.serviceCount} /></Cell>

          <Cell span={12}>
            <Panel flush title={t("k8s.objects")} sub={`${filteredObjects.length} / ${overview.objects.length}`}
              actions={<>
                <Select label={t("k8s.col.kind")} hideLabel value={kindFilter} onChange={(v) => setKindFilter(v as KubernetesObjectKind | "All")}
                  options={[{ value: "All", label: `${t("common.all")} (${overview.objects.length})` },
                    ...visibleKinds.map((kind) => ({ value: kind, label: `${kind} (${overview.objects.filter((o) => o.kind === kind).length})` }))]} />
                {namespaces.length > 0 ? (
                  <Select label={t("k8s.namespace")} hideLabel value={namespaceFilter} onChange={setNamespaceFilter}
                    options={[{ value: "All", label: t("k8s.allNamespaces") }, ...namespaces.map((ns) => ({ value: ns, label: ns }))]} />
                ) : null}
              </>}>
              {overviewLoading ? <LoadingState /> : (
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
                          <td><span className={styles.objectName}>{obj.name}</span></td>
                          <td className={styles.mono}>{obj.namespace || "-"}</td>
                          <td className={styles.kindCell}>{obj.kind}</td>
                          <td>{obj.status ? <Chip level={statusLevel(obj.status)}>{obj.status}</Chip> : "-"}</td>
                          <td className={styles.mono}>{obj.ready ?? obj.replicas ?? "-"}</td>
                          <td className={styles.mono}>{obj.restarts !== undefined ? obj.restarts : "-"}</td>
                          <td className={styles.mono}>{relativeAge(obj.createdAt)}</td>
                        </tr>
                      ))}
                      {filteredObjects.length === 0 && (
                        <tr>
                          <td colSpan={7}><div className={styles.tableHint}>{t("k8s.noMatch")}</div></td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>
          </Cell>
        </Grid>
      )}
      {overviewLoading && !overview ? <LoadingState /> : null}
    </div>
  );
}
