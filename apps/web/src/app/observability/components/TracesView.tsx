"use client";

// 서비스 (APM) › 트레이스 — trace search (TraceQL) and one trace as a waterfall, read from Tempo THROUGH the customer's
// Managed Grafana (API services/grafanaTraces.ts — operators, connection opt-in, the connection's identity needs Grafana
// Viewer). Tempo in the cluster has no authentication and is never read directly. Every value is what Tempo answered;
// attributes and exception texts are masked like log lines. A span is marked only by its own status (ERROR = ▲).
//
// Top-down (2026-11-17): problem groups first — endpoints with error spans / the slowest p95, from spanmetrics (complete
// counts, the same read as 엔드포인트) — then that group's traces, newest first, page after page to the window's start
// (Tempo `most_recent` makes the pages gapless). A trace opens right under its row, scrolled into view.

import { useEffect, useRef, useState } from "react";
import type { TraceDetailResponse, TraceSearchResponse, TraceSpan, TraceState, TraceSummary, WorkloadRedResponse } from "@aud/types";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiQuery } from "@/lib/useApiQuery";
import { useApiToken } from "@/lib/useApiToken";
import { useReducedMotion } from "@/lib/useReducedMotion";
import { dateLocale, useI18n } from "@/lib/i18n";
import { Button, Chip, CodeBlock, CopyButton, EmptyState, ErrorNotice, LinkButton, LoadingState, Notice, Panel, Segmented, Select, TextInput } from "@/components/ui";
import { answersAt, atParam, fitWindow, type TimeRange } from "@/lib/timeRange";
import { useRangeRefresh } from "@/lib/useTimeRange";
import { countText, endpointLabel, quantileText } from "@/lib/redView";
import {
  TRACE_MIN_DURATIONS, TRACE_WINDOWS, exceptionOf, matchedSpans, mergePages, msText, problemGroups, rowErrors, rowSpans, traceCounts, waterfall,
  type ProblemGroup,
} from "@/lib/traceView";
import styles from "../styles.module.css";

export type TraceSeed = { service?: string; name?: string; errorsOnly?: boolean; minDurationMs?: number };
type Filters = { service: string; namespace: string; name: string; errorsOnly: boolean; minDurationMs: number };
/** the group a search came from: its complete count to compare the loaded traces with */
type Origin = { kind: ProblemGroup["kind"]; count: number } | null;

const PAGE = 30;

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

const filtersOf = (seed?: TraceSeed): Filters => ({
  service: seed?.service ?? "", namespace: "", name: seed?.name ?? "", errorsOnly: seed?.errorsOnly ?? false, minDurationMs: seed?.minDurationMs ?? 0,
});

