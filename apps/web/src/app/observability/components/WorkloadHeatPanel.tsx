"use client";

// One workload from the heatmap: every signal with its worst pod (the live card grammar — glyph + status colour), the
// pods (ratio, or bytes / cores when there is no limit / request), Warning kube events (Kubernetes API) and the log
// stream from the cluster's Loki (WorkloadLogStream — ERROR first, operators only, the pod-log gate). Loki behind the
// customer's monitor-namespace policy shows why and the rule to add (copy only). A workload with nothing to run (a
// DaemonSet no node matches, a Deployment at 0) says so once and asks nothing else.

import { useState } from "react";
import type { HeatWorkload, KubeEventsResponse, WorkloadHeatmapResponse, WorkloadLogsResponse } from "@aud/types";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiQuery } from "@/lib/useApiQuery";
import { dateLocale, useI18n } from "@/lib/i18n";
import { Badge, Button, LoadingState, Notice } from "@/components/ui";
import { GLYPH, HEAT_METRICS, formatBytes, formatCell, formatCores } from "@/lib/workloadHeatView";
import { WorkloadLogStream } from "./WorkloadLogStream";
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
  // Nothing runs (a DaemonSet no node matches / scaled to 0): one sentence instead of nine "no pods" rows
  const idle = w.pods.length === 0 && (w.cells.ready.code === "noNodes" || w.cells.ready.code === "scaledToZero") ? w.cells.ready.code : null;
  const events = useApiQuery(idle ? null : `events:${clusterId}:${w.namespace}:${w.workload}`, (token) =>
    fetchJsonWithBearer<KubeEventsResponse>(apiUrl("/api/observability/events", { clusterId, namespace: w.namespace, workload: w.workload }), token),
  );
  const pods = w.pods.map((p) => p.pod).slice(0, 20).join(",");
  const logs = useApiQuery(idle ? null : `wlogs:${clusterId}:${w.namespace}:${w.workload}:${errorsOnly}`, (token) =>
    fetchJsonWithBearer<WorkloadLogsResponse>(apiUrl("/api/observability/workload-logs", {
      clusterId, namespace: w.namespace, workload: w.workload, pods, errorsOnly: String(errorsOnly), minutes: "60",
    }), token),
  );
  const lokiUid = grafana?.datasources.loki;
  const tempoUid = grafana?.datasources.tempo;
  const noBaseline = w.pods.some((p) => (p.memory === null && p.memBytes != null) || (p.cpu === null && p.cpuCores != null));

  return (
    <aside className={styles.hmPanel} aria-label={`${w.namespace}/${w.workload}`} data-level={w.worst}>
      <header className={styles.hmPanelHead}>
        <div className={styles.hmPanelTitle}>
          <strong>{w.workload}</strong>
          <div className={styles.stackMuted}>
            <span className={styles.hmGlyph} aria-hidden="true">{GLYPH[w.worst]}</span> {t(`ob.hm.level.${w.worst}`)}
            {" · "}{w.namespace} · {w.kind ?? t("hb.m.kindUnknown")}{w.basis === "pattern" ? ` · ${t("hb.m.byPattern")}` : ""}
          </div>
        </div>
        <Button size="sm" onClick={onClose}>{t("ob.hm.close")}</Button>
      </header>

      {idle ? <Notice tone="info" title={t(`ob.hm.code.${idle}`)}>{t(`ob.hm.idleHint.${idle}`)}</Notice> : (
        <>
          <dl className={styles.hmCells}>
            {HEAT_METRICS.map((m) => {
              const c = w.cells[m];
              const abs = c.value !== null && c.abs != null ? (m === "memory" ? formatBytes(c.abs) : m === "cpu" ? formatCores(c.abs) : null) : null;
              return (
                <div key={m} className={styles.hmCell}>
                  <dt>{t(`ob.hm.metric.${m}`)}</dt>
                  <dd data-level={c.level}>
                    <span className={styles.hmGlyph} aria-hidden="true">{GLYPH[c.level]}</span>
                    <span className={styles.hmCellValue}>{formatCell(m, w, t)}{abs ? ` · ${abs}` : ""}</span>
                    {c.oom ? <Badge tone="high">OOMKilled</Badge> : null}
                    {c.code === "noLimit" || c.code === "noRequest" ? <span className={styles.hmCellNote}>{t(`ob.hm.code.${c.code}`)}</span> : null}
                    {c.worstPod ? <span className={styles.hmCellNote} title={c.worstPod}>{c.pool ? `${c.pool} · ` : ""}{c.worstPod}</span> : null}
                  </dd>
                </div>
              );
            })}
          </dl>

          {w.pods.length > 0 && (
            <>
              <h4 className={styles.stackTitle}>{t("ob.hm.pods", { n: w.pods.length })}</h4>
              <table className={styles.stackTable}>
                <thead><tr><th>{t("ob.hm.pod")}</th><th>{t("ob.hm.short.ready")}</th><th>{t("ob.hm.short.memory")}</th><th>{t("ob.hm.short.cpu")}</th><th>{t("ob.hm.short.restarts")}</th></tr></thead>
                <tbody>
                  {w.pods.map((p) => (
                    <tr key={p.pod}>
                      <td title={p.pod}>{p.pod}{p.oom ? " · OOM" : ""}</td>
                      <td>{p.ready === null ? "—" : p.ready ? "✓" : "✕"}</td>
                      <td>{p.memory !== null ? `${Math.round(p.memory * 100)}%` : p.memBytes != null ? formatBytes(p.memBytes) : "—"}</td>
                      <td>{p.cpu !== null ? `${Math.round(p.cpu * 100)}%` : p.cpuCores != null ? formatCores(p.cpuCores) : "—"}</td>
                      <td>{p.restarts ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {noBaseline && <p className={styles.stackMuted}>{t("ob.hm.absHint")}</p>}
            </>
          )}

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
          {logs.error ? <Notice tone="warning">{logs.error}</Notice> : !logs.data ? <LoadingState /> : logs.data.state !== "ok" ? (
            <Notice tone={logs.data.state === "notConfigured" ? "info" : "warning"} title={t(`ob.hm.loki.${logs.data.state}`)}>
              {t(`ob.hm.lokiHint.${logs.data.state}`)}
              {logs.data.state === "unreachable" ? <pre className={styles.hmPre}>{LOKI_RULE}</pre> : null}
            </Notice>
          ) : (
            <WorkloadLogStream data={logs.data} workload={w.workload} errorsOnly={errorsOnly} onErrorsOnly={setErrorsOnly} grafana={grafana}
              traceUrl={(id) => (grafana && tempoUid ? explore(grafana.endpoint, tempoUid, { queryType: "traceql", query: id }) : null)}
              logsUrl={grafana && lokiUid ? explore(grafana.endpoint, lokiUid, { expr: `{namespace="${w.namespace}", pod=~"${w.workload}-.*"}` }) : null} />
          )}
        </>
      )}
    </aside>
  );
}
