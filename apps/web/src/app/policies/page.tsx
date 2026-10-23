"use client";

import { Suspense, useMemo, useState } from "react";
import Link from "next/link";
import type { KubernetesPolicyResponse, PolicyCategory, PolicyInsightsResponse, PolicySeverity, WorkloadIdentityResponse } from "@aud/types";
import styles from "./styles.module.css";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiQuery } from "@/lib/useApiQuery";
import { useAksClusters } from "@/lib/useAksClusters";
import { SeverityBadge, categoryLabel, scoreClass } from "./components/shared";
import { FindingsPanel } from "./components/FindingsPanel";
import { NamespaceMatrix } from "./components/NamespaceMatrix";
import { NetworkPolicyPanel } from "./components/NetworkPolicyPanel";
import { RbacPanel } from "./components/RbacPanel";
import { PsaPanel } from "./components/PsaPanel";
import { AutoscalingPanel } from "./components/AutoscalingPanel";
import { PolicyOverview } from "./insights/PolicyOverview";
import { NetworkMap } from "./insights/NetworkMap";
import { PermissionMatrix } from "./insights/PermissionMatrix";
import { KbomPanel } from "./insights/KbomPanel";
import { WorkloadIdentityPanel } from "./insights/WorkloadIdentityPanel";
import type { HeatSel } from "./insights/RiskHeatmap";
import type { InsightsNav } from "./insights/model";
import insightStyles from "./insights/insights.module.css";
import { Button, LoadingState, PageHeader, Segmented, Select, Tabs, Toggle } from "@/components/ui";
import { dateLocale, useI18n } from "@/lib/i18n";
import { useQueryParam } from "@/lib/useQueryParam";
import { PANELS, POLICY_GROUPS, groupOfPanel, type Panel } from "./tabs";

/** Panels that render policy insights (risk combinations, network, permissions, KBOM). */
const INSIGHT_TABS = new Set<Panel>(["overview", "network", "permissions", "kbom"]);

const SEVERITIES: PolicySeverity[] = ["high", "medium", "low"];

export default function PoliciesPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <Policies />
    </Suspense>
  );
}