export function TracesView({ clusterId, range, nonce, report, seed }: { clusterId: string; range: TimeRange; nonce: number; report?: (id: string, loading: boolean) => void; seed?: TraceSeed }) {
  const { t, locale } = useI18n();
  const lc = dateLocale(locale);
  const fit = fitWindow(range, TRACE_WINDOWS);
  const atQ = atParam(range);
  const getToken = useApiToken();
  const [draft, setDraft] = useState<Filters>(() => filtersOf(seed));
  const [applied, setApplied] = useState<Filters>(() => filtersOf(seed));
  const [origin, setOrigin] = useState<Origin>(null);
  const [traceId, setTraceId] = useState<string | null>(null);
  // A new seed (another view's "traces →") replaces the filters and runs the search
  useEffect(() => { const f = filtersOf(seed); setDraft(f); setApplied(f); setOrigin(null); setTraceId(null); }, [seed]);
  const run = (f: Filters, o: Origin) => { setDraft(f); setApplied(f); setOrigin(o); setTraceId(null); };

  // Problem groups: the RED read (same key as RED · 엔드포인트 — one request, one cache)
  const red = useApiQuery(clusterId ? `obs-red:${clusterId}:${fit.value}:${atQ ?? "now"}` : null, (token) =>
    fetchJsonWithBearer<WorkloadRedResponse>(apiUrl("/api/observability/red", { clusterId, window: String(fit.value), at: atQ }), token),
  );
  const rd = red.data?.clusterId === clusterId && red.data.windowMinutes === fit.value && answersAt(red.data.at, atQ) ? red.data : null;
  const groups = rd && rd.metricsState === "ok" ? problemGroups(rd.services, rd.buckets) : null;

  const fq = {
    service: applied.service || undefined, namespace: applied.namespace || undefined, name: applied.name || undefined,
    errorsOnly: applied.errorsOnly ? "true" : undefined, minDurationMs: applied.minDurationMs ? String(applied.minDurationMs) : undefined,
  };
  const key = `obs-traces:${clusterId}:${fit.value}:${atQ ?? "now"}:${JSON.stringify(fq)}`;
  const q = useApiQuery(clusterId ? key : null, (token) =>
    fetchJsonWithBearer<TraceSearchResponse>(apiUrl("/api/observability/traces", { clusterId, minutes: String(fit.value), at: atQ, limit: String(PAGE), ...fq }), token),
  );
  useRangeRefresh("traces", nonce, q.loading || red.loading, () => { q.reload(); red.reload(); }, report);
  const d = q.data?.clusterId === clusterId ? q.data : null;

  // Later pages: kept for this search only (a new key starts over)
  const [more, setMore] = useState<{ key: string; pages: TraceSummary[][]; next: number | null; loading: boolean; error?: string } | null>(null);
  const pages = more?.key === key ? more : null;
  const next = pages ? pages.next : d?.next ?? null;
  const loadMore = async () => {
    if (!d || next === null) return;
    const base = pages ?? { key, pages: [], next };
    setMore({ ...base, loading: true });
    try {
      const r = await fetchJsonWithBearer<TraceSearchResponse>(apiUrl("/api/observability/traces", {
        clusterId, minutes: String(fit.value), at: atQ, limit: String(PAGE), ...fq, since: String(d.since), before: String(next),
      }), await getToken());
      // A page with nothing new ends the paging (pages overlap by a second; never offer the same page again)
      const known = new Set(mergePages([d.traces, ...base.pages]).map((x) => x.traceId));
      const fresh = r.traces.some((x) => !known.has(x.traceId));
      setMore({ key, pages: [...base.pages, r.traces], next: r.state === "ok" && fresh ? r.next : null, loading: false, ...(r.state === "ok" ? {} : { error: r.message ?? r.state }) });
    } catch (e: unknown) {
      setMore({ ...base, loading: false, error: e instanceof Error ? e.message : String(e) });
    }
  };
  const rows = d ? mergePages([d.traces, ...(pages?.pages ?? [])]) : [];
  const win = t(`ob.hm.window.${fit.value}`);

  const form = (
    <form className={styles.trForm} onSubmit={(e) => { e.preventDefault(); run({ ...draft, service: draft.service.trim(), namespace: draft.namespace.trim(), name: draft.name.trim() }, null); }}>
      <TextInput label={t("ob.tr.f.service")} value={draft.service} onChange={(v) => setDraft({ ...draft, service: v })} placeholder={t("ob.tr.f.any")} maxLength={128} />
      <TextInput label={t("ob.tr.f.namespace")} value={draft.namespace} onChange={(v) => setDraft({ ...draft, namespace: v })} placeholder={t("ob.tr.f.any")} maxLength={63} />
      <TextInput label={t("ob.tr.f.name")} value={draft.name} onChange={(v) => setDraft({ ...draft, name: v })} placeholder="GET /orders/{id}" maxLength={200} />
      <Select label={t("ob.tr.f.minDuration")} value={String(draft.minDurationMs)} onChange={(v) => setDraft({ ...draft, minDurationMs: Number(v) })}
        options={[...new Set([...TRACE_MIN_DURATIONS, draft.minDurationMs])].sort((a, z) => a - z).map((ms) => ({ value: String(ms), label: ms ? `≥ ${msText(ms)}` : t("ob.tr.f.any") }))} />
      <Segmented label={t("ob.tr.f.status")} value={draft.errorsOnly ? "error" : "all"} onChange={(v) => setDraft({ ...draft, errorsOnly: v === "error" })}
        items={[{ id: "all", label: t("ob.tr.f.all") }, { id: "error", label: t("ob.tr.f.errors") }]} />
      <Button variant="primary" type="submit">{t("ob.tr.search")}</Button>
    </form>
  );

  const groupList = (list: ProblemGroup[], kind: ProblemGroup["kind"]) => (
    <div className={styles.trGroupCol}>
      <h4 className={styles.depHead}>{t(`ob.tr.g.${kind}`)}</h4>
      {list.length === 0 ? <p className={styles.sloCellSub}>{t(`ob.tr.g.${kind}None`, { w: win })}</p> : (
        <ol className={styles.trGroupList}>
          {list.map((g) => {
            const active = origin?.kind === kind && applied.service === g.service && applied.name === g.name;
            return (
              <li key={`${g.service}|${g.name}`} data-selected={active || undefined}>
                <LinkButton ariaExpanded={active} title={g.name}
                  onClick={() => run({ service: g.service, namespace: "", name: g.name, errorsOnly: kind === "errors", minDurationMs: kind === "slow" ? g.minDurationMs ?? 0 : 0 }, { kind, count: g.count })}>
                  {endpointLabel(g.name)}
                </LinkButton>
                <span className={styles.sloCellSub}>
                  {g.service} · {kind === "errors"
                    ? t("ob.tr.g.errorsN", { n: countText(g.count, lc), r: countText(g.requests, lc) })
                    : t("ob.tr.g.slowN", { p: quantileText(g.p95, rd?.buckets ?? []), r: countText(g.requests, lc) })}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );

  let body;
  if (q.error) body = <ErrorNotice error={q.error} />;
  else if (!d) body = <LoadingState label={t("ob.tr.loading")} />;
  else if (d.state !== "ok") body = <TraceStateNotice state={d.state} message={d.message} />;
  else if (!rows.length) body = <EmptyState title={t("ob.tr.none", { w: win })}>{t("ob.tr.noneHint")}</EmptyState>;
  else {
    body = (
      <div className={styles.sloTableWrap}>
        <table className={styles.sloTable}>
          <thead><tr>
            <th>{t("ob.tr.col.start")}</th><th>{t("ob.tr.col.root")}</th>
            <th className={styles.redNum}>{t("ob.tr.col.duration")}</th><th className={styles.redNum}>{t("ob.tr.col.spans")}</th><th>{t("ob.tr.col.services")}</th>
          </tr></thead>
          <tbody>
            {rows.flatMap((r) => {
              const errs = rowErrors(r);
              const open = traceId === r.traceId;
              const row = (
                <tr key={r.traceId} aria-selected={open} className={open ? styles.trOpenRow : undefined}>
                  <td><span className={styles.sloCellSub}>{new Date(r.start).toLocaleString(lc, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span></td>
                  <td>
                    <LinkButton ariaExpanded={open} onClick={() => setTraceId(open ? null : r.traceId)}>
                      {open ? "▾ " : "▸ "}{r.rootName ?? t("ob.tr.noRoot")}
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
              // The trace opens right under its row — not at the end of a long list
              return open ? [row, (
                <tr key={`${r.traceId}:detail`} className={styles.trDetailRow}>
                  <td colSpan={5}>
                    <TraceDetail key={`trace:${clusterId}:${r.traceId}`} clusterId={clusterId} traceId={r.traceId} onClose={() => setTraceId(null)} />
                  </td>
                </tr>
              )] : [row];
            })}
          </tbody>
        </table>
      </div>
    );
  }

  const matched = matchedSpans(rows);
  return (
    <>
      <Panel title={t("ob.tr.g.title")} sub={t("ob.tr.g.sub", { w: win })}>
        {red.error ? <ErrorNotice error={red.error} /> : !rd ? <LoadingState label={t("ob.tr.g.loading")} />
          : rd.metricsState !== "ok" ? <Notice tone="info" title={t(`hb.m.state.${rd.metricsState}`)}>{t("ob.tr.g.noMetrics")}</Notice>
          : !rd.instrumented ? <p className={styles.sloCellSub}>{t("ob.tr.g.noMetrics")}</p>
          : <div className={styles.trGroups}>{groupList(groups!.errors, "errors")}{groupList(groups!.slow, "slow")}</div>}
      </Panel>
      <Panel title={t("ob.tr.title")} sub={t("ob.tr.sub", { w: win })}
        actions={d?.exploreUrl ? <a href={d.exploreUrl} target="_blank" rel="noreferrer noopener">{t("ob.tr.openGrafana")}</a> : undefined}
        footer={d && d.state === "ok" ? (
          <span className={styles.trFoot}>
            <span>{next === null ? t("ob.tr.footAll", { n: rows.length, w: win }) : t("ob.tr.footSome", { n: rows.length })}</span>
            {origin?.kind === "errors" ? <span>{t("ob.tr.footCompare", { m: matched, e: countText(origin.count, lc) })}</span> : null}
            {next !== null ? <Button size="sm" onClick={() => void loadMore()} disabled={pages?.loading}>{pages?.loading ? t("ob.tr.loadingMore") : t("ob.tr.more", { n: PAGE })}</Button> : null}
            {pages?.error ? <span>▲ {pages.error}</span> : null}
          </span>
        ) : undefined}>
        {form}
        {d ? <p className={styles.sloCellSub}>TraceQL <code>{d.traceql}</code></p> : null}
        {body}
      </Panel>
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
  const box = useRef<HTMLElement>(null);
  const still = useReducedMotion();
  // Bring the opened trace into view and move focus there (keyboard and screen readers land on it, not at the list's end)
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    // Taller than most of the screen: align its top (under the sticky bar) — "nearest" would show only its bottom
    const tall = el.getBoundingClientRect().height > window.innerHeight * 0.8;
    el.scrollIntoView({ block: tall ? "start" : "nearest", behavior: still ? "auto" : "smooth" });
  }, [still, d !== null]);
  const head = (
    <div className={styles.trInlineHead}>
      <h4 className={styles.depHead}>{t("ob.tr.detail")}</h4>
      <span className={styles.trHead}>
        <code>{traceId}</code>
        <CopyButton text={traceId} label={t("ob.slo.copy")} copiedLabel={t("ob.slo.copied")} />
        {d?.exploreUrl ? <a href={d.exploreUrl} target="_blank" rel="noreferrer noopener">{t("ob.tr.openGrafana")}</a> : null}
        <LinkButton tone="muted" onClick={onClose}>{t("ob.tr.close")}</LinkButton>
      </span>
    </div>
  );
  let content;
  if (q.error) content = <ErrorNotice error={q.error} />;
  else if (!d) content = <LoadingState label={t("ob.tr.loadingTrace")} />;
  else if (d.state !== "ok") content = <TraceStateNotice state={d.state} message={d.message} />;
  else {
    const c = traceCounts(d.spans);
    const rows = waterfall(d.spans, d.durationMs);
    const chosen = d.spans.find((s) => s.spanId === sel) ?? null;
    content = (
      <>
        <p className={styles.sloCellSub}>{t("ob.tr.detailSub", { at: d.start ? new Date(d.start).toLocaleString(dateLocale(locale)) : "—", d: msText(d.durationMs), n: c.spans, s: c.services })}</p>
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
        <p className={styles.sloCellSub}>{t("ob.tr.detailFoot")}{d.redacted ? ` · ${t("ob.tr.redacted", { n: d.redacted })}` : ""}{d.truncated ? ` · ${t("ob.tr.truncated", { n: d.truncated })}` : ""}</p>
      </>
    );
  }
  return (
    <section ref={box} tabIndex={-1} className={styles.trInline} aria-label={`${t("ob.tr.detail")} ${traceId}`}>
      {head}
      {content}
    </section>
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
