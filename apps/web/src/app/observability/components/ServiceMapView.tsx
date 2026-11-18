"use client";

// AKS 모니터링 › 서비스 (APM) › 서비스 맵 — who calls whom from the trace pipeline's service graph (API
// services/serviceGraph.ts), in the Pod traffic service map's grammar and CSS module (app/hubble): namespaces are
// boxes, services cards, callers outside the traced services on the left. Lines: grey = requests, orange dashed = some
// failed, dotted = messaging; width = rate. Hover or select a card: its lines stay, the rest dims, the panel lists each
// caller / callee with rate · failures · p95 (server side). Failures are facts (▲) — no target, no red.

import { memo, useEffect, useMemo, useRef, useState, type RefObject } from "react";
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
import {
  CRITICAL_ERROR_RATE, FANOUT_MIN, SHARED_DEP_MIN, SIGNAL_MIN_REQUESTS, VOLUME_FACTOR, bandsOf, instrumentationCoverage, notesOf, serviceRows, serviceSignals, signalCounts, windowText, withSignal,
  type Band, type Coverage, type ServiceSignals, type SignalKind,
} from "@/lib/apmSignals";
import obs from "../styles.module.css";
import { useDependencies } from "./DependenciesView";
import styles from "../../hubble/styles.module.css";

type CardData = { card: ApmPlacedCard; dim: boolean; selected: boolean; sig: ServiceSignals | null; buckets: number[] };
type BoxData = { box: ApmBox; onClose?: () => void };

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
  // Seen on the network only — one step quieter: name + flows · drops (a closed namespace: its workloads, summed)
  if (c.kind === "discovered" || c.kind === "nsGroup") {
    const group = c.kind === "nsGroup";
    return (
      <div className={styles.nmQuiet} data-kind={c.kind} data-dim={data.dim || undefined} data-selected={data.selected || undefined}
        title={group ? t("ob.apm.disc.groupHint", { ns: c.name, n: c.members ?? 0 }) : t("ob.apm.disc.cardHint", { ns: c.namespace, p: c.net?.pods ?? 0 })}>
        <HiddenHandles />
        <span className={styles.nmQuietName}>
          <span aria-hidden="true">{group ? "▸" : "○"}</span>
          <span>{group ? t("ob.apm.disc.groupName", { ns: c.name, n: c.members ?? 0 }) : c.name}</span>
        </span>
        <span className={styles.nmQuietLine}>
          {t("ob.apm.disc.flowsN", { n: countText(c.net?.flows ?? 0, locale) })}
          {c.net?.dropped ? <b> · {t("ob.apm.disc.dropsN", { n: countText(c.net.dropped, locale) })}</b> : null}
          {group ? <span className={styles.nmQuietOpen}>{t("ob.apm.disc.open")}</span> : null}
        </span>
      </div>
    );
  }
  // A service (Datadog service discovery's card): the body — name, kind, numbers, the worst signal's band — and under it,
  // outside the border, the dependency footnote. Words come from stated rules (lib/apmSignals bandsOf · notesOf).
  const entry = c.kind === "entry";
  const bands = entry ? [] : bandsOf(data.sig);
  const top = bands[0] ?? null;
  const notes = entry ? { shared: null, fanout: null } : notesOf(data.sig);
  return (
    <div className={styles.nmApm} data-dim={data.dim || undefined} data-selected={data.selected || undefined}>
      <HiddenHandles />
      <div className={styles.nmApmCard} data-level={top?.level} data-kind={entry ? "entry" : "service"} data-status={c.status}>
        <div className={styles.nmApmHead}>
          <span className={styles.nmApmIcon} aria-hidden="true">{entry ? "⇥" : top ? LEVEL_GLYPH[top.level] : NET_GLYPH.ok}</span>
          <span className={styles.nmCardName} title={c.name}>{entry ? t("ob.apm.entry") : c.name}</span>
        </div>
        <div className={styles.nmApmMeta} title={entry ? c.name : undefined}>
          {entry ? c.name : c.workload ? `${c.workload.kind} · ${c.workload.namespace}` : t("ob.apm.noWorkload")}
        </div>
        <div className={styles.nmApmNums}>
          {entry
            ? <span>{t("ob.apm.out")} <b>{countText(c.outRequests, locale)}</b></span>
            : <>
                <span>{t("ob.apm.in")} <b>{c.inRequests > 0 ? rate(c.inRate) : "—"}</b></span>
                <span data-hot={c.inFailed > 0 || undefined}>{t("ob.apm.failed")} <b>{countText(c.inFailed, locale)}</b></span>
              </>}
        </div>
        {entry ? null : <SignalBand bands={bands} sig={data.sig} buckets={data.buckets} />}
      </div>
      {notes.shared !== null || notes.fanout !== null ? (
        <div className={styles.nmApmNote}>
          <span aria-hidden="true">ⓘ</span>
          {notes.shared !== null ? <span title={t("ob.apm.note.sharedRule", { m: SHARED_DEP_MIN })}>{t("ob.apm.note.shared", { n: notes.shared })}</span> : null}
          {notes.fanout !== null ? <span title={t("ob.apm.note.fanoutRule", { m: FANOUT_MIN })}>{t("ob.apm.note.fanout", { n: notes.fanout })}</span> : null}
        </div>
      ) : null}
    </div>
  );
});

