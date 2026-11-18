"use client";

// AKS 모니터링 › 서비스 (APM) › 서비스 맵 — who calls whom from the trace pipeline's service graph (API
// services/serviceGraph.ts), in the Pod traffic service map's grammar and CSS module (app/hubble): namespaces are
// boxes, services cards, callers outside the traced services on the left. Lines: grey = requests, orange dashed = some
// failed, dotted = messaging; width = rate. Hover or select a card: its lines stay, the rest dims, the panel lists each
// caller / callee with rate · failures · p95 (server side). Failures are facts (▲) — no target, no red.

import { memo, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import ReactFlow, { Background, Controls, Handle, MarkerType, Position, ReactFlowProvider, useNodesInitialized, useReactFlow, type Edge, type Node, type NodeProps } from "reactflow";
import "reactflow/dist/style.css";
import type { AppDependencies, AppMetricsResponse, HubbleServiceMapResponse, RedService, ServiceGraphResponse, WorkloadRedResponse } from "@aud/types";
import { discoverFromNetwork } from "@/lib/apmDiscovery";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiQuery } from "@/lib/useApiQuery";
import { useI18n } from "@/lib/i18n";
import { rgba } from "@/lib/palette";
import { Button, Chip, CodeBlock, EmptyState, ErrorNotice, FilterChip, LinkButton, LoadingState, Notice, SearchInput, Segmented } from "@/components/ui";
import { answersAt, atParam, fitWindow, type TimeRange } from "@/lib/timeRange";
import { useRangeRefresh } from "@/lib/useTimeRange";
import { RED_WINDOWS, countText, errorRateText, quantileText, rateText } from "@/lib/redView";
import { NET_GLYPH, apmLinksOf, buildApmMap, type ApmBox, type ApmLink, type ApmMap, type ApmPlacedCard } from "@/lib/apmServiceMap";
import { depsOf, durationText } from "@/lib/depsView";
import { SIGNAL_MIN_REQUESTS, VOLUME_FACTOR, instrumentationCoverage, serviceSignals, signalCounts, withSignal, type Coverage, type ServiceSignals, type SignalKind } from "@/lib/apmSignals";
import obs from "../styles.module.css";
import { useDependencies } from "./DependenciesView";
import styles from "../../hubble/styles.module.css";

type CardData = { card: ApmPlacedCard; dim: boolean; selected: boolean; sig: ServiceSignals | null; buckets: number[] };
type BoxData = { box: ApmBox };

const HiddenHandles = () => (
  <>
    <Handle type="target" position={Position.Left} className={styles.handleHidden} />
    <Handle type="source" position={Position.Right} className={styles.handleHidden} />
  </>
);

function useRate() {
  const { t } = useI18n();
  return (perSecond: number) => { const r = rateText(perSecond); return t(r.key, { n: r.n }); };
}

const CardNode = memo(function CardNode({ data }: NodeProps<CardData>) {
  const { t, locale } = useI18n();
  const rate = useRate();
  const c = data.card;
  return (
    <div className={styles.nmCard} data-status={c.status} data-dim={data.dim || undefined} data-selected={data.selected || undefined}
      data-kind={c.kind === "entry" ? "internetIn" : "workload"}>
      <HiddenHandles />
      <div className={styles.nmCardTop}>
        <span className={styles.nmGlyph} aria-hidden="true">{NET_GLYPH[c.status]}</span>
        <span className={styles.nmCardName} title={c.name}>{c.kind === "entry" ? t("ob.apm.entry") : c.name}</span>
      </div>
      <div className={styles.nmCardKind}>
        <span>{c.kind === "entry" ? c.name : c.kind === "discovered" ? t("ob.apm.disc.kind", { ns: c.namespace }) : c.workload ? `${c.workload.kind} · ${c.workload.namespace}` : t("ob.apm.noWorkload")}</span>
      </div>
      {c.kind === "discovered" && c.net ? (
        // seen on the network only: Cilium's flows and drops in the sample — no requests, no latency (no spans)
        <div className={styles.nmCells}>
          <span><small>{t("ob.apm.disc.flows")}</small>{countText(c.net.flows, locale)}</span>
          <span data-hot={c.net.dropped > 0 || undefined}><small>{t("ob.apm.disc.drops")}</small>{countText(c.net.dropped, locale)}</span>
        </div>
      ) : (
        <div className={styles.nmCells}>
          {c.kind === "entry"
            ? <span><small>{t("ob.apm.out")}</small>{countText(c.outRequests, locale)}</span>
            : <span><small>{t("ob.apm.in")}</small>{c.inRequests > 0 ? rate(c.inRate) : "—"}</span>}
          <span data-hot={c.inFailed > 0 || undefined}><small>{t("ob.apm.failed")}</small>{c.kind === "entry" ? "—" : countText(c.inFailed, locale)}</span>
        </div>
      )}
      {c.kind === "discovered" ? <div className={styles.nmSignals}><span>○ {t("ob.apm.disc.noTraces")}</span></div> : data.sig ? <SignalRow sig={data.sig} buckets={data.buckets} /> : null}
    </div>
  );
});

