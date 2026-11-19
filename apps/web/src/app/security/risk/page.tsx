"use client";

import { useId, useMemo, useState } from "react";
import Link from "next/link";
import type { ArchitectureGraph, PolicyInsightsResponse } from "@aud/types";
import { Badge, EmptyState, ErrorNotice, LoadingState, Notice, Panel, Select, Stat } from "@/components/ui";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { AzureRiskPanel } from "./AzureRiskPanel";
import { AzurePathsPanel } from "./AzurePathsPanel";
import { joinRisk, type RiskRow } from "@/lib/riskJoin";
import { IssueQueue } from "./IssueQueue";
import { useIssueSources } from "../useIssueSources";
import { useApiQuery } from "@/lib/useApiQuery";
import { EvidenceChip } from "../../policies/insights/Inspector";
import { useSecurity } from "../SecurityContext";
import { PostureNotices, SecurityHeader, SeverityBadge, useLabel } from "../components";
import s from "./risk.module.css";

/** 통합 위험 — cluster risk combinations next to the Defender findings and alerts of Azure resources
 *  that are linked to the cluster by evidence (ID match, observed egress, LB backend). */
export default function SecurityRiskPage() {
  const { t } = useI18n();
  const label = useLabel();
  const { subscriptionId, posture, loading: postureLoading, ready } = useSecurity();
  const sub = subscriptionId || undefined;

  const graphQ = useApiQuery(ready ? `arch:${subscriptionId}` : null, (token) =>
    fetchJsonWithBearer<ArchitectureGraph>(apiUrl("/api/architecture/graph", { subscriptionId: sub }), token),
  );
  const src = useIssueSources();
  const { clusters, clusterId, setClusterId, clustersLoading, clustersError, clustersMock, insightsQ, insights, cluster, azQ, azureRisk, statesQ, queue, sources, saveState } = src;

  // Join only responses that belong to the current subscription and cluster — stale data from the
  // previous selection is never mixed in (useApiQuery keeps old data while a new key loads).
  const graph = graphQ.loading ? undefined : graphQ.data;
  const freshPosture = postureLoading ? undefined : posture;

  const result = useMemo(
    () => (freshPosture && graph && insights && cluster ? joinRisk({ posture: freshPosture, graph, insights, clusterArmId: cluster.id }) : null),
    [freshPosture, graph, insights, cluster],
  );
  const sample = src.sample || graph?.source === "mock";
  const loading = !ready || postureLoading || graphQ.loading || clustersLoading || (!!clusterId && !clustersMock && insightsQ.loading);

  let body: React.ReactNode;
  // The page already says "sample data" once (PostureNotices) — a second banner here would be the same news twice
  if (sample) body = <EmptyState title={t("risk.sampleTitle")}>{t("risk.sample")}</EmptyState>;
  else if (loading) body = <LoadingState />;
  else if (graphQ.error || clustersError) body = <ErrorNotice error={graphQ.error ?? clustersError} />;
  else if (!clusters.length) body = <EmptyState title={t("risk.noAks")}><Link href="/security/findings" className={s.link}>{t("nav.item.securityFindings")} →</Link></EmptyState>;
  else if (insightsQ.error || !insights) body = (
    <>
      <Notice tone="danger" title={t("risk.insightsFailed")}>{t("risk.insightsFailedHint")}</Notice>
      <ErrorNotice error={insightsQ.error} />
    </>
  );
  else if (result) body = <RiskBody result={result} clusterName={cluster?.name ?? ""} insights={insights} label={label} />;

  return (
    <div className={s.page}>
      <SecurityHeader />
      <PostureNotices />
      {clusters.length > 1 ? (
        <div className={s.toolbar}>
          <Select
            label={t("risk.cluster")}
            value={clusterId}
            onChange={setClusterId}
            options={clusters.map((c) => ({ value: c.id, label: `${c.name} (${c.resourceGroup})` }))}
          />
        </div>
      ) : null}
      {!sample && ready && clusters.length > 0 ? (
        <IssueQueue queue={queue} sources={sources} durable={statesQ.data?.durable ?? true} canWrite={statesQ.data?.canWrite ?? false}
          signedIn={statesQ.data?.signedIn ?? false} onSave={saveState} teams={[...new Set((statesQ.data?.owners ?? []).map((o) => o.team))]} />
      ) : null}
      {!sample && ready ? <AzurePathsPanel data={azureRisk} /> : null}
      {!sample && ready ? <AzureRiskPanel data={azureRisk} error={azQ.error} loading={azQ.loading} onReload={azQ.reload} /> : null}
      {body}
    </div>
  );
}

type Label = (prefix: string, raw: string) => string;

