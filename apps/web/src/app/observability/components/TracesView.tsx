"use client";

// 서비스 (APM) › 트레이스 — trace search (TraceQL) and one trace as a waterfall, read from Tempo THROUGH the customer's
// Managed Grafana (API services/grafanaTraces.ts — operators, connection opt-in, the connection's identity needs Grafana
// Viewer). Tempo in the cluster has no authentication and is never read directly. Every value is what Tempo answered;
// attributes and exception texts are masked like log lines. A span is marked only by its own status (ERROR = ▲).

import { useEffect, useState } from "react";
import type { TraceDetailResponse, TraceSearchResponse, TraceSpan, TraceState } from "@aud/types";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiQuery } from "@/lib/useApiQuery";
import { dateLocale, useI18n } from "@/lib/i18n";
import { Button, Chip, CodeBlock, CopyButton, EmptyState, ErrorNotice, LinkButton, LoadingState, Notice, Panel, Segmented, Select, TextInput } from "@/components/ui";
import { atParam, fitWindow, type TimeRange } from "@/lib/timeRange";
import { useRangeRefresh } from "@/lib/useTimeRange";
import { TRACE_MIN_DURATIONS, TRACE_WINDOWS, exceptionOf, msText, rowErrors, rowSpans, traceCounts, waterfall } from "@/lib/traceView";
import styles from "../styles.module.css";

export type TraceSeed = { service?: string; name?: string; errorsOnly?: boolean };
type Filters = { service: string; namespace: string; name: string; errorsOnly: boolean; minDurationMs: number };

/** Placeholders only — the customer grants the role; the dashboard never writes to Azure */
const SETUP_CONNECTION = `"aks": {
  "observability": {
    "grafana": {
      "endpoint": "https://<grafana-name>.<region>.grafana.azure.com",
      "datasources": { "tempo": "<tempo-datasource-uid>" },
      "traces": true
    }
  }
}`;
const SETUP_ROLE = `az role assignment create --role "Grafana Viewer" \\
  --assignee <connection-app-client-id> \\
  --scope <managed-grafana-resource-id>`;

const filtersOf = (seed?: TraceSeed): Filters => ({ service: seed?.service ?? "", namespace: "", name: seed?.name ?? "", errorsOnly: seed?.errorsOnly ?? false, minDurationMs: 0 });

