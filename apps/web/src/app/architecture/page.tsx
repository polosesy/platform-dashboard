"use client";

import "reactflow/dist/style.css";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { MarkerType, type Edge, type Node } from "reactflow";
import type { ArchitectureGraph } from "@aud/types";
import { SubscriptionSelect } from "@/components/SubscriptionSelect";
import { Button, EmptyState, ErrorNotice, LoadingState, PageHeader, SampleDataNotice, Select } from "@/components/ui";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import {
  ARCH_EDGE_KINDS, DEFAULT_LAYERS, buildArchModel, defaultRegion, initialCollapsed, layoutArch, locationPath, neighbours, regionTiles, searchArch,
  type ArchEdgeKind,
} from "@/lib/archModel";
import { formatBytes } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import { useApiQuery } from "@/lib/useApiQuery";
import { useSubscriptions } from "@/lib/useSubscriptions";
import { formatAzureRegion } from "@/app/live-diagram/utils/regionFormat";
import type { ArchNodeData } from "./components/ArchNodes";
import { DiagramCanvas } from "./components/DiagramCanvas";
import { Inspector, type InspectorTarget } from "./components/Inspector";
import { Legend } from "./components/Legend";
import { useFlowOverlay } from "./hooks/useFlowOverlay";
import { EDGE_STYLE, buildEdges, buildNodes } from "./utils/toFlow";
import s from "./styles.module.css";

/** 인프라 구성도 — the whole subscription as a draw.io-style diagram (configuration, not live state). */
export default function ArchitecturePage() {
  const { t } = useI18n();
  const { subscriptions, subscriptionId, setSubscriptionId, loaded } = useSubscriptions();
  const q = useApiQuery(loaded ? `arch:${subscriptionId}` : null, (token) =>
    fetchJsonWithBearer<ArchitectureGraph>(apiUrl("/api/architecture/graph", { subscriptionId: subscriptionId || undefined }), token),
  );
  // Never show the previous subscription's diagram under a new selection
  const graph = q.loading ? undefined : q.data;

  return (
    <div className={s.page}>
      <PageHeader
        actions={<SubscriptionSelect subscriptions={subscriptions} value={subscriptionId} onChange={setSubscriptionId} />}
        meta={
          <span>
            {t("arch.liveHint")} <Link href="/live-diagram" className={s.inlineLink}>{t("arch.openLive")} →</Link>
          </span>
        }
      />
      <ErrorNotice error={q.error} />
      {q.error ? <div><Button onClick={q.reload}>{t("common.retry")}</Button></div> : null}
      {graph?.source === "mock" ? <SampleDataNotice note={graph.note ?? "mock data"} /> : null}
      {!graph ? (
        q.error ? null : <LoadingState />
      ) : graph.nodes.length === 0 ? (
        <EmptyState title={t("arch.emptyGraph")} />
      ) : (
        <Diagram key={`${subscriptionId}:${graph.generatedAt}`} graph={graph} subscriptionId={subscriptionId} />
      )}
    </div>
  );
}

type Anchor = { id: string; x: number; y: number };
const CLEANUP = "__cleanup__";