/** A card's signal line: errors · p95 slower than a week ago · volume ×n · callers / callees (facts — rules in lib/apmSignals) */
function SignalRow({ sig, buckets, fan = true }: { sig: ServiceSignals; buckets: number[]; fan?: boolean }) {
  const { t, locale } = useI18n();
  return (
    <div className={styles.nmSignals}>
      {sig.error ? <span data-hot title={t("ob.apm.sig.errorHint")}>▲ {t("ob.apm.sig.errorN", { n: countText(sig.error.count, locale) })}</span> : null}
      {sig.latency ? <span data-warm title={t("ob.apm.sig.latencyHint", { a: quantileText(sig.latency.weekAgo, buckets), b: quantileText(sig.latency.now, buckets) })}>◷ p95 ↑</span> : null}
      {sig.volume ? <span data-warm title={t("ob.apm.sig.volumeHint", { a: countText(sig.volume.weekAgo, locale), b: countText(sig.volume.now, locale) })}>⇅ {sig.volume.ratio === null ? t("ob.apm.sig.new") : "×" + (sig.volume.ratio < 1 ? sig.volume.ratio.toFixed(2) : sig.volume.ratio.toFixed(1))}</span> : null}
      {fan ? <span className={styles.nmSigFan} title={t("ob.apm.sig.fanHint", { i: sig.callers, o: sig.callees })}>← {sig.callers} · → {sig.callees}</span> : null}
    </div>
  );
}

const BoxNode = memo(function BoxNode({ data }: NodeProps<BoxData>) {
  const { t } = useI18n();
  const b = data.box;
  const title = b.kind === "laneIn" ? t("ob.apm.laneIn") : b.title || t("ob.apm.noNamespace");
  return (
    <div className={styles.nmBox} data-kind={b.kind === "laneIn" ? "laneIn" : "namespace"}>
      <div className={styles.nmBoxHead}>
        {b.kind === "namespace" && <span className={styles.nmBoxTag}>NS</span>}
        <span className={styles.nmBoxTitle} title={title}>{title}</span>
        <span className={styles.nmBoxCounts}>{b.counts.warn ? <span data-status="warn">{NET_GLYPH.warn}{b.counts.warn}</span> : null}</span>
      </div>
    </div>
  );
});

const NODE_TYPES = { aCard: CardNode, aBox: BoxNode };
const TONE: Record<ApmLink["tone"], { color: string; dash?: string; legend: string }> = {
  forward: { color: rgba("ink", 0.38), legend: "forward" },
  fail: { color: rgba("warning", 0.95), dash: "6 4", legend: "dropOther" },
  async: { color: rgba("ink", 0.38), dash: "2 4", legend: "dropIpv6" },
  // seen on the network only (Hubble) — no trace edge: a fine dotted line, no rate
  net: { color: rgba("integration", 0.7), dash: "1 4", legend: "net" },
};

function FitOnKey({ fitKey }: { fitKey: string }) {
  const rf = useReactFlow();
  const initialized = useNodesInitialized();
  const done = useRef("");
  useEffect(() => {
    if (!initialized || done.current === fitKey) return;
    done.current = fitKey;
    rf.fitView({ padding: 0.08, duration: 0 });
  }, [fitKey, initialized, rf]);
  return null;
}

