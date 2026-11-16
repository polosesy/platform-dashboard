"use client";

// AKS 모니터링 › 경고 신호 — Microsoft's recommended Kubernetes alert rules (Azure/prometheus-collector, verbatim) run
// against this cluster's workspace (API services/k8sRecommendedAlerts.ts): what would be firing in Azure Monitor now,
// which rules cannot fire here and why, and which are clear. Nothing is judged by us — the rule, its "for" and its
// severity are the template's; each card shows Microsoft's expression and the one run here.

import { useState } from "react";
import type { RecommendedAlertRule, RecommendedAlertsResponse } from "@aud/types";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiQuery } from "@/lib/useApiQuery";
import { dateLocale, useI18n } from "@/lib/i18n";
import { Chip, CodeBlock, ErrorNotice, LinkButton, LoadingState, Notice, Panel, type ChipLevel } from "@/components/ui";
import { answersAt, atParam, type TimeRange } from "@/lib/timeRange";
import { useRangeRefresh } from "@/lib/useTimeRange";
import { SEVERITY_NAME, objectText, orderRules, summarize } from "@/lib/recommendedAlertsView";
import styles from "../styles.module.css";

/** Placeholders only — the dashboard reads; deploying is the operator's (Azure CLI, Azure Monitor Contributor on the RG) */
const DEPLOY_COMMAND = [
  "az deployment group create \\",
  "  --resource-group <rule-group-resource-group> \\",
  "  --template-file aks-recommended-alerts-fixed.json \\",
  "  --parameters clusterName=<aks-name> clusterResourceId=<aks-resource-id> \\",
  "               azureMonitorWorkspaceResourceId=<monitor-workspace-resource-id> actionGroupResourceId=<action-group-resource-id>",
].join("\n");

const STATE_CHIP: Record<RecommendedAlertRule["state"], ChipLevel> = { firing: "warn", clear: "ok", noData: "unknown", ambiguous: "unknown", failed: "unknown" };

