"use client";

// AKS 모니터링 › 네트워크 (Hubble) › 서비스 맵 — the live diagram's grammar for Kubernetes (lib/k8sNetMap.ts):
// namespaces are boxes, workloads cards (status strip + ● ▲ ■ ○ glyph, two metric cells), left → right = the way
// requests go (Internet in · namespaces by request step · Internet out and the cluster's own parts on the right).
// Lines: colour = what happened (grey forwarded · red dashed dropped · amber HTTP errors), width = flows (log),
// faded = not in the last sample. Labels and the rest-of-the-map dimming only on hover / selection.
//
// Rendering: no physics and no automatic refresh by default — one sample when the view opens, "새 표본" on demand,
// or "실시간" (30 s, visible tab only). Samples accumulate (remember), so a workload that was quiet in one sample
// fades instead of vanishing, and positions change only when a card or line appears or disappears. Every node has
// its width / height (React Flow hides unmeasured nodes — the old map blinked on each poll) and the view is fitted
// only when the cluster, window or filters change.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactFlow, { Background, Controls, Handle, MarkerType, Position, ReactFlowProvider, useNodesInitialized, useReactFlow, type Edge, type Node, type NodeProps } from "reactflow";
import "reactflow/dist/style.css";
import type { HubbleServiceMapResponse } from "@aud/types";
import { apiUrl, fetchJsonWithBearer, isPermanentApiError } from "@/lib/api";
import { useApiToken } from "@/lib/useApiToken";
import { startPolling } from "@/lib/usePolling";
import { dateLocale, useI18n } from "@/lib/i18n";
import { rgba } from "@/lib/palette";
import { Button, EmptyState, ErrorNotice, LoadingState, SearchInput, Segmented, Select } from "@/components/ui";
import { NET_GLYPH, buildNetMap, emptyMemory, linksOf, remember, shortWorkload, type NetBox, type NetLink, type NetMap, type NetMemory, type NetPlacedCard } from "@/lib/k8sNetMap";
import { CoverageNote } from "./CoverageNote";
import styles from "../styles.module.css";

/** live = a new sample every 30 s (visible tab); nonce = one new sample now — HubbleTab owns both for all four views */
type Props = { clusterId: string; live?: boolean; nonce?: number };

const WINDOWS = [1, 5, 15, 30] as const;
/** How long a workload / line not seen again stays (faded) on the map */
const MEMORY_TTL_MS = 15 * 60_000;
const LIVE_MS = 30_000;

type CardData = { card: NetPlacedCard; dim: boolean; selected: boolean };
type BoxData = { box: NetBox };

const HiddenHandles = () => (
  <>
    <Handle type="target" position={Position.Left} className={styles.handleHidden} />
    <Handle type="source" position={Position.Right} className={styles.handleHidden} />
  </>
);

const NetCardNode = memo(function NetCardNode({ data }: NodeProps<CardData>) {
  const { t } = useI18n();
  const c = data.card;
  const kind = c.kind === "workload" ? t("hb.nm.kind.workload", { n: c.pods }) : t(`hb.nm.kind.${c.kind === "platform" ? c.serviceType : c.kind}`);
  const name = c.kind === "workload" ? shortWorkload(c.name, c.namespace) : c.kind === "internetIn" ? t("hb.nm.internetIn") : c.kind === "internetOut" ? t("hb.nm.internetOut") : c.name;
  const second = c.httpRequests > 0
    ? { k: "HTTP 5xx", v: c.httpErrors.toLocaleString() }
    : c.dnsQueries > 0 ? { k: "DNS err", v: c.dnsErrors.toLocaleString() } : { k: t("hb.nm.drops"), v: c.drops.toLocaleString() };
  return (
    <div className={styles.nmCard} data-status={c.status} data-dim={data.dim || undefined} data-selected={data.selected || undefined} data-kind={c.kind}>
      <HiddenHandles />
      <div className={styles.nmCardTop}>
        <span className={styles.nmGlyph} aria-hidden="true">{NET_GLYPH[c.status]}</span>
        <span className={styles.nmCardName} title={c.kind === "workload" ? `${c.namespace}/${c.name}` : name}>{name}</span>
      </div>
      <div className={styles.nmCardKind}>
        <span>{kind}{c.k8sServices ? ` · Service ${c.k8sServices}` : ""}</span>
        {(["dns", "api", "node"] as const).map((h) => (c.hubs[h] ? <span key={h} className={styles.nmHub} title={t(`hb.nm.hub.${h}`)}>{t(`hb.nm.hubShort.${h}`)}</span> : null))}
      </div>
      <div className={styles.nmCells}>
        <span><small>{t("hb.nm.flows")}</small>{c.flows.toLocaleString()}</span>
        <span data-hot={(second.k === t("hb.nm.drops") ? c.drops : second.k === "HTTP 5xx" ? c.httpErrors : c.dnsErrors) > 0 || undefined}><small>{second.k}</small>{second.v}</span>
      </div>
    </div>
  );
});