export function ServiceMapView({ clusterId, range, nonce, report }: { clusterId: string; range: TimeRange; nonce: number; report?: (id: string, loading: boolean) => void }) {
  const { t } = useI18n();
  const fit = fitWindow(range, RED_WINDOWS);
  const atQ = atParam(range);
  const q = useApiQuery(clusterId ? `obs-svcmap:${clusterId}:${fit.value}:${atQ ?? "now"}` : null, (token) =>
    fetchJsonWithBearer<ServiceGraphResponse>(apiUrl("/api/observability/service-map", { clusterId, window: String(fit.value), at: atQ }), token),
  );
  useRangeRefresh("svcmap", nonce, q.loading, q.reload, report);
  // What each service calls outside the traces (Micrometer) — the panel's "dependencies" (exact name only)
  const deps = useDependencies(clusterId, range);
  // Signals (RED now vs a week ago, same window) and instrumentation coverage (every running workload) — the same keys as
  // the RED view and the heatmap, so one request each
  const red = useApiQuery(clusterId ? "obs-red:" + clusterId + ":" + fit.value + ":" + (atQ ?? "now") : null, (token) =>
    fetchJsonWithBearer<WorkloadRedResponse>(apiUrl("/api/observability/red", { clusterId, window: String(fit.value), at: atQ }), token),
  );
  const apps = useApiQuery(clusterId ? "app-metrics:" + clusterId + ":" + (atQ ?? "now") : null, (token) =>
    fetchJsonWithBearer<AppMetricsResponse>(apiUrl("/api/observability/app-metrics", { clusterId, at: atQ }), token),
  );
  const rd = red.data?.clusterId === clusterId && red.data.windowMinutes === fit.value && answersAt(red.data.at, atQ) && red.data.metricsState === "ok" ? red.data : null;
  const ad = apps.data?.clusterId === clusterId && answersAt(apps.data.at, atQ) && apps.data.metricsState === "ok" ? apps.data : null;
  const d = q.data?.clusterId === clusterId && q.data.windowMinutes === fit.value && answersAt(q.data.at, atQ) ? q.data : null;

  if (q.error) return <ErrorNotice error={q.error} />;
  if (!d) return <LoadingState label={t("ob.apm.loading")} />;
  if (d.metricsState !== "ok") {
    return (
      <Notice tone={d.metricsState === "noWorkspace" ? "info" : "warning"} title={t(`hb.m.state.${d.metricsState}`)}>
        {t(`hb.m.stateHint.${d.metricsState}`)}{d.message ? ` (${d.message})` : ""}
      </Notice>
    );
  }
  if (!d.instrumented) return <Notice tone="info" title={t("ob.apm.notInstrumented")}>{t("ob.apm.notInstrumentedHint")}</Notice>;
  return (
    <ReactFlowProvider>
      <ServiceMap d={d} deps={deps.d?.metricsState === "ok" ? deps.d.apps : undefined} fitKey={`${clusterId}|${fit.value}|${atQ ?? "now"}`} windowChip={fit.differs ? t("ob.apm.window", { n: fit.value }) : null}
        red={rd?.services ?? null} redState={red.loading && !rd ? "loading" : rd ? "ok" : "none"} workloads={ad?.workloads ?? null} clusterId={clusterId} />
    </ReactFlowProvider>
  );
}