function RiskBody({ result, clusterName, insights, label }: { result: ReturnType<typeof joinRisk>; clusterName: string; insights: PolicyInsightsResponse; label: Label }) {
  const { t } = useI18n();
  const { stats, coverage, unlinked, gaps } = result;
  const certain = result.rows.filter((r) => !r.uncertain);
  const uncertain = result.rows.filter((r) => r.uncertain);
  const recGap = gaps.includes("recommendations");
  const alertGap = gaps.includes("alerts");
  const cov = insights.network.coverage;

  return (
    <>
      {gaps.filter((g) => g !== "recommendations" && g !== "alerts").map((g) => (
        // Not collected by design (info, how to get it) vs a read that failed (warning, what failed)
        <Notice key={g} tone={g === "hubbleNotCollected" ? "info" : "warning"} title={t(`risk.gap.${g}`)}>
          {t(`risk.gapHint.${g}`)}
          {g === "insightsPartial" && result.gapDetails?.length ? (
            <ul className={s.gapList}>{result.gapDetails.map((d) => <li key={d}>{d}</li>)}</ul>
          ) : null}
        </Notice>
      ))}

      <Panel title={t("risk.scope", { name: clusterName })}>
        <div className={s.stats}>
          <Stat label={t("risk.stat.issues")} value={stats.issues} hint={t("risk.stat.issuesHint")} tone={stats.issues ? "high" : undefined} />
          <Stat label={t("risk.stat.assets")} value={stats.linkedAssets} hint={t("risk.stat.assetsHint")} />
          <Stat
            label={t("risk.stat.highRecs")}
            value={recGap ? t("risk.unknown") : t("risk.atLeast", { n: stats.highRecs })}
            hint={t("risk.stat.highRecsHint")}
            tone={stats.highRecs ? "high" : undefined}
          />
          <Stat
            label={t("risk.stat.alerts")}
            value={alertGap ? t("risk.unknown") : stats.linkedAlerts}
            hint={t("risk.stat.alertsHint")}
            tone={stats.linkedAlerts ? "medium" : undefined}
          />
        </div>
      </Panel>

      <Notice tone="info" title={t("risk.coverageTitle")}>
        <ul className={s.notes}>
          <li>{t("risk.coverageRecs", { arm: coverage.armSamples, matched: coverage.matchedSamples, amb: coverage.ambiguous, truncated: coverage.truncatedRecs, nonArm: coverage.nonArmSamples })}</li>
          <li>
            {t("risk.coverageEgress")}
            {cov ? ` ${t("risk.coverageNodes", { n: cov.nodesObserved, m: cov.nodesTotal, min: cov.commonWindowMinutes })}` : ""}
          </li>
          <li>{t("risk.coverageAlerts")}</li>
        </ul>
      </Notice>

      <Panel title={t("risk.tableTitle")} sub={t("risk.tableSub")} flush>
        {certain.length ? (
          <RiskTable rows={certain} recGap={recGap} alertGap={alertGap} label={label} />
        ) : (
          <div className={s.empty}>{gaps.length ? t("risk.noLinksGaps") : t("risk.noLinks")}</div>
        )}
        {uncertain.length ? (
          <>
            <h3 className={s.subHead}>{t("risk.uncertainHead", { n: uncertain.length })}</h3>
            <p className={s.subNote}>{t("risk.uncertainHint")}</p>
            <RiskTable rows={uncertain} recGap={recGap} alertGap={alertGap} label={label} muted />
          </>
        ) : null}
      </Panel>

      <Panel title={t("risk.unlinkedTitle")} sub={t("risk.unlinkedSub")}>
        <ul className={s.unlinked}>
          <li><Link href="/security/findings" className={s.link}>{recGap ? t("risk.unknown") : t("risk.unlinked.highRecs", { n: unlinked.highRecs })} → {t("nav.item.securityFindings")}</Link></li>
          <li><Link href="/policies?tab=overview" className={s.link}>{t("risk.unlinked.issues", { n: unlinked.issues })} → {t("nav.item.clusterSecurity")}</Link></li>
          <li><Link href="/security/threats" className={s.link}>{alertGap ? t("risk.unknown") : t("risk.unlinked.alerts", { n: unlinked.alerts })} → {t("nav.item.securityThreats")}</Link></li>
          <li><Link href="/policies?tab=network" className={s.link}>{t("risk.unlinked.egress", { n: unlinked.egressTargets })} → {t("nav.item.clusterSecurity")}</Link></li>
        </ul>
      </Panel>
    </>
  );
}

