"use client";

import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import ReactFlow, { Background, Controls, MiniMap, ReactFlowProvider, useReactFlow, useStore, type Edge, type Node } from "reactflow";
import type { ArchNodeData } from "./ArchNodes";
import { ArchActions, NODE_TYPES } from "./ArchNodes";
import s from "../styles.module.css";
import { rgba } from "@/lib/palette";

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
  /** Shape to keep still on screen across the next re-layout (expand / collapse) */
  anchor: { id: string; x: number; y: number } | null;
  /** Shape to centre on after the next re-layout (search) */
  centerOn: string | null;
  onCentered: () => void;
  /** PNG export in progress: render every node (no virtualization), full detail, no selection ring */
  exporting?: boolean;
};

const zoomBucket = (z: number) => (z < 0.45 ? "far" : z < 0.85 ? "mid" : "near");

function Inner(p: CanvasProps) {
  const rf = useReactFlow();
  // Zoom level bucket as a data attribute — CSS hides detail when far. The selector returns a
  // string, so this component re-renders only when a threshold is crossed.
  const zoom = useStore((st) => zoomBucket(st.transform[2]));
  const appliedAnchor = useRef<CanvasProps["anchor"]>(null);

  // Dim what is not in focus without touching node data (memoized nodes skip re-render)
  const nodes = useMemo(
    () =>
      p.nodes.map((n) => {
        const boxed = n.type === "archBox";
        const dim = !!p.focus && !boxed && !p.focus.has(n.id);
        const sel = !p.exporting && p.selectedId === n.id;
        const cls = [dim ? s.dimmed : "", sel ? s.selected : ""].filter(Boolean).join(" ");
        return cls ? { ...n, className: cls } : n;
      }),
    [p.nodes, p.focus, p.selectedId, p.exporting],
  );
  const edges = useMemo(
    () => (p.focus ? p.edges.map((e) => (p.focus!.has(e.source) && p.focus!.has(e.target) ? e : { ...e, className: s.dimmedEdge })) : p.edges),
    [p.edges, p.focus],
  );

  // Fit when the data or region changes (or on request)
  const { width: bw, height: bh } = p.bounds;
  useEffect(() => {
    const id = requestAnimationFrame(() => rf.fitBounds({ x: 0, y: 0, width: bw, height: bh }, { padding: 0.04 }));
    return () => cancelAnimationFrame(id);
  }, [p.fitKey, rf, bw, bh]);

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

  return (
    <div className={s.canvas} data-zoom={p.exporting ? "near" : zoom} data-focus={p.focus ? "on" : undefined}>
      <ArchActions.Provider value={actions}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          onNodeClick={(_e, n) => p.onNodeClick(n as Node<ArchNodeData>)}
          onPaneClick={p.onPaneClick}
          nodesDraggable={false}
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
          <Controls showInteractive={false} position="bottom-right" />
          <MiniMap
            className={s.minimap}
            pannable
            zoomable
            nodeColor={(n) => (n.type === "archBox" ? rgba("accent", 0.08) : rgba("ink", 0.35))}
            nodeStrokeColor={(n) => (n.type === "archBox" ? rgba("accent", 0.35) : "transparent")}
          />
        </ReactFlow>
      </ArchActions.Provider>
    </div>
  );
}

export function DiagramCanvas(props: CanvasProps) {
  return (
    <ReactFlowProvider>
      <Inner {...props} />
    </ReactFlowProvider>
  );
}
