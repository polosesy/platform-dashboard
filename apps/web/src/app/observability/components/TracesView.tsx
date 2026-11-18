"use client";

// 서비스 (APM) › 트레이스 — trace search (TraceQL) and one trace as a waterfall, read from Tempo THROUGH the customer's
// Managed Grafana (API services/grafanaTraces.ts — operators, connection opt-in, the connection's identity needs Grafana
// Viewer). Tempo in the cluster has no authentication and is never read directly. Every value is what Tempo answered;
// attributes and exception texts are masked like log lines. A span is marked only by its own status (ERROR = ▲).
//
// Top-down (2026-11-17): problem groups first — endpoints with error spans / the slowest p95, from spanmetrics (complete
// counts, the same read as 엔드포인트) — then that group's traces, newest first, page after page to the window's start
// (Tempo `most_recent` makes the pages gapless). A trace opens right under its row, scrolled into view.

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { TraceDetailResponse, TraceSearchResponse, TraceSpan, TraceState, TraceSummary, WorkloadRedResponse } from "@aud/types";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiQuery } from "@/lib/useApiQuery";
import { useApiToken } from "@/lib/useApiToken";
import { useReducedMotion } from "@/lib/useReducedMotion";
import { dateLocale, useI18n } from "@/lib/i18n";
import { Button, Chip, CodeBlock, CopyButton, EmptyState, ErrorNotice, FilterChip, LinkButton, LoadingState, Notice, Panel, SearchInput, Segmented, Select, TextInput, Toggle } from "@/components/ui";
import { answersAt, atParam, fitWindow, type TimeRange } from "@/lib/timeRange";
import { useRangeRefresh } from "@/lib/useTimeRange";
import { countText, endpointLabel, quantileText } from "@/lib/redView";
import {
  TRACE_MIN_DURATIONS, TRACE_WINDOWS, attrJson, attrTree, exceptionOf, execTimeByService, flameLayout, flameWindow, httpSummary, serviceSlots, slotVar, matchedSpans, mergePages, msText,
  problemGroups, rowErrors, rowSpans, spanGroups, spanMatches, traceCounts, traceLink, waterfall,
  type AttrNode, type FlameZoom, type ProblemGroup,
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

export function TracesView({ clusterId, range, nonce, report, seed, linked }: { clusterId: string; range: TimeRange; nonce: number; report?: (id: string, loading: boolean) => void; seed?: TraceSeed; linked?: string | null }) {
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
  // ?trace=<id>: shown above the search until closed (closing drops it from the address too)
  const [linkedOpen, setLinkedOpen] = useState<string | null>(linked ?? null);
  useEffect(() => { setLinkedOpen(linked ?? null); }, [linked]);
  const router = useRouter();
  const closeLinked = () => {
    setLinkedOpen(null);
    const q = new URLSearchParams(window.location.search);
    q.delete("trace");
    const rest = q.toString();
    router.replace(`${window.location.pathname}${rest ? `?${rest}` : ""}`, { scroll: false });
  };

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
      {/* a copied trace link (?trace=): that trace first, whatever the search shows */}
      {linked && linkedOpen === linked ? (
        <Panel title={t("ob.tr.linked")} sub={t("ob.tr.linkedSub")}>
          <TraceDetail key={`linked:${clusterId}:${linked}`} clusterId={clusterId} traceId={linked} onClose={closeLinked} />
        </Panel>
      ) : null}
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

type TraceViewKind = "flame" | "waterfall" | "list";

export function TraceDetail({ clusterId, traceId, onClose }: { clusterId: string; traceId: string; onClose: () => void }) {
  const { t, locale } = useI18n();
  const q = useApiQuery(`obs-trace:${clusterId}:${traceId}`, (token) =>
    fetchJsonWithBearer<TraceDetailResponse>(apiUrl("/api/observability/trace", { clusterId, traceId }), token),
  );
  const [sel, setSel] = useState<string | null>(null);
  const [view, setView] = useState<TraceViewKind>("flame");
  const [filter, setFilter] = useState("");
  const [errorsOnly, setErrorsOnly] = useState(false);
  // a service picked in the exec-time list: its blocks stand out (with colour, its label and the legend say it too)
  const [service, setService] = useState<string | null>(null);
  const [zoom, setZoom] = useState<FlameZoom | null>(null);
  // Datadog "Color by": service (default — validated series, apm-parity 4e) or none (one hue)
  const [colorBy, setColorBy] = useState<"service" | "none">("service");
  const d = q.data?.traceId === traceId ? q.data : null;
  const slots = useMemo(() => serviceSlots(d?.state === "ok" ? d.spans : [], d?.durationMs), [d]);
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
  const spans = d?.state === "ok" ? d.spans : [];
  const root = useMemo(() => waterfall(spans, d?.durationMs)[0]?.span ?? null, [spans, d?.durationMs]);
  const link = typeof window === "undefined" ? "" : traceLink(window.location.origin, traceId);
  const head = (
    <div className={styles.trInlineHead}>
      <nav className={styles.trCrumbs} aria-label={t("ob.tr.detail")}>
        <span>{t("ob.slo.view.traces")}</span><span aria-hidden="true">›</span>
        <span><strong>{root?.service ?? "—"}</strong></span><span aria-hidden="true">›</span>
        <span>{root?.name ?? t("ob.tr.noRoot")}</span><span aria-hidden="true">›</span>
        <span><code>{traceId}</code></span>
      </nav>
      <span className={styles.trHead}>
        <CopyButton text={traceId} label={t("ob.tr.copyId")} copiedLabel={t("ob.slo.copied")} />
        {link ? <CopyButton text={link} label={t("ob.tr.copyLink")} copiedLabel={t("ob.slo.copied")} /> : null}
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
    const http = httpSummary(root);
    const matches = (s: TraceSpan) => spanMatches(s, filter, errorsOnly);
    const shown = d.spans.filter(matches).length;
    const chosen = d.spans.find((s) => s.spanId === sel) ?? null;
    const pick = (id: string) => setSel(sel === id ? null : id);
    const startAt = d.start ? new Date(d.start) : null;
    content = (
      <>
        <p className={styles.trReqLine}>
          <span>{msText(d.durationMs)}</span>
          {http ? (
            <span>
              <code>{http.method} {http.target ?? ""}</code>{" "}
              {http.status ? <Chip level={http.status >= 500 ? "warn" : "plain"} glyph={http.status >= 500 ? undefined : false}>{http.status}</Chip> : null}
            </span>
          ) : null}
          {startAt ? <span title={startAt.toISOString()}>{startAt.toLocaleString(dateLocale(locale))} ({relativeText(startAt, locale)})</span> : null}
          <span>{t("ob.tr.countLine", { n: c.spans, s: c.services })}</span>
          {c.errors ? <span>▲ {t("ob.tr.errorSpans", { n: c.errors })}</span> : null}
        </p>
        <div className={styles.trTools}>
          <Segmented label={t("ob.tr.viewLabel")} value={view} onChange={setView} items={[
            { id: "flame", label: t("ob.tr.view.flame") }, { id: "waterfall", label: t("ob.tr.view.waterfall") }, { id: "list", label: t("ob.tr.view.list", { n: spanGroups(d.spans).length }) },
          ]} />
          <SearchInput label={t("ob.tr.spanFilter")} value={filter} onChange={setFilter} placeholder={t("ob.tr.spanFilterPh")} />
          <Toggle checked={errorsOnly} onChange={setErrorsOnly} disabled={!c.errors}>{t("ob.tr.errorsOnlyN", { n: c.errors })}</Toggle>
          {filter.trim() || errorsOnly ? <span className={styles.sloCellSub}>{t("ob.tr.shownN", { n: shown, total: c.spans })}</span> : null}
          {view !== "list" ? (
            <Select label={t("ob.tr.colorBy")} value={colorBy} onChange={(v) => setColorBy(v === "none" ? "none" : "service")}
              options={[{ value: "service", label: t("ob.tr.colorBy.service") }, { value: "none", label: t("ob.tr.colorBy.none") }]} />
          ) : null}
          {view === "flame" ? (
            <>
              <Button size="sm" disabled={!chosen} title={t("ob.tr.zoomHint")} onClick={() => chosen && setZoom({ from: chosen.offsetMs, to: chosen.offsetMs + Math.max(chosen.durationMs, 1e-3) })}>{t("ob.tr.zoomTo")}</Button>
              {zoom ? <><Chip level="plain" glyph={false}>{t("ob.tr.zoomed", { a: msText(zoom.from), d: msText(zoom.to - zoom.from) })}</Chip><Button size="sm" variant="ghost" onClick={() => setZoom(null)}>{t("ob.tr.zoomReset")}</Button></> : null}
            </>
          ) : null}
        </div>
        {view === "flame" ? (
          <FlameView d={d} sel={sel} onPick={pick} matches={matches} service={service} onService={setService} zoom={zoom} onZoom={setZoom} slots={slots} colorBy={colorBy} />
        ) : view === "waterfall" ? (
          <ol className={styles.trWaterfall} aria-label={t("ob.tr.waterfall")}>
            {waterfall(d.spans, d.durationMs).map((r) => (
              <li key={r.span.spanId} className={styles.trRow} data-selected={sel === r.span.spanId || undefined} style={matches(r.span) ? undefined : { opacity: 0.35 }}>
                <span className={styles.trName} style={{ paddingLeft: `${Math.min(r.depth, 16) * 12}px` }}>
                  <LinkButton ariaExpanded={sel === r.span.spanId} onClick={() => pick(r.span.spanId)} title={r.span.name}>
                    {r.span.status === "error" ? "▲ " : ""}{r.span.name}
                  </LinkButton>
                  <span className={styles.sloCellSub}>{r.span.service ?? "—"} · {t(`ob.tr.kind.${r.span.kind}`)}</span>
                </span>
                <span className={styles.trTrack} aria-hidden="true">
                  <span className={styles.trBar} data-error={r.span.status === "error" || undefined}
                    style={{ left: `${r.leftPct}%`, width: `${r.widthPct}%`, ["--svc-rgb" as string]: slotVar(slots.get(r.span.service ?? ""), colorBy) }} />
                </span>
                <span className={styles.trDur}>{msText(r.span.durationMs)}</span>
              </li>
            ))}
          </ol>
        ) : (
          <SpanListView spans={d.spans} matches={matches} onPick={(id) => setSel(id)} />
        )}
        {chosen ? <SpanDetail span={chosen} totalMs={d.durationMs ?? null} /> : <p className={styles.sloCellSub}>{t("ob.tr.pickSpan")}</p>}
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

/** "3 min ago" in the app's language */
function relativeText(at: Date, locale: Parameters<typeof dateLocale>[0]): string {
  const s = Math.round((at.getTime() - Date.now()) / 1000);
  const rtf = new Intl.RelativeTimeFormat(dateLocale(locale), { numeric: "auto" });
  const a = Math.abs(s);
  if (a < 60) return rtf.format(s, "second");
  if (a < 3600) return rtf.format(Math.round(s / 60), "minute");
  if (a < 86400) return rtf.format(Math.round(s / 3600), "hour");
  return rtf.format(Math.round(s / 86400), "day");
}

const FLAME_ROW = 24;
const AXIS_TICKS = [0, 0.25, 0.5, 0.75, 1];

/** Flame graph (time axis = the trace's) + exec time per service — pure layout lib/traceView flameLayout · execTimeByService */
function FlameView({ d, sel, onPick, matches, service, onService, zoom, onZoom, slots, colorBy }: {
  d: TraceDetailResponse; sel: string | null; onPick: (id: string) => void; matches: (s: TraceSpan) => boolean; service: string | null; onService: (s: string | null) => void;
  zoom: FlameZoom | null; onZoom: (z: FlameZoom | null) => void; slots: Map<string, number>; colorBy: "service" | "none";
}) {
  const svc = (name: string | null) => ({ ["--svc-rgb" as string]: slotVar(slots.get(name ?? ""), colorBy) });
  const { t } = useI18n();
  const total = d.durationMs ?? 0;
  const { blocks: laid, rows } = useMemo(() => flameLayout(d.spans, d.durationMs), [d.spans, d.durationMs]);
  // the window shown: the whole trace, or the span zoomed into (double-click a block · "zoom to span")
  const blocks = useMemo(() => flameWindow(laid, total, zoom), [laid, total, zoom]);
  const from = zoom?.from ?? 0, width = (zoom ? zoom.to - zoom.from : total) || 0;
  // zoomed: the rows above the zoomed span are empty there — the shown rows start at the top
  const rowBase = zoom && blocks.length ? Math.min(...blocks.map((b) => b.row)) : 0;
  const shownRows = zoom && blocks.length ? Math.max(...blocks.map((b) => b.row)) - rowBase + 1 : rows;
  const exec = useMemo(() => execTimeByService(d.spans), [d.spans]);
  // axis: the trace's own time; zoomed, the window's start then "+ offset" (absolute ticks were all "47.8 min")
  const tick = (f: number) => (zoom ? (f === 0 ? msText(from) : `+${msText(width * f)}`) : from + width * f === 0 ? "0" : msText(from + width * f));
  return (
    <div className={styles.trFlameWrap}>
      <div className={styles.trFlame}>
        <div className={styles.trAxis} aria-hidden="true">
          {AXIS_TICKS.map((f) => <span key={f} style={{ left: `${f * 100}%` }}>{tick(f)}</span>)}
        </div>
        <div className={styles.trFlameBody} style={{ height: Math.min(480, shownRows * FLAME_ROW) }}>
          {/* SVG like the other charts (attack path, network map): a block = a nested <svg> at % x/width, so its label is
              clipped to the block; each block is a keyboard button (Enter / Space) */}
          <svg className={styles.trFlameSvg} width="100%" height={shownRows * FLAME_ROW} role="group" aria-label={t("ob.tr.view.flame")}>
            {blocks.map((b) => {
              const s = b.span;
              const err = s.status === "error";
              const label = `${s.service ?? "—"} · ${s.name} · ${msText(s.durationMs)}${err ? ` · ${t("ob.tr.status.error")}` : ""}`;
              return (
                <svg key={s.spanId} x={`${b.leftPct}%`} y={(b.row - rowBase) * FLAME_ROW} width={`${b.widthPct}%`} height={FLAME_ROW - 2} overflow="hidden">
                  <g className={styles.trBlock} style={svc(s.service)} role="button" tabIndex={0} aria-label={label} aria-pressed={sel === s.spanId}
                    data-error={err || undefined} data-selected={sel === s.spanId || undefined}
                    data-service={service !== null && (s.service ?? "") === service ? true : undefined}
                    data-dim={!matches(s) || (service !== null && (s.service ?? "") !== service) || undefined}
                    onClick={() => onPick(s.spanId)}
                    onDoubleClick={() => onZoom({ from: s.offsetMs, to: s.offsetMs + Math.max(s.durationMs, 1e-3) })}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(s.spanId); } }}>
                    <title>{label}</title>
                    <rect className={styles.trBlockRect} x="0.5" y="0.5" width="100%" height={FLAME_ROW - 3} rx="4" />
                    <text className={styles.trBlockText} x={err ? 16 : 6} y={FLAME_ROW / 2 + 3}>{s.name}</text>
                    {err ? <text className={styles.trBlockMark} x="5" y={FLAME_ROW / 2 + 3} aria-hidden="true">!</text> : null}
                  </g>
                </svg>
              );
            })}
          </svg>
        </div>
      </div>
      <aside className={styles.trExec} aria-label={t("ob.tr.exec.title")}>
        <h5>{t("ob.tr.exec.title")}</h5>
        <ul className={styles.trExecList}>
          {exec.map((e) => (
            <li key={e.service} className={styles.trExecRow} title={t("ob.tr.exec.row", { s: e.service || "—", ms: msText(e.selfMs), n: e.spans })}>
              <span className={styles.trExecName}>
                {/* the legend: the block colour beside the name (identity is the name; the colour only matches it) */}
                <span className={styles.trSwatch} style={svc(e.service)} aria-hidden="true" />
                <FilterChip pressed={service === e.service} onClick={() => onService(service === e.service ? null : e.service)}>{e.service || "—"}</FilterChip>
              </span>
              <span className={styles.trExecBar} aria-hidden="true"><span style={{ width: `${Math.max(1, e.share * 100)}%` }} /></span>
              <span className={styles.trExecPct}>{(e.share * 100).toFixed(1)}%</span>
            </li>
          ))}
        </ul>
        <p className={styles.sloCellSub}>{t("ob.tr.exec.hint")}{d.truncated ? ` ${t("ob.tr.exec.truncated", { n: d.spans.length })}` : ""}</p>
      </aside>
    </div>
  );
}

/** The span list — service × name groups, most total time first (Datadog span list) */
function SpanListView({ spans, matches, onPick }: { spans: TraceSpan[]; matches: (s: TraceSpan) => boolean; onPick: (id: string) => void }) {
  const { t, locale } = useI18n();
  const groups = useMemo(() => spanGroups(spans.filter(matches)), [spans, matches]);
  if (!groups.length) return <EmptyState title={t("ob.tr.noSpansMatch")} />;
  return (
    <div className={styles.sloTableWrap}>
      <table className={styles.sloTable}>
        <thead><tr>
          <th>{t("ob.tr.col.service")}</th><th>{t("ob.tr.col.spanName")}</th>
          <th className={styles.redNum}>{t("ob.tr.col.count")}</th><th className={styles.redNum}>{t("ob.tr.col.total")}</th>
          <th className={styles.redNum}>{t("ob.tr.col.avg")}</th><th className={styles.redNum}>{t("ob.tr.col.max")}</th><th className={styles.redNum}>{t("ob.tr.col.errors")}</th>
        </tr></thead>
        <tbody>
          {groups.map((g) => (
            <tr key={`${g.service}|${g.name}`}>
              <td><span className={styles.sloCellSub}>{g.service || "—"}</span></td>
              <td><LinkButton onClick={() => onPick(g.first)} title={g.name}>{g.name}</LinkButton></td>
              <td className={styles.redNum}>{g.count.toLocaleString(dateLocale(locale))}</td>
              <td className={styles.redNum}>{msText(g.totalMs)}</td>
              <td className={styles.redNum}>{msText(g.avgMs)}</td>
              <td className={styles.redNum}>{msText(g.maxMs)}</td>
              <td className={styles.redNum}>{g.errors ? `▲ ${g.errors}` : "0"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AttrTreeView({ nodes, root }: { nodes: AttrNode[]; root?: boolean }) {
  return (
    <ul className={root ? `${styles.trAttrTree} ${styles.trAttrRoot}` : styles.trAttrTree}>
      {nodes.map((n) => (
        <li key={n.path}>
          {n.children.length ? (
            <details open>
              <summary>{n.key}{n.value !== undefined ? ` = ${n.value}` : ""}</summary>
              <AttrTreeView nodes={n.children} />
            </details>
          ) : (
            <span className={styles.trAttrLeaf}><span>{n.key}</span><span>{n.value}</span></span>
          )}
        </li>
      ))}
    </ul>
  );
}

function SpanDetail({ span, totalMs }: { span: TraceSpan; totalMs: number | null }) {
  const { t } = useI18n();
  const ex = exceptionOf(span);
  const tree = useMemo(() => attrTree(span.attributes), [span.attributes]);
  return (
    <section className={styles.trSpan}>
      <h4 className={styles.depHead}>{span.service ?? "—"} › {span.name}</h4>
      <p className={styles.sloCellSub}>
        {[span.namespace, span.pod].filter(Boolean).join(" · ") || "—"} · {t(`ob.tr.kind.${span.kind}`)} · {msText(span.durationMs)}
        {totalMs ? ` (${t("ob.tr.ofTrace", { p: (span.durationMs / totalMs) * 100 < 0.1 && span.durationMs > 0 ? "<0.1" : ((span.durationMs / totalMs) * 100).toFixed(1) })})` : ""} · +{msText(span.offsetMs)}
      </p>
      <p className={styles.sloCellSub}>
        <Chip level={span.status === "error" ? "warn" : span.status === "ok" ? "ok" : "neutral"}>{t(`ob.tr.status.${span.status}`)}</Chip>
        {span.statusMessage ? ` ${span.statusMessage}` : ""}
      </p>
      {ex ? (
        <CodeBlock label={`${t("ob.tr.exception")}${ex.type ? ` — ${ex.type}` : ""}`} code={[ex.message, ex.stack].filter(Boolean).join("\n\n") || "—"} maxHeight={280} copyLabel={t("ob.slo.copy")} copiedLabel={t("ob.slo.copied")} />
      ) : null}
      {span.attributes.length ? (
        <>
          <div className={styles.trInlineHead}>
            <h5 className={styles.depHead}>{t("ob.tr.attrs", { n: span.attributes.length })}</h5>
            <CopyButton text={attrJson(span.attributes)} label={t("ob.tr.copyJson")} copiedLabel={t("ob.slo.copied")} />
          </div>
          <AttrTreeView nodes={tree} root />
        </>
      ) : null}
      {span.events.filter((e) => e.name !== "exception").length ? (
        <p className={styles.sloCellSub}>{t("ob.tr.events")}: {span.events.filter((e) => e.name !== "exception").map((e) => `${e.name} (+${msText(e.offsetMs)})`).join(" · ")}</p>
      ) : null}
    </section>
  );
}
