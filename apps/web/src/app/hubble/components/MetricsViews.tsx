"use client";

// Hubble views from Hubble metrics (Managed Prometheus) when exec is off and the cluster sends no flow logs
// (API services/hubbleMetrics.ts). Every series names one side only (source OR destination), so there is no service
// map with edges and no flow list here — per-workload counts, drops, DNS errors. Nothing is filled in: a family the
// workspace lacks shows as not measured.

import { useState } from "react";
import type { HubbleMetricsState, HubbleMetricsSummary, HubbleSourcesResponse, LokiDropsResponse } from "@aud/types";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiQuery } from "@/lib/useApiQuery";
import { dateLocale, useI18n } from "@/lib/i18n";
import { Badge, Button, ErrorNotice, LoadingState, Notice, Segmented, Select, Stat } from "@/components/ui";
import styles from "../styles.module.css";

const WINDOWS = [5, 15, 60, 360] as const;
type View = "service-map" | "network" | "security";

export function useHubbleSource(clusterId: string) {
  const { locale } = useI18n();
  return useApiQuery(clusterId ? `hubble-sources:${clusterId}:${locale}` : null, (token) =>
    fetchJsonWithBearer<HubbleSourcesResponse>(apiUrl("/api/hubble/sources", { clusterId }), token),
  );
}

/** Where the views read from — exec / flow logs / metrics / none, with the reason exec is off */
export function SourceBadge({ sources }: { sources: HubbleSourcesResponse }) {
  const { t } = useI18n();
  const tone = sources.selected === "none" ? "medium" : sources.selected === "metrics" ? "info" : "success";
  const title = sources.exec.allowed ? undefined : t(`hb.src.execOff.${sources.exec.reason ?? "deployment"}`);
  return <Badge tone={tone} title={title}>{t("hb.src.label")}: {t(`hb.src.${sources.selected}`)}</Badge>;
}

function MetricsState({ state, message }: { state: HubbleMetricsState; message?: string }) {
  const { t } = useI18n();
  return (
    <Notice tone={state === "noHubbleMetrics" || state === "noWorkspace" ? "info" : "warning"} title={t(`hb.m.state.${state}`)}>
      {t(`hb.m.stateHint.${state}`)}{message ? ` (${message})` : ""}
    </Notice>
  );
}

const n = (v: number | null, locale: Parameters<typeof dateLocale>[0]) => (v === null ? null : v.toLocaleString(dateLocale(locale)));

export function MetricsView({ clusterId, view }: { clusterId: string; view: View }) {
  const { t, locale } = useI18n();
  const [win, setWin] = useState<number>(15);
  const q = useApiQuery(clusterId ? `hubble-metrics:${clusterId}:${win}` : null, (token) =>
    fetchJsonWithBearer<HubbleMetricsSummary>(apiUrl("/api/hubble/metrics-summary", { clusterId, window: String(win) }), token),
  );
  const d = q.data?.clusterId === clusterId && q.data.windowMinutes === win ? q.data : null;
  const fmt = (v: number | null) => n(v, locale) ?? t("hb.m.notMeasured");

  return (
    <div>
      <div className={styles.subTabs}>
        <Segmented label={t("hb.m.window")} value={win} onChange={setWin} items={WINDOWS.map((w) => ({ id: w, label: t("hb.m.minutes", { n: w }) }))} />
        <Button size="sm" onClick={q.reload}>{t("hb.m.refresh")}</Button>
      </div>
      <ErrorNotice error={q.error} />
      {!d && !q.error && <LoadingState />}
      {d && d.state !== "ok" && <MetricsState state={d.state} message={d.message} />}
      {d && d.state === "ok" && (
        <>
          <Notice tone="info">
            {t("hb.m.basis", { n: d.windowMinutes, at: new Date(d.generatedAt).toLocaleString(dateLocale(locale)) })}
            {d.scope?.basis === "alias" ? ` ${t("hb.m.scopeAlias", { cluster: d.scope.cluster ?? "" })}` : ""}
            {d.scope?.basis === "unscoped" ? ` ${t("hb.m.scopeNone")}` : ""}
          </Notice>
          {(d.lostEvents ?? 0) > 0 && <Notice tone="warning" title={t("hb.m.lost", { n: fmt(d.lostEvents) })}>{t("hb.m.lostHint")}</Notice>}
          {d.missing.length > 0 && <Notice tone="info">{t("hb.m.missing", { list: d.missing.join(", ") })}</Notice>}
          {d.truncated && <Notice tone="warning">{t("hb.m.truncated")}</Notice>}
          {view === "service-map" && <WorkloadGrid d={d} fmt={fmt} />}
          {view === "network" && <NetworkMetrics d={d} fmt={fmt} />}
          {view === "security" && <SecurityMetrics d={d} fmt={fmt} />}
        </>
      )}
    </div>
  );
}

