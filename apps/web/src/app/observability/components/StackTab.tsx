"use client";

// AKS 모니터링 › 관측 스택 — the customer's collection pipeline (Alloy, alloy-traces, Loki, Tempo, Pyroscope,
// kube-state-metrics, node-exporter, Hubble, ama-metrics) from metrics in the cluster's Azure Monitor workspace
// (API services/observabilityStack.ts). Every value comes with its query; no series = "not measured", never 0.
// Grafana (the customer's Azure Managed Grafana) is linked, never read.

import type { ObservabilityStackResponse, StackCheck, StackComponent, StackState } from "@aud/types";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiQuery } from "@/lib/useApiQuery";
import { dateLocale, useI18n } from "@/lib/i18n";
import { Badge, Button, EmptyState, LoadingState, Notice, Stat, type BadgeTone } from "@/components/ui";
import styles from "../styles.module.css";

const TONE: Record<StackState, BadgeTone> = { ok: "success", degraded: "medium", stale: "medium", down: "high", unknown: "neutral", notDetected: "neutral" };

function grafanaUrl(endpoint: string, uid: string, expr: string): string {
  const panes = { aud: { datasource: uid, queries: [{ refId: "A", datasource: { uid }, expr }], range: { from: "now-1h", to: "now" } } };
  return `${endpoint}/explore?schemaVersion=1&orgId=1&panes=${encodeURIComponent(JSON.stringify(panes))}`;
}

export function StackTab({ clusterId }: { clusterId: string }) {
  const { t, locale } = useI18n();
  const q = useApiQuery(clusterId ? `obs-stack:${clusterId}` : null, (token) =>
    fetchJsonWithBearer<ObservabilityStackResponse>(apiUrl("/api/observability/stack", { clusterId }), token),
  );
  const d = q.data?.clusterId === clusterId ? q.data : null;

  if (q.error) return <Notice tone="danger">{q.error}</Notice>;
  if (!d) return <LoadingState />;
  if (d.metricsState !== "ok") {
    return (
      <Notice tone={d.metricsState === "noWorkspace" ? "info" : "warning"} title={t(`hb.m.state.${d.metricsState}`)}>
        {t(`hb.m.stateHint.${d.metricsState}`)}{d.message ? ` (${d.message})` : ""}
      </Notice>
    );
  }

  const counts = (s: StackState) => d.components.filter((c) => c.state === s).length;
  const down = d.targets.reduce((n, x) => n + x.down, 0);
  const total = d.targets.reduce((n, x) => n + x.total, 0);
  const promUid = d.grafana?.datasources.prometheus;

  return (
    <div className={styles.stack}>
      <div className={styles.stackHead}>
        <Notice tone="info">
          {t("obs.stack.basis", { n: d.windowMinutes, at: new Date(d.generatedAt).toLocaleString(dateLocale(locale)) })}
        </Notice>
        <Button size="sm" onClick={q.reload}>{t("hb.m.refresh")}</Button>
      </div>

      <div className={styles.stackStats}>
        <Stat label={t("obs.stack.components")} value={d.components.length} hint={t("obs.stack.componentsHint", { ok: counts("ok") })} />
        <Stat label={t("obs.stack.problems")} value={counts("degraded") + counts("down") + counts("stale")}
          tone={counts("down") ? "high" : counts("degraded") + counts("stale") ? "medium" : "success"}
          hint={t("obs.stack.problemsHint", { down: counts("down"), degraded: counts("degraded"), stale: counts("stale") })} />
        <Stat label={t("obs.stack.targets")} value={`${total - down} / ${total}`} tone={down ? "medium" : "success"} hint={t("obs.stack.targetsHint", { n: down })} />
        <Stat label={t("obs.stack.grafana")} value={d.grafana ? t("obs.stack.linked") : "—"} hint={d.grafana ? new URL(d.grafana.endpoint).host : t("obs.stack.grafanaHint")} />
      </div>

      <div className={styles.stackGrid}>
        {d.components.map((c) => <ComponentCard key={`${c.kind}|${c.namespace}/${c.name}`} c={c} grafana={d.grafana} promUid={promUid} />)}
      </div>
      {d.components.length === 0 && <EmptyState title={t("obs.stack.none")}>{t("obs.stack.noneHint")}</EmptyState>}

      <h3 className={styles.stackTitle}>{t("obs.stack.targetsTitle")}</h3>
      <table className={styles.stackTable}>
        <thead><tr><th>{t("obs.stack.job")}</th><th>{t("obs.stack.total")}</th><th>{t("obs.stack.down")}</th></tr></thead>
        <tbody>
          {d.targets.map((x) => (
            <tr key={x.job}><td>{x.job}</td><td>{x.total}</td><td className={x.down ? styles.stackBad : undefined}>{x.down}</td></tr>
          ))}
        </tbody>
      </table>
      {d.downTargets.length > 0 && (
        <Notice tone="warning" title={t("obs.stack.downTitle", { n: d.downTargets.length })}>
          <ul className={styles.stackList}>
            {d.downTargets.map((x) => <li key={`${x.job}|${x.namespace}|${x.pod}`}>{x.namespace ?? "—"}/{x.pod ?? "—"} <span className={styles.stackMuted}>({x.job})</span></li>)}
          </ul>
          {t("obs.stack.downHint")}
        </Notice>
      )}
      {!d.grafana && <p className={styles.stackMuted}>{t("obs.stack.grafanaSetup")}</p>}
    </div>
  );
}