function ServiceMap({ d, deps, fitKey, windowChip, red, redState, workloads, clusterId }: {
  d: ServiceGraphResponse; deps?: AppDependencies[]; fitKey: string; windowChip: string | null;
  red: RedService[] | null; redState: "loading" | "ok" | "none"; workloads: AppMetricsResponse["workloads"] | null; clusterId: string;
}) {
  // Service discovery without instrumentation (lib/apmDiscovery.ts): the Hubble sample, read only when asked — it opens a
  // Hubble UI channel (the backend replays its buffer), so not on every map view
  const [discover, setDiscover] = useState(false);
  const [discScope, setDiscScope] = useState<"traced" | "all">("traced");
  const { locale: lang } = useI18n();
  const hq = useApiQuery(discover && clusterId ? `apm-disc:${clusterId}:${lang}` : null, (token) =>
    fetchJsonWithBearer<HubbleServiceMapResponse>(apiUrl("/api/hubble/service-map", { clusterId, timeWindow: "5", lang }), token),
  );
  const net = useMemo(() => (discover && hq.data && hq.data.clusterId === clusterId ? discoverFromNetwork(d, hq.data, discScope) : null), [discover, hq.data, clusterId, d, discScope]);
  const { t, locale } = useI18n();
  const [failing, setFailing] = useState(false);
  const [signal, setSignal] = useState<SignalKind | null>(null);
  const [mode, setMode] = useState<"map" | "list">("map");
  const signals = useMemo(() => serviceSignals(d, red), [d, red]);
  const counts = signalCounts(signals);
  const marked = useMemo(() => withSignal(signals, signal), [signals, signal]);
  const coverage = useMemo(() => (workloads ? instrumentationCoverage(d, red, workloads) : null), [d, red, workloads]);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const map: ApmMap = useMemo(() => buildApmMap(d, { failing, search }, net), [d, failing, search, net]);
  const rate = useRate();

  const focus = selected ?? hover;
  const near = useMemo(() => {
    if (!focus) return null;
    const s = new Set([focus]);
    for (const l of map.links) if (l.source === focus || l.target === focus) { s.add(l.source); s.add(l.target); }
    return s;
  }, [focus, map.links]);

  const nodes: Node[] = useMemo(() => {
    const out: Node[] = map.boxes.map((b) => ({
      id: b.id, type: "aBox", position: { x: b.x, y: b.y }, width: b.w, height: b.h, style: { width: b.w, height: b.h, pointerEvents: "none" },
      data: { box: b } satisfies BoxData, draggable: false, selectable: false, zIndex: 0,
    }));
    for (const c of map.cards) {
      out.push({
        id: c.id, type: "aCard", position: { x: c.x, y: c.y }, width: c.w, height: c.h, style: { width: c.w, height: c.h },
        data: { card: c, dim: (!!near && !near.has(c.id)) || (!near && !!marked && !marked.has(c.id)), selected: selected === c.id, sig: signals.get(c.id) ?? null, buckets: d.buckets } satisfies CardData, draggable: false, zIndex: 10,
      });
    }
    return out;
  }, [map, near, selected, marked, signals, d.buckets]);

  const edges: Edge[] = useMemo(() => map.links.map((l) => {
    const tone = TONE[l.tone];
    const on = !!focus && (l.source === focus || l.target === focus);
    return {
      id: l.id, source: l.source, target: l.target, type: "smoothstep",
      style: { stroke: tone.color, strokeWidth: on ? l.width + 0.8 : l.width * 0.7, strokeDasharray: tone.dash, opacity: (focus && !on) || (!focus && marked && !marked.has(l.source) && !marked.has(l.target)) ? 0.06 : on ? 1 : l.tone === "fail" ? 0.95 : 0.5 },
      markerEnd: { type: MarkerType.ArrowClosed, color: tone.color, width: 14, height: 14 },
      ...(on ? { label: l.net
        ? t("ob.apm.disc.linkLabel", { f: countText(l.net.flows, locale), d: countText(l.net.dropped, locale), p: `${l.net.port}/${l.net.protocol}` })
        : `${rate(l.edge.rate)}${l.edge.failed ? ` · ${t("ob.apm.failed")} ${countText(l.edge.failed, locale)}` : ""} · p95 ${quantileText(l.edge.p95, d.buckets)}`, labelStyle: { fontSize: 12 }, labelBgPadding: [4, 2] as [number, number] } : {}),
      zIndex: on ? 20 : 5,
    } satisfies Edge;
  }), [map.links, focus, t, locale, rate, d.buckets, marked]);

  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setSelected(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

  const sel = map.cards.find((c) => c.id === selected) ?? null;
  return (
    <div className={styles.nm}>
      <div className={styles.nmBar}>
        <Segmented label={t("ob.apm.show")} value={failing ? "failing" : "all"} onChange={(v) => setFailing(v === "failing")}
          items={[{ id: "all", label: t("ob.apm.all") }, { id: "failing", label: t("ob.apm.failingOnly") }]} />
        <SearchInput label={t("ob.apm.search")} value={search} onChange={setSearch} placeholder={t("ob.apm.search")} />
        <Segmented label={t("ob.apm.mode")} value={mode} onChange={setMode} items={[{ id: "map", label: t("ob.apm.mode.map") }, { id: "list", label: t("ob.apm.mode.list") }]} />
      </div>
      <div className={styles.nmBar} role="group" aria-label={t("ob.apm.disc.title")}>
        <FilterChip pressed={discover} title={t("ob.apm.disc.hint")} onClick={() => setDiscover(!discover)}>{t("ob.apm.disc.toggle")}</FilterChip>
        {discover ? (
          <>
            <Segmented label={t("ob.apm.disc.scope")} value={discScope} onChange={setDiscScope}
              items={[{ id: "traced", label: t("ob.apm.disc.scope.traced") }, { id: "all", label: t("ob.apm.disc.scope.all") }]} />
            <span className={styles.nmSigLabel}>
              {hq.error ? t("ob.apm.disc.failed", { e: hq.error })
                : !net ? t("ob.apm.disc.loading")
                : t("ob.apm.disc.summary", { c: net.cards.length, l: net.links.length, m: net.matched, f: countText(net.sample.flows, locale), w: net.sample.windowMinutes })}
            </span>
          </>
        ) : null}
      </div>
      <div className={styles.nmBar} role="group" aria-label={t("ob.apm.sig.filter")}>
        <span className={styles.nmSigLabel}>{t("ob.apm.sig.filter")}</span>
        {(["latency", "error", "volume"] as const).map((k) => (
          <FilterChip key={k} pressed={signal === k} disabled={(k !== "error" && redState !== "ok") || counts[k] === 0} title={t(`ob.apm.sig.${k}Rule`, { n: SIGNAL_MIN_REQUESTS, f: VOLUME_FACTOR })}
            onClick={() => setSignal(signal === k ? null : k)}>{t(`ob.apm.sig.${k}`)} {counts[k]}</FilterChip>
        ))}
        {redState === "none" ? <span className={styles.nmSigLabel}>{t("ob.apm.sig.noRed")}</span> : redState === "loading" ? <span className={styles.nmSigLabel}>{t("ob.apm.sig.loadingRed")}</span> : null}
      </div>

      <div className={styles.nmSummary}>
        <span>{t("ob.apm.summary", { s: map.totals.services, l: map.totals.links, r: countText(map.totals.requests, locale), m: d.windowMinutes })}</span>
        {map.totals.failingLinks > 0 && <span data-status="warn">{NET_GLYPH.warn} {t("ob.apm.failingLinks", { n: map.totals.failingLinks, f: countText(map.totals.failed, locale) })}</span>}
        {windowChip && <Chip>{windowChip}</Chip>}
        {d.resets != null && d.resets > 0 && <Chip level="warn" title={t("ob.apm.resetsHint")}>{t("ob.apm.resets", { n: d.resets })}</Chip>}
        {d.gaps?.length ? <Chip level="warn">{t("ob.apm.gaps", { q: d.gaps.map((g) => g.query).join(", ") })}</Chip> : null}
        <ul className={styles.nmLegend} aria-label={t("ob.hm.legend")}>
          <li data-status="ok"><span aria-hidden="true">{NET_GLYPH.ok}</span>{t("ob.apm.status.ok")}</li>
          <li data-status="warn"><span aria-hidden="true">{NET_GLYPH.warn}</span>{t("ob.apm.status.warn")}</li>
          <li><span className={styles.nmLine} data-tone="forward" />{t("ob.apm.line.forward")}</li>
          <li><span className={styles.nmLine} data-tone="dropOther" />{t("ob.apm.line.fail")}</li>
          <li><span className={styles.nmLine} data-tone="dropIpv6" />{t("ob.apm.line.async")}</li>
          {net ? <li><span className={styles.nmLine} data-tone="net" />{t("ob.apm.line.net")}</li> : null}
        </ul>
      </div>

      {mode === "list" ? <ServiceList map={map} signals={signals} marked={marked} buckets={d.buckets} red={red} onPick={(id) => { setSelected(id); setMode("map"); }} /> : null}
      <div className={styles.nmLayout} data-open={!!sel || undefined} hidden={mode === "list"}>
        <div className={styles.nmCanvas}>
          {map.cards.length === 0 ? (
            <EmptyState title={t(failing ? "ob.apm.noFailing" : "ob.apm.noData")}>{t(failing ? "ob.apm.noFailingHint" : "ob.apm.noDataHint")}</EmptyState>
          ) : (
            <ReactFlow
              nodes={nodes} edges={edges} nodeTypes={NODE_TYPES}
              nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} elevateNodesOnSelect={false}
              onNodeClick={(_, n) => { if (n.type === "aCard") setSelected((p) => (p === n.id ? null : n.id)); }}
              onNodeMouseEnter={(_, n) => { if (n.type === "aCard") setHover(n.id); }}
              onNodeMouseLeave={() => setHover(null)}
              onPaneClick={() => setSelected(null)}
              minZoom={0.05} maxZoom={2} proOptions={{ hideAttribution: true }}
            >
              <FitOnKey fitKey={`${fitKey}|${failing}|${search}`} />
              <Background gap={24} size={1} color={rgba("ink", 0.05)} />
              <Controls showInteractive={false} />
            </ReactFlow>
          )}
        </div>
        {sel && <CardPanel card={sel} map={map} d={d} deps={depsOf(deps, sel.id)} onPick={setSelected} onClose={() => setSelected(null)} />}
      </div>

      {coverage ? <CoveragePanel c={coverage} /> : null}
      <details className={styles.nmAt}>
        <summary>{t("ob.apm.howMeasured")}</summary>
        <p>{t("ob.apm.howMeasuredHint")}</p>
        {Object.entries(d.queries).map(([k, v]) => <CodeBlock key={k} label={k} code={v} copyLabel={t("ob.slo.copy")} copiedLabel={t("ob.slo.copied")} />)}
      </details>
    </div>
  );
}

