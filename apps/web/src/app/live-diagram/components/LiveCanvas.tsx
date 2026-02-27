"use client";

import { useMemo, useCallback, useRef, useState, useEffect } from "react";
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  ReactFlowProvider,
  useNodesState,
  useOnViewportChange,
  getBezierPath,
  Position,
  type Node as FlowNode,
  type Edge as FlowEdge,
  type NodeTypes,
  type EdgeTypes,
  type Viewport,
} from "reactflow";
import type {
  DiagramSpec,
  LiveDiagramSnapshot,
  VisualizationMode,
} from "@aud/types";
import { LiveNode, type LiveNodeData } from "./LiveNode";
import { AnimatedEdge, type AnimatedEdgeData } from "./AnimatedEdge";
import { D3ParticleCanvas } from "./D3ParticleCanvas";
import { FaultRipple } from "./FaultRipple";
import { ImpactCascade } from "./ImpactCascade";
import { TrafficHeatmap } from "./TrafficHeatmap";
import { nodeColor } from "../utils/designTokens";
import styles from "../styles.module.css";

type LiveCanvasProps = {
  spec: DiagramSpec;
  snapshot: LiveDiagramSnapshot | null;
  onNodeSelect: (nodeId: string | null) => void;
  vizMode: VisualizationMode;
  showParticles: boolean;
  showFaultRipple: boolean;
  showHeatmap: boolean;
};

const nodeTypes: NodeTypes = { live: LiveNode };
const edgeTypes: EdgeTypes = { animated: AnimatedEdge };

/** Minimum gap between nodes to prevent overlap (px) */
const NODE_MIN_GAP = 20;
const NODE_WIDTH = 220;
const NODE_HEIGHT = 80;