function Policies() {
  const { t, locale } = useI18n();
  const { clusters, clusterId, setClusterId, loading: clustersLoading, error: clustersError } = useAksClusters();
  // The panel lives in the URL (?tab=rbac) so links from other pages open it directly
  const [tab, setTab] = useQueryParam<Panel>("tab", PANELS, "overview");
  const group = groupOfPanel(tab);
  const [heatSel, setHeatSel] = useState<HeatSel | null>(null);
  const [heatManaged, setHeatManaged] = useState(false);
  const [issueId, setIssueId] = useState("");
  const [netSel, setNetSel] = useState<string | null>(null);
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [category, setCategory] = useState<PolicyCategory | "all">("all");
  const [showSystem, setShowSystem] = useState(false);

  // Findings and insights text come from the API in the selected language
  const query = useApiQuery(clusterId ? `k8s-policies:${clusterId}:${locale}` : null, (token) =>
    fetchJsonWithBearer<KubernetesPolicyResponse>(apiUrl("/api/kubernetes/policies", { clusterId, lang: locale }), token),
  );
  const insightsQuery = useApiQuery(clusterId ? `k8s-policy-insights:${clusterId}:${locale}` : null, (token) =>
    fetchJsonWithBearer<PolicyInsightsResponse>(apiUrl("/api/kubernetes/policies/insights", { clusterId, lang: locale }), token),
  );
  // Workload identity map: read only when its tab opens (Azure lookups per identity); scan = other identities too
  const [wiScan, setWiScan] = useState(false);
  const wiQuery = useApiQuery(tab === "workloadIdentity" && clusterId ? `k8s-wi:${clusterId}:${locale}:${wiScan}` : null, (token) =>
    fetchJsonWithBearer<WorkloadIdentityResponse>(apiUrl("/api/kubernetes/policies/workload-identity", { clusterId, lang: locale, ...(wiScan ? { scan: "subscription" } : {}) }), token),
  );
  const wi = wiQuery.data?.clusterId === clusterId ? wiQuery.data : undefined;
  // Only show data that belongs to the selected cluster
  const data = query.data?.clusterId === clusterId ? query.data : undefined;
  const insights = insightsQuery.data?.clusterId === clusterId ? insightsQuery.data : undefined;

  /** Scroll a target into view once the tab switch has rendered. */
  const reveal = (selector: string) =>
    requestAnimationFrame(() => requestAnimationFrame(() => document.querySelector(selector)?.scrollIntoView({ behavior: "smooth", block: "nearest" })));
  const nav: InsightsNav = {
    openHeatRow: (rowId) => {
      if (insights?.rows.find((r) => r.id === rowId)?.managed) setHeatManaged(true);
      setTab("overview");
      setHeatSel({ row: rowId, key: null });
      reveal(`[data-row="${CSS.escape(rowId)}"]`);
    },
    openNet: (nodeId) => {
      setTab("network");
      setNetSel(nodeId);
      reveal(`[aria-label='${t("ins.net.title")}']`);
    },
    openIssue: (id) => {
      setTab("overview");
      setIssueId(id);
      reveal("#policy-combos");
    },
  };
  const toggleAction = (id: string, on: boolean) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const changeCluster = (id: string) => {
    setClusterId(id);
    setHeatSel(null);
    setIssueId("");
    setNetSel(null);
    setChecked(new Set());
    setWiScan(false);
  };

  const findings = useMemo(() => (data?.findings ?? []).filter((f) => showSystem || !f.system), [data, showSystem]);
  const namespaces = useMemo(() => (data?.namespaces ?? []).filter((n) => showSystem || !n.system), [data, showSystem]);

  const openCategory = (c: PolicyCategory | "all") => {
    setCategory(c);
    setTab("findings");
  };

  return (
    <div className={styles.page}>
      <PageHeader
        meta={data ? <span>{t("pol.scope")} · {t("common.updated")} {new Date(data.generatedAt).toLocaleTimeString(dateLocale(locale))}</span> : <span>{t("pol.scope")}</span>}
        actions={
          <>
            <Select
              label={t("common.cluster")}
              value={clusterId}
              onChange={changeCluster}
              placeholder={clustersLoading ? t("common.loading") : t("pol.noCluster")}
              options={clusters.map((c) => ({ value: c.id, label: `${c.name} (${c.location})` }))}
            />
            <Toggle checked={showSystem} onChange={setShowSystem} title={t("pol.systemHint")}>{t("pol.showSystem")}</Toggle>
            <Button onClick={() => { query.reload(); insightsQuery.reload(); if (tab === "workloadIdentity") wiQuery.reload(); }} disabled={!clusterId || query.loading || insightsQuery.loading}>
              {query.loading || insightsQuery.loading ? t("pol.checking") : t("pol.recheck")}
            </Button>
          </>
        }
      />

      {clustersError && <div className={styles.error}>{t("polc.page.clustersFailed")}: {clustersError}</div>}
      {query.error && <div className={styles.error}>{t("polc.page.policiesFailed")}: {query.error}</div>}
      {data && data.capabilities.unavailable.length > 0 && (
        <div className={styles.notice}>
          {t("polc.page.unavailable")}: {data.capabilities.unavailable.join(", ")} — {t("polc.page.incomplete")}
        </div>
      )}

      {!data && query.loading && <div className={styles.loading}>{t("polc.page.loading")}</div>}
      {!clusterId && !clustersLoading && <div className={styles.notice}>{t("polc.page.noCluster")}</div>}

      {data && (
        <>
          <div className={styles.scoreStrip}>
            <button className={`${styles.scoreCard} ${category === "all" && tab === "findings" ? styles.scoreCardActive : ""}`} onClick={() => openCategory("all")}>
              <div className={styles.scoreLabel}>{t("polc.page.overall")}</div>
              <div className={`${styles.scoreValue} ${scoreClass(data.summary.score)}`}>{data.summary.score}</div>
              <div className={styles.scoreCounts}>
                {SEVERITIES.map((s) => (
                  <SeverityBadge key={s} severity={s} count={data.summary.findings[s]} />
                ))}
              </div>
            </button>
            {data.summary.categories.map((c) => (
              <button
                key={c.category}
                className={`${styles.scoreCard} ${category === c.category && tab === "findings" ? styles.scoreCardActive : ""}`}
                onClick={() => openCategory(c.category)}
              >
                <div className={styles.scoreLabel}>{categoryLabel(t, c.category)}</div>
                <div className={`${styles.scoreValue} ${scoreClass(c.score)}`}>{c.score}</div>
                <div className={styles.scoreCounts}>
                  {SEVERITIES.filter((s) => c.findings[s] > 0).map((s) => (
                    <SeverityBadge key={s} severity={s} count={c.findings[s]} />
                  ))}
                  {SEVERITIES.every((s) => c.findings[s] === 0) && <span className={styles.muted}>{t("polc.page.nothingFound")}</span>}
                </div>
              </button>
            ))}
          </div>
          <div className={styles.panelHint}>
            {t("polc.page.scoring", { ns: data.summary.namespaces, wl: data.summary.workloads })}
          </div>

          <Tabs
            label={t("nav.item.clusterSecurity")}
            idPrefix="pol-tab"
            value={group.id}
            onChange={(g) => setTab(POLICY_GROUPS.find((x) => x.id === g)!.panels[0]!)}
            items={POLICY_GROUPS.map((g) => ({ id: g.id, label: t(`pol.group.${g.id}`), count: g.id === "config" ? findings.length : undefined }))}
          />
          {group.panels.length > 1 ? (
            <div className={styles.subTabs}>
              <Segmented
                label={t(`pol.group.${group.id}`)}
                value={tab}
                onChange={setTab}
                items={group.panels.map((p) => ({ id: p, label: p === "findings" ? `${t("pol.panel.findings")} ${findings.length}` : t(`pol.panel.${p}`) }))}
              />
              {group.id === "identity" ? (
                <Link href="/security/identity" className={styles.crossLink}>{t("pol.azureIdentity")} →</Link>
              ) : group.id === "exposure" ? (
                <Link href="/architecture" className={styles.crossLink}>{t("pol.azureExposure")} →</Link>
              ) : null}
            </div>
          ) : null}

          {INSIGHT_TABS.has(tab) && !insights && (
            insightsQuery.error
              ? <div className={styles.error}>{t("polc.page.insightsFailed")}: {insightsQuery.error}</div>
              : <div className={styles.loading}>{t("polc.page.insightsLoading")}</div>
          )}
          {tab === "overview" && insights && (
            <PolicyOverview
              data={insights}
              findings={data.findings}
              heatSel={heatSel}
              onHeatSel={setHeatSel}
              heatManaged={heatManaged}
              onHeatManaged={setHeatManaged}
              issueId={issueId || insights.issues[0]?.id || ""}
              onIssue={setIssueId}
              checked={checked}
              onToggleAction={toggleAction}
              nav={nav}
            />
          )}
          {tab === "network" && insights && (
            <div className={insightStyles.root}><NetworkMap data={insights} sel={netSel} onSelect={setNetSel} nav={nav} /></div>
          )}
          {tab === "permissions" && insights && (
            <div className={insightStyles.root}><PermissionMatrix data={insights} nav={nav} /></div>
          )}
          {tab === "kbom" && insights && (
            <div className={insightStyles.root}><KbomPanel data={insights} /></div>
          )}
          {tab === "findings" && <FindingsPanel findings={findings} category={category} onCategoryChange={setCategory} />}
          {tab === "namespaces" && <NamespaceMatrix namespaces={namespaces} />}
          {tab === "networkPolicy" && (
            <NetworkPolicyPanel
              policies={data.networkPolicies.filter((p) => showSystem || p.source === "cilium-clusterwide" || namespaces.some((n) => n.name === p.namespace))}
              namespaces={namespaces}
              ciliumInstalled={data.capabilities.ciliumInstalled}
            />
          )}
          {tab === "workloadIdentity" && (
            wi ? (
              <div className={insightStyles.root}>
                <WorkloadIdentityPanel data={wi} showSystem={showSystem} onScan={() => setWiScan(true)} scanning={wiQuery.loading} />
              </div>
            ) : wiQuery.error
              ? <div className={styles.error}>{t("wi.failed")}: {wiQuery.error}</div>
              : <div className={styles.loading}>{t("wi.loading")}</div>
          )}
          {tab === "rbac" && <RbacPanel roles={data.rbac.roles} bindings={data.rbac.bindings} showSystem={showSystem} />}
          {tab === "psa" && <PsaPanel namespaces={namespaces} />}
          {tab === "autoscaling" && (
            <AutoscalingPanel
              workloads={data.workloads}
              vpas={data.autoscaling.vpas.filter((v) => showSystem || namespaces.some((n) => n.name === v.namespace))}
              hpas={data.autoscaling.hpas.filter((h) => showSystem || namespaces.some((n) => n.name === h.namespace))}
              pdbs={data.autoscaling.pdbs.filter((p) => showSystem || namespaces.some((n) => n.name === p.namespace))}
              vpaInstalled={data.capabilities.vpaInstalled}
              showSystem={showSystem}
            />
          )}
        </>
      )}
    </div>
  );
}