export function TracesView({ clusterId, range, nonce, report, seed }: { clusterId: string; range: TimeRange; nonce: number; report?: (id: string, loading: boolean) => void; seed?: TraceSeed }) {
  const { t, locale } = useI18n();
  const lc = dateLocale(locale);
  const fit = fitWindow(range, TRACE_WINDOWS);
  const atQ = atParam(range);
  const [draft, setDraft] = useState<Filters>(() => filtersOf(seed));
  const [applied, setApplied] = useState<Filters>(() => filtersOf(seed));
  const [traceId, setTraceId] = useState<string | null>(null);
  // A new seed (another view's "traces →") replaces the filters and runs the search
  useEffect(() => { const f = filtersOf(seed); setDraft(f); setApplied(f); setTraceId(null); }, [seed]);
  const fq = { service: applied.service || undefined, namespace: applied.namespace || undefined, name: applied.name || undefined, errorsOnly: applied.errorsOnly ? "true" : undefined, minDurationMs: applied.minDurationMs ? String(applied.minDurationMs) : undefined };
  const key = `obs-traces:${clusterId}:${fit.value}:${atQ ?? "now"}:${JSON.stringify(fq)}`;
  const q = useApiQuery(clusterId ? key : null, (token) =>
    fetchJsonWithBearer<TraceSearchResponse>(apiUrl("/api/observability/traces", { clusterId, minutes: String(fit.value), at: atQ, limit: "30", ...fq }), token),
  );
  useRangeRefresh("traces", nonce, q.loading, q.reload, report);
  const d = q.data?.clusterId === clusterId ? q.data : null;
  const win = t(`ob.hm.window.${fit.value}`);

  const form = (
    <form className={styles.trForm} onSubmit={(e) => { e.preventDefault(); setApplied({ ...draft, service: draft.service.trim(), namespace: draft.namespace.trim(), name: draft.name.trim() }); setTraceId(null); }}>
      <TextInput label={t("ob.tr.f.service")} value={draft.service} onChange={(v) => setDraft({ ...draft, service: v })} placeholder={t("ob.tr.f.any")} maxLength={128} />
      <TextInput label={t("ob.tr.f.namespace")} value={draft.namespace} onChange={(v) => setDraft({ ...draft, namespace: v })} placeholder={t("ob.tr.f.any")} maxLength={63} />
      <TextInput label={t("ob.tr.f.name")} value={draft.name} onChange={(v) => setDraft({ ...draft, name: v })} placeholder="GET /orders/{id}" maxLength={200} />
      <Select label={t("ob.tr.f.minDuration")} value={String(draft.minDurationMs)} onChange={(v) => setDraft({ ...draft, minDurationMs: Number(v) })}
        options={TRACE_MIN_DURATIONS.map((ms) => ({ value: String(ms), label: ms ? `≥ ${msText(ms)}` : t("ob.tr.f.any") }))} />
      <Segmented label={t("ob.tr.f.status")} value={draft.errorsOnly ? "error" : "all"} onChange={(v) => setDraft({ ...draft, errorsOnly: v === "error" })}
        items={[{ id: "all", label: t("ob.tr.f.all") }, { id: "error", label: t("ob.tr.f.errors") }]} />
      <Button variant="primary" type="submit">{t("ob.tr.search")}</Button>
    </form>
  );

  let body;
  if (q.error) body = <ErrorNotice error={q.error} />;
  else if (!d) body = <LoadingState label={t("ob.tr.loading")} />;
  else if (d.state !== "ok") body = <TraceStateNotice state={d.state} message={d.message} />;
  else if (!d.traces.length) body = <EmptyState title={t("ob.tr.none", { w: win })}>{t("ob.tr.noneHint")}</EmptyState>;
  else {
    body = (
      <div className={styles.sloTableWrap}>
        <table className={styles.sloTable}>
          <thead><tr>
            <th>{t("ob.tr.col.start")}</th><th>{t("ob.tr.col.root")}</th>
            <th className={styles.redNum}>{t("ob.tr.col.duration")}</th><th className={styles.redNum}>{t("ob.tr.col.spans")}</th><th>{t("ob.tr.col.services")}</th>
          </tr></thead>
          <tbody>
            {d.traces.map((r) => {
              const errs = rowErrors(r);
              return (
                <tr key={r.traceId} aria-selected={traceId === r.traceId}>
                  <td><span className={styles.sloCellSub}>{new Date(r.start).toLocaleString(lc, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span></td>
                  <td>
                    <LinkButton ariaExpanded={traceId === r.traceId} onClick={() => setTraceId(traceId === r.traceId ? null : r.traceId)}>
                      {r.rootName ?? t("ob.tr.noRoot")}
                    </LinkButton>
                    <span className={styles.sloCellSub}>{r.rootService ?? t("ob.tr.noRootHint")}</span>
                  </td>
                  <td className={styles.redNum}>{msText(r.durationMs)}</td>
                  <td className={styles.redNum}>
                    <span className={styles.sloCellMain}>{rowSpans(r)}</span>
                    {errs ? <span className={styles.sloCellSub}>▲ {t("ob.tr.errorsN", { n: errs })}</span> : null}
                  </td>
                  <td><span className={styles.sloCellSub}>{r.services.map((s) => `${s.errors ? "▲ " : ""}${s.name}`).join(" · ")}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <>
      <Panel title={t("ob.tr.title")} sub={t("ob.tr.sub", { w: win })}
        actions={d?.exploreUrl ? <a href={d.exploreUrl} target="_blank" rel="noreferrer noopener">{t("ob.tr.openGrafana")}</a> : undefined}
        footer={d && d.state === "ok" ? (
          <span>{t("ob.tr.foot", { n: d.traces.length, limit: d.limit })}{d.partial || d.traces.length >= d.limit ? ` · ${t("ob.tr.more")}` : ""}</span>
        ) : undefined}>
        {form}
        {d ? <p className={styles.sloCellSub}>TraceQL <code>{d.traceql}</code></p> : null}
        {body}
      </Panel>
      {traceId ? <TraceDetail key={`trace:${clusterId}:${traceId}`} clusterId={clusterId} traceId={traceId} onClose={() => setTraceId(null)} /> : null}
    </>
  );
}

function TraceStateNotice({ state, message }: { state: TraceState; message?: string }) {
  const { t } = useI18n();
  const setup = state === "notConfigured" || state === "forbidden";
  return (
    <>
      <Notice tone={state === "notConfigured" || state === "unsupportedMode" ? "info" : "warning"} title={t(`ob.tr.state.${state}`)}>
        {t(`ob.tr.stateHint.${state}`)}{message ? ` (${message})` : ""}
      </Notice>
      {setup ? (
        <>
          {state === "notConfigured" ? <CodeBlock label={t("ob.tr.setup.connection")} code={SETUP_CONNECTION} copyLabel={t("ob.slo.copy")} copiedLabel={t("ob.slo.copied")} /> : null}
          <CodeBlock label={t("ob.tr.setup.role")} code={SETUP_ROLE} copyLabel={t("ob.slo.copy")} copiedLabel={t("ob.slo.copied")} />
        </>
      ) : null}
    </>
  );
}

function TraceDetail({ clusterId, traceId, onClose }: { clusterId: string; traceId: string; onClose: () => void }) {
  const { t, locale } = useI18n();
  const q = useApiQuery(`obs-trace:${clusterId}:${traceId}`, (token) =>
    fetchJsonWithBearer<TraceDetailResponse>(apiUrl("/api/observability/trace", { clusterId, traceId }), token),
  );
  const [sel, setSel] = useState<string | null>(null);
  const d = q.data?.traceId === traceId ? q.data : null;
  const head = (
    <span className={styles.trHead}>
      <code>{traceId}</code>
      <CopyButton text={traceId} label={t("ob.slo.copy")} copiedLabel={t("ob.slo.copied")} />
      {d?.exploreUrl ? <a href={d.exploreUrl} target="_blank" rel="noreferrer noopener">{t("ob.tr.openGrafana")}</a> : null}
      <LinkButton tone="muted" onClick={onClose}>{t("ob.tr.close")}</LinkButton>
    </span>
  );
  if (q.error) return <Panel title={t("ob.tr.detail")} actions={head}><ErrorNotice error={q.error} /></Panel>;
  if (!d) return <Panel title={t("ob.tr.detail")} actions={head}><LoadingState label={t("ob.tr.loadingTrace")} /></Panel>;
  if (d.state !== "ok") return <Panel title={t("ob.tr.detail")} actions={head}><TraceStateNotice state={d.state} message={d.message} /></Panel>;
  const c = traceCounts(d.spans);
  const rows = waterfall(d.spans, d.durationMs);
  const chosen = d.spans.find((s) => s.spanId === sel) ?? null;
  return (
    <Panel title={t("ob.tr.detail")} actions={head}
      sub={t("ob.tr.detailSub", { at: d.start ? new Date(d.start).toLocaleString(dateLocale(locale)) : "—", d: msText(d.durationMs), n: c.spans, s: c.services })}
      footer={<span>{t("ob.tr.detailFoot")}{d.redacted ? ` · ${t("ob.tr.redacted", { n: d.redacted })}` : ""}{d.truncated ? ` · ${t("ob.tr.truncated", { n: d.truncated })}` : ""}</span>}>
      {c.errors ? <p className={styles.sloText}>▲ {t("ob.tr.errorSpans", { n: c.errors })}</p> : null}
      <ol className={styles.trWaterfall} aria-label={t("ob.tr.waterfall")}>
        {rows.map((r) => (
          <li key={r.span.spanId} className={styles.trRow} data-selected={sel === r.span.spanId || undefined}>
            <span className={styles.trName} style={{ paddingLeft: `${Math.min(r.depth, 16) * 12}px` }}>
              <LinkButton ariaExpanded={sel === r.span.spanId} onClick={() => setSel(sel === r.span.spanId ? null : r.span.spanId)} title={r.span.name}>
                {r.span.status === "error" ? "▲ " : ""}{r.span.name}
              </LinkButton>
              <span className={styles.sloCellSub}>{r.span.service ?? "—"} · {t(`ob.tr.kind.${r.span.kind}`)}</span>
            </span>
            <span className={styles.trTrack} aria-hidden="true">
              <span className={styles.trBar} data-error={r.span.status === "error" || undefined} style={{ left: `${r.leftPct}%`, width: `${r.widthPct}%` }} />
            </span>
            <span className={styles.trDur}>{msText(r.span.durationMs)}</span>
          </li>
        ))}
      </ol>
      {chosen ? <SpanDetail span={chosen} /> : <p className={styles.sloCellSub}>{t("ob.tr.pickSpan")}</p>}
    </Panel>
  );
}

function SpanDetail({ span }: { span: TraceSpan }) {
  const { t } = useI18n();
  const ex = exceptionOf(span);
  return (
    <section className={styles.trSpan}>
      <h4 className={styles.depHead}>{span.name}</h4>
      <p className={styles.sloCellSub}>
        {[span.service, span.namespace, span.pod].filter(Boolean).join(" · ") || "—"} · {t(`ob.tr.kind.${span.kind}`)} · {msText(span.durationMs)} · +{msText(span.offsetMs)}
      </p>
      <p className={styles.sloCellSub}>
        <Chip level={span.status === "error" ? "warn" : span.status === "ok" ? "ok" : "neutral"}>{t(`ob.tr.status.${span.status}`)}</Chip>
        {span.statusMessage ? ` ${span.statusMessage}` : ""}
      </p>
      {ex ? (
        <CodeBlock label={`${t("ob.tr.exception")}${ex.type ? ` — ${ex.type}` : ""}`} code={[ex.message, ex.stack].filter(Boolean).join("\n\n") || "—"} maxHeight={280} copyLabel={t("ob.slo.copy")} copiedLabel={t("ob.slo.copied")} />
      ) : null}
      {span.attributes.length ? (
        <table className={styles.sloTable}>
          <thead><tr><th>{t("ob.tr.attr")}</th><th>{t("ob.tr.value")}</th></tr></thead>
          <tbody>{span.attributes.map((a) => <tr key={a.key}><td><code>{a.key}</code></td><td><span className={styles.trValue}>{a.value}</span></td></tr>)}</tbody>
        </table>
      ) : null}
      {span.events.filter((e) => e.name !== "exception").length ? (
        <p className={styles.sloCellSub}>{t("ob.tr.events")}: {span.events.filter((e) => e.name !== "exception").map((e) => `${e.name} (+${msText(e.offsetMs)})`).join(" · ")}</p>
      ) : null}
    </section>
  );
}
