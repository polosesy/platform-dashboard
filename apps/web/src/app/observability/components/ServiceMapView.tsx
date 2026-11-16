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
import type { ServiceGraphResponse } from "@aud/types";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiQuery } from "@/lib/useApiQuery";
import { useI18n } from "@/lib/i18n";
import { rgba } from "@/lib/palette";
import { Button, Chip, CodeBlock, EmptyState, ErrorNotice, LoadingState, Notice, SearchInput, Segmented } from "@/components/ui";
import { answersAt, atParam, fitWindow, type TimeRange } from "@/lib/timeRange";
import { useRangeRefresh } from "@/lib/useTimeRange";
import { RED_WINDOWS, countText, errorRateText, quantileText, rateText } from "@/lib/redView";
import { NET_GLYPH, apmLinksOf, buildApmMap, type ApmBox, type ApmLink, type ApmMap, type ApmPlacedCard } from "@/lib/apmServiceMap";
import styles from "../../hubble/styles.module.css";

type CardData = { card: ApmPlacedCard; dim: boolean; selected: boolean };
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
        <span>{c.kind === "entry" ? c.name : c.workload ? `${c.workload.kind} · ${c.workload.namespace}` : t("ob.apm.noWorkload")}</span>
      </div>
      <div className={styles.nmCells}>
        {c.kind === "entry"
          ? <span><small>{t("ob.apm.out")}</small>{countText(c.outRequests, locale)}</span>
          : <span><small>{t("ob.apm.in")}</small>{c.inRequests > 0 ? rate(c.inRate) : "—"}</span>}
        <span data-hot={c.inFailed > 0 || undefined}><small>{t("ob.apm.failed")}</small>{c.kind === "entry" ? "—" : countText(c.inFailed, locale)}</span>
      </div>
    </div>
  );
});

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
      <ServiceMap d={d} fitKey={`${clusterId}|${fit.value}|${atQ ?? "now"}`} windowChip={fit.differs ? t("ob.apm.window", { n: fit.value }) : null} />
    </ReactFlowProvider>
  );
}

function ServiceMap({ d, fitKey, windowChip }: { d: ServiceGraphResponse; fitKey: string; windowChip: string | null }) {
  const { t, locale } = useI18n();
  const [failing, setFailing] = useState(false);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const map: ApmMap = useMemo(() => buildApmMap(d, { failing, search }), [d, failing, search]);
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
        data: { card: c, dim: !!near && !near.has(c.id), selected: selected === c.id } satisfies CardData, draggable: false, zIndex: 10,
      });
    }
    return out;
  }, [map, near, selected]);

  const edges: Edge[] = useMemo(() => map.links.map((l) => {
    const tone = TONE[l.tone];
    const on = !!focus && (l.source === focus || l.target === focus);
    return {
      id: l.id, source: l.source, target: l.target, type: "smoothstep",
      style: { stroke: tone.color, strokeWidth: on ? l.width + 0.8 : l.width * 0.7, strokeDasharray: tone.dash, opacity: focus && !on ? 0.06 : on ? 1 : l.tone === "fail" ? 0.95 : 0.5 },
      markerEnd: { type: MarkerType.ArrowClosed, color: tone.color, width: 14, height: 14 },
      ...(on ? { label: `${rate(l.edge.rate)}${l.edge.failed ? ` · ${t("ob.apm.failed")} ${countText(l.edge.failed, locale)}` : ""} · p95 ${quantileText(l.edge.p95, d.buckets)}`, labelStyle: { fontSize: 12 }, labelBgPadding: [4, 2] as [number, number] } : {}),
      zIndex: on ? 20 : 5,
    } satisfies Edge;
  }), [map.links, focus, t, locale, rate, d.buckets]);

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
        </ul>
      </div>

      <div className={styles.nmLayout} data-open={!!sel || undefined}>
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
        {sel && <CardPanel card={sel} map={map} d={d} onPick={setSelected} onClose={() => setSelected(null)} />}
      </div>

      <details className={styles.nmAt}>
        <summary>{t("ob.apm.howMeasured")}</summary>
        <p>{t("ob.apm.howMeasuredHint")}</p>
        {Object.entries(d.queries).map(([k, v]) => <CodeBlock key={k} label={k} code={v} copyLabel={t("ob.slo.copy")} copiedLabel={t("ob.slo.copied")} />)}
      </details>
    </div>
  );
}

function CardPanel({ card: c, map, d, onPick, onClose }: { card: ApmPlacedCard; map: ApmMap; d: ServiceGraphResponse; onPick: (id: string) => void; onClose: () => void }) {
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
          {rate(l.edge.rate)} · p95 {quantileText(l.edge.p95, d.buckets)}
          {l.edge.failed ? <b> · {t("ob.apm.failed")} {countText(l.edge.failed, locale)} ({errorRateText(l.edge.errorRate)})</b> : null}
          {l.edge.lowTraffic ? <> · {t("ob.apm.lowTraffic")}</> : null}
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
      <p className={styles.nmWhy}>{c.kind === "entry" ? t("ob.apm.entryHint") : c.inFailed > 0 ? t("ob.apm.why.warn", { f: countText(c.inFailed, locale), m: d.windowMinutes }) : t("ob.apm.why.ok", { m: d.windowMinutes })}</p>
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
      <p className={styles.nmAt}>{t("ob.apm.panelNote")}</p>
    </aside>
  );
}