function LiveCanvasInner({
  spec,
  snapshot,
  onNodeSelect,
  vizMode,
  showParticles,
  showFaultRipple,
  showHeatmap,
}: LiveCanvasProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const viewTransformRef = useRef({ x: 0, y: 0, zoom: 1 });
  const [viewTransform, setViewTransform] = useState({ x: 0, y: 0, zoom: 1 });

  // Track container size
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const obs = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setDimensions({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
      }
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // Continuous viewport tracking — fires on every frame during pan/zoom
  useOnViewportChange({
    onChange: useCallback((vp: Viewport) => {
      viewTransformRef.current = { x: vp.x, y: vp.y, zoom: vp.zoom };
      setViewTransform({ x: vp.x, y: vp.y, zoom: vp.zoom });
    }, []),
  });

  // Build initial nodes from spec — then managed by useNodesState for dragging
  const initialNodes: FlowNode<LiveNodeData>[] = useMemo(() => {
    return spec.nodes.map((nodeSpec) => {
      const live = snapshot?.nodes.find((n) => n.id === nodeSpec.id);
      return {
        id: nodeSpec.id,
        type: "live",
        position: nodeSpec.position ?? { x: 0, y: 0 },
        draggable: true,
        data: {
          label: nodeSpec.label,
          icon: nodeSpec.icon,
          health: live?.health ?? "unknown",
          healthScore: live?.healthScore ?? 0.5,
          metrics: live?.metrics ?? {},
          hasAlert: (live?.activeAlertIds.length ?? 0) > 0,
          sparklines: live?.sparklines,
        },
      };
    });
  }, [spec.nodes, snapshot?.nodes]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);

  // Sync nodes with spec: update existing, add new, REMOVE stale (when spec changes)
  useEffect(() => {
    setNodes((prev) => {
      const specIds = new Set(spec.nodes.map((s) => s.id));
      const prevById = new Map(prev.map((n) => [n.id, n]));

      return spec.nodes.map((nodeSpec) => {
        const existing = prevById.get(nodeSpec.id);
        const live = snapshot?.nodes.find((s) => s.id === nodeSpec.id);
        const data: LiveNodeData = {
          label: nodeSpec.label,
          icon: nodeSpec.icon,
          health: live?.health ?? "unknown",
          healthScore: live?.healthScore ?? 0.5,
          metrics: live?.metrics ?? {},
          hasAlert: (live?.activeAlertIds.length ?? 0) > 0,
          sparklines: live?.sparklines,
        };

        if (existing) {
          // Preserve drag position, update data only
          return { ...existing, data };
        }
        // New node from spec
        return {
          id: nodeSpec.id,
          type: "live" as const,
          position: nodeSpec.position ?? { x: 0, y: 0 },
          draggable: true,
          data,
        } as FlowNode<LiveNodeData>;
      });
      // Nodes NOT in spec.nodes are automatically dropped (not included in the map output)
    });
  }, [spec.nodes, snapshot?.nodes, setNodes]);

  // Snap-back collision prevention after drag ends
  const handleNodesChange = useCallback(
    (changes: Parameters<typeof onNodesChange>[0]) => {
      onNodesChange(changes);

      // After a drag ends, check for overlaps and nudge if needed
      const dragEnd = changes.find(
        (c) => c.type === "position" && c.dragging === false,
      );
      if (!dragEnd) return;

      setNodes((prev) => {
        const draggedId = dragEnd.type === "position" ? dragEnd.id : null;
        if (!draggedId) return prev;

        const dragged = prev.find((n) => n.id === draggedId);
        if (!dragged) return prev;

        let { x, y } = dragged.position;
        let adjusted = false;

        for (const other of prev) {
          if (other.id === draggedId) continue;
          const dx = x - other.position.x;
          const dy = y - other.position.y;
          const overlapX = NODE_WIDTH + NODE_MIN_GAP - Math.abs(dx);
          const overlapY = NODE_HEIGHT + NODE_MIN_GAP - Math.abs(dy);

          if (overlapX > 0 && overlapY > 0) {
            // Push out on the axis with less overlap
            if (overlapX < overlapY) {
              x += dx >= 0 ? overlapX : -overlapX;
            } else {
              y += dy >= 0 ? overlapY : -overlapY;
            }
            adjusted = true;
          }
        }

        if (!adjusted) return prev;
        return prev.map((n) =>
          n.id === draggedId ? { ...n, position: { x, y } } : n,
        );
      });
    },
    [onNodesChange, setNodes],
  );

  const edges: FlowEdge<AnimatedEdgeData>[] = useMemo(() => {
    return spec.edges.map((edgeSpec) => {
      const live = snapshot?.edges.find((e) => e.id === edgeSpec.id);
      return {
        id: edgeSpec.id,
        source: edgeSpec.source,
        target: edgeSpec.target,
        type: "animated",
        data: {
          status: live?.status ?? "idle",
          trafficLevel: live?.trafficLevel ?? "none",
          label: edgeSpec.label,
        },
      };
    });
  }, [spec.edges, snapshot?.edges]);

  // Build node positions map with actual measured dimensions from ReactFlow
  const nodePositions = useMemo(() => {
    const map = new Map<string, { x: number; y: number; w: number; h: number }>();
    for (const node of nodes) {
      map.set(node.id, {
        ...node.position,
        w: node.width ?? NODE_WIDTH,
        h: node.height ?? NODE_HEIGHT,
      });
    }
    return map;
  }, [nodes]);

  /** Compute edge endpoints matching ReactFlow handle positions (Right→Left). */
  function edgeEndpoints(srcId: string, tgtId: string) {
    const src = nodePositions.get(srcId) ?? { x: 0, y: 0, w: NODE_WIDTH, h: NODE_HEIGHT };
    const tgt = nodePositions.get(tgtId) ?? { x: 0, y: 0, w: NODE_WIDTH, h: NODE_HEIGHT };
    return {
      sourceX: src.x + src.w,       // Right edge (Position.Right handle)
      sourceY: src.y + src.h / 2,   // Vertical center
      targetX: tgt.x,               // Left edge (Position.Left handle)
      targetY: tgt.y + tgt.h / 2,   // Vertical center
    };
  }

  // Build particle edge data with SVG path strings for exact alignment
  const particleEdges = useMemo(() => {
    if (!showParticles || vizMode !== "2d-animated") return [];

    return spec.edges.map((edgeSpec) => {
      const live = snapshot?.edges.find((e) => e.id === edgeSpec.id);
      const pts = edgeEndpoints(edgeSpec.source, edgeSpec.target);
      // Compute the exact same SVG path that ReactFlow renders
      const [pathD] = getBezierPath({
        sourceX: pts.sourceX,
        sourceY: pts.sourceY,
        sourcePosition: Position.Right,
        targetX: pts.targetX,
        targetY: pts.targetY,
        targetPosition: Position.Left,
      });
      return {
        id: edgeSpec.id,
        ...pts,
        pathD,
        status: live?.status ?? ("idle" as const),
        trafficLevel: live?.trafficLevel ?? ("none" as const),
        metrics: live?.metrics,
      };
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec.edges, snapshot?.edges, nodePositions, showParticles, vizMode]);

  // Build edge paths for cascade overlay
  const edgePaths = useMemo(() => {
    const map = new Map<string, { sourceX: number; sourceY: number; targetX: number; targetY: number }>();
    for (const edgeSpec of spec.edges) {
      if (!nodePositions.has(edgeSpec.source) || !nodePositions.has(edgeSpec.target)) continue;
      map.set(edgeSpec.id, edgeEndpoints(edgeSpec.source, edgeSpec.target));
    }
    return map;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec.edges, nodePositions]);

  // Build heatmap edge positions
  const heatmapEdgePositions = useMemo(() => {
    const map = new Map<string, { id: string; sourceX: number; sourceY: number; targetX: number; targetY: number }>();
    for (const edgeSpec of spec.edges) {
      if (!nodePositions.has(edgeSpec.source) || !nodePositions.has(edgeSpec.target)) continue;
      const key = `${edgeSpec.source}->${edgeSpec.target}`;
      map.set(key, { id: edgeSpec.id, ...edgeEndpoints(edgeSpec.source, edgeSpec.target) });
    }
    return map;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec.edges, nodePositions]);

  const faultImpacts = snapshot?.faultImpacts ?? [];
  const heatmapData = snapshot?.heatmap ?? null;

  return (
    <div ref={wrapRef} className={styles.canvasWrap}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={handleNodesChange}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeClick={(_e, node) => onNodeSelect(node.id)}
        onPaneClick={() => onNodeSelect(null)}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={20} size={1} color="rgba(20,21,23,0.06)" />
        <Controls />
        <MiniMap
          nodeColor={(n) => {
            const health = (n.data as LiveNodeData | undefined)?.health ?? "unknown";
            return nodeColor(health).ringStroke;
          }}
          maskColor="rgba(247,248,250,0.85)"
          style={{ borderRadius: 12, border: "1px solid rgba(20,21,23,0.10)" }}
        />
      </ReactFlow>

      {/* D3 Particle Canvas overlay */}
      {vizMode === "2d-animated" && showParticles && (
        <D3ParticleCanvas
          edges={particleEdges}
          width={dimensions.width}
          height={dimensions.height}
          transform={viewTransform}
          enabled={showParticles}
        />
      )}

      {/* Fault Ripple overlay */}
      {showFaultRipple && faultImpacts.length > 0 && (
        <FaultRipple
          impacts={faultImpacts}
          nodePositions={nodePositions}
          transform={viewTransform}
          width={dimensions.width}
          height={dimensions.height}
          enabled={showFaultRipple}
        />
      )}

      {/* Impact Cascade overlay */}
      {showFaultRipple && faultImpacts.length > 0 && (
        <ImpactCascade
          impacts={faultImpacts}
          nodePositions={nodePositions}
          edgePaths={edgePaths}
          transform={viewTransform}
          width={dimensions.width}
          height={dimensions.height}
          enabled={showFaultRipple}
        />
      )}

      {/* Traffic Heatmap overlay */}
      {showHeatmap && (
        <TrafficHeatmap
          heatmap={heatmapData}
          edgePositions={heatmapEdgePositions}
          transform={viewTransform}
          width={dimensions.width}
          height={dimensions.height}
          enabled={showHeatmap}
        />
      )}
    </div>
  );
}

export function LiveCanvas(props: LiveCanvasProps) {
  return (
    <ReactFlowProvider>
      <LiveCanvasInner {...props} />
    </ReactFlowProvider>
  );
}
