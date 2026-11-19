"use client";

// 네트워크 경로 › Path View (Datadog "Network topology visualization"): the hops of the picked runs left → right, one
// column per TTL, a card per address with its average latency and, when the device looked it up, its AS; an edge per
// way the traceroutes went (thicker = more of them), labelled with the latency it adds; the destination card says
// whether it was reachable (end-to-end probes), its loss and latency. Search hops · hide unknown hops · group by AS or
// segment and collapse the groups · a threshold of your own for "slow" edges. Click a card: its facts at the side.

import { memo, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import ReactFlow, { Controls, Handle, MarkerType, Position, ReactFlowProvider, useNodesInitialized, useReactFlow, type Edge, type Node, type NodeProps } from "reactflow";
import "reactflow/dist/style.css";
import type { NetPathRun } from "@aud/types";
import { useI18n } from "@/lib/i18n";
import { hex } from "@/lib/palette";
import { Button, Chip, SearchInput, Select, TextInput, Toggle } from "@/components/ui";
import {
  DEST_ID, PATH_DEST_H, PATH_NODE_H, PATH_NODE_W, buildGraph, collapse, edgeLabel, groupsOf, layoutPath, matchHops, mergedE2e,
  type GEdge, type GNode, type GroupBy, type GroupNode, type HopGroup,
} from "@/lib/netPathGraph";
import { ms } from "./LatencyProfile";
import s from "./styles.module.css";

type CardData = { n: GNode | GroupNode; passes: number; dim: boolean; hit: boolean; selected: boolean; target: string; device: string; e2e: ReturnType<typeof mergedE2e>; onToggle?: () => void };
type BoxData = { group: HopGroup; label: string; onToggle: () => void };

const HIDDEN = { opacity: 0, pointerEvents: "none" as const };

const Card = memo(function Card({ data }: NodeProps<CardData>) {
  const { t } = useI18n();
  const { n, passes, dim, hit, selected } = data;
  const isGroup = "group" in n;
  const loss = n.ttlLossPct !== null && n.ttlLossPct > 0;
  if (n.kind === "source") {
    return (
      <div className={s.pvCard} data-kind="source" data-dim={dim || undefined} data-selected={selected || undefined}>
        <Handle type="source" position={Position.Right} style={HIDDEN} />
        <span className={s.pvName}>{data.device}</span>
        <span className={s.pvMeta}>{t("np.source")}</span>
      </div>
    );
  }
  if (n.kind === "dest") {
    const e = data.e2e;
    const reach = e ? e.received > 0 : n.traversed > 0;
    return (
      <div className={s.pvCard} data-kind="dest" data-reach={reach ? "ok" : "no"} data-dim={dim || undefined} data-selected={selected || undefined}>
        <Handle type="target" position={Position.Left} style={HIDDEN} />
        <span className={s.pvDestHead}>{reach ? `● ${t("np.pv.reach")}` : `■ ${t("np.pv.noReach")}`}</span>
        <span className={s.pvName} title={data.target}>{data.target}</span>
        <span className={s.pvNums}>
          <span>{e ? t("np.pv.loss", { n: e.lossPct }) : n.ttlLossPct !== null ? t("np.pv.loss", { n: n.ttlLossPct }) : "—"}</span>
          <strong>{ms(e ? e.rttAvg : n.rttAvg)}</strong>
        </span>
      </div>
    );
  }
  if (n.kind === "unknown") {
    return (
      <div className={s.pvCard} data-kind="unknown" data-dim={dim || undefined} data-selected={selected || undefined}>
        <Handle type="target" position={Position.Left} style={HIDDEN} />
        <Handle type="source" position={Position.Right} style={HIDDEN} />
        <span className={s.pvName}>*</span>
        <span className={s.pvMeta}>{t("np.pv.unknownHop", { n: n.ttl })}</span>
      </div>
    );
  }
  const as = n.info?.asn ? `AS${n.info.asn}${n.info.asName ? ` · ${n.info.asName}` : ""}` : null;
  return (
    <div className={s.pvCard} data-kind={isGroup ? "group" : "hop"} data-verdict={n.verdict ?? undefined} data-dim={dim || undefined} data-hit={hit || undefined} data-selected={selected || undefined}>
      <Handle type="target" position={Position.Left} style={HIDDEN} />
      <Handle type="source" position={Position.Right} style={HIDDEN} />
      <span className={s.pvName} title={isGroup ? n.group.key : n.ip ?? ""}>
        {isGroup ? (as ?? t(`np.seg.${n.group.segment ?? "transit"}`)) : n.info?.name ?? n.ip}
      </span>
      <span className={s.pvMeta} title={as ?? undefined}>
        {isGroup ? t("np.pv.groupHops", { n: n.hops }) : as ?? (n.scope ? t(`np.scope.${n.scope}`) : "")}
        {!isGroup && n.info?.name ? ` · ${n.ip}` : ""}
      </span>
      <span className={s.pvNums}>
        <span>
          {loss ? <span className={s.pvLoss} data-verdict={n.verdict ?? undefined}>{n.verdict === "pathLoss" ? "▲" : "◌"} {n.ttlLossPct}%</span> : null}
          {n.traversed < passes ? <span className={s.pvTrav} title={t("np.pv.traversedHint", { n: n.traversed, m: passes })}>{n.traversed}/{passes}</span> : null}
        </span>
        <strong>{isGroup && n.rttMin !== null && n.rttMax !== null ? `${ms(n.rttMin)}–${ms(n.rttMax)}` : ms(n.rttAvg)}</strong>
      </span>
      {isGroup && data.onToggle ? <span className={s.pvGroupBtn}><Button size="sm" variant="ghost" onClick={data.onToggle}>{t("np.pv.expand")}</Button></span> : null}
    </div>
  );
});

function Box({ data }: NodeProps<BoxData>) {
  const { t } = useI18n();
  return (
    <div className={s.pvBox}>
      <span className={s.pvBoxHead}>
        <span title={data.label}>{data.label}</span>
        <Button size="sm" variant="ghost" onClick={data.onToggle}>{t("np.pv.collapse")}</Button>
      </span>
    </div>
  );
}

const NODE_TYPES = { card: Card, box: Box };

/**
 * Place the drawing when its shape changes (not on every hover): the whole path when it fits at a readable size
 * (≥ FIT_MIN_ZOOM — 12 px text stays ≥ 8.4 px), else that size from the source (left) — pan or zoom out for the rest.
 */
export const FIT_MIN_ZOOM = 0.7;
function Fit({ k, bounds, box }: { k: string; bounds: { x0: number; x1: number; y0: number; y1: number }; box: RefObject<HTMLDivElement | null> }) {
  const rf = useReactFlow();
  const ready = useNodesInitialized();
  useEffect(() => {
    const el = box.current;
    if (!ready || !el) return;
    const W = el.clientWidth, H = el.clientHeight, pad = 24;
    const bw = bounds.x1 - bounds.x0, bh = bounds.y1 - bounds.y0;
    const zoom = Math.max(FIT_MIN_ZOOM, Math.min(1.1, (W - 2 * pad) / bw, (H - 2 * pad) / bh));
    const x = bw * zoom <= W - 2 * pad ? (W - bw * zoom) / 2 - bounds.x0 * zoom : pad - bounds.x0 * zoom;
    const y = (H - bh * zoom) / 2 - bounds.y0 * zoom;
    rf.setViewport({ x, y, zoom }, { duration: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, k, rf]);
  return null;
}

export function PathGraph({ runs, target, device }: { runs: NetPathRun[]; target: string; device: string }) {
  const { t } = useI18n();
  const [q, setQ] = useState("");
  const [hideUnknown, setHideUnknown] = useState(true);
  const [by, setBy] = useState<GroupBy>("ip");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [slow, setSlow] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const slowMs = Number(slow) > 0 ? Number(slow) : null;
  const g = useMemo(() => buildGraph(runs, { hideUnknown, slowMs }), [runs, hideUnknown, slowMs]);
  const e2e = useMemo(() => mergedE2e(runs), [runs]);
  const groups = useMemo(() => groupsOf(g, by), [g, by]);
  const hasAsn = useMemo(() => g.nodes.some((n) => n.info?.asn), [g]);
  // groups that no longer exist are not collapsed
  const live = useMemo(() => new Set([...collapsed].filter((id) => groups.some((gr) => gr.id === id))), [collapsed, groups]);
  const view = useMemo(() => {
    const c = collapse(g, groups, live);
    // the destination always has a card: end-to-end probes may reach it when no traceroute did (ICMP not answered)
    if (!c.nodes.some((n) => n.id === DEST_ID)) {
      c.nodes = [...c.nodes, { id: DEST_ID, kind: "dest", ttl: Math.max(0, ...g.nodes.map((n) => n.ttl)) + 1, ip: runs[0]?.targetIp ?? null, traversed: 0, rttAvg: null, rttMin: null, rttMax: null, info: null, scope: null, ttlLossPct: null, verdict: "unreached", segment: "destination" }];
    }
    return c;
  }, [g, groups, live, runs]);
  const pos = useMemo(() => layoutPath(view.nodes), [view.nodes]);
  const hits = useMemo(() => matchHops(view.nodes, q), [view.nodes, q]);
  const toggle = (id: string) => setCollapsed((c) => { const n = new Set(c); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allCollapsed = groups.length > 0 && groups.every((gr) => live.has(gr.id));
  const shape = `${runs.map((r) => r.id).join(",")}|${hideUnknown}|${by}|${[...live].join(",")}`;
  const bounds = useMemo(() => {
    const ps = [...pos.values()];
    return { x0: Math.min(...ps.map((p) => p.x)), x1: Math.max(...ps.map((p) => p.x)) + PATH_NODE_W, y0: Math.min(...ps.map((p) => p.y)) - 40, y1: Math.max(...ps.map((p) => p.y)) + PATH_NODE_H };
  }, [pos]);
  // as tall as the busiest column needs at the readable zoom (240–560 px)
  const canvasH = Math.round(Math.min(560, Math.max(240, (bounds.y1 - bounds.y0) * 0.9 + 96)));
  const canvasRef = useRef<HTMLDivElement>(null);

  const nodes: Node[] = useMemo(() => {
    const out: Node[] = [];
    // group boxes behind the cards (expanded groups)
    for (const gr of groups) {
      if (live.has(gr.id)) continue;
      const ps = gr.nodeIds.map((id) => pos.get(id)).filter((p): p is { x: number; y: number; col: number } => !!p);
      if (!ps.length) continue;
      const x0 = Math.min(...ps.map((p) => p.x)) - 10, x1 = Math.max(...ps.map((p) => p.x)) + PATH_NODE_W + 10;
      const y0 = Math.min(...ps.map((p) => p.y)) - 36, y1 = Math.max(...ps.map((p) => p.y)) + PATH_NODE_H + 10;
      const label = gr.asn ? `AS${gr.asn}${gr.asName ? ` · ${gr.asName}` : ""}` : t(`np.seg.${gr.segment ?? "transit"}`);
      out.push({ id: `box:${gr.id}`, type: "box", position: { x: x0, y: y0 }, data: { group: gr, label, onToggle: () => toggle(gr.id) } satisfies BoxData,
        style: { width: x1 - x0, height: y1 - y0 }, width: x1 - x0, height: y1 - y0, selectable: false, draggable: false, zIndex: 0 });
    }
    for (const n of view.nodes) {
      const p = pos.get(n.id)!;
      const isGroup = "group" in n;
      // the destination card is taller (status band + two rows) and stays centred on its row
      const h = n.kind === "dest" ? PATH_DEST_H : PATH_NODE_H;
      out.push({
        id: n.id, type: "card", position: { x: p.x, y: p.y - (h - PATH_NODE_H) / 2 }, draggable: false, zIndex: 2,
        style: { width: PATH_NODE_W, height: h }, width: PATH_NODE_W, height: h,
        data: { n, passes: g.passes, dim: !!hits && !hits.has(n.id), hit: !!hits?.has(n.id), selected: picked === n.id, target, device, e2e, ...(isGroup ? { onToggle: () => toggle(n.group.id) } : {}) } satisfies CardData,
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, pos, groups, live, hits, picked, g.passes, target, device, e2e, t]);

  const edges: Edge[] = useMemo(() => view.edges.map((e: GEdge) => {
    const dashed = !e.measured || e.skipped > 0;
    const color = e.state === "loss" ? hex("danger") : e.state === "slow" ? hex("warning") : dashed ? hex("ink") : hex("success");
    const label = edgeLabel(e);
    const share = g.passes ? e.count / g.passes : 1;
    const dim = !!hits && !(hits.has(e.from) || hits.has(e.to));
    return {
      id: e.id, source: e.from, target: e.to, type: "default", zIndex: 1,
      className: s.pvEdge, data: e,
      style: { stroke: color, strokeWidth: 1.5 + 3 * share, strokeDasharray: dashed ? "5 4" : undefined, opacity: dim ? 0.25 : dashed ? 0.55 : 1 },
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
      ...(label ? { label: e.skipped ? `${label} · *${e.skipped}` : label, labelBgPadding: [4, 2] as [number, number], labelBgBorderRadius: 8, labelShowBg: true } : {}),
      labelStyle: { fontSize: 12, fill: e.state === "loss" ? hex("danger-strong") : hex("ink") },
      labelBgStyle: { fill: hex("paper"), stroke: color, strokeWidth: 1 },
    };
  }), [view.edges, g.passes, hits]);

  const pickedNode = picked ? view.nodes.find((n) => n.id === picked) ?? null : null;

  return (
    <div className={s.pv}>
      <div className={s.pvTools}>
        <div className={s.pvSearch}><SearchInput label={t("np.pv.search")} value={q} onChange={setQ} placeholder={t("np.pv.searchPh")} /></div>
        <div className={s.pvToolsEnd}>
          <Toggle checked={hideUnknown} onChange={setHideUnknown} title={t("np.pv.hideUnknownHint")}>{t("np.pv.hideUnknown", { n: g.unknownTtls })}</Toggle>
          <Button size="sm" disabled={!groups.length} title={groups.length ? undefined : t("np.pv.noGroups")}
            onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(groups.map((gr) => gr.id)))}>
            {allCollapsed ? t("np.pv.expandAll") : t("np.pv.collapseAll")}
          </Button>
          <Select label={t("np.pv.groupBy")} value={by} onChange={(v) => setBy(v as GroupBy)}
            options={[{ value: "ip", label: t("np.pv.by.ip") }, { value: "asn", label: t(hasAsn ? "np.pv.by.asn" : "np.pv.by.asnNone") }, { value: "segment", label: t("np.pv.by.segment") }]} />
          <TextInput label={t("np.pv.slow")} type="number" value={slow} onChange={setSlow} width={110} placeholder={t("np.pv.slowPh")} />
        </div>
      </div>
      {by === "asn" && !hasAsn ? <p className={s.muted}>{t("np.pv.asnHow")}</p> : null}
      {g.unpaired ? <p className={s.muted}>{t("np.pv.unpaired")}</p> : null}
      <div className={s.pvLayout} data-side={pickedNode ? "" : undefined}>
        <div className={s.pvCanvas} data-path-graph ref={canvasRef} style={{ height: canvasH }}>
          <ReactFlowProvider>
            <ReactFlow nodes={nodes} edges={edges} nodeTypes={NODE_TYPES} nodesDraggable={false} nodesConnectable={false} elementsSelectable
              minZoom={0.2} maxZoom={2} proOptions={{ hideAttribution: true }} onlyRenderVisibleElements={false}
              onNodeClick={(_, n) => { if (n.type === "card") setPicked((p) => (p === n.id ? null : n.id)); }} onPaneClick={() => setPicked(null)}>
              <Controls showInteractive={false} position="top-right" />
              <Fit k={shape} bounds={bounds} box={canvasRef} />
            </ReactFlow>
          </ReactFlowProvider>
        </div>
        {pickedNode ? <HopDetail n={pickedNode} passes={g.passes} e2e={e2e} target={target} /> : null}
      </div>
      <ul className={s.legend}>
        <li><span className={s.pvKey} data-k="ok" aria-hidden="true" />{t("np.pv.key.ok")}</li>
        <li><span className={s.pvKey} data-k="loss" aria-hidden="true" />{t("np.pv.key.loss")}</li>
        <li><span className={s.pvKey} data-k="slow" aria-hidden="true" />{t("np.pv.key.slow")}</li>
        <li><span className={s.pvKey} data-k="dashed" aria-hidden="true" />{t("np.pv.key.dashed")}</li>
        <li>{t("np.pv.key.width", { n: g.passes, r: g.runs })}</li>
        <li>{t("np.pv.key.completed", { n: g.completed, m: g.passes })}</li>
      </ul>
    </div>
  );
}

/** A picked card's facts */
function HopDetail({ n, passes, e2e, target }: { n: GNode | GroupNode; passes: number; e2e: ReturnType<typeof mergedE2e>; target: string }) {
  const { t } = useI18n();
  const isGroup = "group" in n;
  const rows: Array<[string, string]> = [];
  if (n.kind === "dest") {
    rows.push([t("np.pv.d.target"), target]);
    if (n.ip) rows.push([t("np.pv.d.address"), n.ip]);
    if (e2e) {
      rows.push([t("np.pv.d.e2e"), e2e.protocol === "tcp" ? t("np.pv.d.tcp", { p: e2e.port ?? 443 }) : "ICMP"]);
      rows.push([t("np.pv.d.probes"), t("np.pv.d.probesN", { r: e2e.received, s: e2e.sent })]);
      rows.push([t("np.cell.loss"), `${e2e.lossPct}%`]);
      rows.push([t("np.cell.rtt"), `${ms(e2e.rttAvg)} (${ms(e2e.rttMin)} – ${ms(e2e.rttMax)})`]);
      rows.push([t("np.an.jitter"), ms(e2e.jitter)]);
    }
    rows.push([t("np.pv.d.icmp"), n.traversed ? t("np.pv.d.icmpYes", { n: n.traversed, m: passes, ttl: n.ttl }) : t("np.pv.d.icmpNo")]);
  } else if (n.kind === "source") {
    rows.push([t("np.pv.d.traversed"), `${passes}`]);
  } else {
    if (!isGroup) rows.push(["TTL", String(n.ttl)]);
    if (n.ip) rows.push([t("np.pv.d.address"), n.ip]);
    if (n.info?.name) rows.push([t("np.pv.d.ptr"), n.info.name]);
    if (n.info?.asn) rows.push(["AS", `AS${n.info.asn}${n.info.asName ? ` · ${n.info.asName}` : ""}`]);
    if (n.info?.prefix) rows.push([t("np.pv.d.prefix"), `${n.info.prefix}${n.info.country ? ` · ${n.info.country}` : ""}`]);
    if (n.scope) rows.push([t("np.pv.d.scope"), t(`np.scope.${n.scope}`)]);
    if (isGroup) rows.push([t("np.pv.d.members"), t("np.pv.groupHops", { n: n.hops })]);
    rows.push([t("np.pv.d.traversed"), t("np.pv.d.traversedN", { n: n.traversed, m: passes })]);
    if (n.kind === "hop") {
      rows.push([t("np.cell.rtt"), `${ms(n.rttAvg)} (${ms(n.rttMin)} – ${ms(n.rttMax)})`]);
      if (n.ttlLossPct !== null) rows.push([t("np.pv.d.ttlLoss"), `${n.ttlLossPct}%`]);
    }
  }
  const why = n.kind === "unknown" ? "silent" : n.verdict === "icmpLimited" || n.verdict === "pathLoss" || n.verdict === "destLoss" ? n.verdict : null;
  return (
    <aside className={s.pvSide} aria-label={t("np.pv.detail")}>
      <h3>{n.kind === "dest" ? t("np.pv.dest") : n.kind === "source" ? t("np.source") : isGroup ? t("np.pv.group") : n.kind === "unknown" ? t("np.pv.unknownHop", { n: n.ttl }) : t("np.chart.hop", { n: n.ttl })}</h3>
      <dl>{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
      {why ? <p className={s.muted}>{t(`np.why.${why}`)}</p> : null}
      {n.info?.asn ? <p className={s.sub}>{t("np.pv.d.lookupSource")}</p> : null}
      {n.kind === "hop" && !isGroup && n.verdict === "pathLoss" ? <Chip level="warn">{t("np.legend.pathLoss")}</Chip> : null}
    </aside>
  );
}

