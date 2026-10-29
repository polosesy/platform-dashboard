"use client";

// VNet 트래픽 › 트래픽 맵 — the Pod traffic service map's grammar and CSS module (app/hubble) for VNet flow
// logs (lib/vnetFlowMap.ts): VNets are boxes, subnets cards, address classes in (left) and out (right). Lines: grey
// allowed · red dashed denied / malicious, width = bytes. Hover or select a card: its lines stay, the rest dims, the
// panel lists its lines with ports. Flow logs are a range aggregate (Traffic Analytics), so there is no "live" here —
// the range above the tabs decides; the view is fitted when the range, VNet or filters change.

import { memo, useEffect, useMemo, useRef, useState } from "react";
import ReactFlow, { Background, Controls, Handle, MarkerType, Position, ReactFlowProvider, useNodesInitialized, useReactFlow, type Edge, type Node, type NodeProps } from "reactflow";
import "reactflow/dist/style.css";
import type { NetMapData } from "@aud/types";
import { dateLocale, useI18n } from "@/lib/i18n";
import { rgba } from "@/lib/palette";
import { Button, EmptyState, SearchInput, Segmented } from "@/components/ui";
import { NET_GLYPH, buildVnetMap, formatBytes, vLinksOf, type VBox, type VLink, type VMap, type VPlacedCard } from "@/lib/vnetFlowMap";
import styles from "../../hubble/styles.module.css";

type CardData = { card: VPlacedCard; dim: boolean; selected: boolean };
type BoxData = { box: VBox };

const HiddenHandles = () => (
  <>
    <Handle type="target" position={Position.Left} className={styles.handleHidden} />
    <Handle type="source" position={Position.Right} className={styles.handleHidden} />
  </>
);

function useCardText() {
  const { t } = useI18n();
  return (c: Pick<VPlacedCard, "kind" | "external" | "name" | "vnet">) => ({
    name: c.external ? t(`net.map.ext.${c.external}`) : c.name,
    kind: c.external ? t(c.kind === "externalIn" ? "net.map.from" : "net.map.to") : t("net.map.subnetIn", { vnet: c.vnet.split("/")[1] ?? c.vnet }),
  });
}

const CardNode = memo(function CardNode({ data }: NodeProps<CardData>) {
  const { t } = useI18n();
  const text = useCardText();
  const c = data.card;
  const { name, kind } = text(c);
  const bytes = c.bytesIn + c.bytesOut + c.bytesWithin;
  return (
    <div className={styles.nmCard} data-status={c.status} data-dim={data.dim || undefined} data-selected={data.selected || undefined}
      data-kind={c.kind === "externalIn" ? "internetIn" : c.kind === "externalOut" ? "internetOut" : "workload"}>
      <HiddenHandles />
      <div className={styles.nmCardTop}>
        <span className={styles.nmGlyph} aria-hidden="true">{NET_GLYPH[c.status]}</span>
        <span className={styles.nmCardName} title={c.external ? name : `${c.vnet}/${c.name}`}>{name}</span>
      </div>
      <div className={styles.nmCardKind}>
        <span>{kind}</span>
        {c.bytesWithin > 0 && <span className={styles.nmHub} title={t("net.map.withinHint")}>{t("net.map.within", { v: formatBytes(c.bytesWithin) })}</span>}
        {c.maliciousRecords > 0 && <span className={styles.nmHub} title={t("net.map.maliciousHint")}>{t("net.map.malicious", { n: c.maliciousRecords })}</span>}
      </div>
      <div className={styles.nmCells}>
        <span><small>{t("net.bytes")}</small>{formatBytes(bytes)}</span>
        <span data-hot={c.deniedFlows > 0 || undefined}><small>{t("net.deniedShort")}</small>{c.deniedFlows.toLocaleString()}</span>
      </div>
    </div>
  );
});