const BAND_GLYPH: Record<SignalKind, string> = { error: "✱", latency: "◷", volume: "⇅" };
/** The card's square follows its worst band — the platform's state grammar (■ danger · ▲ warning · ● fine), ◆ = a change */
const LEVEL_GLYPH: Record<Band["level"], string> = { critical: "■", high: "▲", info: "◆" };

/** A band's words and its rule (the tooltip) — the same text in the card, the list and the panel */
function useBandText() {
  const { t, locale } = useI18n();
  const ratio = (x: number) => (x < 1 ? x.toFixed(2) : x.toFixed(1));
  const text = (b: Band, s: ServiceSignals, buckets: number[]) => {
    switch (b.label) {
      case "errorCritical": return t("ob.apm.band.errorCritical", { r: errorRateText(s.error!.rate) });
      case "errors": return s.error!.rate !== null
        ? t("ob.apm.band.errorsRate", { n: countText(s.error!.count, locale), r: errorRateText(s.error!.rate) })
        : t("ob.apm.band.errors", { n: countText(s.error!.count, locale) });
      case "latency": return t("ob.apm.band.latency", { a: quantileText(s.latency!.weekAgo, buckets), b: quantileText(s.latency!.now, buckets) });
      case "volumeNew": return t("ob.apm.band.volumeNew");
      default: return t(`ob.apm.band.${b.label}`, { x: ratio(s.volume!.ratio!) });
    }
  };
  const rule = (b: Band, s: ServiceSignals) => {
    const crit = { r: errorRateText(CRITICAL_ERROR_RATE), n: SIGNAL_MIN_REQUESTS };
    if (b.kind === "error") return `${t(b.level === "critical" ? "ob.apm.band.criticalRule" : "ob.apm.band.errorsRule", crit)} · ${t("ob.apm.sig.errorHint")} (${s.error!.basis === "spans" ? "RED" : "service graph"})`;
    if (b.kind === "latency") return t("ob.apm.sig.latencyRule", { n: SIGNAL_MIN_REQUESTS });
    return `${t("ob.apm.sig.volumeHint", { a: countText(s.volume!.weekAgo, locale), b: countText(s.volume!.now, locale) })} · ${t("ob.apm.band.volumeRule")}`;
  };
  return { text, rule };
}

/** The card's band: the worst signal in words (+n more — all of them in the tooltip); no signal = a quiet line */
function SignalBand({ bands, sig, buckets }: { bands: Band[]; sig: ServiceSignals | null; buckets: number[] }) {
  const { t } = useI18n();
  const { text, rule } = useBandText();
  const top = bands[0];
  if (!top || !sig) return <div className={styles.nmApmBand}><span aria-hidden="true">●</span><span>{t("ob.apm.band.none")}</span></div>;
  const all = bands.map((b) => `${BAND_GLYPH[b.kind]} ${text(b, sig, buckets)} — ${rule(b, sig)}`).join("\n");
  return (
    <div className={styles.nmApmBand} data-level={top.level} title={all}>
      <span aria-hidden="true">{BAND_GLYPH[top.kind]}</span>
      <span className={styles.nmApmBandText}>{text(top, sig, buckets)}</span>
      {bands.length > 1 ? <span className={styles.nmApmMore}>+{bands.length - 1}</span> : null}
    </div>
  );
}

