"use client";

// One workload from the heatmap: every signal with its worst pod, the pods, Warning kube events (Kubernetes API) and
// the log stream from the cluster's Loki (ERROR first, operators only — the pod-log gate). Loki behind the
// customer's monitor-namespace policy shows why and the rule to add (copy only).

import { useState } from "react";
import type { HeatMetric, HeatWorkload, KubeEventsResponse, WorkloadHeatmapResponse, WorkloadLogsResponse } from "@aud/types";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiQuery } from "@/lib/useApiQuery";
import { dateLocale, useI18n } from "@/lib/i18n";
import { Badge, Button, EmptyState, LoadingState, Notice, Segmented } from "@/components/ui";
import { GLYPH, HEAT_METRICS, formatCell } from "@/lib/workloadHeatView";
import { LEVEL_CLASS } from "./WorkloadHeatmap";
import styles from "../styles.module.css";

const LOKI_RULE = `# monitor namespace — allow the dashboard to read Loki (applied by the cluster owner through GitOps)
- fromEndpoints:
    - matchLabels: { "k8s:io.kubernetes.pod.namespace": aud-dashboard }
  toPorts: [{ ports: [{ port: "3100", protocol: TCP }] }]`;

function explore(endpoint: string, uid: string, query: Record<string, unknown>): string {
  const panes = { aud: { datasource: uid, queries: [{ refId: "A", datasource: { uid }, ...query }], range: { from: "now-1h", to: "now" } } };
  return `${endpoint}/explore?schemaVersion=1&orgId=1&panes=${encodeURIComponent(JSON.stringify(panes))}`;
}