const BoxNode = memo(function BoxNode({ data }: NodeProps<BoxData>) {
  const { t } = useI18n();
  const b = data.box;
  const title = b.kind === "laneIn" ? t("net.map.laneIn") : b.kind === "laneOut" ? t("net.map.laneOut") : b.title;
  return (
    <div className={styles.nmBox} data-kind={b.kind === "vnet" ? "namespace" : b.kind}>
      <div className={styles.nmBoxHead}>
        {b.kind === "vnet" && <span className={styles.nmBoxTag}>VNet</span>}
        <span className={styles.nmBoxTitle} title={b.kind === "vnet" ? `${b.sub}/${b.title}` : title}>{title}</span>
        <span className={styles.nmBoxCounts}>
          {b.counts.danger ? <span data-status="danger">{NET_GLYPH.danger}{b.counts.danger}</span> : null}
        </span>
      </div>
    </div>
  );
});

const NODE_TYPES = { vCard: CardNode, vBox: BoxNode };
const TONE: Record<VLink["tone"], { color: string; dash?: string }> = {
  forward: { color: rgba("ink", 0.38) },
  drop: { color: rgba("danger", 0.9), dash: "6 4" },
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

export function TrafficMapSection(props: { map: NetMapData; rangeKey: string; onTalkers: () => void }) {
  return (
    <ReactFlowProvider>
      <TrafficMap {...props} />
    </ReactFlowProvider>
  );
}

function TrafficMap({ map: data, rangeKey, onTalkers }: { map: NetMapData; rangeKey: string; onTalkers: () => void }) {
  const { t } = useI18n();
  const [denied, setDenied] = useState(false);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const map: VMap = useMemo(() => buildVnetMap(data, { denied, search }), [data, denied, search]);

  const focus = selected ?? hover;
  const near = useMemo(() => {
    if (!focus) return null;
    const s = new Set([focus]);
    for (const l of map.links) if (l.source === focus || l.target === focus) { s.add(l.source); s.add(l.target); }
    return s;
  }, [focus, map.links]);

  const nodes: Node[] = useMemo(() => {
    const out: Node[] = map.boxes.map((b) => ({
      id: b.id, type: "vBox", position: { x: b.x, y: b.y }, width: b.w, height: b.h, style: { width: b.w, height: b.h, pointerEvents: "none" },
      data: { box: b } satisfies BoxData, draggable: false, selectable: false, zIndex: 0,
    }));
    for (const c of map.cards) {
      out.push({
        id: c.id, type: "vCard", position: { x: c.x, y: c.y }, width: c.w, height: c.h, style: { width: c.w, height: c.h },
        data: { card: c, dim: !!near && !near.has(c.id), selected: selected === c.id } satisfies CardData, draggable: false, zIndex: 10,
      });
    }
    return out;
  }, [map, near, selected]);

  const edges: Edge[] = useMemo(() => map.links.map((l) => {
    const tone = TONE[l.tone];
    const on = !!focus && (l.source === focus || l.target === focus);
    const top = l.edge.ports[0];
    return {
      id: l.id, source: l.source, target: l.target, type: "smoothstep",
      style: { stroke: tone.color, strokeWidth: on ? l.width + 0.8 : l.width * 0.7, strokeDasharray: tone.dash, opacity: focus && !on ? 0.06 : on ? 1 : l.tone === "forward" ? 0.5 : 0.9 },
      markerEnd: { type: MarkerType.ArrowClosed, color: tone.color, width: 14, height: 14 },
      ...(on ? { label: `${formatBytes(l.edge.bytes)}${top ? ` · ${top.proto ?? ""}:${top.port ?? "—"}` : ""}${l.edge.deniedFlows ? ` · ${t("net.deniedShort")} ${l.edge.deniedFlows.toLocaleString()}` : ""}`, labelStyle: { fontSize: 11 }, labelBgPadding: [4, 2] as [number, number] } : {}),
      zIndex: on ? 20 : 5,
    } satisfies Edge;
  }), [map.links, focus, t]);

  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setSelected(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);
  useEffect(() => setSelected(null), [rangeKey]);

  const sel = map.cards.find((c) => c.id === selected) ?? null;
  return (
    <div className={styles.nm}>
      <div className={styles.nmBar}>
        <Segmented label={t("net.map.show")} value={denied ? "denied" : "all"} onChange={(v) => setDenied(v === "denied")}
          items={[{ id: "all", label: t("net.map.all") }, { id: "denied", label: t("net.map.deniedOnly") }]} />
        <SearchInput label={t("net.map.search")} value={search} onChange={setSearch} placeholder={t("net.map.search")} />
      </div>

      <div className={styles.nmSummary}>
        <span>{t("net.map.summary", { s: map.totals.subnets, v: map.totals.vnets, l: map.totals.links })}</span>
        {map.totals.deniedLinks > 0 && <span data-status="danger">{NET_GLYPH.danger} {t("net.map.deniedLinks", { n: map.totals.deniedLinks })}</span>}
        {map.totals.maliciousLinks > 0 && <span data-status="danger">{t("net.map.maliciousLinks", { n: map.totals.maliciousLinks })}</span>}
        {data.unplaced.records > 0 && (
          <span className={styles.nmAt} title={t("net.map.unplacedHint")}>
            ⓘ {t("net.map.unplaced", { v: formatBytes(data.unplaced.bytes), n: data.unplaced.records.toLocaleString() })}{" "}
            <Button size="sm" variant="ghost" onClick={onTalkers}>{t("net.map.toTalkers")}</Button>
          </span>
        )}
        {data.omitted > 0 && <span className={styles.nmAt}>{t("net.map.omitted", { n: data.omitted })}</span>}
        <ul className={styles.nmLegend} aria-label={t("ob.hm.legend")}>
          <li data-status="ok"><span aria-hidden="true">{NET_GLYPH.ok}</span>{t("net.map.status.ok")}</li>
          <li data-status="danger"><span aria-hidden="true">{NET_GLYPH.danger}</span>{t("net.map.status.danger")}</li>
          <li><span className={styles.nmLine} data-tone="forward" />{t("net.map.line.forward")}</li>
          <li><span className={styles.nmLine} data-tone="drop" />{t("net.map.line.drop")}</li>
        </ul>
      </div>

      <div className={styles.nmLayout} data-open={!!sel || undefined}>
        <div className={styles.nmCanvas}>
          {map.cards.length === 0 ? (
            <EmptyState title={t(denied ? "net.map.noDenied" : "net.map.noData")}>{t(denied ? "net.map.noDeniedHint" : "net.map.noDataHint")}</EmptyState>
          ) : (
            <ReactFlow
              nodes={nodes} edges={edges} nodeTypes={NODE_TYPES}
              nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} elevateNodesOnSelect={false}
              onNodeClick={(_, n) => { if (n.type === "vCard") setSelected((p) => (p === n.id ? null : n.id)); }}
              onNodeMouseEnter={(_, n) => { if (n.type === "vCard") setHover(n.id); }}
              onNodeMouseLeave={() => setHover(null)}
              onPaneClick={() => setSelected(null)}
              minZoom={0.05} maxZoom={2} proOptions={{ hideAttribution: true }}
            >
              <FitOnKey fitKey={`${rangeKey}|${denied}|${search}`} />
              <Background gap={24} size={1} color={rgba("ink", 0.05)} />
              <Controls showInteractive={false} />
            </ReactFlow>
          )}
        </div>
        {sel && <CardPanel card={sel} map={map} onPick={setSelected} onClose={() => setSelected(null)} />}
      </div>
    </div>
  );
}