type Fmt = (v: number | null) => string;

function WorkloadGrid({ d, fmt }: { d: HubbleMetricsSummary; fmt: Fmt }) {
  const { t } = useI18n();
  const [ns, setNs] = useState("");
  const namespaces = [...new Set(d.workloads.map((w) => w.namespace))].sort();
  const shown = ns ? d.workloads.filter((w) => w.namespace === ns) : d.workloads;
  return (
    <section aria-labelledby="hb-m-grid">
      <h3 id="hb-m-grid" className={styles.sectionTitle}>{t("hb.m.gridTitle", { n: d.workloads.length })}</h3>
      <Notice tone="info" title={t("hb.m.noEdges")}>{t("hb.m.noEdgesHint")}</Notice>
      <div className={styles.subTabs}>
        <Select label={t("hb.m.namespace")} value={ns} onChange={setNs}
          options={[{ value: "", label: t("hb.m.allNamespaces") }, ...namespaces.map((x) => ({ value: x, label: x }))]} />
      </div>
      <div className={styles.metricGrid}>
        {shown.map((w) => (
          <div key={`${w.namespace}/${w.workload}`} className={styles.metricCard}>
            <div className={styles.metricCardHead}>
              <strong title={`${w.namespace}/${w.workload}`}>{w.workload}</strong>
              <span className={styles.metricMeta}>{w.namespace} · {w.kind ?? t("hb.m.kindUnknown")}{w.basis === "pattern" ? ` · ${t("hb.m.byPattern")}` : ""} · {t("hb.m.pods", { n: w.pods })}</span>
            </div>
            <dl className={styles.metricCardBody}>
              <dt>{t("hb.m.sent")}</dt><dd>{fmt(w.egressEvents)}</dd>
              <dt>{t("hb.m.received")}</dt><dd>{fmt(w.ingressEvents)}</dd>
              <dt>{t("hb.m.drops")}</dt><dd className={(w.drops ?? 0) > 0 ? styles.metricBad : undefined}>{fmt(w.drops)}</dd>
              <dt>{t("hb.m.dnsErrors")}</dt><dd className={(w.dnsErrors ?? 0) > 0 ? styles.metricWarn : undefined}>{fmt(w.dnsErrors)}</dd>
            </dl>
          </div>
        ))}
      </div>
      <p className={styles.metricNote}>
        {t("hb.m.unattributed", { egress: fmt(d.unattributed.egressEvents), ingress: fmt(d.unattributed.ingressEvents), none: fmt(d.unattributed.unlabelledEvents) })}
      </p>
      <EnableFlowLogsPanel />
    </section>
  );
}

