"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ReactFlow, { Background, ControlButton, Controls, EdgeLabelRenderer, MiniMap, ReactFlowProvider, useReactFlow, useStore, type Edge, type Node } from "reactflow";
import type { ArchNodeData } from "./ArchNodes";
import { ArchActions, NODE_TYPES } from "./ArchNodes";
import { EDGE_TYPES } from "./ArchEdge";
import s from "../styles.module.css";
import { rgba } from "@/lib/palette";
import { handleValue, lineHandle, manualPath, type DropPlan, type LineStyle } from "@/lib/archArrange";
import type { ArchDrawEdge } from "@/lib/archModel";
import { roundedPath, type RRect } from "@/lib/archRoute";
import { gestureStep, viewportLost, type GestureState } from "@/lib/archView";
import { useI18n } from "@/lib/i18n";
import { EDGE_STYLE } from "../utils/toFlow";

export type CanvasProps = {
  nodes: Node<ArchNodeData>[];
  edges: Edge[];
  /** Ids kept bright; everything else is dimmed (null = nothing focused) */
  focus: ReadonlySet<string> | null;
  selectedId: string | null;
  onNodeClick: (node: Node<ArchNodeData>) => void;
  onPaneClick: () => void;
  onToggleVnet: (id: string) => void;
  /** Changing this re-fits the whole diagram (data, region) */
  fitKey: string;
  /** Layout size — fitting uses it directly, so it works before nodes are measured */
  bounds: { width: number; height: number };
  /** A gesture ended by focus loss (screen capture, Alt+Tab): the pending move was cancelled */
  onGestureAbort?: () => void;
  /** Shape to keep still on screen across the next re-layout (expand / collapse) */
  anchor: { id: string; x: number; y: number } | null;
  /** Shape to centre on after the next re-layout (search) */
  centerOn: string | null;
  onCentered: () => void;
  /** PNG export in progress: render every node (no virtualization), full detail, no selection ring */
  exporting?: boolean;
  /** Manual editing (lib/archArrange): arrange = drag a shape to another slot of its container; connect = pick two shapes */
  editMode?: "auto" | "arrange" | "connect";
  /** Shapes that may be moved in arrange mode (their container is reorderable) */
  movable?: ReadonlySet<string>;
  /** Connect mode: the picked source, its valid targets (→ relationship label) and, before a pick, each shape's partner count */
  connect?: { from: string | null; targets: ReadonlyMap<string, string>; counts: ReadonlyMap<string, number>; style: LineStyle; kindOf: ReadonlyMap<string, ArchDrawEdge["kind"]> };
  dropPlan?: (id: string, point: [number, number]) => DropPlan | { refused: "notMovable" | "follower" };
  onArrangeDrop?: (id: string, point: [number, number]) => void;
  /** Container / shape names for the overlay's words */
  nameOf?: (id: string) => string;
  /** The user's lines (layout edges with `manual`), the selected one, and how a handle drag ends */
  manualEdges?: readonly ArchDrawEdge[];
  selectedLine?: string | null;
  onEdgeClick?: (edgeId: string) => void;
  onHandleCommit?: (edgeId: string, value: number | null) => void;
};

const zoomBucket = (z: number) => (z < 0.45 ? "far" : z < 0.85 ? "mid" : "near");
const rectOfNode = (n: Node<ArchNodeData>): RRect => ({ x: n.position.x, y: n.position.y, w: (n.width ?? 0) as number, h: (n.height ?? 0) as number });