function RiskTable({ rows, recGap, alertGap, label, muted = false }: { rows: RiskRow[]; recGap: boolean; alertGap: boolean; label: Label; muted?: boolean }) {
  const { t } = useI18n();
  const [open, setOpen] = useState<string | null>(null);
  const base = useId();
  const kindName = (k: string) => { const v = t(`arch.kind.${k}`); return v === `arch.kind.${k}` ? k : v; };
  const sev = (r: RiskRow, x: "High" | "Medium" | "Low") => r.recs.filter((y) => y.severity === x).length;

  return (
    <div className={s.tableWrap}>
      <div className={s.head} aria-hidden="true">
        <span>{t("risk.col.asset")}</span>
        <span>{t("risk.col.relation")}</span>
        <span>{t("risk.col.recs")}</span>
        <span>{t("risk.col.alerts")}</span>
        <span>{t("risk.col.issues")}</span>
        <span>{t("risk.col.internet")}</span>
      </div>
      <ul className={s.rows} data-muted={muted || undefined}>
        {rows.map((r) => {
          const expanded = open === r.key;
          const panelId = `${base}-${r.key.replace(/[^a-z0-9]/gi, "")}`;
          return (
            <li key={r.key} className={s.row} data-open={expanded || undefined}>
              <button type="button" className={s.rowHead} aria-expanded={expanded} aria-controls={panelId} onClick={() => setOpen(expanded ? null : r.key)}>
                <span className={s.asset}>
                  <span className={s.name}>{r.name}</span>
                  <span className={s.meta}>{kindName(r.kind)} · {r.resourceGroup}</span>
                </span>
                <span className={s.cell} data-label={t("risk.col.relation")}>
                  {r.links.map((l) => <EvidenceChip key={l.rel} ev={l.ev} text={`${t(`risk.rel.${l.rel}`)} · ${t(`risk.ev.${l.ev}`)}`} />)}
                </span>
                <span className={s.cell} data-label={t("risk.col.recs")}>
                  {recGap ? t("risk.unknown") : r.recs.length ? (
                    <>
                      {sev(r, "High") ? <Badge tone={muted ? "neutral" : "high"}>H {sev(r, "High")}</Badge> : null}
                      {sev(r, "Medium") ? <Badge tone={muted ? "neutral" : "medium"}>M {sev(r, "Medium")}</Badge> : null}
                      {sev(r, "Low") ? <Badge tone={muted ? "neutral" : "low"}>L {sev(r, "Low")}</Badge> : null}
                    </>
                  ) : <span className={s.dim} title={t("risk.noLinkedFindingHint")}>—</span>}
                </span>
                <span className={s.cell} data-label={t("risk.col.alerts")}>{alertGap ? t("risk.unknown") : r.alerts.length}</span>
                <span className={s.cell} data-label={t("risk.col.issues")}>{r.issues.length}</span>
                <span className={s.cell} data-label={t("risk.col.internet")}>
                  {r.internet ? <EvidenceChip ev={r.internet} text={t(`risk.internet.${r.internet}`)} /> : <span className={s.dim}>—</span>}
                </span>
              </button>
              {expanded ? (
                <div id={panelId} className={s.rowBody}>
                  {r.recs.length ? (
                    <section>
                      <h4 className={s.detailTitle}>{t("risk.detail.recs", { n: r.recs.length })}</h4>
                      <ul className={s.list}>
                        {r.recs.map((x) => (
                          <li key={x.key}>
                            <SeverityBadge severity={x.severity} />
                            <Link href={`/security/findings?domain=${x.domain}`} className={s.link}>{x.title}</Link>
                            <span className={s.dim}>{label("sec.domain", x.domain)}</span>
                          </li>
                        ))}
                      </ul>
                    </section>
                  ) : null}
                  {r.alerts.length ? (
                    <section>
                      <h4 className={s.detailTitle}>{t("risk.detail.alerts", { n: r.alerts.length })}</h4>
                      <ul className={s.list}>
                        {r.alerts.map((a) => (
                          <li key={a.id}>
                            <SeverityBadge severity={a.severity} />
                            <Link href="/security/threats" className={s.link}>{a.title}</Link>
                            {a.intent ? <span className={s.dim}>{label("sec.intent", a.intent)}</span> : null}
                          </li>
                        ))}
                      </ul>
                    </section>
                  ) : null}
                  {r.issues.length ? (
                    <section>
                      <h4 className={s.detailTitle}>{t("risk.detail.issues", { n: r.issues.length })}</h4>
                      <ul className={s.list}>
                        {r.issues.map((i) => (
                          <li key={i.id}>
                            <Badge tone={i.sev === "crit" ? "high" : "medium"}>{t(`risk.issueSev.${i.sev}`)}</Badge>
                            <Link href="/policies?tab=overview" className={s.link}>{i.title}</Link>
                          </li>
                        ))}
                      </ul>
                    </section>
                  ) : null}
                  <p className={s.why}>{r.links.map((l) => t(`risk.why.${l.rel}.${l.ev}`)).join(" ")}</p>
                  <Link href="/architecture" className={s.link}>{t("risk.openArch")} →</Link>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