function CardPanel({ card: c, map, onPick, onClose }: { card: VPlacedCard; map: VMap; onPick: (id: string) => void; onClose: () => void }) {
  const { t, locale } = useI18n();
  const text = useCardText();
  const { inbound, outbound } = vLinksOf(map, c.id);
  const nameOf = (id: string) => {
    const p = map.cards.find((x) => x.id === id);
    return p ? (p.external ? text(p).name : `${p.vnet.split("/")[1] ?? ""}/${p.name}`) : id;
  };
  const row = (l: VLink, peer: string, dir: "in" | "out") => (
    <li key={l.id}>
      <button type="button" className={styles.nmLinkRow} data-tone={l.tone} onClick={() => onPick(peer)}
        title={l.edge.ports.map((p) => `${p.proto ?? ""}:${p.port ?? "—"} ${formatBytes(p.bytes)}${p.deniedFlows ? ` · ${t("net.deniedShort")} ${p.deniedFlows}` : ""}`).join("\n")}>
        <span className={styles.nmLinkDir}>{dir === "in" ? "←" : "→"}</span>
        <span className={styles.nmLinkPeer} title={nameOf(peer)}>{nameOf(peer)}</span>
        <span className={styles.nmLinkPort}>{l.edge.ports.slice(0, 3).map((p) => `${p.proto ?? ""}:${p.port ?? "—"}`).join(" ")}</span>
        <span className={styles.nmLinkFlows}>
          {formatBytes(l.edge.bytes)}
          {l.edge.deniedFlows ? <b> · {t("net.deniedShort")} {l.edge.deniedFlows.toLocaleString()}{l.edge.deniedPorts.length ? ` (${l.edge.deniedPorts.slice(0, 5).join(", ")})` : ""}</b> : null}
          {l.edge.maliciousRecords ? <b> · {t("net.map.malicious", { n: l.edge.maliciousRecords })}</b> : null}
        </span>
      </button>
    </li>
  );
  const { name, kind } = text(c);
  const why = c.status === "danger" ? t("net.map.why.danger", { d: c.deniedFlows.toLocaleString(), m: c.maliciousRecords }) : t("net.map.why.ok");
  const last = [...inbound, ...outbound].map((l) => l.edge.last).filter((x): x is string => !!x).sort().pop();
  return (
    <aside className={styles.nmPanel} aria-label={name}>
      <header className={styles.nmPanelHead} data-status={c.status}>
        <span className={styles.nmGlyph} aria-hidden="true">{NET_GLYPH[c.status]}</span>
        <div>
          <strong title={c.external ? name : `${c.vnet}/${c.name}`}>{name}</strong>
          <small>{kind}</small>
        </div>
        <Button size="sm" variant="ghost" ariaLabel={t("hb.nm.close")} onClick={onClose}>✕</Button>
      </header>
      <p className={styles.nmWhy}>{c.external ? t(`net.map.extHint.${c.external}`) : why}</p>
      <dl className={styles.nmKv}>
        <dt>{t("net.map.bytesIn")}</dt><dd>{formatBytes(c.bytesIn)}</dd>
        <dt>{t("net.map.bytesOut")}</dt><dd>{formatBytes(c.bytesOut)}</dd>
        {c.bytesWithin > 0 && <><dt>{t("net.map.bytesWithin")}</dt><dd>{formatBytes(c.bytesWithin)}</dd></>}
        <dt>{t("net.allowed")}</dt><dd>{c.allowedFlows.toLocaleString()}</dd>
        <dt>{t("net.deniedShort")}</dt><dd>{c.deniedFlows.toLocaleString()}</dd>
        {c.maliciousRecords > 0 && <><dt>{t("net.map.maliciousShort")}</dt><dd>{c.maliciousRecords.toLocaleString()}</dd></>}
        {last && <><dt>{t("net.map.last")}</dt><dd>{new Date(last).toLocaleString(dateLocale(locale))}</dd></>}
      </dl>
      {inbound.length > 0 && <section><h4>{t("hb.inbound", { n: inbound.length })}</h4><ul className={styles.nmLinks}>{inbound.map((l) => row(l, l.source, "in"))}</ul></section>}
      {outbound.length > 0 && <section><h4>{t("hb.outbound", { n: outbound.length })}</h4><ul className={styles.nmLinks}>{outbound.map((l) => row(l, l.target, "out"))}</ul></section>}
      <p className={styles.nmAt}>{t("net.map.panelNote")}</p>
    </aside>
  );
}