const BoxNode = memo(function BoxNode({ data }: NodeProps<BoxData>) {
  const { t } = useI18n();
  const b = data.box;
  const title = b.kind === "laneIn" ? t("ob.apm.laneIn")
    : b.kind === "disc" ? t("ob.apm.disc.boxTitle", { n: b.members })
    : b.kind === "untraced" ? t("ob.apm.disc.laneTitle", { n: b.members })
    : b.title || t("ob.apm.noNamespace");
  return (
    <div className={styles.nmBox} data-kind={b.kind}>
      <div className={styles.nmBoxHead}>
        {(b.kind === "namespace" || b.kind === "nsOpen") && <span className={styles.nmBoxTag}>NS</span>}
        <span className={styles.nmBoxTitle} title={b.kind === "nsOpen" ? `${title} · ${t("ob.apm.disc.openNote", { n: b.members })}` : title}>{title}</span>
        <span className={styles.nmBoxCounts}>
          {b.counts.warn ? <span data-status="warn">{NET_GLYPH.warn}{b.counts.warn}</span> : null}
          {/* the box itself lets clicks through (pointer-events none); this button takes them */}
          {b.kind === "nsOpen" && data.onClose ? <span className={styles.nmBoxBtn}><Button size="sm" variant="ghost" onClick={data.onClose}>{t("ob.apm.disc.close")}</Button></span> : null}
        </span>
      </div>
    </div>
  );
});