export function WorkloadHeatPanel({ clusterId, w, grafana, onClose }: { clusterId: string; w: HeatWorkload; grafana: WorkloadHeatmapResponse["grafana"]; onClose: () => void }) {
  const { t, locale } = useI18n();
  const [errorsOnly, setErrorsOnly] = useState(true);
  const when = (iso: string) => new Date(iso).toLocaleString(dateLocale(locale));
  const events = useApiQuery(`events:${clusterId}:${w.namespace}:${w.workload}`, (token) =>
    fetchJsonWithBearer<KubeEventsResponse>(apiUrl("/api/observability/events", { clusterId, namespace: w.namespace, workload: w.workload }), token),
  );
  const pods = w.pods.map((p) => p.pod).slice(0, 20).join(",");
  const logs = useApiQuery(`wlogs:${clusterId}:${w.namespace}:${w.workload}:${errorsOnly}`, (token) =>
    fetchJsonWithBearer<WorkloadLogsResponse>(apiUrl("/api/observability/workload-logs", {
      clusterId, namespace: w.namespace, workload: w.workload, pods, errorsOnly: String(errorsOnly), minutes: "60",
    }), token),
  );
  const lokiUid = grafana?.datasources.loki;
  const tempoUid = grafana?.datasources.tempo;

  return (
    <aside className={styles.hmPanel} aria-label={`${w.namespace}/${w.workload}`}>
      <header className={styles.hmPanelHead}>
        <div>
          <strong>{w.workload}</strong>
          <div className={styles.stackMuted}>{w.namespace} · {w.kind ?? t("hb.m.kindUnknown")}{w.basis === "pattern" ? ` · ${t("hb.m.byPattern")}` : ""}</div>
        </div>
        <Button size="sm" onClick={onClose}>{t("ob.hm.close")}</Button>
      </header>

      <dl className={styles.hmCells}>
        {HEAT_METRICS.map((m) => {
          const c = w.cells[m];
          return (
            <div key={m} className={styles.hmCell}>
              <dt>{t(`ob.hm.metric.${m}`)}</dt>
              <dd className={LEVEL_CLASS[c.level]}>
                {GLYPH[c.level] ? `${GLYPH[c.level]} ` : ""}{formatCell(m, w, t)}
                {c.worstPod ? <span className={styles.stackMuted}> · {c.pool ? `${c.pool} · ` : ""}{c.worstPod}</span> : null}
                {c.oom ? <Badge tone="high">OOMKilled</Badge> : null}
                {c.code ? <span className={styles.stackMuted}> ({t(`ob.hm.code.${c.code}`)})</span> : null}
              </dd>
            </div>
          );
        })}
      </dl>

      <h4 className={styles.stackTitle}>{t("ob.hm.pods", { n: w.pods.length })}</h4>
      <table className={styles.stackTable}>
        <thead><tr><th>{t("ob.hm.pod")}</th><th>{t("ob.hm.metric.ready")}</th><th>{t("ob.hm.metric.memory")}</th><th>{t("ob.hm.metric.cpu")}</th><th>{t("ob.hm.metric.restarts")}</th></tr></thead>
        <tbody>
          {w.pods.map((p) => (
            <tr key={p.pod}>
              <td title={p.pod}>{p.pod}{p.oom ? " · OOM" : ""}</td>
              <td>{p.ready === null ? "—" : p.ready ? "✓" : "✕"}</td>
              <td>{p.memory === null ? "—" : `${Math.round(p.memory * 100)}%`}</td>
              <td>{p.cpu === null ? "—" : `${Math.round(p.cpu * 100)}%`}</td>
              <td>{p.restarts ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h4 className={styles.stackTitle}>{t("ob.hm.events")}</h4>
      {events.error ? <Notice tone="warning">{events.error}</Notice> : !events.data ? <LoadingState /> : events.data.events.length === 0 ? (
        <p className={styles.stackMuted}>{t("ob.hm.noEvents")}</p>
      ) : (
        <ul className={styles.hmEvents}>
          {events.data.events.map((e, i) => (
            <li key={`${e.time}|${e.name}|${e.reason}|${i}`}>
              <span className={styles.stackMuted}>{when(e.time)}</span> <strong>{e.reason}</strong> {e.kind}/{e.name}{e.count > 1 ? ` ×${e.count}` : ""}
              {e.message ? <div className={styles.hmMsg}>{e.message}</div> : null}
            </li>
          ))}
        </ul>
      )}
      <p className={styles.stackMuted}>{t(events.data?.messages ? "ob.hm.eventsHint" : "ob.hm.eventsHintViewer")}</p>

      <h4 className={styles.stackTitle}>{t("ob.hm.logs")}</h4>
      <Segmented label={t("ob.hm.logs")} value={errorsOnly ? "e" : "a"} onChange={(v) => setErrorsOnly(v === "e")}
        items={[{ id: "e", label: t("ob.hm.logsErrors") }, { id: "a", label: t("ob.hm.logsAll") }]} />
      {logs.error ? <Notice tone="warning">{logs.error}</Notice> : !logs.data ? <LoadingState /> : logs.data.state !== "ok" ? (
        <Notice tone={logs.data.state === "notConfigured" ? "info" : "warning"} title={t(`ob.hm.loki.${logs.data.state}`)}>
          {t(`ob.hm.lokiHint.${logs.data.state}`)}
          {logs.data.state === "unreachable" ? <pre className={styles.hmPre}>{LOKI_RULE}</pre> : null}
        </Notice>
      ) : (
        <>
          {logs.data.exceptions.length > 0 && (
            <p>{logs.data.exceptions.map((x) => <span key={x.cls} className={styles.hmChip}>{x.cls} · {x.count} </span>)}</p>
          )}
          {logs.data.lines.length === 0 ? <EmptyState title={t(errorsOnly ? "ob.hm.noErrors" : "ob.hm.noLines")} /> : (
            <ol className={styles.hmLog}>
              {logs.data.lines.map((l, i) => (
                <li key={`${l.time}|${i}`} className={l.level === "error" ? styles.hmLogError : l.level === "warn" ? styles.hmLogWarn : undefined}>
                  <span className={styles.stackMuted}>{when(l.time)}{l.pod ? ` · ${l.pod}` : ""}</span>
                  {l.traceId && grafana && tempoUid ? (
                    <a className={styles.stackLink} href={explore(grafana.endpoint, tempoUid, { queryType: "traceql", query: l.traceId })} target="_blank" rel="noreferrer">trace ↗</a>
                  ) : null}
                  <pre className={styles.hmPre}>{l.text}</pre>
                </li>
              ))}
            </ol>
          )}
          <p className={styles.stackMuted}>
            {t("ob.hm.logsBasis", { n: logs.data.lines.length, r: logs.data.redactions })}{logs.data.truncated ? ` ${t("ob.hm.truncated")}` : ""}
          </p>
        </>
      )}
      {grafana && lokiUid && (
        <a className={styles.stackLink} target="_blank" rel="noreferrer"
          href={explore(grafana.endpoint, lokiUid, { expr: `{namespace="${w.namespace}", pod=~"${w.workload}-.*"}` })}>
          {t("ob.hm.openLogs")} ↗
        </a>
      )}
    </aside>
  );
}
