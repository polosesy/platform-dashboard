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
import { GLYPH, HEAT_METRICS, MANAGED_EXEMPT, formatBytes, formatCell, formatCores, isProblem } from "@/lib/workloadHeatView";
import { WorkloadLogStream } from "./WorkloadLogStream";
import { WorkloadVpaSection } from "./WorkloadVpaSection";
import { WORKLOAD_LOG_WINDOWS, atParam, fitWindow, type TimeRange } from "@/lib/timeRange";
import { useRangeRefresh } from "@/lib/useTimeRange";
import styles from "../styles.module.css";

const LOKI_RULE = `# monitor namespace — allow the dashboard to read Loki (applied by the cluster owner through GitOps)
- fromEndpoints:
    - matchLabels: { "k8s:io.kubernetes.pod.namespace": aud-dashboard }
  toPorts: [{ ports: [{ port: "3100", protocol: TCP }] }]`;

// Why a cell has its level, said under the value (the idle codes have their own notice)
const CELL_NOTE_CODES = new Set(["noLimit", "noRequest", "configDeficit", "imminent", "marginal", "belowFloor", "warmingUp", "lowTraffic", "queryFailed"]);
const bytesOrDash = (v: number | null) => (v === null ? "—" : formatBytes(v));
const coresOrDash = (v: number | null) => (v === null ? "—" : formatCores(v));
const pctOrDash = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(1)}%`);

function explore(endpoint: string, uid: string, query: Record<string, unknown>): string {
  const panes = { aud: { datasource: uid, queries: [{ refId: "A", datasource: { uid }, ...query }], range: { from: "now-1h", to: "now" } } };
  return `${endpoint}/explore?schemaVersion=1&orgId=1&panes=${encodeURIComponent(JSON.stringify(panes))}`;
}

/**
 * `range` = the page's time range: the log stream reads it (≤ 6 h — WORKLOAD_LOG_WINDOWS, ending at the range's end);
 * events (Kubernetes keeps ~1 h) and VPA (today's recommendation) are now — a past range says so beside them
 */
export function WorkloadHeatPanel({ clusterId, w, grafana, windowMinutes, range, nonce, onClose }: {
  clusterId: string; w: HeatWorkload; grafana: WorkloadHeatmapResponse["grafana"]; windowMinutes: number; range: TimeRange; nonce: number; onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const [errorsOnly, setErrorsOnly] = useState(true);
  const when = (iso: string) => new Date(iso).toLocaleString(dateLocale(locale));
  // Nothing runs (a DaemonSet no node matches / scaled to 0): one sentence instead of nine "no pods" rows
  const idle = w.pods.length === 0 && (w.cells.ready.code === "noNodes" || w.cells.ready.code === "scaledToZero") ? w.cells.ready.code : null;
  const events = useApiQuery(idle ? null : `events:${clusterId}:${w.namespace}:${w.workload}`, (token) =>
    fetchJsonWithBearer<KubeEventsResponse>(apiUrl("/api/observability/events", { clusterId, namespace: w.namespace, workload: w.workload }), token),
  );
  const pods = w.pods.map((p) => p.pod).slice(0, 20).join(",");
  const logWin = fitWindow(range, WORKLOAD_LOG_WINDOWS);
  const at = atParam(range);
  const past = at !== undefined;
  const pastAt = range.to === null ? "" : new Date(range.to).toLocaleString(dateLocale(locale), { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const logs = useApiQuery(idle ? null : `wlogs:${clusterId}:${w.namespace}:${w.workload}:${errorsOnly}:${logWin.value}:${at ?? "now"}`, (token) =>
    fetchJsonWithBearer<WorkloadLogsResponse>(apiUrl("/api/observability/workload-logs", {
      clusterId, namespace: w.namespace, workload: w.workload, pods, errorsOnly: String(errorsOnly), minutes: String(logWin.value), at,
    }), token),
  );
  useRangeRefresh("panelEvents", nonce, false, events.reload);
  useRangeRefresh("panelLogs", nonce, false, logs.reload);
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
            {w.managed ? <> · <Badge tone="neutral" title={t("ob.hm.managedHint")}>{t("ob.hm.managed")}</Badge></> : null}
          </div>
        </div>
        <Button size="sm" onClick={onClose}>{t("ob.hm.close")}</Button>
      </header>

      {idle ? <Notice tone="info" title={t(`ob.hm.code.${idle}`)}>{t(`ob.hm.idleHint.${idle}`)}</Notice> : (
        <>
          <dl className={styles.hmCells}>
            {HEAT_METRICS.map((m) => {
              const c = w.cells[m];
              const abs = c.value !== null && c.abs != null ? (m === "memory" ? formatBytes(c.abs) : m === "cpu" || m === "cpuNow" ? formatCores(c.abs) : null) : null;
              return (
                <div key={m} className={styles.hmCell}>
                  <dt>{t(`ob.hm.metric.${m}`)}</dt>
                  <dd data-level={c.level}>
                    <span className={styles.hmGlyph} aria-hidden="true">{GLYPH[c.level]}</span>
                    <span className={styles.hmCellValue}>{formatCell(m, w, t)}{abs ? ` · ${abs}` : ""}</span>
                    {c.oom ? <Badge tone="high">OOMKilled</Badge> : null}
                    {c.code && CELL_NOTE_CODES.has(c.code) ? <span className={styles.hmCellNote}>{t(`ob.hm.code.${c.code}`)}</span> : null}
                    {w.managed && MANAGED_EXEMPT.includes(m) && isProblem(c.level) ? <span className={styles.hmCellNote} title={t("ob.hm.managedHint")}>{t("ob.hm.managedCell")}</span> : null}
                    {c.peak ? (
                      <span className={styles.hmCellNote}>
                        {t("ob.hm.memPeak", { w: t(`ob.hm.window.${windowMinutes}`), v: c.peak.ratio !== null ? `${Math.round(c.peak.ratio * 100)}%` : formatBytes(c.peak.bytes), bytes: formatBytes(c.peak.bytes) })}
                      </span>
                    ) : null}
                    {c.jvm ? (
                      <span className={styles.hmCellNote} title={t("ob.hm.jvmHint")}>
                        {t("ob.hm.jvmBreakdown", {
                          limit: formatBytes(c.jvm.limit), heap: formatBytes(c.jvm.heapMax), band: formatBytes(c.jvm.band),
                          nonheap: bytesOrDash(c.jvm.nonheapCommitted ?? c.jvm.nonheapUsed), direct: bytesOrDash(c.jvm.direct), native: bytesOrDash(c.jvm.native),
                        })}
                        {c.jvm.partial ? ` · ${t("ob.hm.jvmPartial")}` : ""}
                      </span>
                    ) : null}
                    {c.jvm && (c.jvm.nativePeak != null || c.jvm.observedHours != null) ? (
                      <span className={styles.hmCellNote} title={t("ob.hm.jvmNativePeakHint")}>
                        {t("ob.hm.jvmNativePeak", { peak: bytesOrDash(c.jvm.nativePeak ?? null), h: c.jvm.observedHours == null ? "—" : c.jvm.observedHours < 1 ? "<1" : String(Math.floor(c.jvm.observedHours)) })}
                      </span>
                    ) : null}
                    {c.cpu ? (
                      <span className={styles.hmCellNote} title={t("ob.hm.cpuHint")}>
                        {t("ob.hm.cpuBreakdown", {
                          p95: coresOrDash(c.cpu.p95), avg: coresOrDash(c.cpu.avg), max: coresOrDash(c.cpu.max), now: coresOrDash(c.cpu.now), request: coresOrDash(c.cpu.request),
                          psi: pctOrDash(c.cpu.psi), throttle: pctOrDash(c.cpu.throttle),
                        })}
                      </span>
                    ) : null}
                    {c.cpuNow ? (
                      <span className={styles.hmCellNote} title={t("ob.hm.cpuNowHint")}>
                        {t("ob.hm.cpuNowBreakdown", { avg: formatCores(c.cpuNow.avg15), now: coresOrDash(c.cpuNow.now5), request: coresOrDash(c.cpuNow.request) })}
                        {c.cpuNow.overMinutes !== null && c.cpuNow.windowMinutes > 0
                          ? ` · ${t("ob.hm.cpuNowOver", { n: c.cpuNow.overMinutes, w: t(`ob.hm.window.${c.cpuNow.windowMinutes}`) })}` : ""}
                      </span>
                    ) : null}
                    {c.requests != null ? <span className={styles.hmCellNote}>{t("ob.hm.requests", { n: c.requests.toLocaleString() })}</span> : null}
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
                <thead><tr><th>{t("ob.hm.pod")}</th><th>{t("ob.hm.short.ready")}</th><th>{t("ob.hm.short.memory")}</th><th>{t("ob.hm.short.cpu")}</th><th>{t("ob.hm.short.cpuNow")}</th><th>{t("ob.hm.short.restarts")}</th></tr></thead>
                <tbody>
                  {w.pods.map((p) => (
                    <tr key={p.pod}>
                      <td title={p.pod}>{p.pod}{p.oom ? " · OOM" : ""}</td>
                      <td>{p.ready === null ? "—" : p.ready ? "✓" : "✕"}</td>
                      <td>{p.memory !== null ? `${Math.round(p.memory * 100)}%` : p.memBytes != null ? formatBytes(p.memBytes) : "—"}</td>
                      <td>{p.cpu !== null ? `${Math.round(p.cpu * 100)}%` : p.cpuCores != null ? formatCores(p.cpuCores) : "—"}</td>
                      <td>{p.cpuNow != null ? `${Math.round(p.cpuNow * 100)}%` : "—"}</td>
                      <td>{p.restarts ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {noBaseline && <p className={styles.stackMuted}>{t("ob.hm.absHint")}</p>}
            </>
          )}

          <WorkloadVpaSection clusterId={clusterId} namespace={w.namespace} workload={w.workload} kind={w.kind} />
          {past ? <p className={styles.stackMuted}>{t("ob.hm.vpaNow")}</p> : null}

          <h4 className={styles.stackTitle}>{t("ob.hm.events")}</h4>
          {past ? <Notice tone="info">{t("ob.hm.eventsNow", { at: pastAt })}</Notice> : null}
          {events.error ? <Notice tone="warning">{events.error}</Notice> : !events.data ? <LoadingState /> : events.data.events.length === 0 ? (
            <p className={styles.stackMuted}>{t("ob.hm.noEvents")}</p>
          ) : (
            <ul className={styles.hmEvents}>
              {events.data.events.map((e, i) => (
                <li key={`${e.time}|${e.name}|${e.reason}|${i}`}>
                  <span className={styles.stackMuted}>{when(e.time)}</span> <strong>{e.reason}</strong> {e.kind}/{e.name}
                  {/* count accumulates since the first occurrence — not occurrences in the last hour */}
                  {e.count > 1 ? (
                    <span title={e.firstTime ? t("ob.lg.repeat", { n: e.count, first: when(e.firstTime), last: when(e.time) }) : undefined}>
                      {" "}{e.firstTime && e.firstTime !== e.time ? t("ob.hm.eventsCumulative", { n: e.count, first: when(e.firstTime) }) : `×${e.count}`}
                    </span>
                  ) : null}
                  {e.message ? <div className={styles.hmMsg}>{e.message}</div> : null}
                </li>
              ))}
            </ul>
          )}
          <p className={styles.stackMuted}>{t(events.data?.messages ? "ob.hm.eventsHint" : "ob.hm.eventsHintViewer")}</p>

          <h4 className={styles.stackTitle}>{t("ob.hm.logs")}</h4>
          <p className={styles.stackMuted}>
            {past ? t("ob.hm.logsRangeAt", { w: t(`ob.hm.window.${logWin.value}`), at: pastAt }) : t("ob.hm.logsRange", { w: t(`ob.hm.window.${logWin.value}`) })}
            {logWin.differs === "max" ? ` · ${t("ob.hm.logsMax")}` : logWin.differs === "round" ? ` · ${t("ob.hm.logsRound")}` : ""}
          </p>
          {logs.error ? <Notice tone="warning">{logs.error}</Notice> : !logs.data ? <LoadingState /> : logs.data.state !== "ok" ? (
            <Notice tone={logs.data.state === "notConfigured" ? "info" : "warning"} title={t(`ob.hm.loki.${logs.data.state}`)}>
              {t(`ob.hm.lokiHint.${logs.data.state}`)}
              {logs.data.retryAt ? ` ${t("ob.hm.lokiRetry", { at: new Date(logs.data.retryAt).toLocaleTimeString(dateLocale(locale)) })}` : ""}
              {logs.data.state === "unreachable" ? <pre className={styles.hmPre}>{LOKI_RULE}</pre> : null}
              {logs.data.message ? <span className={styles.hmMsg}>{t("ob.hm.lokiCause", { msg: logs.data.message })}</span> : null}
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