const NODE_TYPES = { aCard: CardNode, aBox: BoxNode };
const TONE: Record<ApmLink["tone"], { color: string; dash?: string; legend: string }> = {
  forward: { color: rgba("ink", 0.38), legend: "forward" },
  fail: { color: rgba("warning", 0.95), dash: "6 4", legend: "dropOther" },
  async: { color: rgba("ink", 0.38), dash: "2 4", legend: "dropIpv6" },
  // seen on the network only (Hubble) — no trace edge: a fine dotted line in the discovery colour, no rate, no label
  // until pointed at (54 labels at once hid the map)
  net: { color: rgba("integration", 0.75), dash: "2 4", legend: "net" },
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
  // namespaces without traces the user opened (the rest stay one card each)
  const [openNs, setOpenNs] = useState<ReadonlySet<string>>(new Set());
  // a line's label: while pointed at, or pinned by a click (touch screens have no hover). React Flow only sends edge
  // events when an edge click handler exists (elementsSelectable is off) — hence onEdgeClick below
  const [hoverEdge, setHoverEdge] = useState<string | null>(null);
  const [pinEdge, setPinEdge] = useState<string | null>(null);
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
  const map: ApmMap = useMemo(() => buildApmMap(d, { failing, search, open: openNs }, net), [d, failing, search, net, openNs]);
  const nameOf = (id: string) => map.cards.find((c) => c.id === id)?.name ?? id;
  const closeNs = (ns: string) => setOpenNs((p) => { const n = new Set(p); n.delete(ns); return n; });
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
      data: { box: b, ...(b.kind === "nsOpen" ? { onClose: () => closeNs(b.title) } : {}) } satisfies BoxData, draggable: false, selectable: false,
      // a "not instrumented" box sits inside its namespace box
      zIndex: b.kind === "disc" ? 1 : 0,
    }));
    for (const c of map.cards) {
      out.push({
        id: c.id, type: "aCard", position: { x: c.x, y: c.y }, width: c.w, height: c.h, style: { width: c.w, height: c.h },
        data: { card: c, dim: (!!near && !near.has(c.id)) || (!near && !!marked && !marked.has(c.id)), selected: selected === c.id, sig: signals.get(c.id) ?? null, buckets: d.buckets } satisfies CardData, draggable: false, zIndex: 10,
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, near, selected, marked, signals, d.buckets]);

  const edges: Edge[] = useMemo(() => map.links.map((l) => {
    const tone = TONE[l.tone];
    const on = !!focus && (l.source === focus || l.target === focus);
    const pointed = hoverEdge === l.id || pinEdge === l.id;
    // labels: a trace line when its card is in focus; a network-only line only when pointed at (the panel lists them all)
    const label = pointed || (on && !l.net) ? (l.net
      ? t("ob.apm.disc.linkLabel", { f: countText(l.net.flows, locale), d: countText(l.net.dropped, locale), p: `${l.net.port}/${l.net.protocol}` }) + (l.net.merged > 1 ? ` · ${t("ob.apm.disc.mergedN", { n: l.net.merged })}` : "")
      : `${rate(l.edge.rate)}${l.edge.failed ? ` · ${t("ob.apm.failed")} ${countText(l.edge.failed, locale)}` : ""} · p95 ${quantileText(l.edge.p95, d.buckets)}`) : null;
    const quietNet = l.tone === "net" && !on && !pointed;
    return {
      id: l.id, source: l.source, target: l.target, type: "default", interactionWidth: 14,
      style: { stroke: tone.color, strokeWidth: on || pointed ? l.width + 0.8 : l.width * 0.7, strokeDasharray: tone.dash, opacity: (focus && !on) || (!focus && marked && !marked.has(l.source) && !marked.has(l.target)) ? 0.06 : on || pointed ? 1 : l.tone === "fail" ? 0.95 : quietNet ? 0.35 : 0.5 },
      markerEnd: { type: MarkerType.ArrowClosed, color: tone.color, width: 14, height: 14 },
      ...(label ? { label, labelStyle: { fontSize: 12 }, labelBgPadding: [4, 2] as [number, number] } : {}),
      zIndex: on || pointed ? 20 : 5,
    } satisfies Edge;
  }), [map.links, focus, hoverEdge, pinEdge, t, locale, rate, d.buckets, marked]);

  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setSelected(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

  const sel = map.cards.find((c) => c.id === selected) ?? null;
  const win = windowText(d.windowMinutes);
  // "Instrument services": the coverage panel below (the workloads that send no traces, and how to add them)
  const covRef = useRef<HTMLElement>(null);
  const [covOpen, setCovOpen] = useState(false);
  const toCoverage = () => { setCovOpen(true); covRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }); covRef.current?.focus({ preventScroll: true }); };
  return (
    <div className={styles.nm}>
      <div className={styles.nmTop}>
        <div className={styles.nmSummary}>
          <span>{t("ob.apm.summary", { s: map.totals.services, l: map.totals.links, r: countText(map.totals.requests, locale), m: d.windowMinutes })}</span>
          {map.totals.failingLinks > 0 && <span data-status="warn">{NET_GLYPH.warn} {t("ob.apm.failingLinks", { n: map.totals.failingLinks, f: countText(map.totals.failed, locale) })}</span>}
          {windowChip && <Chip>{windowChip}</Chip>}
          {d.resets != null && d.resets > 0 && <Chip level="warn" title={t("ob.apm.resetsHint")}>{t("ob.apm.resets", { n: d.resets })}</Chip>}
          {d.gaps?.length ? <Chip level="warn">{t("ob.apm.gaps", { q: d.gaps.map((g) => g.query).join(", ") })}</Chip> : null}
        </div>
        <Button variant="primary" disabled={!coverage} onClick={toCoverage}
          title={coverage ? t("ob.apm.instrumentHint", { n: coverage.untraced.length }) : t("ob.apm.instrumentWait")}>
          {t("ob.apm.instrument")} →
        </Button>
      </div>

      <section className={styles.nmFrame} aria-label={t("ob.apm.mode.map")}>
        <div className={styles.nmFrameHead}>
          <span className={styles.nmFrameRange} title={t("ob.apm.frame.rangeHint")}>
            <span className={styles.nmRangeCode}>{win.short}</span>
            {win.unit === "hour" ? (win.n === 1 ? t("ob.apm.frame.past.hour1") : t("ob.apm.frame.past.hour", { n: win.n })) : t("ob.apm.frame.past.min", { n: win.n })}
          </span>
          <Segmented label={t("ob.apm.mode")} value={mode} onChange={setMode} items={[
            { id: "map", label: <><span aria-hidden="true">⊶ </span>{t("ob.apm.mode.map")}</> },
            { id: "list", label: <><span aria-hidden="true">☰ </span>{t("ob.apm.mode.list")}</> },
          ]} />
        </div>
        <div className={styles.nmSigRow} role="group" aria-label={t("ob.apm.sig.filter")}>
          <span className={styles.nmSigLead}>{t("ob.apm.sig.filter")}:</span>
          {(["latency", "error", "volume"] as const).map((k) => (
            <FilterChip key={k} pressed={signal === k} disabled={(k !== "error" && redState !== "ok") || counts[k] === 0} title={t(`ob.apm.sig.${k}Rule`, { n: SIGNAL_MIN_REQUESTS, f: VOLUME_FACTOR })}
              onClick={() => setSignal(signal === k ? null : k)}>
              <span className={styles.nmSigIcon} aria-hidden="true">{BAND_GLYPH[k]}</span>
              {t(`ob.apm.sig.${k}`)}
              <span className={styles.nmSigNum} data-zero={counts[k] === 0 || undefined}>{counts[k]}</span>
            </FilterChip>
          ))}
          {redState === "none" ? <span className={styles.nmSigLabel}>{t("ob.apm.sig.noRed")}</span> : redState === "loading" ? <span className={styles.nmSigLabel}>{t("ob.apm.sig.loadingRed")}</span> : null}
          <span className={styles.nmSigTools}>
            <Segmented label={t("ob.apm.show")} value={failing ? "failing" : "all"} onChange={(v) => setFailing(v === "failing")}
              items={[{ id: "all", label: t("ob.apm.all") }, { id: "failing", label: t("ob.apm.failingOnly") }]} />
            <SearchInput label={t("ob.apm.search")} value={search} onChange={setSearch} placeholder={t("ob.apm.search")} />
          </span>
        </div>
      <div className={styles.nmFrameSub} role="group" aria-label={t("ob.apm.disc.title")}>
        <FilterChip pressed={discover} title={t("ob.apm.disc.hint")} onClick={() => { setDiscover(!discover); setOpenNs(new Set()); }}>{t("ob.apm.disc.toggle")}</FilterChip>
        {discover ? (
          <>
            <Segmented label={t("ob.apm.disc.scope")} value={discScope} onChange={(v) => { setDiscScope(v); setOpenNs(new Set()); }}
              items={[{ id: "traced", label: t("ob.apm.disc.scope.traced") }, { id: "all", label: t("ob.apm.disc.scope.all") }]} />
            <span className={styles.nmSigLabel}>
              {hq.error ? t("ob.apm.disc.failed", { e: hq.error })
                : !net ? t("ob.apm.disc.loading")
                : t("ob.apm.disc.summary", { c: net.cards.length, l: net.links.length, m: net.matched, f: countText(net.sample.flows, locale), w: net.sample.windowMinutes })}
            </span>
            {openNs.size ? <LinkButton onClick={() => setOpenNs(new Set())}>{t("ob.apm.disc.closeAll", { n: openNs.size })}</LinkButton> : null}
          </>
        ) : null}
      </div>
      {mode === "list" ? <div className={styles.nmFrameList}><ServiceList map={map} signals={signals} marked={marked} buckets={d.buckets} red={red} onPick={(id) => { setSelected(id); setMode("map"); }} /></div> : null}
      <div className={styles.nmLayout} data-open={!!sel || undefined} hidden={mode === "list"}>
        <div className={styles.nmCanvas}>
          {map.cards.length === 0 ? (
            <EmptyState title={t(failing ? "ob.apm.noFailing" : "ob.apm.noData")}>{t(failing ? "ob.apm.noFailingHint" : "ob.apm.noDataHint")}</EmptyState>
          ) : (
            <ReactFlow
              nodes={nodes} edges={edges} nodeTypes={NODE_TYPES}
              nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} elevateNodesOnSelect={false}
              onNodeClick={(_, n) => {
                if (n.type !== "aCard") return;
                // a closed namespace opens (its workloads as small cards); anything else selects
                if (n.id.startsWith("nsg:")) { const ns = n.id.slice(4); setOpenNs((p) => new Set([...p, ns])); setHover(null); return; }
                setSelected((p) => (p === n.id ? null : n.id));
              }}
              onNodeMouseEnter={(_, n) => { if (n.type === "aCard") setHover(n.id); }}
              onNodeMouseLeave={() => setHover(null)}
              onEdgeMouseEnter={(_, e) => setHoverEdge(e.id)}
              onEdgeMouseLeave={() => setHoverEdge(null)}
              onEdgeClick={(_, e) => setPinEdge((p) => (p === e.id ? null : e.id))}
              onPaneClick={() => { setSelected(null); setPinEdge(null); }}
              minZoom={0.05} maxZoom={2} proOptions={{ hideAttribution: true }}
            >
              <FitOnKey fitKey={`${fitKey}|${failing}|${search}|${net ? `${discScope}:${map.totals.discovered}` : "-"}|${[...openNs].sort().join(",")}`} />
              <Background gap={24} size={1} color={rgba("ink", 0.05)} />
              <Controls showInteractive={false} />
            </ReactFlow>
          )}
        </div>
        {sel && <CardPanel card={sel} map={map} d={d} deps={depsOf(deps, sel.id)} onPick={setSelected} onClose={() => setSelected(null)} nameOf={nameOf} />}
      </div>
        <ul className={styles.nmLegend} aria-label={t("ob.hm.legend")}>
          <li><span className={styles.nmApmKey} data-level="critical" aria-hidden="true">{BAND_GLYPH.error}</span>{t("ob.apm.legend.critical")}</li>
          <li><span className={styles.nmApmKey} data-level="high" aria-hidden="true">{BAND_GLYPH.latency}</span>{t("ob.apm.legend.high")}</li>
          <li><span className={styles.nmApmKey} data-level="info" aria-hidden="true">{BAND_GLYPH.volume}</span>{t("ob.apm.legend.info")}</li>
          <li><span aria-hidden="true">ⓘ</span>{t("ob.apm.legend.note")}</li>
          <li><span className={styles.nmLine} data-tone="forward" />{t("ob.apm.line.forward")}</li>
          <li><span className={styles.nmLine} data-tone="dropOther" />{t("ob.apm.line.fail")}</li>
          <li><span className={styles.nmLine} data-tone="dropIpv6" />{t("ob.apm.line.async")}</li>
          {net ? <li><span className={styles.nmLine} data-tone="net" />{t("ob.apm.line.net")}</li> : null}
          {net ? <li><span className={styles.nmQuietKey} aria-hidden="true" />{t("ob.apm.disc.legendCard")}</li> : null}
        </ul>
      </section>

      {coverage ? <CoveragePanel c={coverage} open={covOpen} setOpen={setCovOpen} anchor={covRef} /> : null}
      <details className={styles.nmAt}>
        <summary>{t("ob.apm.howMeasured")}</summary>
        <p>{t("ob.apm.howMeasuredHint")}</p>
        {Object.entries(d.queries).map(([k, v]) => <CodeBlock key={k} label={k} code={v} copyLabel={t("ob.slo.copy")} copiedLabel={t("ob.slo.copied")} />)}
      </details>
    </div>
  );
}