const NetBoxNode = memo(function NetBoxNode({ data }: NodeProps<BoxData>) {
  const { t } = useI18n();
  const b = data.box;
  const title = b.kind === "laneIn" ? t("hb.nm.laneIn") : b.kind === "laneOut" ? t("hb.nm.laneOut") : b.title;
  return (
    <div className={styles.nmBox} data-kind={b.kind} data-system={b.system || undefined}>
      <div className={styles.nmBoxHead}>
        {b.kind === "namespace" && <span className={styles.nmBoxTag}>ns</span>}
        <span className={styles.nmBoxTitle} title={title}>{title}</span>
        <span className={styles.nmBoxCounts}>
          {(["danger", "warn"] as const).map((s) => (b.counts[s] ? <span key={s} data-status={s}>{NET_GLYPH[s]}{b.counts[s]}</span> : null))}
        </span>
      </div>
    </div>
  );
});

const NODE_TYPES = { netCard: NetCardNode, netBox: NetBoxNode };

const TONE: Record<NetLink["tone"], { color: string; dash?: string }> = {
  forward: { color: rgba("ink", 0.38) },
  drop: { color: rgba("danger", 0.9), dash: "6 4" },
  l7err: { color: rgba("warning", 0.95) },
};

/** Fit once per key (cluster · window · filters) after React Flow has the nodes — never on a refresh */
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

export function ServiceMapTab(props: Props) {
  return (
    <ReactFlowProvider>
      <NetworkMap {...props} />
    </ReactFlowProvider>
  );
}