function ComponentCard({ c, grafana, promUid }: { c: StackComponent; grafana: ObservabilityStackResponse["grafana"]; promUid: string | undefined }) {
  const { t } = useI18n();
  const version = [...new Set(c.pods.map((p) => p.version).filter(Boolean))].join(", ");
  const dsUid = c.kind === "loki" || c.kind === "tempo" || c.kind === "pyroscope" ? grafana?.datasources[c.kind] : undefined;
  return (
    <article className={styles.stackCard}>
      <header className={styles.stackCardHead}>
        <div className={styles.stackCardName}>
          <strong title={c.name}>{c.name}</strong>
          <span className={styles.stackMuted}>
            {t(`obs.stack.kind.${c.kind}`)}{c.namespace ? ` · ${c.namespace}` : ""}{c.pods.length ? ` · ${t("hb.m.pods", { n: c.pods.length })}` : ""}{version ? ` · ${version}` : ""}
          </span>
        </div>
        <Badge tone={TONE[c.state]}>{t(`obs.stack.state.${c.state}`)}</Badge>
      </header>
      <dl className={styles.stackChecks}>
        {c.checks.map((x) => (
          <div key={x.id} className={styles.stackCheck}>
            <dt>{t(`obs.stack.check.${x.id}`)}</dt>
            <dd className={x.state === "down" ? styles.stackBad : x.state === "degraded" || x.state === "stale" ? styles.stackWarn : undefined}>
              {format(x, t)}
              {grafana && promUid && <a className={styles.stackLink} href={grafanaUrl(grafana.endpoint, promUid, x.promql)} target="_blank" rel="noreferrer" title={x.promql}>↗</a>}
            </dd>
          </div>
        ))}
      </dl>
      {grafana && dsUid && (
        <a className={styles.stackLink} href={`${grafana.endpoint}/explore?schemaVersion=1&orgId=1&panes=${encodeURIComponent(JSON.stringify({ aud: { datasource: dsUid, queries: [{ refId: "A", datasource: { uid: dsUid } }], range: { from: "now-1h", to: "now" } } }))}`} target="_blank" rel="noreferrer">
          {t("obs.stack.openExplore")} ↗
        </a>
      )}
    </article>
  );
}

function format(x: StackCheck, t: (k: string, v?: Record<string, string | number>) => string): string {
  if (x.value === null) return t("hb.m.notMeasured");
  const v = x.value;
  switch (x.unit) {
    case "ratio": return `${(v * 100).toFixed(v > 0 && v < 0.0001 ? 4 : 2)}%`;
    case "seconds": return t("obs.stack.seconds", { n: Math.round(v) });
    case "perSecond": return `${v < 10 ? v.toFixed(2) : Math.round(v).toLocaleString()}/s`;
    case "bytesPerSecond": return v >= 1024 * 1024 ? `${(v / 1024 / 1024).toFixed(1)} MB/s` : `${(v / 1024).toFixed(1)} KB/s`;
    default: return Math.round(v).toLocaleString();
  }
}