export function RecommendedAlertsTab({ clusterId, range, nonce, report }: { clusterId: string; range: TimeRange; nonce: number; report?: (id: string, loading: boolean) => void }) {
  const { t, locale } = useI18n();
  const atQ = atParam(range);
  const q = useApiQuery(clusterId ? `obs-msalerts:${clusterId}:${atQ ?? "now"}` : null, (token) =>
    fetchJsonWithBearer<RecommendedAlertsResponse>(apiUrl("/api/observability/recommended-alerts", { clusterId, at: atQ }), token),
  );
  useRangeRefresh("msalerts", nonce, q.loading, q.reload, report);
  const [showClear, setShowClear] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const d = q.data?.clusterId === clusterId && answersAt(q.data.at, atQ) ? q.data : null;

  if (q.error) return <ErrorNotice error={q.error} />;
  if (!d) return <LoadingState label={t("ob.ra.loading")} />;
  if (d.metricsState !== "ok") {
    return (
      <Notice tone={d.metricsState === "noWorkspace" ? "info" : "warning"} title={t(`hb.m.state.${d.metricsState}`)}>
        {t(`hb.m.stateHint.${d.metricsState}`)}{d.message ? ` (${d.message})` : ""}
      </Notice>
    );
  }
  const s = summarize(d.rules);
  const rules = orderRules(d.rules);
  // A clear rule whose shipped job matcher matches nothing here stays in view — "clear" only because it was scoped
  const shown = rules.filter((r) => r.state !== "clear" || r.jobMismatch?.length);
  const clear = rules.filter((r) => r.state === "clear" && !r.jobMismatch?.length);
  const mismatched = rules.filter((r) => r.jobMismatch?.length).length;
  const tpl = d.template;

  const card = (r: RecommendedAlertRule) => (
    <li key={r.alert} className={styles.raRule} data-state={r.state}>
      <div className={styles.raHead}>
        <Chip level={STATE_CHIP[r.state]}>{t(`ob.ra.state.${r.state}`)}{r.state === "firing" ? ` ${r.firing.length}` : ""}</Chip>
        <strong className={styles.raName}>{r.alert}</strong>
        <span className={styles.sloCellSub}>{t(`ob.ra.group.${r.group}`)} · {SEVERITY_NAME[r.severity] ?? `Sev${r.severity}`} · {t("ob.ra.for", { m: r.forMinutes })}</span>
      </div>
      <p className={styles.sloText}>{t(`ob.ra.rule.${r.alert}`)}</p>
      {r.state === "firing" && (
        <ul className={styles.raObjects}>
          {r.firing.slice(0, 20).map((f, i) => <li key={i}><span className={styles.mono}>{objectText(f.object) || t("ob.ra.cluster")}</span> <span className={styles.sloCellSub}>= {f.value}</span></li>)}
          {r.firing.length > 20 ? <li className={styles.sloCellSub}>{t("ob.ra.more", { n: r.firing.length - 20 })}</li> : null}
        </ul>
      )}
      {r.state === "noData" && <p className={styles.sloCellSub}>{t("ob.ra.noDataWhy", { m: (r.missing ?? []).join(", ") })}</p>}
      {r.state === "ambiguous" && <p className={styles.sloCellSub}>{t("ob.ra.ambiguousWhy", { m: (r.missing ?? []).join(", ") })}</p>}
      {r.state === "failed" && <p className={styles.sloCellSub}>{t(r.reason === "tooCostly" ? "ob.ra.tooCostlyWhy" : r.reason === "timeout" || r.reason === "throttled" ? "ob.ra.timeoutWhy" : "ob.ra.failedWhy")}</p>}
      {r.jobMismatch?.length ? (
        <p className={styles.sloCellSub}>▲ {t("ob.ra.jobMismatch", { m: r.jobMismatch.map((x) => `${x.metric} job="${x.expected}" → ${x.actual.join(", ")}`).join(" · ") })}</p>
      ) : null}
      {r.fix ? (
        <p className={styles.sloCellSub}>
          <Chip level={r.fix.state === "firing" ? "warn" : r.fix.state === "clear" ? "ok" : "unknown"}>{t("ob.ra.fix.state", { s: t(`ob.ra.state.${r.fix.state}`) })}</Chip>{" "}
          {t(`ob.ra.fix.${r.fix.why}`)}
        </p>
      ) : null}
      <LinkButton ariaExpanded={open === r.alert} onClick={() => setOpen(open === r.alert ? null : r.alert)}>{t(open === r.alert ? "ob.ra.hideExpr" : "ob.ra.showExpr")}</LinkButton>
      {open === r.alert && (
        <>
          <CodeBlock label={t("ob.ra.original")} code={r.original} copyLabel={t("ob.slo.copy")} copiedLabel={t("ob.slo.copied")} />
          {r.expression ? <CodeBlock label={t("ob.ra.runHere")} code={r.expression} copyLabel={t("ob.slo.copy")} copiedLabel={t("ob.slo.copied")} /> : null}
          {r.fix ? <CodeBlock label={t("ob.ra.fix.expr")} code={r.fix.expression} copyLabel={t("ob.slo.copy")} copiedLabel={t("ob.slo.copied")} /> : null}
        </>
      )}
    </li>
  );

  return (
    <Panel title={t("ob.ra.title")} sub={t("ob.ra.sub")}
      actions={<>
        {s.firing ? <Chip level="warn">{t("ob.ra.chip.firing", { n: s.firing, o: s.objects })}</Chip> : <Chip level="ok">{t("ob.ra.chip.none")}</Chip>}
        {s.noData + s.failed + s.ambiguous ? <Chip level="unknown">{t("ob.ra.chip.cannot", { n: s.noData + s.failed + s.ambiguous })}</Chip> : null}
        {mismatched ? <Chip level="warn">{t("ob.ra.chip.jobMismatch", { n: mismatched })}</Chip> : null}
      </>}
      footer={<span>{t("ob.ra.foot", { at: new Date(d.at ?? d.generatedAt).toLocaleString(dateLocale(locale)), src: d.source })}</span>}>
      <p className={styles.sloText}>{t("ob.ra.summary", { total: s.total, ev: s.evaluated, f: s.firing, c: s.clear, nd: s.noData, fl: s.failed + s.ambiguous })}</p>
      <ul className={styles.raList}>{shown.map(card)}</ul>
      {clear.length ? (
        <p className={styles.sloCellSub}>
          <LinkButton ariaExpanded={showClear} onClick={() => setShowClear(!showClear)}>{t(showClear ? "ob.ra.hideClear" : "ob.ra.showClear", { n: clear.length })}</LinkButton>
        </p>
      ) : null}
      {showClear ? <ul className={styles.raList}>{clear.map(card)}</ul> : null}
      {tpl ? (
        <section className={styles.raTemplate}>
          <h4 className={styles.depHead}>{t("ob.ra.tpl.title")}</h4>
          <p className={styles.sloText}>{t("ob.ra.tpl.summary", { i: tpl.included.length, f: tpl.fixed.length, e: tpl.excluded.length })}</p>
          {tpl.fixed.length ? <p className={styles.sloCellSub}>{t("ob.ra.tpl.fixed", { a: tpl.fixed.join(", ") })}</p> : null}
          {tpl.excluded.length ? <p className={styles.sloCellSub}>{t("ob.ra.tpl.excluded", { a: tpl.excluded.map((x) => `${x.alert}${x.missing?.length ? ` (${x.missing.join(", ")})` : ""}`).join(", ") })}</p> : null}
          <p className={styles.sloCellSub}>
            <a href={`data:application/json;charset=utf-8,${encodeURIComponent(tpl.json)}`} download="aks-recommended-alerts-fixed.json">{t("ob.ra.tpl.download")}</a>
          </p>
          <CodeBlock label={t("ob.ra.tpl.deploy")} code={DEPLOY_COMMAND} copyLabel={t("ob.slo.copy")} copiedLabel={t("ob.slo.copied")} />
          <CodeBlock label="aks-recommended-alerts-fixed.json" code={tpl.json} maxHeight={360} copyLabel={t("ob.slo.copy")} copiedLabel={t("ob.slo.copied")} />
          <p className={styles.sloCellSub}>{t("ob.ra.tpl.note")}</p>
        </section>
      ) : null}
    </Panel>
  );
}
