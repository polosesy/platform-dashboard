"use client";

import "reactflow/dist/style.css";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { MarkerType, type Edge, type Node } from "reactflow";
import type { ArchitectureGraph } from "@aud/types";
import { SubscriptionSelect } from "@/components/SubscriptionSelect";
import { Button, EmptyState, ErrorNotice, LoadingState, Notice, PageHeader, SampleDataNotice, Segmented, Select } from "@/components/ui";
import { applyBand, applyManualLines, arrangementStatus, bandPlan, cellPlan, compactBox, dropPlan, moveInOrder, parseArrangement, relationBetween, relationIndex, resetBand, resetBox, samePair, serializeArrangement, setCols, stepBand, stepCell, stepInOrder, type Arrangement, type LineStyle, type ManualLine, type MoveResult } from "@/lib/archArrange";
import { maskGuids } from "@/lib/mask";
import { useArrangement } from "./hooks/useArrangement";
import { useTeamArrangement } from "./hooks/useTeamArrangement";
import { useMe } from "@/lib/useMe";
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
const FLOW_KEY = "aud.arch.autoOrder";
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

  // ── Manual editing (lib/archArrange): order of slots + the user's lines, this browser only, undoable ──
  const { arrangement, commit, undo, redo, canUndo, canRedo } = useArrangement(subscriptionId);
  // Team layout (API, one per subscription): load into this browser's edit, or publish it (operators)
  const teamLayout = useTeamArrangement(subscriptionId);
  const me = useMe();
  const signedIn = !!me.data && !me.data.anonymous;
  const canPublish = signedIn && (me.data?.role === "operator" || me.data?.role === "admin");
  const [editMode, setEditMode] = useState<"auto" | "arrange" | "connect">("auto");
  const [applyEdits, setApplyEdits] = useState(true);
  const [lineStyle, setLineStyle] = useState<LineStyle>("elbow");
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  // A manual line picked for editing (its two ends — the edge id changes with the relationship kind)
  const [selectedPair, setSelectedPair] = useState<[string, string] | null>(null);
  const [editNote, setEditNote] = useState("");
  const order = applyEdits ? arrangement.order : undefined;
  const grid = applyEdits ? arrangement.grid : undefined;
  // Automatic order: by traffic entry (left → right = the way requests come in) or by name — a view setting of this browser
  const [flowOrder, setFlowOrderState] = useState<boolean>(() => {
    try { return window.localStorage.getItem(FLOW_KEY) !== "name"; } catch { return true; }
  });
  const setFlowOrder = (on: boolean) => {
    setFlowOrderState(on);
    try { window.localStorage.setItem(FLOW_KEY, on ? "flow" : "name"); } catch { /* storage unavailable — this page only */ }
  };
  const autoLayout = useMemo(
    () => layoutArch(vm, { region, collapsed, expandedStacks: stacks, layers, allLines, order, grid, flow: flowOrder, hiddenIn: view.hiddenIn }),
    [vm, region, collapsed, stacks, layers, allLines, order, grid, flowOrder, view.hiddenIn],
  );
  // The user's lines replace the auto line of their pair (same relationship kind, colour and direction)
  const layout = useMemo(() => (applyEdits ? applyManualLines(autoLayout, arrangement.lines) : autoLayout), [autoLayout, applyEdits, arrangement.lines]);
  const editStatus = useMemo(() => arrangementStatus(arrangement, model, layout), [arrangement, model, layout]);
  const movable = useMemo(() => new Set(autoLayout.containerOf.keys()), [autoLayout]);
  // Who can be connected to whom (one pass over the configuration) — counts before a pick, targets after it
  const relIndex = useMemo(() => relationIndex(model, autoLayout), [model, autoLayout]);
  const manualEdges = useMemo(() => layout.edges.filter((e) => e.manual), [layout.edges]);
  const selectedLine = selectedPair ? manualEdges.find((e) => samePair({ source: e.source, target: e.target, style: "elbow" }, selectedPair[0], selectedPair[1]))?.id ?? null : null;
  const flow = useFlowOverlay(subscriptionId, traffic, lookback);

  // Cards come from the auto layout (same shapes): adding or bending a manual line never rebuilds them
  const baseNodes = useMemo(() => buildNodes(vm, autoLayout, t, { context: view.context, hiddenIn: view.hiddenIn }), [vm, autoLayout, t, view]);
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
  const shapeName = (id: string): string => {
    const sh = layout.shapes.find((x) => x.id === id);
    if (!sh) return id;
    if (sh.shape === "internet") return t(sh.out ? "arch.internetOut" : "arch.internet");
    if (sh.shape === "site") return maskGuids(model.sites.get(sh.ref)?.name ?? t("arch.site.sub"));
    if (sh.shape === "box" && (sh.type === "lane" || sh.type === "global")) return t(`arch.lane.${sh.label}`);
    if (sh.shape === "box" && sh.type === "group") return t(`arch.paas.${sh.label}`);
    if (sh.shape === "box") return maskGuids(model.nodes.get(sh.id)?.name ?? sh.label);
    if (sh.shape === "stack" || sh.shape === "fold") return t("arch.stackOf", { kind: t(`arch.kind.${sh.kind}`), n: sh.shape === "stack" ? sh.members.length : sh.n });
    return maskGuids(model.nodes.get(sh.ref)?.name ?? sh.ref);
  };
  /**
   * Words for a container (the "only here" chip, notes): a VNet's subnet layout / column / row below, a region's VNets,
   * a lane or a PaaS zone — never a raw id (wrapper ids hold ARM ids with the subscription GUID)
   */
  const containerName = (id: string): string => {
    const [kind, rest = ""] = [id.slice(0, id.indexOf(":")), id.slice(id.indexOf(":") + 1)];
    const vnet = (vid: string) => maskGuids(model.vnets.get(vid)?.node.name ?? "") || t("arch.box.vnet");
    let out: string;
    if (kind === "vband") out = t("arch.edit.where.band", { vnet: vnet(rest) });
    else if (kind === "vcol") out = t("arch.edit.where.col", { vnet: vnet(rest.slice(0, rest.lastIndexOf(":"))) });
    else if (kind === "vrest") out = t("arch.edit.where.rest", { vnet: vnet(rest) });
    else if (kind === "vnets") out = t("arch.edit.where.vnets", { region: regionName(rest, t) });
    else if (kind === "lane") out = t(`arch.lane.${rest.slice(0, rest.indexOf(":"))}`);
    else if (kind === "paas") out = t(`arch.paas.${rest.slice(0, rest.indexOf(":"))}`);
    else out = shapeName(id);
    return /\/subscriptions\/|[0-9a-f]{8}-[0-9a-f]{4}-/i.test(out) ? t("arch.edit.where.unknown") : out;
  };
  // Connect mode: counts before a pick, the valid targets (with their relationship) after it — from one index
  const connectInfo = useMemo(() => {
    if (editMode !== "connect") return undefined;
    const counts = new Map([...relIndex].map(([id, m]) => [id, m.size] as const));
    const partners = connectFrom ? relIndex.get(connectFrom) ?? new Map() : new Map<string, ArchEdgeKind[]>();
    const targets = new Map<string, string>([...partners].map(([id, kinds]) => [id, kinds.length > 1 ? t("arch.edit.kindsN", { kind: t(`arch.edge.${kinds[0]}`), n: kinds.length - 1 }) : t(`arch.edge.${kinds[0]}`)] as const));
    const kindOf = new Map<string, ArchEdgeKind>([...partners].map(([id, kinds]) => [id, kinds[0]!] as const));
    return { from: connectFrom, targets, counts, style: lineStyle, kindOf };
  }, [editMode, connectFrom, relIndex, lineStyle, t]);
  const connectClick = (id: string) => {
    if (!connectFrom) {
      const sh = layout.shapes.find((x) => x.id === id);
      if (!sh || sh.shape === "fold" || sh.shape === "ghost" || (sh.shape === "box" && sh.type !== "subnet" && sh.type !== "vnet")) { setEditNote(t("arch.edit.notEnd")); return; }
      setConnectFrom(id);
      setEditNote(t("arch.edit.pickTarget", { name: shapeName(id) }));
      return;
    }
    const rel = relationBetween(model, layout, connectFrom, id);
    if (!rel.ok) { setEditNote(t(`arch.edit.refused.${rel.reason}`, { a: shapeName(connectFrom), b: shapeName(id) })); return; }
    const line: ManualLine = { source: connectFrom, target: id, style: lineStyle };
    commit({ ...arrangement, lines: [...arrangement.lines.filter((l) => !samePair(l, connectFrom, id)), line] });
    setEditNote(t(lineStyle === "straight" ? "arch.edit.drawn" : "arch.edit.drawnBend", { a: shapeName(connectFrom), b: shapeName(id), kind: rel.kinds.map((k) => t(`arch.edge.${k}`)).join(", ") }));
    setSelectedPair([connectFrom, id]);
    setConnectFrom(null);
  };
  // Arrange mode: a drop lands in the nearest slot of the shape's own container, or snaps back with the reason
  // Tile containers: a grid of cells (empty ones too); subnets / VNets: slots in order
  // A VNet's subnets: any column, a new column, the row below (bandPlan); tiles: grid cells; the rest: slots in order
  const planDrop = useCallback((id: string, point: [number, number]) => bandPlan(autoLayout, id, point) ?? cellPlan(autoLayout, id, point) ?? dropPlan(autoLayout, id, point), [autoLayout]);
  /** A move (drop or Alt+arrow) applied: undoable, the container kept still on screen, said in words */
  const applyMove = (id: string, r: Exclude<MoveResult, { refused: string }>, merge?: string) => {
    const anchorId = r.containerId.startsWith("vband:") ? r.containerId.slice(6) : r.containerId;
    const box = layout.shapes.find((x) => x.id === anchorId);
    if (box) setAnchor({ id: box.id, x: box.x, y: box.y });
    const unit = id.startsWith("fold:") ? id.slice(5) : id;
    let next: Arrangement;
    if ("band" in r) {
      next = applyBand(arrangement, anchorId, r.band.columns, r.band.rest);
      const c = r.band.columns.findIndex((col) => col.includes(id));
      setEditNote(c >= 0
        ? t("arch.edit.movedCol", { name: shapeName(id), col: c + 1, i: r.band.columns[c]!.indexOf(id) + 1 })
        : t("arch.edit.movedRest", { name: shapeName(id), i: r.band.rest.indexOf(id) + 1 }));
    } else if ("grid" in r) {
      const g = new Map(arrangement.grid);
      g.set(r.containerId, r.grid);
      next = { ...arrangement, grid: g };
      const [col, row] = r.grid.cells?.get(unit) ?? [0, 0];
      setEditNote(r.swapWith
        ? t("arch.edit.swapped", { name: shapeName(id), other: shapeName(r.swapWith), col: col + 1, row: row + 1 })
        : t("arch.edit.movedCell", { name: shapeName(id), col: col + 1, row: row + 1 }));
    } else {
      const o = new Map(arrangement.order);
      o.set(r.containerId, r.order);
      next = { ...arrangement, order: o };
      setEditNote(t("arch.edit.moved", { name: shapeName(id), i: r.order.indexOf(unit) + 1, n: r.order.length }));
    }
    commit(next, merge);
  };
  const onArrangeDrop = (id: string, point: [number, number]) => {
    const r = moveInOrder(autoLayout, id, point);
    if ("refused" in r) { if (r.refused !== "noChange") setEditNote(t(`arch.edit.move.${r.refused}`)); return; }
    applyMove(id, r);
  };
  // Column count / gaps of the tile container the selection is in (a subnet header, or a tile inside it)
  const gridBox = editMode === "arrange" && selectedId
    ? (autoLayout.grids.has(selectedId) ? selectedId : autoLayout.containerOf.get(selectedId) ?? (autoLayout.followers.has(selectedId) ? null : null))
    : null;
  const gridInfo = gridBox ? autoLayout.grids.get(gridBox) : undefined;
  // The VNet whose subnet columns the selection belongs to (a subnet, or the VNet itself)
  const bandVnet = editMode === "arrange" && selectedId
    ? (autoLayout.bands.has(selectedId) ? selectedId : autoLayout.containerOf.get(selectedId)?.startsWith("vband:") ? autoLayout.containerOf.get(selectedId)!.slice(6) : null)
    : null;
  const changeCols = (n: number | null) => {
    if (!gridBox) return;
    const box = layout.shapes.find((x) => x.id === gridBox);
    if (box) setAnchor({ id: box.id, x: box.x, y: box.y });
    commit(setCols(arrangement, autoLayout, gridBox, n));
    setEditNote(n === null ? t("arch.edit.colsAutoSet", { name: shapeName(gridBox) }) : t("arch.edit.colsSet", { name: shapeName(gridBox), n }));
  };
  // Undo / redo from the keyboard while editing
  // Keyboard while editing: Ctrl+Z / Ctrl+Shift+Z, Esc, and Alt+arrows move the selected shape one slot
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e: KeyboardEvent) => {
    const typing = e.target instanceof HTMLElement && (e.target.tagName === "INPUT" || e.target.tagName === "SELECT" || e.target.tagName === "TEXTAREA");
    if (typing) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (e.key === "Escape") { setConnectFrom(null); setSelectedPair(null); return; }
    const dir = e.key === "ArrowLeft" ? "left" : e.key === "ArrowRight" ? "right" : e.key === "ArrowUp" ? "up" : e.key === "ArrowDown" ? "down" : null;
    if (!e.altKey || !dir || editMode !== "arrange" || !selectedId) return;
    e.preventDefault(); // Alt+← is the browser's Back
    // A tile: the neighbouring cell (empty ones too); a subnet / VNet: the next slot
    const r = stepBand(autoLayout, selectedId, dir) ?? stepCell(autoLayout, selectedId, dir) ?? stepInOrder(autoLayout, selectedId, dir);
    if ("refused" in r) { setEditNote(t(r.refused === "edge" ? "arch.edit.move.edge" : `arch.edit.move.${r.refused}`)); return; }
    applyMove(selectedId, r, `step:${selectedId}`);
  };
  useEffect(() => {
    if (editMode === "auto") return;
    const onKey = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editMode]);
  // A line clicked in connect mode: a manual one is selected for its handle; an auto one becomes a manual elbow
  const onEdgeClick = (edgeId: string) => {
    if (editMode !== "connect") return;
    const e = layout.edges.find((x) => x.id === edgeId);
    if (!e || e.id.startsWith("traffic:")) return;
    if (!e.manual) {
      commit({ ...arrangement, lines: [...arrangement.lines.filter((l) => !samePair(l, e.source, e.target)), { source: e.source, target: e.target, style: "elbow" }] });
      setEditNote(t("arch.edit.toManual", { a: shapeName(e.source), b: shapeName(e.target) }));
    }
    setSelectedPair([e.source, e.target]);
    setConnectFrom(null);
  };
  /** A handle drag ended (value) or was double-clicked (null = back to the default bend / bulge) */
  const onHandleCommit = (edgeId: string, value: number | null) => {
    const e = layout.edges.find((x) => x.id === edgeId);
    if (!e?.manual) return;
    commit({
      ...arrangement,
      lines: arrangement.lines.map((l) => {
        if (!samePair(l, e.source, e.target)) return l;
        const { bend: _b, bulge: _g, ...rest } = l;
        void _b; void _g;
        if (value == null) return rest;
        return l.style === "curve" ? { ...rest, bulge: value } : { ...rest, bend: value };
      }),
    });
  };
  const exportArrangement = () => {
    const blob = new Blob([serializeArrangement(arrangement)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `arch-arrangement-${(subscriptionId || "sample").slice(-4)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const importArrangement = async (file: File) => {
    const next = parseArrangement(await file.text());
    if (!next.order.size && !next.grid.size && !next.lines.length) { setEditNote(t("arch.edit.importEmpty")); return; }
    commit(next);
    setEditNote(t("arch.edit.imported", { n: new Set([...next.order.keys(), ...next.grid.keys()]).size, m: next.lines.length }));
  };
  const changeEditMode = (m: "auto" | "arrange" | "connect") => {
    setEditMode(m);
    setConnectFrom(null);
    setSelectedPair(null);
    setEditNote(m === "arrange" ? t("arch.edit.hintArrange") : m === "connect" ? t("arch.edit.hintConnect") : "");
    if (m !== "auto") setApplyEdits(true);
  };

  const onNodeClick = (n: Node<ArchNodeData>) => {
    const sh = n.data.shape;
    if (editMode === "connect") { connectClick(sh.id); return; }
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
    ...(applyEdits && (editStatus.reordered || editStatus.lines) ? [t("arch.export.manual", { n: editStatus.reordered, m: editStatus.lines })] : []),
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
        <Segmented
          label={t("arch.order.label")}
          value={flowOrder ? "flow" : "name"}
          onChange={(v) => { setFlowOrder(v === "flow"); setFitNonce((n) => n + 1); }}
          items={[{ id: "flow", label: t("arch.order.flow"), title: t("arch.order.flowHint") }, { id: "name", label: t("arch.order.name") }]}
        />
        <Segmented
          label={t("arch.edit.mode")}
          value={editMode}
          onChange={changeEditMode}
          items={[{ id: "auto", label: t("arch.edit.auto") }, { id: "arrange", label: t("arch.edit.arrange") }, { id: "connect", label: t("arch.edit.connect") }]}
        />
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
      {editMode !== "auto" || editStatus.reordered || editStatus.lines ? (
        <section className={s.editBar} aria-label={t("arch.edit.title")}>
          <span className={s.editBadge}>{t("arch.edit.badge", { n: editStatus.reordered, m: editStatus.lines })}</span>
          {editMode === "auto" ? (
            <label className={s.layerItem}>
              <input type="checkbox" checked={applyEdits} onChange={(e) => setApplyEdits(e.target.checked)} />
              {t("arch.edit.apply")}
            </label>
          ) : null}
          {editMode === "connect" ? (
            <Segmented
              label={t("arch.edit.lineStyle")}
              value={lineStyle}
              onChange={setLineStyle}
              items={[{ id: "elbow", label: t("arch.edit.style.elbow") }, { id: "straight", label: t("arch.edit.style.straight") }, { id: "curve", label: t("arch.edit.style.curve") }]}
            />
          ) : null}
          {editMode !== "auto" ? (
            <>
              <Button onClick={undo} disabled={!canUndo} title="Ctrl+Z">{t("arch.edit.undo")}</Button>
              <Button onClick={redo} disabled={!canRedo} title="Ctrl+Shift+Z">{t("arch.edit.redo")}</Button>
              <Button onClick={() => commit({ ...arrangement, order: new Map(), grid: new Map() })} disabled={!arrangement.order.size && !arrangement.grid.size}>{t("arch.edit.resetOrder")}</Button>
              <Button onClick={() => commit({ ...arrangement, lines: [] })} disabled={!arrangement.lines.length}>{t("arch.edit.resetLines")}</Button>
              {connectFrom ? <Button onClick={() => { setConnectFrom(null); setEditNote(t("arch.edit.hintConnect")); }}>{t("arch.edit.cancel")}</Button> : null}
              <Button onClick={exportArrangement} disabled={!arrangement.order.size && !arrangement.grid.size && !arrangement.lines.length} title={t("arch.edit.exportHint")}>{t("arch.edit.export")}</Button>
              <label className={s.fileBtn} title={t("arch.edit.importHint")}>
                {t("arch.edit.import")}
                <input type="file" accept="application/json,.json" onChange={(e) => { const f = e.target.files?.[0]; if (f) void importArrangement(f); e.target.value = ""; }} />
              </label>
            </>
          ) : null}
          {editMode === "arrange" ? (
            gridBox && gridInfo ? (
              <div className={s.editTargets} role="group" aria-label={t("arch.edit.colsFor", { name: shapeName(gridBox) })}>
                <span className={s.editTargetsTitle}>{t("arch.edit.colsFor", { name: shapeName(gridBox) })}</span>
                <Segmented
                  label={t("arch.edit.cols")}
                  value={gridInfo.userCols ? String(gridInfo.cols) : "auto"}
                  onChange={(v) => changeCols(v === "auto" ? null : Number(v))}
                  items={[{ id: "auto", label: t("arch.edit.colsAuto", { n: gridInfo.userCols ? "" : ` (${gridInfo.cols})` }) }, ...[1, 2, 3, 4, 5, 6].map((n) => ({ id: String(n), label: String(n) }))]}
                />
                <Button
                  onClick={() => { commit(compactBox(arrangement, autoLayout, gridBox)); setEditNote(t("arch.edit.compacted", { name: shapeName(gridBox) })); }}
                  disabled={!gridInfo.slots.some((x) => !x.unit)}
                  title={t("arch.edit.compactHint")}
                >{t("arch.edit.compact")}</Button>
                <Button
                  onClick={() => { commit(resetBox(arrangement, gridBox)); setEditNote(t("arch.edit.boxReset", { name: shapeName(gridBox) })); }}
                  disabled={!arrangement.order.has(gridBox) && !arrangement.grid.has(gridBox)}
                >{t("arch.edit.resetBox")}</Button>
              </div>
            ) : <span className={s.iDim}>{t("arch.edit.pickBox")}</span>
          ) : null}
          {editMode === "arrange" && bandVnet && autoLayout.bands.get(bandVnet)?.user ? (
            <Button onClick={() => { commit(resetBand(arrangement, bandVnet)); setEditNote(t("arch.edit.bandReset", { vnet: containerName(`vband:${bandVnet}`) })); }}>
              {t("arch.edit.resetBand")}
            </Button>
          ) : null}
          {editMode === "connect" && connectFrom && connectInfo ? (
            <div className={s.editTargets} role="group" aria-label={t("arch.edit.targetsTitle", { n: connectInfo.targets.size })}>
              <span className={s.editTargetsTitle}>{t("arch.edit.targetsTitle", { n: connectInfo.targets.size })}</span>
              {connectInfo.targets.size ? [...connectInfo.targets].map(([id, label]) => (
                <button key={id} type="button" className={s.editTarget} onClick={() => connectClick(id)}>
                  {shapeName(id)} <span className={s.iDim}>· {label}{arrangement.lines.some((l) => samePair(l, connectFrom, id)) ? ` · ${t("arch.edit.hasManual")}` : ""}</span>
                </button>
              )) : <span className={s.iDim}>{t("arch.edit.noTargets")}</span>}
            </div>
          ) : null}
          {editMode === "connect" && selectedPair && selectedLine ? (() => {
            const line = arrangement.lines.find((l) => samePair(l, selectedPair[0], selectedPair[1]));
            if (!line) return null;
            const update = (patch: Partial<ManualLine>) => commit({ ...arrangement, lines: arrangement.lines.map((l) => (l === line ? { ...l, ...patch } : l)) });
            return (
              <div className={s.editTargets} role="group" aria-label={t("arch.edit.lineTitle")}>
                <span className={s.editTargetsTitle}>{t("arch.edit.lineTitle")}: {shapeName(selectedPair[0])} ↔ {shapeName(selectedPair[1])}</span>
                <select aria-label={t("arch.edit.lineStyle")} value={line.style} onChange={(e) => update({ style: e.target.value as LineStyle })}>
                  <option value="elbow">{t("arch.edit.style.elbow")}</option>
                  <option value="straight">{t("arch.edit.style.straight")}</option>
                  <option value="curve">{t("arch.edit.style.curve")}</option>
                </select>
                <span className={s.iDim}>{t(line.style === "straight" ? "arch.edit.handleNone" : line.style === "curve" ? "arch.edit.handleCurve" : "arch.edit.handleElbow")}</span>
                <Button onClick={() => { const { bend: _b, bulge: _g, ...rest } = line; void _b; void _g; commit({ ...arrangement, lines: arrangement.lines.map((l) => (l === line ? rest : l)) }); }} disabled={line.bend == null && line.bulge == null}>{t("arch.edit.resetBend")}</Button>
                <Button onClick={() => { commit({ ...arrangement, lines: arrangement.lines.filter((l) => l !== line) }); setSelectedPair(null); }}>{t("arch.edit.toAuto")}</Button>
                <Button onClick={() => setSelectedPair(null)}>{t("arch.edit.deselect")}</Button>
              </div>
            );
          })() : null}
          {editMode !== "auto" && signedIn && graph.source !== "mock" ? (
            <span className={s.editTeam}>
              <Button
                disabled={teamLayout.busy}
                onClick={() => void teamLayout.load().then((a) => {
                  if (a) { commit(a); setEditNote(t("arch.edit.team.loaded")); } else setEditNote(t("arch.edit.team.none"));
                }).catch((e: unknown) => setEditNote(e instanceof Error ? e.message : String(e)))}
              >{t("arch.edit.team.load")}</Button>
              <Button
                disabled={teamLayout.busy || !canPublish}
                title={canPublish ? t("arch.edit.team.publishHint") : t("arch.edit.team.needOperator")}
                onClick={() => void teamLayout.publish(arrangement).then((r) => setEditNote(t(r === "ok" ? "arch.edit.team.published" : "arch.edit.team.conflict")))
                  .catch((e: unknown) => setEditNote(e instanceof Error ? e.message : String(e)))}
              >{t("arch.edit.team.publish")}</Button>
              {teamLayout.conflict && canPublish ? (
                <Button onClick={() => void teamLayout.publish(arrangement, true).then(() => setEditNote(t("arch.edit.team.published"))).catch((e: unknown) => setEditNote(e instanceof Error ? e.message : String(e)))}>{t("arch.edit.team.overwrite")}</Button>
              ) : null}
              {teamLayout.team ? (
                <span className={s.iDim}>
                  {t("arch.edit.team.info", { v: teamLayout.team.version, by: teamLayout.team.updatedBy ?? "—", at: new Date(teamLayout.team.updatedAt).toLocaleString(dateLocale(locale)) })}
                  {teamLayout.team.durable ? "" : ` · ${t("arch.edit.team.memory")}`}
                </span>
              ) : null}
            </span>
          ) : null}
          {editStatus.stale ? <span className={s.warnText}>{t("arch.edit.stale", { n: editStatus.stale })}</span> : null}
          <span className={s.editNote} aria-live="polite">{editNote}</span>
          {editMode === "connect" && arrangement.lines.length ? (
            <details className={s.editLines}>
              <summary>{t("arch.edit.linesTitle", { n: arrangement.lines.length })}</summary>
              <ul>
                {arrangement.lines.map((l) => (
                  <li key={`${l.source}|${l.target}`}>
                    <span>{shapeName(l.source)} ↔ {shapeName(l.target)}</span>
                    <select
                      aria-label={t("arch.edit.lineStyle")}
                      value={l.style}
                      onChange={(e) => commit({ ...arrangement, lines: arrangement.lines.map((x) => (x === l ? { ...x, style: e.target.value as LineStyle } : x)) })}
                    >
                      <option value="elbow">{t("arch.edit.style.elbow")}</option>
                      <option value="straight">{t("arch.edit.style.straight")}</option>
                      <option value="curve">{t("arch.edit.style.curve")}</option>
                    </select>
                    <button type="button" className={s.linkBtn} onClick={() => commit({ ...arrangement, lines: arrangement.lines.filter((x) => x !== l) })}>{t("arch.edit.toAuto")}</button>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </section>
      ) : null}
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
                editMode={exp.exporting ? "auto" : editMode}
                movable={movable}
                connect={connectInfo}
                dropPlan={planDrop}
                onArrangeDrop={onArrangeDrop}
                onGestureAbort={() => setEditNote(t("arch.edit.dragCancelled"))}
                nameOf={containerName}
                manualEdges={manualEdges}
                selectedLine={selectedLine}
                onEdgeClick={onEdgeClick}
                onHandleCommit={onHandleCommit}
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
            <Legend open={legendOpen} onToggle={() => setLegendOpen((v) => !v)} showContext={view.active} flow={flowOrder} />
          </div>
          <Inspector model={model} flow={flowOrder} target={target} drawn={layout.edges} offscreen={layout.offscreen} onSelect={setSelectedId} shownAt={layout.shownAt} filteredOut={scope.cut} undrawn={graph.undrawnTypes} />
        </div>
      )}
    </>
  );
}