function NetworkMap({ clusterId, live = false, nonce = 0 }: Props) {
  const { t, locale } = useI18n();
  const getApiToken = useApiToken();
  const [win, setWin] = useState<number>(5);
  const [ns, setNs] = useState("");
  const [verdict, setVerdict] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [last, setLast] = useState<HubbleServiceMapResponse | null>(null);
  const mem = useRef<NetMemory>(emptyMemory());
  const [memVersion, setMemVersion] = useState(0);

  const sample = useCallback(async () => {
    if (!clusterId) return;
    setLoading(true);
    try {
      const token = await getApiToken();
      const data = await fetchJsonWithBearer<HubbleServiceMapResponse>(apiUrl("/api/hubble/service-map", { clusterId, timeWindow: win, lang: locale }), token);
      if (data.clusterId !== clusterId) return;
      mem.current = remember(mem.current, data, Date.now(), MEMORY_TTL_MS);
      setLast(data);
      setError(null);
      setMemVersion((v) => v + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return !isPermanentApiError(e);
    } finally {
      setLoading(false);
    }
  }, [clusterId, win, locale, getApiToken]);

  // A new cluster / window starts a new memory and takes one sample
  useEffect(() => {
    mem.current = emptyMemory();
    setLast(null);
    setSelected(null);
    setMemVersion((v) => v + 1);
    void sample();
  }, [clusterId, win]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => (live ? startPolling(sample, LIVE_MS) : undefined), [live, sample]);
  // "새 표본" — added to the memory, the layout moves only if a card or line appears / goes
  const firstNonce = useRef(nonce);
  useEffect(() => { if (nonce !== firstNonce.current) void sample(); }, [nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  const map: NetMap = useMemo(() => buildNetMap(mem.current, { search, verdict, namespace: ns }), [memVersion, search, verdict, ns]); // eslint-disable-line react-hooks/exhaustive-deps
  const namespaces = useMemo(() => [...new Set([...mem.current.nodes.values()].map((x) => x.node.namespace).filter(Boolean))].sort(), [memVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  // Focus = the selected card, else the hovered one: its lines and neighbours stay, the rest dims
  const focus = selected ?? hover;
  const near = useMemo(() => {
    if (!focus) return null;
    const s = new Set([focus]);
    for (const l of map.links) if (l.source === focus || l.target === focus) { s.add(l.source); s.add(l.target); }
    return s;
  }, [focus, map.links]);

  const nodes: Node[] = useMemo(() => {
    const out: Node[] = map.boxes.map((b) => ({
      id: b.id, type: "netBox", position: { x: b.x, y: b.y }, width: b.w, height: b.h, style: { width: b.w, height: b.h, pointerEvents: "none" },
      data: { box: b } satisfies BoxData, draggable: false, selectable: false, zIndex: 0,
    }));
    for (const c of map.cards) {
      out.push({
        id: c.id, type: "netCard", position: { x: c.x, y: c.y }, width: c.w, height: c.h, style: { width: c.w, height: c.h },
        data: { card: c, dim: !!near && !near.has(c.id), selected: selected === c.id } satisfies CardData, draggable: false, zIndex: 10,
      });
    }
    return out;
  }, [map, near, selected]);

  const edges: Edge[] = useMemo(() => map.links.flatMap((l) => {
    const tone = TONE[l.tone];
    const on = !!focus && (l.source === focus || l.target === focus);
    // Hub lines (DNS · API server · nodes) only for the focused card; a drop to a hub is always shown
    if (l.hub && !on && l.tone !== "drop") return [];
    const dim = !!focus && !on;
    return [{
      id: l.id, source: l.source, target: l.target, type: "smoothstep",
      style: { stroke: tone.color, strokeWidth: on ? l.width + 0.8 : l.width * 0.7, strokeDasharray: l.stale ? "2 4" : tone.dash, opacity: dim ? 0.06 : on ? 1 : l.stale ? 0.25 : l.tone === "forward" ? 0.5 : 0.9 },
      markerEnd: { type: MarkerType.ArrowClosed, color: tone.color, width: 14, height: 14 },
      ...(on ? { label: `${l.protocol}:${l.port}${l.tone === "drop" ? ` · ${t("hb.nm.dropped")}` : ""}`, labelStyle: { fontSize: 11 }, labelBgPadding: [4, 2] as [number, number] } : {}),
      zIndex: on ? 20 : 5,
    } satisfies Edge];
  }), [map.links, focus, t]);

  const sel = map.cards.find((c) => c.id === selected) ?? null;
  const fitKey = `${clusterId}|${win}|${ns}|${verdict}|${search}`;

  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setSelected(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

  return (
    <div className={styles.nm}>
      <div className={styles.nmBar}>
        <Select label={t("hb.m.namespace")} value={ns} onChange={setNs} options={[{ value: "", label: t("hb.allNamespaces") }, ...namespaces.map((n) => ({ value: n, label: n }))]} />
        <Segmented label={t("hb.col.verdict")} value={verdict} onChange={setVerdict}
          items={[{ id: "", label: t("hb.anyVerdict") }, { id: "DROPPED", label: t("hb.verdict.DROPPED") }, { id: "FORWARDED", label: t("hb.verdict.FORWARDED") }]} />
        <Segmented label={t("hb.nm.window")} value={win} onChange={setWin} items={WINDOWS.map((m) => ({ id: m, label: t("hb.minutes", { n: m }) }))} />
        <SearchInput label={t("hb.nm.search")} value={search} onChange={setSearch} placeholder={t("hb.nm.search")} />
        {loading && <span className={styles.nmMeta}>{t("hb.receiving")}</span>}
      </div>

      <div className={styles.nmSummary}>
        <span>{t("hb.nm.summary", { w: map.totals.workloads, ns: map.totals.namespaces, l: map.totals.links })}</span>
        {map.totals.dropLinks > 0 && <span data-status="danger">{NET_GLYPH.danger} {t("hb.nm.dropLinks", { n: map.totals.dropLinks })}</span>}
        {map.totals.stale > 0 && <span data-status="stale" title={t("hb.nm.staleHint")}>{NET_GLYPH.stale} {t("hb.nm.stale", { n: map.totals.stale })}</span>}
        <span className={styles.nmAt} title={t("hb.nm.hubNote")}>ⓘ {t("hb.nm.hubShortNote")}</span>
        {last && <span className={styles.nmAt}>{t("hb.nm.at", { at: new Date(mem.current.at).toLocaleTimeString(dateLocale(locale)) })}</span>}
        <ul className={styles.nmLegend} aria-label={t("ob.hm.legend")}>
          {(["ok", "warn", "danger", "stale"] as const).map((s) => <li key={s} data-status={s}><span aria-hidden="true">{NET_GLYPH[s]}</span>{t(`hb.nm.status.${s}`)}</li>)}
          <li><span className={styles.nmLine} data-tone="forward" />{t("hb.nm.line.forward")}</li>
          <li><span className={styles.nmLine} data-tone="drop" />{t("hb.nm.line.drop")}</li>
          <li><span className={styles.nmLine} data-tone="l7err" />{t("hb.nm.line.l7err")}</li>
        </ul>
      </div>

      <CoverageNote coverage={last?.coverage} requestedMinutes={last?.timeWindowMinutes} />
      <ErrorNotice error={error} />

      {!last && !error ? <LoadingState label={t("hb.map.loading")} /> : (
        <div className={styles.nmLayout} data-open={!!sel || undefined}>
          <div className={styles.nmCanvas}>
            {map.cards.length === 0 ? (
              <EmptyState title={t("hb.map.noData")}>{t("hb.map.noDataHint")}</EmptyState>
            ) : (
              <ReactFlow
                nodes={nodes} edges={edges} nodeTypes={NODE_TYPES}
                nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} elevateNodesOnSelect={false}
                onNodeClick={(_, n) => { if (n.type === "netCard") setSelected((p) => (p === n.id ? null : n.id)); }}
                onNodeMouseEnter={(_, n) => { if (n.type === "netCard") setHover(n.id); }}
                onNodeMouseLeave={() => setHover(null)}
                onPaneClick={() => setSelected(null)}
                minZoom={0.05} maxZoom={2} proOptions={{ hideAttribution: true }}
              >
                <FitOnKey fitKey={fitKey} />
                <Background gap={24} size={1} color={rgba("ink", 0.05)} />
                <Controls showInteractive={false} />
              </ReactFlow>
            )}
          </div>
          {sel && <CardPanel card={sel} map={map} onPick={setSelected} onClose={() => setSelected(null)} />}
        </div>
      )}
    </div>
  );
}

function CardPanel({ card: c, map, onPick, onClose }: { card: NetPlacedCard; map: NetMap; onPick: (id: string) => void; onClose: () => void }) {
  const { t } = useI18n();
  const { inbound, outbound } = linksOf(map, c.id);
  const nameOf = (id: string) => {
    const p = map.cards.find((x) => x.id === id);
    if (!p) return id;
    return p.kind === "internetIn" ? t("hb.nm.internetIn") : p.kind === "internetOut" ? t("hb.nm.internetOut") : p.namespace ? `${p.namespace}/${p.name}` : p.name;
  };
  const row = (l: NetLink, peer: string, dir: "in" | "out") => (
    <li key={l.id}>
      <button type="button" className={styles.nmLinkRow} data-tone={l.tone} data-stale={l.stale || undefined} onClick={() => onPick(peer)}>
        <span className={styles.nmLinkDir}>{dir === "in" ? "←" : "→"}</span>
        <span className={styles.nmLinkPeer} title={nameOf(peer)}>{nameOf(peer)}</span>
        <span className={styles.nmLinkPort}>{l.protocol}:{l.port}</span>
        <span className={styles.nmLinkFlows}>{l.flows.toLocaleString()}{l.drops ? <b> · {t("hb.nm.dropped")} {l.drops}</b> : null}</span>
        {l.l7?.httpMethods?.length ? <span className={styles.nmLinkL7}>{l.l7.httpMethods.join(" ")}</span> : null}
      </button>
    </li>
  );
  const why = c.status === "danger" ? t("hb.nm.why.danger", { n: c.drops }) : c.status === "warn" ? t("hb.nm.why.warn", { h: c.httpErrors, d: c.dnsErrors })
    : c.status === "stale" ? t("hb.nm.staleHint") : t("hb.nm.why.ok");
  return (
    <aside className={styles.nmPanel} aria-label={c.name}>
      <header className={styles.nmPanelHead} data-status={c.status}>
        <span className={styles.nmGlyph} aria-hidden="true">{NET_GLYPH[c.status]}</span>
        <div>
          <strong title={c.name}>{c.kind === "workload" ? c.name : nameOf(c.id)}</strong>
          <small>{c.namespace || t(`hb.nm.kind.${c.kind === "platform" ? c.serviceType : c.kind}`)}</small>
        </div>
        <Button size="sm" variant="ghost" ariaLabel={t("hb.nm.close")} onClick={onClose}>✕</Button>
      </header>
      <p className={styles.nmWhy}>{why}</p>
      <dl className={styles.nmKv}>
        <dt>{t("hb.nm.flows")}</dt><dd>{c.flows.toLocaleString()}</dd>
        <dt>{t("hb.nm.drops")}</dt><dd>{c.drops.toLocaleString()}</dd>
        {c.kind === "workload" && <><dt>{t("hb.nm.pods")}</dt><dd>{c.pods}</dd></>}
        {c.httpRequests > 0 && <><dt>HTTP</dt><dd>{c.httpRequests.toLocaleString()} · 5xx {c.httpErrors.toLocaleString()}{c.latencyMs !== null ? ` · ${Math.round(c.latencyMs)} ms` : ""}</dd></>}
        {c.dnsQueries > 0 && <><dt>DNS</dt><dd>{c.dnsQueries.toLocaleString()} · {t("hb.nm.errors")} {c.dnsErrors.toLocaleString()}</dd></>}
      </dl>
      {inbound.length > 0 && <section><h4>{t("hb.inbound", { n: inbound.length })}</h4><ul className={styles.nmLinks}>{inbound.map((l) => row(l, l.source, "in"))}</ul></section>}
      {outbound.length > 0 && <section><h4>{t("hb.outbound", { n: outbound.length })}</h4><ul className={styles.nmLinks}>{outbound.map((l) => row(l, l.target, "out"))}</ul></section>}
    </aside>
  );
}