function CardPanel({ card: c, map, d, deps, onPick, onClose }: { card: ApmPlacedCard; map: ApmMap; d: ServiceGraphResponse; deps: AppDependencies | null; onPick: (id: string) => void; onClose: () => void }) {
  const { t, locale } = useI18n();
  const rate = useRate();
  const { inbound, outbound } = apmLinksOf(map, c.id);
  const row = (l: ApmLink, peer: string, dir: "in" | "out") => (
    <li key={l.id}>
      <button type="button" className={styles.nmLinkRow} data-tone={l.tone === "fail" ? "dropOther" : "forward"} onClick={() => onPick(peer)}>
        <span className={styles.nmLinkDir}>{dir === "in" ? "←" : "→"}</span>
        <span className={styles.nmLinkPeer} title={peer}>{peer}</span>
        <span className={styles.nmLinkPort}>{t(`ob.apm.kind.${l.edge.kind}`)}</span>
        <span className={styles.nmLinkFlows}>
          {l.net ? t("ob.apm.disc.linkLabel", { f: countText(l.net.flows, locale), d: countText(l.net.dropped, locale), p: `${l.net.port}/${l.net.protocol}` }) : <>
            {rate(l.edge.rate)} · p95 {quantileText(l.edge.p95, d.buckets)}
            {l.edge.failed ? <b> · {t("ob.apm.failed")} {countText(l.edge.failed, locale)} ({errorRateText(l.edge.errorRate)})</b> : null}
            {l.edge.lowTraffic ? <> · {t("ob.apm.lowTraffic")}</> : null}
          </>}
        </span>
      </button>
    </li>
  );
  return (
    <aside className={styles.nmPanel} aria-label={c.name}>
      <header className={styles.nmPanelHead} data-status={c.status}>
        <span className={styles.nmGlyph} aria-hidden="true">{NET_GLYPH[c.status]}</span>
        <div>
          <strong title={c.name}>{c.kind === "entry" ? t("ob.apm.entry") : c.name}</strong>
          <small>{c.kind === "entry" ? c.name : c.workload ? `${c.workload.kind} · ${c.workload.namespace}/${c.workload.name}` : t("ob.apm.noWorkload")}</small>
        </div>
        <Button size="sm" variant="ghost" ariaLabel={t("hb.nm.close")} onClick={onClose}>✕</Button>
      </header>
      <p className={styles.nmWhy}>{c.kind === "discovered" ? t("ob.apm.disc.why", { p: c.net?.pods ?? 0 }) : c.kind === "entry" ? t("ob.apm.entryHint") : c.inFailed > 0 ? t("ob.apm.why.warn", { f: countText(c.inFailed, locale), m: d.windowMinutes }) : t("ob.apm.why.ok", { m: d.windowMinutes })}</p>
      <dl className={styles.nmKv}>
        {c.kind !== "entry" && <><dt>{t("ob.apm.in")}</dt><dd>{countText(c.inRequests, locale)}{c.inRequests > 0 ? ` (${rate(c.inRate)})` : ""}</dd></>}
        {c.kind !== "entry" && <><dt>{t("ob.apm.failed")}</dt><dd>{countText(c.inFailed, locale)}</dd></>}
        <dt>{t("ob.apm.out")}</dt><dd>{countText(c.outRequests, locale)}</dd>
      </dl>
      {c.workload && (
        <p><Link href={`/observability?wl=${encodeURIComponent(`${c.workload.namespace}/${c.workload.name}`)}`}>{t("ob.apm.toWorkload")}</Link></p>
      )}
      {inbound.length > 0 && <section><h4>{t("hb.inbound", { n: inbound.length })}</h4><ul className={styles.nmLinks}>{inbound.map((l) => row(l, l.source, "in"))}</ul></section>}
      {outbound.length > 0 && <section><h4>{t("hb.outbound", { n: outbound.length })}</h4><ul className={styles.nmLinks}>{outbound.map((l) => row(l, l.target, "out"))}</ul></section>}
      {deps && (deps.outbound.some((o) => o.requests > 0) || deps.pools.length || deps.consumers.length) ? (
        <section>
          <h4>{t("ob.apm.deps")}</h4>
          <ul className={styles.nmLinks}>
            {deps.outbound.filter((o) => o.requests > 0).map((o) => (
              <li key={`o:${o.target}`} className={styles.nmLinkRow} data-tone={o.failed > 0 ? "dropOther" : "forward"}>
                <span className={styles.nmLinkDir}>⇢</span>
                <span className={styles.nmLinkPeer} title={o.target}>{o.target || t("ob.dep.untagged")}</span>
                <span className={styles.nmLinkPort}>HTTP</span>
                <span className={styles.nmLinkFlows}>{rate(o.rate)} · {t("ob.dep.col.avg")} {durationText(o.avg)}{o.failed ? <b> · {t("ob.apm.failed")} {countText(o.failed, locale)}</b> : null}</span>
              </li>
            ))}
            {deps.pools.map((p) => (
              <li key={`p:${p.pool}`} className={styles.nmLinkRow} data-tone={(p.pendingPeak ?? 0) > 0 || (p.timeouts ?? 0) > 0 ? "dropOther" : "forward"}>
                <span className={styles.nmLinkDir}>⛁</span>
                <span className={styles.nmLinkPeer} title={p.pool}>{p.pool || "—"}</span>
                <span className={styles.nmLinkPort}>JDBC</span>
                <span className={styles.nmLinkFlows}>{t("ob.dep.col.active")} {p.active ?? "—"}/{p.max ?? "—"} · {t("ob.dep.col.pending")} {t("ob.dep.peak", { n: p.pendingPeak ?? "—" })} · {t("ob.dep.col.timeouts")} {p.timeouts ?? "—"}</span>
              </li>
            ))}
            {deps.consumers.map((k) => (
              <li key={`k:${k.topic}`} className={styles.nmLinkRow} data-tone={(k.lagPeak ?? 0) > 0 ? "dropOther" : "forward"}>
                <span className={styles.nmLinkDir}>⇠</span>
                <span className={styles.nmLinkPeer} title={k.topic}>{k.topic || "—"}</span>
                <span className={styles.nmLinkPort}>Kafka</span>
                <span className={styles.nmLinkFlows}>{t("ob.dep.col.lag")} {t("ob.dep.peak", { n: k.lagPeak ?? "—" })}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <p className={styles.nmAt}>{t("ob.apm.panelNote")}</p>
    </aside>
  );
}

/** Map | List — the same services as rows (Datadog's list toggle): signals first, then most requests */
function ServiceList({ map, signals, marked, buckets, red, onPick }: {
  map: ApmMap; signals: Map<string, ServiceSignals>; marked: Set<string> | null; buckets: number[]; red: RedService[] | null; onPick: (id: string) => void;
}) {
  const { t, locale } = useI18n();
  const rate = useRate();
  const redOf = new Map((red ?? []).map((r) => [r.service, r]));
  const weight = (s: ServiceSignals | undefined) => (s ? (s.error ? 4 : 0) + (s.latency ? 2 : 0) + (s.volume ? 1 : 0) : 0);
  const rows = map.cards.filter((c) => c.kind === "service" && (!marked || marked.has(c.id)))
    .sort((a, b) => weight(signals.get(b.id)) - weight(signals.get(a.id)) || b.inRequests - a.inRequests || (a.name < b.name ? -1 : 1));
  if (!rows.length) return <EmptyState title={t("ob.apm.noData")} />;
  return (
    <div className={obs.sloTableWrap}>
      <table className={obs.sloTable}>
        <thead><tr>
          <th>{t("ob.apm.col.service")}</th><th className={obs.redNum}>{t("ob.apm.in")}</th><th className={obs.redNum}>{t("ob.apm.failed")}</th>
          <th className={obs.redNum}>p95</th><th>{t("ob.apm.col.signals")}</th><th className={obs.redNum}>{t("ob.apm.col.fan")}</th>
        </tr></thead>
        <tbody>
          {rows.map((c) => {
            const s = signals.get(c.id);
            const r = redOf.get(c.id);
            return (
              <tr key={c.id}>
                <td>
                  <LinkButton onClick={() => onPick(c.id)} title={c.name}>{c.name}</LinkButton>
                  <span className={obs.sloCellSub}>{c.workload ? `${c.workload.kind} · ${c.workload.namespace}` : c.namespace || t("ob.apm.noWorkload")}</span>
                </td>
                <td className={obs.redNum}>{c.inRequests > 0 ? rate(c.inRate) : "—"}</td>
                <td className={obs.redNum}>{c.inFailed ? `▲ ${countText(c.inFailed, locale)}` : "0"}</td>
                <td className={obs.redNum}>
                  <span className={obs.sloCellMain}>{r?.p95 ? quantileText(r.p95, buckets) : "—"}</span>
                  {r?.weekAgo?.p95 ? <span className={obs.sloCellSub}>{t("ob.apm.col.weekAgo", { v: quantileText(r.weekAgo.p95, buckets) })}</span> : null}
                </td>
                <td>{s ? <SignalRow sig={s} buckets={buckets} fan={false} /> : "—"}</td>
                <td className={obs.redNum}>← {s?.callers ?? 0} · → {s?.callees ?? 0}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Instrumentation coverage — the running workloads of the traced namespaces that send no traces */
function CoveragePanel({ c }: { c: Coverage }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  if (!c.total) return null;
  const shown = open ? c.untraced : c.untraced.slice(0, 12);
  return (
    <section className={styles.nmCoverage} aria-label={t("ob.apm.cov.title")}>
      <h4>{t("ob.apm.cov.title")}</h4>
      <p>{t("ob.apm.cov.summary", { ns: c.namespaces.length, t: c.traced, n: c.total, u: c.untraced.length })}</p>
      {c.untraced.length ? (
        <>
          <ul className={styles.nmCoverageList}>
            {shown.map((w) => (
              <li key={`${w.namespace}/${w.workload}`}>
                <span title={`${w.namespace}/${w.workload}`}>{w.workload}</span>
                <small>{w.namespace}{w.kinds.length ? ` · ${w.kinds.join(", ")}` : ""}</small>
              </li>
            ))}
          </ul>
          {c.untraced.length > 12 ? <LinkButton onClick={() => setOpen(!open)}>{open ? t("ob.apm.cov.less") : t("ob.apm.cov.more", { n: c.untraced.length - 12 })}</LinkButton> : null}
        </>
      ) : <p>{t("ob.apm.cov.all")}</p>}
      {c.unmatchedServices.length ? <p className={styles.nmAt}>{t("ob.apm.cov.unmatched", { s: c.unmatchedServices.join(", ") })}</p> : null}
      <p className={styles.nmAt}>{t("ob.apm.cov.hint")}</p>
    </section>
  );
}