function CardPanel({ card: c, map, d, deps, onPick, onClose, nameOf }: { card: ApmPlacedCard; map: ApmMap; d: ServiceGraphResponse; deps: AppDependencies | null; onPick: (id: string) => void; onClose: () => void; nameOf: (id: string) => string }) {
  const { t, locale } = useI18n();
  const rate = useRate();
  const { inbound, outbound } = apmLinksOf(map, c.id);
  const row = (l: ApmLink, peer: string, dir: "in" | "out") => (
    <li key={l.id}>
      <button type="button" className={styles.nmLinkRow} data-tone={l.tone === "fail" ? "dropOther" : "forward"} onClick={() => onPick(peer)}>
        <span className={styles.nmLinkDir}>{dir === "in" ? "←" : "→"}</span>
        <span className={styles.nmLinkPeer} title={nameOf(peer)}>{peer.startsWith("nsg:") ? t("ob.apm.disc.groupName", { ns: nameOf(peer), n: map.cards.find((x) => x.id === peer)?.members ?? 0 }) : nameOf(peer)}</span>
        <span className={styles.nmLinkPort}>{l.net ? t("ob.apm.disc.netKind") : t(`ob.apm.kind.${l.edge.kind}`)}</span>
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
          <small>{c.kind === "entry" ? c.name : c.kind === "discovered" ? t("ob.apm.disc.kind", { ns: c.namespace }) : c.workload ? `${c.workload.kind} · ${c.workload.namespace}/${c.workload.name}` : t("ob.apm.noWorkload")}</small>
        </div>
        <Button size="sm" variant="ghost" ariaLabel={t("hb.nm.close")} onClick={onClose}>✕</Button>
      </header>
      <p className={styles.nmWhy}>{c.kind === "discovered" ? t("ob.apm.disc.why", { p: c.net?.pods ?? 0 }) : c.kind === "entry" ? t("ob.apm.entryHint") : c.inFailed > 0 ? t("ob.apm.why.warn", { f: countText(c.inFailed, locale), m: d.windowMinutes }) : t("ob.apm.why.ok", { m: d.windowMinutes })}</p>
      {c.kind === "discovered" ? (
        <dl className={styles.nmKv}>
          <dt>{t("ob.apm.disc.flows")}</dt><dd>{countText(c.net?.flows ?? 0, locale)}</dd>
          <dt>{t("ob.apm.disc.drops")}</dt><dd>{countText(c.net?.dropped ?? 0, locale)}</dd>
        </dl>
      ) : (
        <dl className={styles.nmKv}>
          {c.kind !== "entry" && <><dt>{t("ob.apm.in")}</dt><dd>{countText(c.inRequests, locale)}{c.inRequests > 0 ? ` (${rate(c.inRate)})` : ""}</dd></>}
          {c.kind !== "entry" && <><dt>{t("ob.apm.failed")}</dt><dd>{countText(c.inFailed, locale)}</dd></>}
          <dt>{t("ob.apm.out")}</dt><dd>{countText(c.outRequests, locale)}</dd>
        </dl>
      )}
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
  const rows = serviceRows(map.cards, signals, marked);
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
                <td><BandCells sig={s ?? null} buckets={buckets} /></td>
                <td className={obs.redNum}>← {s?.callers ?? 0} · → {s?.callees ?? 0}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** The list's signal cell: every band (worst first) in its words — the same as the card, all of them */
function BandCells({ sig, buckets }: { sig: ServiceSignals | null; buckets: number[] }) {
  const { text, rule } = useBandText();
  const bands = bandsOf(sig);
  if (!sig || !bands.length) return <>—</>;
  return (
    <span className={styles.nmBandCells}>
      {bands.map((b) => (
        <span key={b.label} className={styles.nmApmBand} data-level={b.level} title={rule(b, sig)}>
          <span aria-hidden="true">{BAND_GLYPH[b.kind]}</span><span className={styles.nmApmBandText}>{text(b, sig, buckets)}</span>
        </span>
      ))}
    </span>
  );
}

/** Instrumentation coverage — the running workloads of the traced namespaces that send no traces */
function CoveragePanel({ c, open, setOpen, anchor }: { c: Coverage; open: boolean; setOpen: (v: boolean) => void; anchor: RefObject<HTMLElement | null> }) {
  const { t } = useI18n();
  const shown = open ? c.untraced : c.untraced.slice(0, 12);
  return (
    <section ref={anchor} tabIndex={-1} className={styles.nmCoverage} aria-label={t("ob.apm.cov.title")}>
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