function NetworkMetrics({ d, fmt }: { d: HubbleMetricsSummary; fmt: Fmt }) {
  const { t } = useI18n();
  const byNs = new Map<string, { sent: number; received: number; drops: number | null }>();
  for (const w of d.workloads) {
    const r = byNs.get(w.namespace) ?? { sent: 0, received: 0, drops: w.drops === null ? null : 0 };
    r.sent += w.egressEvents; r.received += w.ingressEvents;
    if (r.drops !== null && w.drops !== null) r.drops += w.drops;
    byNs.set(w.namespace, r);
  }
  return (
    <div>
      <div className={styles.verdictSummary}>
        {(["forwarded", "dropped", "redirected", "error"] as const).map((v) => <Stat key={v} label={t(`hb.m.verdict.${v}`)} value={fmt(d.byVerdict[v])} tone={v === "dropped" && d.byVerdict.dropped > 0 ? "high" : undefined} />)}
      </div>
      <p className={styles.metricNote}>{t("hb.m.eventsNotFlows")}</p>
      <h3 className={styles.sectionTitle}>{t("hb.m.protocols")}</h3>
      <p>{d.protocols.map((p) => <span key={p.protocol} className={styles.protocolBadge}>{p.protocol} · {fmt(p.events)}</span>)}</p>
      <h3 className={styles.sectionTitle}>{t("hb.m.namespaces")}</h3>
      <table className={styles.dataTable}>
        <thead><tr><th>{t("hb.m.namespace")}</th><th>{t("hb.m.sent")}</th><th>{t("hb.m.received")}</th><th>{t("hb.m.drops")}</th></tr></thead>
        <tbody>
          {[...byNs].sort((a, b) => b[1].sent + b[1].received - (a[1].sent + a[1].received)).map(([ns, r]) => (
            <tr key={ns}><td>{ns}</td><td>{fmt(r.sent)}</td><td>{fmt(r.received)}</td><td>{fmt(r.drops)}</td></tr>
          ))}
        </tbody>
      </table>
      <h3 className={styles.sectionTitle}>{t("hb.m.dnsTitle")}</h3>
      {d.missing.includes("hubble_dns_responses_total") ? <p>{t("hb.m.notMeasured")}</p> : d.dnsErrors.length === 0 ? <p>{t("hb.m.noDnsErrors")}</p> : (
        <>
          <table className={styles.dataTable}>
            <thead><tr><th>{t("hb.m.rcode")}</th><th>{t("hb.m.workload")}</th><th>{t("hb.m.side")}</th><th>{t("hb.m.count")}</th></tr></thead>
            <tbody>
              {d.dnsErrors.map((e) => (
                <tr key={`${e.side}|${e.rcode}|${e.namespace}/${e.workload}`}>
                  <td>{e.rcode}</td><td>{e.namespace}/{e.workload}</td><td>{t(`hb.m.side.${e.side}`)}</td><td>{fmt(e.count)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {d.dnsErrors.some((e) => e.side === "server" && /non-existent|nxdomain/i.test(e.rcode)) && <Notice tone="info">{t("hb.m.nxdomainHint")}</Notice>}
        </>
      )}
    </div>
  );
}

function SecurityMetrics({ d, fmt }: { d: HubbleMetricsSummary; fmt: Fmt }) {
  const { t } = useI18n();
  return (
    <div>
      <h3 className={styles.sectionTitle}>{t("hb.m.dropsByReason")}</h3>
      {d.missing.includes("hubble_drop_total") ? <p>{t("hb.m.notMeasured")}</p> : d.dropsByReason.length === 0 ? <p>{t("hb.m.noDrops")}</p> : (
        <p>{d.dropsByReason.map((r) => <span key={r.reason} className={styles.protocolBadge}>{r.reason} · {fmt(r.count)}</span>)}</p>
      )}
      <h3 className={styles.sectionTitle}>{t("hb.m.policyDenied")}</h3>
      {d.policyDenied.length === 0 ? <p>{d.missing.includes("hubble_drop_total") ? t("hb.m.notMeasured") : t("hb.m.noPolicyDenied")}</p> : (
        <table className={styles.dataTable}>
          <thead><tr><th>{t("hb.m.workload")}</th><th>{t("hb.col.direction")}</th><th>{t("hb.m.count")}</th></tr></thead>
          <tbody>
            {d.policyDenied.map((p) => (
              <tr key={`${p.direction}|${p.namespace}/${p.workload}`}><td>{p.namespace}/{p.workload}</td><td>{p.direction}</td><td className={styles.metricBad}>{fmt(p.count)}</td></tr>
            ))}
          </tbody>
        </table>
      )}
      <h3 className={styles.sectionTitle}>{t("hb.m.verdictEvents")}</h3>
      <div className={styles.verdictSummary}>
        {(["forwarded", "dropped", "redirected"] as const).map((v) => <Stat key={v} label={t(`hb.m.verdict.${v}`)} value={fmt(d.policyVerdictEvents[v])} />)}
      </div>
      <Notice tone="info" title={t("hb.m.readinessTitle")}>{t("hb.m.readinessHint")}</Notice>
      <LokiDrops clusterId={d.clusterId} fmt={fmt} />
    </div>
  );
}

const LOKI_RULE = `# monitor namespace — allow the dashboard to read Loki (applied by the cluster owner through GitOps)
- fromEndpoints:
    - matchLabels: { "k8s:io.kubernetes.pod.namespace": aud-dashboard }
  toPorts: [{ ports: [{ port: "3100", protocol: TCP }] }]`;

/** Drops shipped by hubble-flow-exporter to Loki — flow by flow (source → destination), plus the exporter's own health */
function LokiDrops({ clusterId, fmt }: { clusterId: string; fmt: Fmt }) {
  const { t, locale } = useI18n();
  const [win, setWin] = useState<number>(60);
  const q = useApiQuery(`loki-drops:${clusterId}:${win}`, (token) =>
    fetchJsonWithBearer<LokiDropsResponse>(apiUrl("/api/hubble/loki-drops", { clusterId, window: String(win) }), token),
  );
  const d = q.data?.windowMinutes === win ? q.data : null;
  return (
    <section aria-labelledby="hb-loki-drops">
      <h3 id="hb-loki-drops" className={styles.sectionTitle}>{t("hb.ld.title")}</h3>
      <Segmented label={t("hb.m.window")} value={win} onChange={setWin} items={[60, 360, 1440].map((w) => ({ id: w, label: t(`ob.hm.window.${w}`) }))} />
      {q.error ? <Notice tone="warning">{q.error}</Notice> : !d ? <LoadingState /> : d.state !== "ok" ? (
        <Notice tone={d.state === "notConfigured" ? "info" : "warning"} title={t(`ob.hm.loki.${d.state}`)}>
          {t(`ob.hm.lokiHint.${d.state}`)}
          {d.state === "unreachable" ? <pre className={styles.flowMono}>{LOKI_RULE}</pre> : null}
        </Notice>
      ) : (
        <>
          {d.pipelineBroken && <Notice tone="danger" title={t("hb.ld.broken")}>{t("hb.ld.brokenHint")}</Notice>}
          {d.relayErrors > 0 && <Notice tone="warning" title={t("hb.ld.relay", { n: d.relayErrors })}>{t("hb.ld.relayHint")}</Notice>}
          {d.drops.length === 0 ? <p>{t("hb.ld.none", { n: d.flowLines })}</p> : (
            <table className={styles.dataTable}>
              <thead><tr><th>{t("hb.col.source")}</th><th>{t("hb.col.destination")}</th><th>{t("hb.col.port")}</th><th>{t("hb.ld.reason")}</th><th>{t("hb.m.count")}</th><th>{t("hb.audit.col.lastSeen")}</th></tr></thead>
              <tbody>
                {d.drops.map((x) => (
                  <tr key={`${x.source}|${x.destination}|${x.port}|${x.reason}`}>
                    <td>{x.source}</td><td>{x.destination}</td><td>{x.port} {x.protocol}</td><td>{x.reason}</td><td>{fmt(x.count)}</td>
                    <td>{new Date(x.lastSeen).toLocaleString(dateLocale(locale))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className={styles.metricNote}>{t("hb.ld.basis", { n: d.flowLines })}</p>
        </>
      )}
    </section>
  );
}

const CNL_YAML = `apiVersion: acn.azure.com/v1alpha1
kind: ContainerNetworkLog          # cluster-scoped; applied by the cluster owner (GitOps), never by the dashboard
metadata:
  name: aud-dashboard-flows
spec:
  includefilters:
    - name: app-pods
      from:
        labelSelector:
          matchLabels:
            app.kubernetes.io/part-of: <your-app>   # narrow it: every record is billed Log Analytics ingestion
      protocol: [tcp, udp, dns]
      verdict: [forwarded, dropped]
    - name: app-pods-inbound
      to:
        labelSelector:
          matchLabels:
            app.kubernetes.io/part-of: <your-app>
      protocol: [tcp, udp]
      verdict: [forwarded, dropped]
`;

/** How to get edges and flows: ACNS container network logs (copy only — a cluster write by its owner) */
export function EnableFlowLogsPanel() {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(CNL_YAML).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => undefined);
  };
  return (
    <details className={styles.enablePanel}>
      <summary>{t("hb.fl.title")}</summary>
      <p>{t("hb.fl.why")}</p>
      <ol>
        <li>{t("hb.fl.step1")}</li>
        <li>{t("hb.fl.step2")}</li>
        <li>{t("hb.fl.step3")}</li>
      </ol>
      <pre className={styles.flowMono}>{CNL_YAML}</pre>
      <Button size="sm" onClick={copy}>{copied ? t("hb.fl.copied") : t("hb.fl.copy")}</Button>
      <p className={styles.metricNote}>{t("hb.fl.cost")}</p>
    </details>
  );
}