function Diagram({ graph, subscriptionId }: { graph: ArchitectureGraph; subscriptionId: string }) {
  const { t } = useI18n();
  const model = useMemo(() => buildArchModel(graph), [graph]);
  const firstRegion = useMemo(() => defaultRegion(model), [model]);

  const [region, setRegionState] = useState(firstRegion);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => initialCollapsed(model, firstRegion));
  const [stacks, setStacks] = useState<ReadonlySet<string>>(() => new Set());
  const [layers, setLayers] = useState<ReadonlySet<ArchEdgeKind>>(() => new Set(DEFAULT_LAYERS));
  const [traffic, setTraffic] = useState(false);
  const [lookback, setLookback] = useState(60);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [rg, setRg] = useState("");
  const [query, setQuery] = useState("");
  const [match, setMatch] = useState<{ q: string; i: number; n: number } | null>(null);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [centerOn, setCenterOn] = useState<string | null>(null);
  const [legendOpen, setLegendOpen] = useState(true);
  const [fitNonce, setFitNonce] = useState(0);

  const layout = useMemo(() => layoutArch(model, { region, collapsed, expandedStacks: stacks, layers }), [model, region, collapsed, stacks, layers]);
  const flow = useFlowOverlay(subscriptionId, traffic, lookback);

  const baseNodes = useMemo(() => buildNodes(model, layout, t), [model, layout, t]);
  const trafficEdges = useMemo<Edge[]>(() => {
    const list = flow.overlay?.edges ?? [];
    const max = Math.max(1, ...list.map((e) => e.totalBytes));
    const seen = new Map<string, Edge>();
    for (const e of list) {
      const a = layout.shownAt.get(e.source.toLowerCase()), b = layout.shownAt.get(e.target.toLowerCase());
      if (!a || !b || a === b) continue;
      const id = `traffic:${a}->${b}`;
      if (seen.has(id)) continue;
      const w = 1.5 + (e.totalBytes / max) * 4.5;
      seen.set(id, {
        id, source: a, target: b, type: "smoothstep", zIndex: 1, animated: true, focusable: false,
        label: formatBytes(e.totalBytes), labelStyle: { fontSize: 10, fontWeight: 700, fill: "#0078d4" }, labelBgStyle: { fill: "#fff", fillOpacity: 0.9 },
        style: { stroke: EDGE_STYLE.traffic.stroke, strokeWidth: w, strokeDasharray: e.deniedFlows > 0 ? "5 3" : undefined },
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: "#0078d4" },
      });
    }
    return [...seen.values()];
  }, [flow.overlay, layout.shownAt]);
  const edges = useMemo(() => [...buildEdges(layout.edges, t), ...trafficEdges], [layout.edges, t, trafficEdges]);

  const selectedShape = selectedId && selectedId !== CLEANUP ? layout.shapes.find((x) => x.id === selectedId) ?? null : null;
  const target: InspectorTarget = selectedId === CLEANUP ? { type: "cleanup" } : selectedShape ? { type: "shape", shape: selectedShape } : null;

  const rgs = useMemo(() => [...new Set([...model.resources.values()].map((r) => r.node.resourceGroup).filter((x): x is string => !!x))].sort((a, b) => a.localeCompare(b)), [model]);
  const focus = useMemo<ReadonlySet<string> | null>(() => {
    if (rg) {
      const keep = new Set<string>();
      for (const r of model.resources.values()) if (r.node.resourceGroup === rg) { const at = layout.shownAt.get(r.id); if (at) keep.add(at); }
      return keep;
    }
    if (selectedShape && selectedShape.shape !== "box") return neighbours(layout.edges, selectedShape.id);
    return null;
  }, [rg, model, layout, selectedShape]);

  const posOf = (id: string): Anchor | null => {
    const sh = layout.shapes.find((x) => x.id === id);
    return sh ? { id, x: sh.x, y: sh.y } : null;
  };
  const setRegion = (r: string) => {
    setRegionState(r);
    setCollapsed(initialCollapsed(model, r));
    setStacks(new Set());
    setSelectedId(null);
    setAnchor(null);
  };
  const toggleVnet = useCallback(
    (id: string) => {
      const sh = layout.shapes.find((x) => x.id === id);
      if (sh) setAnchor({ id, x: sh.x, y: sh.y });
      setCollapsed((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    },
    [layout.shapes],
  );
  const onNodeClick = (n: Node<ArchNodeData>) => {
    const sh = n.data.shape;
    if (sh.shape === "stack") {
      // Expanding replaces the stack with its members; keep the subnet still on screen
      const parent = sh.parent ? posOf(sh.parent) : null;
      if (parent) setAnchor(parent);
      setStacks((prev) => new Set(prev).add(sh.id));
      setSelectedId(sh.parent);
      return;
    }
    if (sh.shape === "pill") {
      toggleVnet(sh.id);
      setSelectedId(sh.id);
      return;
    }
    setSelectedId(sh.id);
  };

  const runSearch = () => {
    const hits = searchArch(model, query);
    if (!hits.length) { setMatch({ q: query, i: 0, n: 0 }); return; }
    const i = match && match.q === query && match.n === hits.length ? (match.i + 1) % hits.length : 0;
    const id = hits[i]!;
    setMatch({ q: query, i, n: hits.length });
    // Make the hit visible: its region, its VNet expanded, its stack opened
    const reg = locationPath(model, id)?.region ?? "all";
    const nextRegion = region === "all" || reg === region || reg === "global" ? region : reg;
    const col = new Set(nextRegion === region ? collapsed : initialCollapsed(model, nextRegion));
    const subId = model.resources.get(id)?.subnetId ?? (model.subnets.has(id) ? id : null);
    const vnetOf = subId ? model.subnets.get(subId)?.vnetId : undefined;
    if (vnetOf) col.delete(vnetOf);
    if (model.vnets.has(id)) col.delete(id);
    const st = new Set(nextRegion === region ? stacks : []);
    const probe = layoutArch(model, { region: nextRegion, collapsed: col, expandedStacks: st, layers });
    const at = probe.shownAt.get(id);
    if (at?.startsWith("stack:")) st.add(at);
    if (nextRegion !== region) setRegionState(nextRegion);
    setCollapsed(col);
    setStacks(st);
    setAnchor(null);
    setSelectedId(id);
    setCenterOn(id);
  };
  const onCentered = useCallback(() => setCenterOn(null), []);

  const expandAll = () => {
    const probe = layoutArch(model, { region, collapsed: new Set(), expandedStacks: new Set(), layers });
    setCollapsed(new Set());
    setStacks(new Set(probe.shapes.filter((x) => x.shape === "stack").map((x) => x.id)));
    setAnchor(null);
    setFitNonce((n) => n + 1);
  };
  const collapseAll = () => {
    setCollapsed(new Set(model.regions.filter((r) => region === "all" || r.key === region).flatMap((r) => r.vnets.map((v) => v.node.id.toLowerCase()))));
    setAnchor(null);
    setFitNonce((n) => n + 1);
  };
  const toggleLayer = (k: ArchEdgeKind) =>
    setLayers((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const totals = model.totals;
  const cleanup = totals.unusedPublicIps + totals.unresolvedPublicIps + totals.unusedNsgs;
  const regionHasNothing = region !== "all" && !model.regions.some((r) => r.key === region && (regionTiles(r) > 0 || r.vnets.length > 0));

  return (
    <>
      <section className={s.toolbar} aria-label={t("arch.layers")}>
        <Select
          label={t("arch.region")}
          value={region}
          onChange={setRegion}
          options={[
            ...model.regions.map((r) => ({ value: r.key, label: `${formatAzureRegion(r.key)} · ${t("arch.tilesN", { n: regionTiles(r) })}` })),
            { value: "all", label: t("arch.allRegions") },
          ]}
        />
        <Select
          label={t("arch.rgHighlight")}
          value={rg}
          onChange={setRg}
          options={[{ value: "", label: t("arch.rgNone") }, ...rgs.map((x) => ({ value: x, label: x }))]}
        />
        <form className={s.search} onSubmit={(e) => { e.preventDefault(); runSearch(); }} role="search">
          <label className={s.searchLabel}>
            <span>{t("common.search")}</span>
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("arch.search")} />
          </label>
          <span className={s.searchInfo} aria-live="polite">
            {match && match.q === query ? (match.n ? t("arch.matchN", { i: match.i + 1, n: match.n }) : t("arch.noMatch")) : ""}
          </span>
        </form>
        <div className={s.toolButtons}>
          <Button onClick={expandAll}>{t("arch.expandAll")}</Button>
          <Button onClick={collapseAll}>{t("arch.collapseAll")}</Button>
          <Button onClick={() => setFitNonce((n) => n + 1)}>{t("arch.fit")}</Button>
        </div>
        <details className={s.layers}>
          <summary>{t("arch.layers")}</summary>
          <div className={s.layerList}>
            {ARCH_EDGE_KINDS.map((k) => (
              <label key={k} className={s.layerItem}>
                <input type="checkbox" checked={layers.has(k)} onChange={() => toggleLayer(k)} />
                <svg width="26" height="8" aria-hidden="true"><line x1="1" y1="4" x2="25" y2="4" stroke={EDGE_STYLE[k].stroke} strokeWidth="2" strokeDasharray={EDGE_STYLE[k].dash} /></svg>
                {t(`arch.layer.${k}`)}
              </label>
            ))}
            <label className={s.layerItem}>
              <input type="checkbox" checked={traffic} onChange={(e) => setTraffic(e.target.checked)} />
              <svg width="26" height="8" aria-hidden="true"><line x1="1" y1="4" x2="25" y2="4" stroke={EDGE_STYLE.traffic.stroke} strokeWidth="3" /></svg>
              {t("arch.layer.traffic")}
            </label>
            {traffic ? (
              <div className={s.trafficInfo}>
                <Select
                  label={t("arch.trafficWindow")}
                  value={String(lookback)}
                  onChange={(v) => setLookback(Number(v))}
                  options={[15, 60, 360, 1440].map((m) => ({ value: String(m), label: m < 60 ? `${m}m` : `${m / 60}h` }))}
                />
                {flow.loading ? <span>{t("common.loading")}</span> : null}
                {flow.error ? <span className={s.warnText}>{flow.error}</span> : null}
                {flow.overlay?.note || graph.source === "mock" ? <span className={s.warnText}>{t("arch.trafficMock")}</span> : null}
                {flow.overlay && !flow.loading && trafficEdges.length === 0 ? <span>{t("arch.trafficNone")}</span> : null}
                {flow.overlay?.unmatchedPairs.length ? <span>{t("arch.trafficUnmatched", { n: flow.overlay.unmatchedPairs.length })}</span> : null}
              </div>
            ) : null}
          </div>
        </details>
      </section>

      <div className={s.summary}>
        <span><b>{totals.regions}</b> {t("arch.sum.regions")}</span>
        <span><b>{totals.vnets}</b> {t("arch.sum.vnets")}</span>
        <span><b>{totals.subnets}</b> {t("arch.sum.subnets")}</span>
        <span><b>{totals.vms}</b> {t("arch.sum.vms")}</span>
        <span><b>{totals.publicIpResources}</b> {t("arch.sum.public")}</span>
        <span><b>{totals.privateEndpoints}</b> {t("arch.sum.pe")}</span>
        {cleanup ? (
          <button type="button" className={s.cleanupBtn} title={t("arch.sum.cleanupHint")} onClick={() => setSelectedId(CLEANUP)}>
            <b>{cleanup}</b> {t("arch.sum.cleanup")}
          </button>
        ) : null}
      </div>

      {regionHasNothing ? (
        <EmptyState title={t("arch.emptyRegion")}>
          <Button onClick={() => setRegion("all")}>{t("arch.allRegions")}</Button>
        </EmptyState>
      ) : (
        <div className={s.stage}>
          <div className={s.canvasCol}>
            <div className={s.canvasWrap}>
              <DiagramCanvas
                nodes={baseNodes}
                edges={edges}
                focus={focus}
                selectedId={selectedShape?.id ?? null}
                onNodeClick={onNodeClick}
                onPaneClick={() => setSelectedId(null)}
                onToggleVnet={toggleVnet}
                fitKey={`${region}:${fitNonce}`}
                bounds={{ width: layout.width, height: layout.height }}
                anchor={anchor}
                centerOn={centerOn}
                onCentered={onCentered}
              />
            </div>
            <Legend open={legendOpen} onToggle={() => setLegendOpen((v) => !v)} />
          </div>
          <Inspector model={model} target={target} drawn={layout.edges} offscreen={layout.offscreen} onSelect={setSelectedId} shownAt={layout.shownAt} />
        </div>
      )}
    </>
  );
}