function Inner(p: CanvasProps) {
  const rf = useReactFlow();
  const { t } = useI18n();
  // Zoom level bucket as a data attribute — CSS hides detail when far. The selector returns a
  // string, so this component re-renders only when a threshold is crossed.
  const zoom = useStore((st) => zoomBucket(st.transform[2]));
  const appliedAnchor = useRef<CanvasProps["anchor"]>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  // The latest props for the stable handlers below (React Flow keeps handlers in its store)
  const pRef = useRef(p);
  pRef.current = p;
  const arrange = p.editMode === "arrange";
  const connectMode = p.editMode === "connect";

  const byId = useMemo(() => new Map(p.nodes.map((n) => [n.id, n] as const)), [p.nodes]);
  const byIdRef = useRef(byId);
  byIdRef.current = byId;

  // ── Arrange: the cards never change during a drag — the overlay draws the slots, the bar and a ghost ──
  const [dragId, setDragId] = useState<string | null>(null);
  const [plan, setPlan] = useState<DropPlan | null>(null);
  const dragRef = useRef<{ id: string; start: [number, number]; center: [number, number]; rect: RRect } | null>(null);
  /** Set while the watchdog ends a gesture: the drag-stop handler cancels instead of dropping */
  const abortRef = useRef(false);
  const ghostRef = useRef<SVGGElement>(null);
  const frame = useRef(0);
  const toFlow = useCallback((e: { clientX: number; clientY: number }): [number, number] => {
    const q = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    return [q.x, q.y];
  }, [rf]);

  const onNodeDragStart = useCallback((e: React.MouseEvent, n: Node) => {
    const cur = pRef.current;
    if (cur.editMode !== "arrange" || !cur.movable?.has(n.id)) return;
    const r = rectOfNode(n as Node<ArchNodeData>);
    const center: [number, number] = [r.x + r.w / 2, r.y + r.h / 2];
    dragRef.current = { id: n.id, start: toFlow(e), center, rect: r };
    setDragId(n.id);
    const first = cur.dropPlan?.(n.id, center);
    setPlan(first && "containerId" in first ? first : null);
  }, [toFlow]);
  const onNodeDrag = useCallback((e: React.MouseEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const [x, y] = toFlow(e);
    const dx = x - d.start[0], dy = y - d.start[1];
    // The ghost follows the pointer through its DOM transform — no React render per move
    ghostRef.current?.setAttribute("transform", `translate(${dx} ${dy})`);
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const next = pRef.current.dropPlan?.(d.id, [d.center[0] + dx, d.center[1] + dy]);
      if (!next || !("containerId" in next)) return;
      setPlan((prev) => (prev && prev.refused === next.refused && prev.bar?.x === next.bar?.x && prev.bar?.y === next.bar?.y && prev.target?.x === next.target?.x && prev.target?.y === next.target?.y && !!prev.grid === !!next.grid && prev.bar?.w === next.bar?.w && prev.zones?.findIndex((z) => z.active) === next.zones?.findIndex((z) => z.active) ? prev : next));
    });
  }, [toFlow]);
  const onNodeDragStop = useCallback((e: React.MouseEvent) => {
    const d = dragRef.current;
    if (!d) return;
    cancelAnimationFrame(frame.current);
    if (abortRef.current) {
      // Ended by the watchdog (focus lost mid-drag): the card stays where it was
      dragRef.current = null;
      setDragId(null);
      setPlan(null);
      return;
    }
    const [x, y] = toFlow(e);
    dragRef.current = null;
    setDragId(null);
    setPlan(null);
    pRef.current.onArrangeDrop?.(d.id, [d.center[0] + x - d.start[0], d.center[1] + y - d.start[1]]);
  }, [toFlow]);

  // ── Gesture watchdog (lib/archView gestureStep): a screen-capture tool or Alt+Tab takes the mouse mid-gesture and
  // the page never gets the mouseup. d3-zoom (pan) and d3-drag (cards) listen on window and never look at the buttons,
  // so every later plain move kept panning — the diagram slid off the canvas ("disappeared"). A move with no button, a
  // blur or a hidden page ends the gesture with a synthetic mouseup (view = window: d3 removes its listeners through
  // event.view) at the last real pointer position; a pending card move is cancelled, not dropped.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    let st: GestureState = { active: false, x: 0, y: 0 };
    const abort = () => {
      abortRef.current = true;
      try {
        window.dispatchEvent(new MouseEvent("mouseup", { view: window, bubbles: true, cancelable: true, clientX: st.x, clientY: st.y, button: 0, buttons: 0 }));
      } finally {
        abortRef.current = false;
      }
      pRef.current.onGestureAbort?.();
    };
    const feed = (ev: Parameters<typeof gestureStep>[1], native?: Event) => {
      const r = gestureStep(st, ev);
      st = r.state;
      if (r.abort) { native?.stopImmediatePropagation(); abort(); }
    };
    const onDown = (e: PointerEvent) => feed({ type: "down", button: e.button, x: e.clientX, y: e.clientY });
    const onMove = (e: MouseEvent) => feed({ type: "move", buttons: e.buttons, x: e.clientX, y: e.clientY }, e);
    const onUp = (e: MouseEvent) => { if (e.isTrusted) feed({ type: "up" }); };
    const onBlur = () => feed({ type: "blur" });
    const onVis = () => { if (document.visibilityState === "hidden") feed({ type: "blur" }); };
    el.addEventListener("pointerdown", onDown, true);
    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("mouseup", onUp, true);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      el.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("mouseup", onUp, true);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  // ── Connect: hovered target (state changes only on enter / leave) and a preview line following the pointer ──
  const [hoverId, setHoverId] = useState<string | null>(null);
  const previewRef = useRef<SVGLineElement>(null);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || !connectMode || !p.connect?.from) return;
    const from = byIdRef.current.get(p.connect.from);
    if (!from) return;
    const r = rectOfNode(from);
    const onMove = (ev: PointerEvent) => {
      const [x, y] = toFlow(ev);
      const line = previewRef.current;
      if (!line) return;
      line.setAttribute("x1", String(r.x + r.w / 2));
      line.setAttribute("y1", String(r.y + r.h / 2));
      line.setAttribute("x2", String(x));
      line.setAttribute("y2", String(y));
    };
    el.addEventListener("pointermove", onMove);
    return () => el.removeEventListener("pointermove", onMove);
  }, [connectMode, p.connect?.from, toFlow]);
  const onNodeMouseEnter = useCallback((_e: React.MouseEvent, n: Node) => { if (pRef.current.editMode === "connect") setHoverId(n.id); }, []);
  const onNodeMouseLeave = useCallback(() => setHoverId(null), []);

  // Classes change only when a mode, a pick or a drag starts / ends — never per pointer move
  const nodes = useMemo(
    () =>
      p.nodes.map((n) => {
        const boxed = n.type === "archBox";
        const dim = !!p.focus && !boxed && !p.focus.has(n.id);
        const sel = !p.exporting && p.selectedId === n.id;
        const c = connectMode ? p.connect : undefined;
        const connectCls = !c ? ""
          : c.from === n.id ? s.connectFrom
          : c.from ? (c.targets.has(n.id) ? s.connectOk : boxed && n.data.shape.shape === "box" && n.data.shape.type !== "subnet" && n.data.shape.type !== "vnet" ? "" : s.connectNo)
          : (c.counts.get(n.id) ?? 0) > 0 ? "" : boxed ? "" : s.connectNone;
        const movable = arrange && !!p.movable?.has(n.id);
        const cls = [
          dim ? s.dimmed : "", sel ? s.selected : "", connectCls,
          dragId === n.id ? s.dragging : "",
          arrange ? (movable ? s.movable : boxed ? "" : s.fixed) : "",
        ].filter(Boolean).join(" ");
        // Movable shapes drag (boxes by their header); everything else stays put
        const drag = movable ? { draggable: true, ...(boxed ? { dragHandle: `.${s.boxHead}` } : {}) } : {};
        return cls || movable ? { ...n, ...drag, ...(cls ? { className: cls } : {}) } : n;
      }),
    [p.nodes, p.focus, p.selectedId, p.exporting, p.connect, p.movable, connectMode, arrange, dragId],
  );
  const edges = useMemo(() => {
    const base = p.focus ? p.edges.map((e) => (p.focus!.has(e.source) && p.focus!.has(e.target) ? e : { ...e, className: s.dimmedEdge })) : p.edges;
    // The selected manual line gets a halo
    return p.selectedLine ? base.map((e) => (e.id === p.selectedLine ? { ...e, className: `${e.className ?? ""} ${s.lineSelected}` } : e)) : base;
  }, [p.edges, p.focus, p.selectedLine]);

  // Fit when the data or region changes (or on request)
  // Only on fitKey: a drop or a column change resizes the layout, and re-fitting then threw the user's view away (and
  // overrode the anchor that keeps the edited container still)
  const boundsRef = useRef(p.bounds);
  boundsRef.current = p.bounds;
  const fitAll = useCallback(() => {
    const b = boundsRef.current;
    rf.fitBounds({ x: 0, y: 0, width: b.width, height: b.height }, { padding: 0.04 });
  }, [rf]);
  useEffect(() => {
    const id = requestAnimationFrame(fitAll);
    return () => cancelAnimationFrame(id);
  }, [p.fitKey, fitAll]);
  // Safety net: the diagram is off the canvas → a chip with "fit" (never automatic — the user may have panned there on
  // purpose); a viewport that is not a number is repaired at once
  const { width: bw, height: bh } = p.bounds;
  const lost = useStore((st) => viewportLost({ width: bw, height: bh }, st.transform, { width: st.width, height: st.height }));
  useEffect(() => { if (lost === "invalid") fitAll(); }, [lost, fitAll]);

  // Keep the toggled VNet under the pointer: shift the viewport by how far it moved
  // (each anchor object is applied once, on the layout it was recorded for)
  useLayoutEffect(() => {
    const a = p.anchor;
    if (!a || appliedAnchor.current === a) return;
    appliedAnchor.current = a;
    const now = p.nodes.find((n) => n.id === a.id);
    if (!now) return;
    const vp = rf.getViewport();
    rf.setViewport({ x: vp.x - (now.position.x - a.x) * vp.zoom, y: vp.y - (now.position.y - a.y) * vp.zoom, zoom: vp.zoom });
  }, [p.nodes, p.anchor, rf]);

  // Centre on a search hit once it is laid out — two frames later, so a region switch's
  // fit (one frame later) does not override it
  const { centerOn, onCentered } = p;
  useEffect(() => {
    if (!centerOn) return;
    const n = p.nodes.find((x) => x.id === centerOn);
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        if (n) {
          const w = (n.style?.width as number) ?? 0;
          const h = (n.style?.height as number) ?? 0;
          rf.setCenter(n.position.x + w / 2, n.position.y + h / 2, { zoom: Math.max(rf.getZoom(), 0.9), duration: 300 });
        }
        onCentered();
      });
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [centerOn, onCentered, p.nodes, rf]);

  const actions = useMemo(() => ({ toggleVnet: p.onToggleVnet }), [p.onToggleVnet]);
  const onNodeClick = useCallback((_e: React.MouseEvent, n: Node) => pRef.current.onNodeClick(n as Node<ArchNodeData>), []);
  const onEdgeClick = useCallback((_e: React.MouseEvent, e: Edge) => pRef.current.onEdgeClick?.(e.id), []);
  const onPaneClick = useCallback(() => pRef.current.onPaneClick(), []);

  return (
    <div ref={wrapRef} className={s.canvas} data-zoom={p.exporting ? "near" : zoom} data-focus={p.focus ? "on" : undefined} data-edit={p.editMode && p.editMode !== "auto" ? p.editMode : undefined}>
      <ArchActions.Provider value={actions}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          onNodeClick={onNodeClick}
          onEdgeClick={onEdgeClick}
          onPaneClick={onPaneClick}
          onNodeMouseEnter={onNodeMouseEnter}
          onNodeMouseLeave={onNodeMouseLeave}
          nodesDraggable={arrange}
          nodeDragThreshold={4}
          // No auto-pan near the edge: a move stays inside a container already on screen, and while the page had lost the
          // mouse (capture tool) its frame loop kept sliding the diagram with no input at all
          autoPanOnNodeDrag={false}
          // No key features are used (nothing selectable): a Shift / Ctrl left "pressed" by a capture hotkey changes nothing
          selectionKeyCode={null}
          multiSelectionKeyCode={null}
          deleteKeyCode={null}
          onNodeDragStart={onNodeDragStart}
          onNodeDrag={onNodeDrag}
          onNodeDragStop={onNodeDragStop}
          nodesConnectable={false}
          nodesFocusable={false}
          edgesFocusable={false}
          elementsSelectable={false}
          elevateNodesOnSelect={false}
          elevateEdgesOnSelect={false}
          onlyRenderVisibleElements={!p.exporting}
          minZoom={0.05}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
          zoomOnDoubleClick={false}
        >
          <Background gap={20} size={1} color={rgba("ink", 0.07)} />
          {/* React Flow's own fit skips nodes never measured (onlyRenderVisibleElements) — fit the layout bounds instead */}
          <Controls showInteractive={false} showFitView={false} position="bottom-right">
            <ControlButton onClick={fitAll} title={t("arch.view.fit")} aria-label={t("arch.view.fit")}>
              <svg viewBox="0 0 32 30" aria-hidden><path d="M3.692 4.63c0-.53.4-.938.939-.938h5.215V0H4.708C2.13 0 0 2.054 0 4.63v5.216h3.692V4.631zM27.354 0h-5.2v3.692h5.17c.53 0 .984.4.984.939v5.215H32V4.631A4.624 4.624 0 0027.354 0zm.954 24.83c0 .532-.4.94-.939.94h-5.215v3.768h5.215c2.577 0 4.631-2.13 4.631-4.707v-5.139h-3.692v5.139zm-23.677.94c-.531 0-.939-.4-.939-.94v-5.138H0v5.139c0 2.577 2.13 4.707 4.708 4.707h5.138V25.77H4.631z" /></svg>
            </ControlButton>
          </Controls>
          <MiniMap
            className={s.minimap}
            pannable
            zoomable
            nodeColor={(n) => (n.type === "archBox" ? rgba("accent", 0.08) : rgba("ink", 0.35))}
            nodeStrokeColor={(n) => (n.type === "archBox" ? rgba("accent", 0.35) : "transparent")}
          />
          {!p.exporting && p.editMode && p.editMode !== "auto" ? (
            <EditLayer
              p={p}
              byId={byId}
              plan={plan}
              dragId={dragId}
              ghostRef={ghostRef}
              ghostRect={dragRef.current?.rect ?? null}
              hoverId={hoverId}
              previewRef={previewRef}
              toFlow={toFlow}
            />
          ) : null}
        </ReactFlow>
      </ArchActions.Provider>
      {lost && !p.exporting ? (
        <div className={s.viewLost} role="status">
          <span>{t("arch.view.lost")}</span>
          <button type="button" className={s.viewLostBtn} onClick={fitAll}>{t("arch.view.fit")}</button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Everything the editor draws over the diagram, in diagram coordinates (React Flow's edge-label layer moves and
 * zooms with the viewport): arrange — the container's slots, the insertion bar, the ghost and the "only here" chip;
 * connect — partner counts, relationship labels on valid targets, the preview line; a selected manual line's handle.
 * Words keep their screen size whatever the zoom.
 */
function EditLayer({ p, byId, plan, dragId, ghostRef, ghostRect, hoverId, previewRef, toFlow }: {
  p: CanvasProps;
  byId: ReadonlyMap<string, Node<ArchNodeData>>;
  plan: DropPlan | null;
  dragId: string | null;
  ghostRef: React.RefObject<SVGGElement | null>;
  ghostRect: RRect | null;
  hoverId: string | null;
  previewRef: React.RefObject<SVGLineElement | null>;
  toFlow: (e: { clientX: number; clientY: number }) => [number, number];
}) {
  const { t } = useI18n();
  const k = useStore((st) => st.transform[2]);
  const px = (n: number) => n / k; // screen pixels → diagram units
  const accent = "var(--accent)", danger = "var(--danger)", ok = "var(--success)";
  const name = (id: string) => p.nameOf?.(id) ?? id;

  // ── handle drag (bend / bulge): a local draft, committed on release ──
  const [draft, setDraftState] = useState<{ edgeId: string; value: number } | null>(null);
  const draftRef = useRef<{ edgeId: string; value: number } | null>(null);
  const setDraft = (d: { edgeId: string; value: number } | null) => { draftRef.current = d; setDraftState(d); };
  const selected = p.selectedLine ? p.manualEdges?.find((e) => e.id === p.selectedLine) : undefined;
  const handle = selected ? lineHandle(selected) : null;
  const S = selected ? byId.get(selected.source) : undefined, T = selected ? byId.get(selected.target) : undefined;
  const draftPoints = selected && draft && S && T
    ? manualPath(rectOfNode(S), rectOfNode(T), selected.manual!, handle?.kind === "bend" ? draft.value : 0.5, handle?.kind === "bulge" ? draft.value : 0).points
    : null;
  // Elbow handles snap to the gaps between tiles (the routes' own lanes)
  const channels = useMemo(() => {
    const xs: number[] = [], ys: number[] = [];
    for (const n of byId.values()) if (n.type === "archTile") { const r = rectOfNode(n); xs.push(r.x - 7, r.x + r.w + 7); ys.push(r.y - 7, r.y + r.h + 7); }
    return { xs, ys };
  }, [byId]);
  const startHandle = (ev: React.PointerEvent) => {
    if (!selected || !handle) return;
    ev.stopPropagation();
    ev.preventDefault();
    (ev.target as Element).setPointerCapture(ev.pointerId);
    const horizontal = selected.sourceSide === "l" || selected.sourceSide === "r";
    const move = (e: PointerEvent) => {
      let pt = toFlow(e);
      if (handle.kind === "bend") {
        const list = horizontal ? channels.xs : channels.ys;
        const v = horizontal ? pt[0] : pt[1];
        const near = list.reduce((b, c) => (Math.abs(c - v) < Math.abs(b - v) ? c : b), Infinity);
        if (Math.abs(near - v) <= px(10)) pt = horizontal ? [near, pt[1]] : [pt[0], near];
      }
      const value = handleValue(selected, pt);
      if (value != null) setDraft({ edgeId: selected.id, value });
    };
    const end = (commit: boolean) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
      const d = draftRef.current;
      setDraft(null);
      if (commit && d) p.onHandleCommit?.(d.edgeId, d.value);
    };
    const up = () => end(true);
    // Focus lost mid-drag (capture tool): drop the draft, keep the line as it was
    const cancel = () => end(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel);
  };

  const chip = (x: number, y: number, text: string, tone: string, key: string) => (
    <g key={key} transform={`translate(${x} ${y})`}>
      <rect x={0} y={-px(18)} width={px(text.length * 7.2 + 14)} height={px(18)} rx={px(9)} fill="var(--panel-solid)" stroke={tone} strokeWidth={px(1.2)} />
      <text x={px(7)} y={-px(5)} fontSize={px(11)} fontWeight={700} fill={tone}>{text}</text>
    </g>
  );

  const c = p.connect;
  const hovered = c?.from && hoverId && c.targets.has(hoverId) ? byId.get(hoverId) : undefined;
  const from = c?.from ? byId.get(c.from) : undefined;
  const hoverPath = from && hovered ? manualPath(rectOfNode(from), rectOfNode(hovered), c!.style) : null;
  const hoverKind = hovered ? c!.kindOf.get(hovered.id) : undefined;

  return (
    <EdgeLabelRenderer>
      <svg className={s.editLayer} style={{ position: "absolute", left: 0, top: 0, width: 1, height: 1, overflow: "visible", zIndex: 1500 }}>
        {/* ── arrange: area, slots, insertion bar, target slot, ghost ── */}
        {plan ? (
          <g>
            <rect x={plan.area.x - px(4)} y={plan.area.y - px(4)} width={plan.area.w + px(8)} height={plan.area.h + px(8)} rx={px(10)}
              fill={plan.refused ? "rgba(var(--danger-rgb), 0.05)" : "rgba(var(--accent-rgb), 0.05)"} stroke={plan.refused ? danger : accent} strokeWidth={px(2.5)} strokeDasharray={`${px(8)} ${px(5)}`} />
            {plan.slots.map((r, i) => (
              <rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} rx={px(8)} fill="none" stroke={plan.refused ? danger : accent} strokeOpacity={0.55} strokeWidth={px(1.5)} strokeDasharray={`${px(5)} ${px(4)}`} />
            ))}
            {/* Grid cells: occupied = dashed outline, empty = dotted tint, extra column / row = "+" (the box grows) */}
            {plan.cells?.map((c) => (
              <g key={`c${c.col}:${c.row}`} opacity={c.locked ? 0.35 : 1}>
                <rect x={c.rect.x} y={c.rect.y} width={c.rect.w} height={c.rect.h} rx={px(8)}
                  fill={c.occupant ? "none" : "rgba(var(--accent-rgb), 0.06)"}
                  stroke={plan.refused ? danger : accent} strokeOpacity={c.occupant ? 0.55 : 0.4} strokeWidth={px(1.5)}
                  strokeDasharray={c.occupant ? `${px(5)} ${px(4)}` : `${px(1.5)} ${px(4)}`} />
                {!c.occupant ? (
                  <text x={c.rect.x + c.rect.w / 2} y={c.rect.y + c.rect.h / 2 + px(5)} textAnchor="middle" fontSize={px(c.extra ? 18 : 11)} fontWeight={700} fill={accent} fillOpacity={0.55}>
                    {c.extra ? "+" : t("arch.edit.emptyCell")}
                  </text>
                ) : null}
              </g>
            ))}
            {/* Alignment guides through the target cell, across the container */}
            {plan.guides && !plan.refused ? (
              <g stroke={accent} strokeOpacity={0.5} strokeWidth={px(1)} strokeDasharray={`${px(2)} ${px(3)}`}>
                <line x1={plan.guides.x} y1={plan.area.y} x2={plan.guides.x} y2={plan.area.y + plan.area.h} />
                <line x1={plan.area.x} y1={plan.guides.y} x2={plan.area.x + plan.area.w} y2={plan.guides.y} />
              </g>
            ) : null}
            {plan.grow && !plan.refused ? (
              <rect x={plan.grow.x - px(6)} y={plan.grow.y - px(6)} width={plan.grow.w + px(12)} height={plan.grow.h + px(12)} rx={px(10)} fill="none" stroke={accent} strokeWidth={px(1.5)} strokeDasharray={`${px(10)} ${px(4)}`} />
            ) : null}
            {plan.target && !plan.refused ? <rect x={plan.target.x} y={plan.target.y} width={plan.target.w} height={plan.target.h} rx={px(8)} fill="rgba(var(--accent-rgb), 0.16)" stroke={accent} strokeWidth={px(2)} /> : null}
            {/* VNet subnets: each column, "+ new column", the row below (the one the point is in, filled) */}
            {plan.zones?.map((z, i) => (
              <g key={`z${i}`}>
                <rect x={z.rect.x - px(4)} y={z.rect.y - px(4)} width={z.rect.w + px(8)} height={z.rect.h + px(8)} rx={px(8)}
                  fill={z.active ? "rgba(var(--accent-rgb), 0.12)" : z.kind === "col" ? "none" : "rgba(var(--accent-rgb), 0.04)"}
                  stroke={accent} strokeOpacity={z.active ? 0.9 : 0.45} strokeWidth={px(z.active ? 2 : 1.5)} strokeDasharray={`${px(6)} ${px(4)}`} />
                {z.kind !== "col" ? (
                  <text x={z.rect.x + z.rect.w / 2} y={z.rect.y + Math.min(z.rect.h / 2, px(40)) + px(5)} textAnchor="middle" fontSize={px(12)} fontWeight={700} fill={accent} fillOpacity={0.75}>
                    {t(z.kind === "newCol" ? "arch.edit.zone.newCol" : "arch.edit.zone.rest")}
                  </text>
                ) : null}
              </g>
            ))}
            {/* The insertion bar: vertical between items of a row, horizontal between items of a column */}
            {plan.bar && !plan.refused ? (
              plan.bar.w > plan.bar.h
                ? <rect x={plan.bar.x} y={plan.bar.y + plan.bar.h / 2 - px(2)} width={plan.bar.w} height={px(4)} rx={px(2)} fill={accent} />
                : <rect x={plan.bar.x - px(1.5)} y={plan.bar.y} width={px(4)} height={plan.bar.h} rx={px(2)} fill={accent} />
            ) : null}
            {chip(plan.area.x, plan.area.y - px(8), plan.refused ? t("arch.edit.snapBack") : t("arch.edit.onlyHere", { name: name(plan.containerId) }), plan.refused ? danger : accent, "area")}
            {plan.target && !plan.refused && plan.swapWith ? chip(plan.target.x, plan.target.y + plan.target.h + px(20), t("arch.edit.swapChip", { name: name(plan.swapWith) }), accent, "swap") : null}
            {plan.target && !plan.refused && plan.grow && !plan.swapWith ? chip(plan.target.x, plan.target.y + plan.target.h + px(20), t("arch.edit.growChip"), accent, "grow") : null}
          </g>
        ) : null}
        {dragId && ghostRect ? (
          <g ref={ghostRef}>
            <rect x={ghostRect.x} y={ghostRect.y} width={ghostRect.w} height={ghostRect.h} rx={px(10)} fill="rgba(var(--accent-rgb), 0.12)" stroke={accent} strokeWidth={px(2)} />
            <text x={ghostRect.x + px(10)} y={ghostRect.y + px(20)} fontSize={px(12)} fontWeight={700} fill="var(--ink)">{name(dragId)}</text>
          </g>
        ) : null}

        {/* ── connect: partner counts before a pick; relationship labels, preview line after ── */}
        {c && !c.from
          ? [...c.counts].filter(([, n]) => n > 0).map(([id, n]) => {
              const nd = byId.get(id);
              if (!nd) return null;
              const r = rectOfNode(nd);
              return chip(r.x + r.w - px(70), r.y - px(2), t("arch.edit.connectableN", { n }), ok, `cnt:${id}`);
            })
          : null}
        {c?.from
          ? [...c.targets].map(([id, label]) => {
              const nd = byId.get(id);
              if (!nd) return null;
              const r = rectOfNode(nd);
              return chip(r.x, r.y - px(2), label, ok, `tgt:${id}`);
            })
          : null}
        {c?.from && !hoverPath ? <line ref={previewRef} stroke={accent} strokeWidth={px(2)} strokeDasharray={`${px(6)} ${px(4)}`} /> : null}
        {hoverPath ? (
          hoverPath.curve
            ? <path d={`M${hoverPath.points[0]![0]},${hoverPath.points[0]![1]} C${hoverPath.points[1]![0]},${hoverPath.points[1]![1]} ${hoverPath.points[2]![0]},${hoverPath.points[2]![1]} ${hoverPath.points[3]![0]},${hoverPath.points[3]![1]}`} fill="none" stroke={hoverKind ? EDGE_STYLE[hoverKind].stroke : ok} strokeOpacity={0.7} strokeWidth={px(3)} />
            : <path d={roundedPath(hoverPath.points, 6)} fill="none" stroke={hoverKind ? EDGE_STYLE[hoverKind].stroke : ok} strokeOpacity={0.7} strokeWidth={px(3)} />
        ) : null}

        {/* ── the selected manual line's handle (and its draft while dragging) ── */}
        {draftPoints && selected ? (
          selected.manual === "curve"
            ? <path d={`M${draftPoints[0]![0]},${draftPoints[0]![1]} C${draftPoints[1]![0]},${draftPoints[1]![1]} ${draftPoints[2]![0]},${draftPoints[2]![1]} ${draftPoints[3]![0]},${draftPoints[3]![1]}`} fill="none" stroke={EDGE_STYLE[selected.kind].stroke} strokeWidth={px(3)} />
            : <path d={roundedPath(draftPoints, 6)} fill="none" stroke={EDGE_STYLE[selected.kind].stroke} strokeWidth={px(3)} />
        ) : null}
        {handle && selected ? (() => {
          const at = draft && draftPoints ? lineHandle({ ...selected, points: draftPoints })!.at : handle.at;
          const size = px(14);
          const common = {
            style: { pointerEvents: "all" as const, cursor: handle.kind === "bend" ? (selected.sourceSide === "l" || selected.sourceSide === "r" ? "ew-resize" : "ns-resize") : "move" },
            className: "nodrag nopan",
            fill: "var(--panel-solid)", stroke: accent, strokeWidth: px(2.5),
            onPointerDown: startHandle,
            onDoubleClick: (e: React.MouseEvent) => { e.stopPropagation(); p.onHandleCommit?.(selected.id, null); },
          };
          return (
            <g>
              {handle.kind === "bend"
                ? <rect x={at[0] - size / 2} y={at[1] - size / 2} width={size} height={size} rx={px(3)} {...common} />
                : <circle cx={at[0]} cy={at[1]} r={size / 2} {...common} />}
              {draft ? chip(at[0] + px(12), at[1] - px(10), handle.kind === "bend" ? `${Math.round(draft.value * 100)}%` : `${draft.value > 0 ? "+" : ""}${Math.round(draft.value * 100)}%`, accent, "val") : null}
            </g>
          );
        })() : null}
      </svg>
    </EdgeLabelRenderer>
  );
}

export function DiagramCanvas(props: CanvasProps) {
  return (
    <ReactFlowProvider>
      <Inner {...props} />
    </ReactFlowProvider>
  );
}
