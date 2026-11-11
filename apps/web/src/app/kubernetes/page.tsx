"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import styles from "./styles.module.css";
import type { AksClusterConfigResponse, KubernetesClusterAccess, KubernetesClusterOverview, KubernetesObjectKind } from "@aud/types";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiQuery } from "@/lib/useApiQuery";
import { useAksClusters } from "@/lib/useAksClusters";
import {
  Badge, Cell, Chip, ErrorNotice, FilterChip, Grid, LinkButton, LoadingState, Notice, PageHeader, Panel, SearchInput, Select, Stat, useNoteText, type ChipLevel,
} from "@/components/ui";
import { useI18n } from "@/lib/i18n";
import { useOnChange } from "@/lib/useOnChange";
import {
  NO_OBJECT_FILTER, filterObjects, groupCounts, kindCounts, monitoringHref, parseObjectParams, type ObjectFilter,
} from "@/lib/aksConfigView";
import { ClusterConfig } from "./ClusterConfig";

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

/** Rows drawn before "show all" (a cluster has thousands of objects) */
const FIRST_ROWS = 200;

// AKS 클러스터 = 구성 · 리소스 (docs/architecture/kubernetes-ia.md): what the cluster is set to (Azure) and what is in
// it (Kubernetes objects). Whether it is healthy is AKS 모니터링 — one source for pod numbers — so this page counts
// inventory only and a workload row links to its signals there.
export default function KubernetesPage() {
  const { t } = useI18n();
  const noteText = useNoteText();
  const {
    clusters,
    clusterId: selectedClusterId,
    note: clustersNote,
    loading,
    error: clustersError,
  } = useAksClusters();
  const [f, setF] = useState<ObjectFilter>(NO_OBJECT_FILTER);
  const [all, setAll] = useState(false);
  const set = (patch: Partial<ObjectFilter>) => { setF((x) => ({ ...x, ...patch })); setAll(false); };
  // `?ns=&q=` (AKS 모니터링 › 워크로드 패널 '구성 보기'): read once, after the first render (no hydration mismatch)
  useEffect(() => {
    const fromUrl = parseObjectParams(window.location.search);
    if (fromUrl.namespace || fromUrl.query) setF((x) => ({ ...x, ...fromUrl }));
  }, []);
  // The cluster comes from the scope bar (shared by every AKS screen); another cluster starts with no filters —
  // the first selection (from none) keeps what the link asked for
  const lastCluster = useRef(selectedClusterId);
  useOnChange(selectedClusterId, () => {
    if (lastCluster.current) { setF(NO_OBJECT_FILTER); setAll(false); }
    lastCluster.current = selectedClusterId;
  });

  const overviewQuery = useApiQuery(selectedClusterId ? `k8s-overview:${selectedClusterId}` : null, (token) =>
    fetchJsonWithBearer<KubernetesClusterOverview>(apiUrl(`/api/kubernetes/cluster/${encodeClusterId(selectedClusterId)}/overview`), token),
  );
  // Azure's configuration: ARM only — it answers even when the cluster's Kubernetes API cannot be reached
  const configQuery = useApiQuery(selectedClusterId ? `k8s-config:${selectedClusterId}` : null, (token) =>
    fetchJsonWithBearer<AksClusterConfigResponse>(apiUrl("/api/kubernetes/cluster-config", { clusterId: selectedClusterId }), token),
  );
  // Never show the previous cluster's objects or configuration while the new selection loads
  const overview = overviewQuery.loading ? null : (overviewQuery.data ?? null);
  const config = !configQuery.loading && configQuery.data?.clusterId === selectedClusterId.toLowerCase() ? configQuery.data : null;
  const overviewLoading = overviewQuery.loading;

  const objects = overview?.objects;
  const namespaces = useMemo(() => [...new Set((objects ?? []).map((o) => o.namespace).filter(Boolean))].sort(), [objects]);
  const groups = useMemo(() => groupCounts(objects ?? [], f), [objects, f]);
  const kinds = useMemo(() => kindCounts(objects ?? [], f), [objects, f]);
  const rows = useMemo(() => filterObjects(objects ?? [], f), [objects, f]);
  const shown = all ? rows : rows.slice(0, FIRST_ROWS);
  const count = (kindsOf: KubernetesObjectKind[]) => (objects ?? []).filter((o) => kindsOf.includes(o.kind)).length;
  const filtered = f.group || f.kind || f.namespace || f.query.trim();

  const selectedCluster = clusters.find((c) => c.id === selectedClusterId);

  return (
    <div className={styles.page}>
      <PageHeader
        meta={selectedCluster ? <span>{selectedCluster.name} · {selectedCluster.location} · Kubernetes v{selectedCluster.kubernetesVersion}<AccessBadges access={selectedCluster.access} /></span> : null}
        actions={selectedClusterId ? <Link className={styles.stateLink} href="/observability">{t("k8s.toMonitoring")} →</Link> : undefined}
      />

      {clustersNote ? <Notice tone="info">{noteText(clustersNote)}</Notice> : null}
      {/* The list and the overview both carry "signin_required" for a signed-out visitor — say it once */}
      {overview?.note && noteText(overview.note) !== noteText(clustersNote) ? <Notice tone="info">{noteText(overview.note)}</Notice> : null}
      <ErrorNotice error={clustersError} />
      {loading ? <LoadingState /> : null}

      {/* 12 columns: the configuration 6 + 6, four inventory cards × 3, the objects table 12 (design-system.md · 8) */}
      {selectedClusterId ? (
        <Grid>
          <Cell span={12}><h2 className={styles.sectionTitle}>{t("k8s.cfg.title")}<span className={styles.sectionSub}>{t("k8s.cfg.sub")}</span></h2></Cell>
          {configQuery.error ? <Cell span={12}><ErrorNotice error={configQuery.error} title={t("k8s.cfg.failed")} /></Cell>
            : config ? <ClusterConfig c={config} />
            : <Cell span={12}><LoadingState label={t("k8s.cfg.loading")} /></Cell>}

          <Cell span={12}><h2 className={styles.sectionTitle}>{t("k8s.res.title")}<span className={styles.sectionSub}>{t("k8s.res.sub")}</span></h2></Cell>
          {overviewQuery.error ? <Cell span={12}><ErrorNotice error={overviewQuery.error} title={t("k8s.res.failed")} /></Cell> : null}
          {overviewLoading ? <Cell span={12}><LoadingState /></Cell> : null}
          {overview && (
            <>
              <Cell span={3}><Stat label={t("k8s.nodes")} value={overview.summary.nodeCount} hint={t("k8s.res.nsHint", { n: overview.summary.namespaceCount })} /></Cell>
              <Cell span={3}><Stat label={t("k8s.group.workloads")} value={count(["Deployment", "StatefulSet", "DaemonSet"])} hint={t("k8s.res.workloadsHint", { n: overview.summary.podTotal })} /></Cell>
              <Cell span={3}><Stat label={t("k8s.group.network")} value={count(["Service", "Ingress"])} hint={t("k8s.res.networkHint", { n: count(["Ingress"]) })} /></Cell>
              <Cell span={3}><Stat label={t("k8s.group.batch")} value={count(["Job", "CronJob"])} hint={t("k8s.res.batchHint", { n: count(["CronJob"]) })} /></Cell>

              <Cell span={12}>
                <Panel flush title={t("k8s.objects")} sub={`${rows.length} / ${overview.objects.length}`}
                  footer={<span>{t("k8s.res.foot")}</span>}>
                  <div className={styles.filters}>
                    <div className={styles.groupRow} role="group" aria-label={t("k8s.col.kind")}>
                      {groups.map((g) => (
                        <FilterChip key={g.group} pressed={f.group === g.group} onClick={() => set({ group: f.group === g.group ? "" : g.group, kind: "" })}>
                          {t(`k8s.group.${g.group}`)} <span className={styles.countN}>{g.n}</span>
                        </FilterChip>
                      ))}
                    </div>
                    <Select label={t("k8s.col.kind")} hideLabel value={f.kind} onChange={(v) => set({ kind: v as KubernetesObjectKind | "", group: "" })}
                      options={[{ value: "", label: t("k8s.allKinds") }, ...kinds.map((k) => ({ value: k.kind, label: `${k.kind} (${k.n})` }))]} />
                    {namespaces.length > 0 ? (
                      <Select label={t("k8s.namespace")} hideLabel value={f.namespace} onChange={(v) => set({ namespace: v })}
                        options={[{ value: "", label: t("k8s.allNamespaces") }, ...namespaces.map((ns) => ({ value: ns, label: ns }))]} />
                    ) : null}
                    <SearchInput label={t("k8s.search")} value={f.query} onChange={(v) => set({ query: v })} placeholder={t("k8s.searchPh")} />
                    {filtered ? <LinkButton onClick={() => { setF(NO_OBJECT_FILTER); setAll(false); }}>{t("k8s.clear")}</LinkButton> : null}
                  </div>
                  <div className={styles.tableWrap}>
                    <table className={styles.table}>
                      <thead>
                        <tr>
                          <th scope="col">{t("k8s.col.name")}</th>
                          <th scope="col">{t("k8s.namespace")}</th>
                          <th scope="col">{t("k8s.col.kind")}</th>
                          <th scope="col">{t("k8s.col.status")}</th>
                          <th scope="col">{t("k8s.col.ready")}</th>
                          <th scope="col">{t("k8s.col.restarts")}</th>
                          <th scope="col">{t("k8s.col.age")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {shown.map((obj, i) => {
                          const signals = monitoringHref(obj);
                          return (
                            <tr key={`${obj.kind}-${obj.namespace}-${obj.name}-${i}`}>
                              <td>
                                <span className={styles.objectName}>{obj.name}</span>
                                {signals ? <> <Link className={styles.rowLink} href={signals} title={t("k8s.res.signalsHint")}>{t("k8s.res.signals")} →</Link></> : null}
                                {obj.ports?.length ? <span className={styles.cfgSub}>{obj.ports.join(" · ")}</span> : null}
                                {obj.targets ? (
                                  <span className={styles.cfgSub}>
                                    {obj.targets.pods === 0 ? t("k8s.res.noTargets")
                                      : t("k8s.res.targets", { pods: obj.targets.pods, workloads: obj.targets.workloads.join(", ") })}
                                  </span>
                                ) : null}
                              </td>
                              <td className={styles.mono}>{obj.namespace || "-"}</td>
                              <td className={styles.kindCell}>{obj.kind}</td>
                              <td>{obj.status ? <Chip level={statusLevel(obj.status)}>{obj.status}</Chip> : "-"}</td>
                              <td className={styles.mono}>{obj.ready ?? obj.replicas ?? "-"}</td>
                              <td className={styles.mono}>{obj.restarts !== undefined ? obj.restarts : "-"}</td>
                              <td className={styles.mono}>{relativeAge(obj.createdAt)}</td>
                            </tr>
                          );
                        })}
                        {rows.length === 0 && (
                          <tr>
                            <td colSpan={7}><div className={styles.tableHint}>{t("k8s.noMatch")}</div></td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                    {rows.length > shown.length ? (
                      <div className={styles.more}><LinkButton onClick={() => setAll(true)}>{t("k8s.res.more", { n: rows.length })}</LinkButton></div>
                    ) : null}
                  </div>
                </Panel>
              </Cell>
            </>
          )}
        </Grid>
      ) : null}
    </div>
  );
}
