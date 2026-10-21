"use client";

import "reactflow/dist/style.css";

import { useCallback, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { MarkerType, type Edge, type Node } from "reactflow";
import type { ArchitectureGraph } from "@aud/types";
import { SubscriptionSelect } from "@/components/SubscriptionSelect";
import { Button, EmptyState, ErrorNotice, LoadingState, Notice, PageHeader, SampleDataNotice, Select } from "@/components/ui";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import {
  ARCH_EDGE_KINDS, DEFAULT_LAYERS, archCategoryOf, buildArchModel, categoryCounts, defaultRegion, filterArchModel, initialCollapsed, layoutArch,
  locationPath, neighbours, regionTiles, searchArch,
  type ArchCategory, type ArchEdgeKind,
} from "@/lib/archModel";
import { formatBytes } from "@/lib/format";
import { dateLocale, useI18n } from "@/lib/i18n";
import { useApiQuery } from "@/lib/useApiQuery";
import { useSubscriptions } from "@/lib/useSubscriptions";
import { regionName } from "./utils/toFlow";
import type { ArchNodeData } from "./components/ArchNodes";
import { DiagramCanvas } from "./components/DiagramCanvas";
import { Inspector, type InspectorTarget } from "./components/Inspector";
import { CategoryFilter } from "./components/CategoryFilter";
import { Legend } from "./components/Legend";
import { useDiagramExport } from "./hooks/useDiagramExport";
import { useFlowOverlay } from "./hooks/useFlowOverlay";
import { EDGE_STYLE, buildEdges, buildNodes } from "./utils/toFlow";
import s from "./styles.module.css";
import { hex } from "@/lib/palette";

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
  const { t, locale } = useI18n();
  const model = useMemo(() => buildArchModel(graph), [graph]);
  const firstRegion = useMemo(() => defaultRegion(model), [model]);

  const [region, setRegionState] = useState(firstRegion);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => initialCollapsed(model, firstRegion));
  const [stacks, setStacks] = useState<ReadonlySet<string>>(() => new Set());
  const [layers, setLayers] = useState<ReadonlySet<ArchEdgeKind>>(() => new Set(DEFAULT_LAYERS));
  // Private Link / NAT / VNet integration lines: on selection only (lib/archModel FOCUS_KINDS) unless this is on
  const [allLines, setAllLines] = useState(false);
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
  // 표시 범위: null = every category. The filtered view drives layout; the original model keeps
  // counts, search, cleanup items and inspector details.
  const [cats, setCats] = useState<ReadonlySet<ArchCategory> | null>(null);
  const [searchNote, setSearchNote] = useState("");
  const view = useMemo(() => filterArchModel(model, cats), [model, cats]);
  const vm = view.model;
  const canvasRef = useRef<HTMLDivElement>(null);

  const layout = useMemo(() => layoutArch(vm, { region, collapsed, expandedStacks: stacks, layers, allLines }), [vm, region, collapsed, stacks, layers, allLines]);
  const flow = useFlowOverlay(subscriptionId, traffic, lookback);

  const baseNodes = useMemo(() => buildNodes(vm, layout, t, { context: view.context, hiddenIn: view.hiddenIn }), [vm, layout, t, view]);
  const trafficDropped = useMemo(() => {
    if (!view.active) return 0;
    return (flow.overlay?.edges ?? []).filter((e) => !layout.shownAt.get(e.source.toLowerCase()) || !layout.shownAt.get(e.target.toLowerCase())).length;
  }, [flow.overlay, layout.shownAt, view.active]);
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
        label: formatBytes(e.totalBytes), labelStyle: { fontSize: 10, fontWeight: 700, fill: hex("accent") }, labelBgStyle: { fill: "#fff", fillOpacity: 0.9 },
        style: { stroke: EDGE_STYLE.traffic.stroke, strokeWidth: w, strokeDasharray: e.deniedFlows > 0 ? "5 3" : undefined },
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: hex("accent") },
      });
    }
    return [...seen.values()];
  }, [flow.overlay, layout.shownAt]);
  // Focus lines (Private Link, subnet → NAT, VNet integration) join for the selected tile / box only
  const selectedForLines = selectedId && selectedId !== CLEANUP ? selectedId : null;
  const edges = useMemo(() => [...buildEdges(layout.edges, t, selectedForLines), ...trafficEdges], [layout.edges, t, selectedForLines, trafficEdges]);

  const selectedShape = selectedId && selectedId !== CLEANUP ? layout.shapes.find((x) => x.id === selectedId) ?? null : null;
  const target: InspectorTarget = selectedId === CLEANUP ? { type: "cleanup" } : selectedShape ? { type: "shape", shape: selectedShape } : null;

  const rgs = useMemo(() => [...new Set([...model.resources.values()].map((r) => r.node.resourceGroup).filter((x): x is string => !!x))].sort((a, b) => a.localeCompare(b)), [model]);
  const rgFocus = useMemo<ReadonlySet<string> | null>(() => {
    if (!rg) return null;
    const keep = new Set<string>();
    for (const r of model.resources.values()) if (r.node.resourceGroup === rg) { const at = layout.shownAt.get(r.id); if (at) keep.add(at); }
    return keep;
  }, [rg, model, layout]);
  const focus = useMemo<ReadonlySet<string> | null>(() => {
    if (rgFocus) return rgFocus;
    if (selectedShape && selectedShape.shape !== "box") return neighbours(layout.edges, selectedShape.id);
    return null;
  }, [rgFocus, layout, selectedShape]);

  const posOf = (id: string): Anchor | null => {
    const sh = layout.shapes.find((x) => x.id === id);
    return sh ? { id, x: sh.x, y: sh.y } : null;
  };
  const setRegion = (r: string) => {
    setRegionState(r);
    setCollapsed(initialCollapsed(vm, r, 24, view.active));
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
  const changeCats = (next: ReadonlySet<ArchCategory> | null) => {
    const nv = filterArchModel(model, next);
    setCats(next);
    setCollapsed(initialCollapsed(nv.model, region, 24, nv.active));
    setStacks(new Set());
    setSelectedId(null);
    setAnchor(null);
    setCenterOn(null);
    setSearchNote("");
    setFitNonce((n) => n + 1);
  };
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
    if (sh.shape === "fold") {
      // The same spot folds it back (ref = the stack id); the subnet stays still on screen
      const parent = sh.parent ? posOf(sh.parent) : null;
      if (parent) setAnchor(parent);
      setStacks((prev) => { const next = new Set(prev); next.delete(sh.ref); return next; });
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
    // A hit hidden by the filter: add its category (VNets / subnets belong to network) and go there
    let nextView = view;
    const shownNow = view.keep?.has(id) || vm.vnets.has(id) || vm.subnets.has(id) || !view.active;
    if (!shownNow) {
      const r = model.resources.get(id);
      const c: ArchCategory = r ? archCategoryOf(r.node.kind) : "network";
      const next = new Set(cats ?? []);
      next.add(c);
      nextView = filterArchModel(model, next);
      setCats(nextView.active ? next : null);
      setSearchNote(t("arch.filter.added", { cat: t(`arch.cat.${c}`) }));
    } else setSearchNote("");
    const fm = nextView.model;
    const changed = nextView !== view;
    // Make the hit visible: its region, its VNet expanded, its stack opened
    const reg = locationPath(model, id)?.region ?? "all";
    const nextRegion = region === "all" || reg === region || reg === "global" ? region : reg;
    const col = new Set(nextRegion === region && !changed ? collapsed : initialCollapsed(fm, nextRegion, 24, nextView.active));
    const subId = model.resources.get(id)?.subnetId ?? (model.subnets.has(id) ? id : null);
    const vnetOf = subId ? model.subnets.get(subId)?.vnetId : undefined;
    if (vnetOf) col.delete(vnetOf);
    if (model.vnets.has(id)) col.delete(id);
    const st = new Set(nextRegion === region && !changed ? stacks : []);
    const probe = layoutArch(fm, { region: nextRegion, collapsed: col, expandedStacks: st, layers });
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
    const probe = layoutArch(vm, { region, collapsed: new Set(), expandedStacks: new Set(), layers });
    setCollapsed(new Set());
    setStacks(new Set(probe.shapes.filter((x) => x.shape === "stack").map((x) => x.id)));
    setAnchor(null);
    setFitNonce((n) => n + 1);
  };
  const collapseAll = () => {
    setCollapsed(new Set(vm.regions.filter((r) => region === "all" || r.key === region).flatMap((r) => r.vnets.map((v) => v.node.id.toLowerCase()))));
    // Stacks too (lanes have them, and an open VNet would come back with its old stacks open) — the pair of 모두 펼치기
    setStacks(new Set());
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
  const regionHasNothing = region !== "all" && !vm.regions.some((r) => r.key === region && (regionTiles(r) > 0 || r.vnets.length > 0)) && vm.global.length === 0;
  const counts = useMemo(() => categoryCounts(model, region), [model, region]);
  // Filter banner numbers, scoped to the current region (+ global services)
  const scope = useMemo(() => {
    const inScope = (rid: string) => { const r = model.resources.get(rid); return !!r && (region === "all" || r.region === region || r.region === "global"); };
    let total = 0, shown = 0, ctx = 0;
    for (const r of model.resources.values()) {
      if (!inScope(r.id)) continue;
      total++;
      // "shown" = selected categories only; context tiles are counted separately, never twice
      if (view.context.has(r.id)) ctx++;
      else if (!view.keep || view.keep.has(r.id)) shown++;
    }
    const cut = view.crossing.filter((e) => layers.has(e.kind) && (inScope(e.source) || inScope(e.target) || e.source.startsWith("internet:")));
    const byKind = new Map<ArchEdgeKind, number>();
    for (const e of cut) byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + 1);
    return { total, shown, ctx, cut, byKind };
  }, [model, region, view, layers]);

  const regionLabel = region === "all" ? t("arch.allRegions") : regionName(region, t);
  const exportCaption = [
    `${t("nav.item.architecture")} · ${regionLabel} · ${t("arch.export.generated", { time: new Date(graph.generatedAt).toLocaleString(dateLocale(locale)) })}`,
    view.active
      ? `${t("arch.filter.title")}: ${[...(cats ?? [])].map((c) => t(`arch.cat.${c}`)).join(", ")} · ${t("arch.filter.banner", { shown: scope.shown, total: scope.total, ctx: scope.ctx, cut: scope.cut.length })}`
      : t("arch.filter.everything"),
    `${t("arch.layers")}: ${ARCH_EDGE_KINDS.filter((k) => layers.has(k)).map((k) => t(`arch.layer.${k}`)).join(", ") || "—"} · ${t(allLines ? "arch.export.allLines" : "arch.export.focusLines")}${traffic ? ` · ${t("arch.export.traffic", { m: lookback })}` : ""}${rg ? ` · ${t("arch.rgHighlight")}: ${rg}` : ""}`,
    `${t("arch.export.basis")}${graph.source === "mock" ? ` · ${t("common.sampleData")}` : ""}`,
  ];
  const dimmed = useMemo(() => new Set(rgFocus ? layout.shapes.filter((x) => x.shape !== "box" && x.shape !== "fold" && !rgFocus.has(x.id)).map((x) => x.id) : []), [rgFocus, layout]);
  const exp = useDiagramExport({
    layout, nodes: baseNodes, caption: exportCaption, title: t("nav.item.architecture"), region, filtered: view.active,
    sample: graph.source === "mock", context: view.context, dimmed, canvasRef,
    messages: { tooLarge: t("arch.export.tooLarge"), failed: t("arch.export.failed") },
  });

  return (
    <>
      <section className={s.toolbar} aria-label={t("arch.layers")}>
        <Select
          label={t("arch.region")}
          value={region}
          onChange={setRegion}
          options={[
            ...model.regions.map((r) => ({ value: r.key, label: `${regionName(r.key, t)} · ${t("arch.tilesN", { n: regionTiles(r) })}` })),
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
            {searchNote ? ` · ${searchNote}` : ""}
          </span>
        </form>
        <CategoryFilter model={model} counts={counts} value={cats} onChange={changeCats} />
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
            <label className={s.layerItem} title={t("arch.allLinesHint")}>
              <input type="checkbox" checked={allLines} onChange={(e) => setAllLines(e.target.checked)} />
              {t("arch.allLines")}
            </label>
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
                {trafficDropped ? <span>{t("arch.filter.trafficHidden", { n: trafficDropped })}</span> : null}
              </div>
            ) : null}
          </div>
        </details>
        <div className={s.exportButtons} role="group" aria-label={t("arch.export.title")}>
          <Button onClick={exp.exportDrawio} disabled={regionHasNothing} title={t("arch.export.drawioHint")}>{t("arch.export.drawio")}</Button>
          <Button onClick={() => void exp.exportPng()} disabled={regionHasNothing || exp.exporting} title={t("arch.export.pngHint")}>
            {exp.exporting ? t("arch.export.working") : t("arch.export.png")}
          </Button>
        </div>
      </section>
      <ErrorNotice error={exp.error} />
      {view.active ? (
        <Notice tone="info">
          <span className={s.filterBanner}>
            <span>{t("arch.filter.banner", { shown: scope.shown, total: scope.total, ctx: scope.ctx, cut: scope.cut.length })}</span>
            {scope.byKind.size ? <span className={s.iDim}>({[...scope.byKind].map(([k, n]) => `${t(`arch.edge.${k}`)} ${n}`).join(", ")})</span> : null}
            <button type="button" className={s.linkBtn} onClick={() => changeCats(null)}>{t("arch.filter.clear")}</button>
          </span>
        </Notice>
      ) : null}

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
        <EmptyState title={view.active ? t("arch.filter.emptyRegion") : t("arch.emptyRegion")}>
          {view.active ? <Button onClick={() => changeCats(null)}>{t("arch.filter.clear")}</Button> : <Button onClick={() => setRegion("all")}>{t("arch.allRegions")}</Button>}
        </EmptyState>
      ) : (
        <div className={s.stage}>
          <div className={s.canvasCol}>
            <div className={s.canvasWrap} ref={canvasRef}>
              <DiagramCanvas
                nodes={baseNodes}
                edges={edges}
                focus={exp.exporting ? rgFocus : focus}
                selectedId={selectedShape?.id ?? null}
                exporting={exp.exporting}
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
            <Legend open={legendOpen} onToggle={() => setLegendOpen((v) => !v)} showContext={view.active} />
          </div>
          <Inspector model={model} target={target} drawn={layout.edges} offscreen={layout.offscreen} onSelect={setSelectedId} shownAt={layout.shownAt} filteredOut={scope.cut} undrawn={graph.undrawnTypes} />
        </div>
      )}
    </>
  );
}
