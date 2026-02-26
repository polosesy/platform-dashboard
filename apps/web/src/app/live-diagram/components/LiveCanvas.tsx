"use client";

import { useMemo, useCallback, useRef, useState, useEffect } from "react";
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  useReactFlow,
  ReactFlowProvider,
  type Node as FlowNode,
  type Edge as FlowEdge,
  type NodeTypes,
  type EdgeTypes,
} from "reactflow";
import type {
  DiagramSpec,
  LiveDiagramSnapshot,
  VisualizationMode,
  FaultImpact,
  TrafficHeatmapData,
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

  const nodes: FlowNode<LiveNodeData>[] = useMemo(() => {
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

  // Build node positions map for overlay components
  const nodePositions = useMemo(() => {
    const map = new Map<string, { x: number; y: number }>();
    for (const node of nodes) {
      map.set(node.id, node.position);
    }
    return map;
  }, [nodes]);

  // Build particle edge data from React Flow nodes
  const particleEdges = useMemo(() => {
    if (!showParticles || vizMode !== "2d-animated") return [];

    return spec.edges.map((edgeSpec) => {
      const live = snapshot?.edges.find((e) => e.id === edgeSpec.id);
      const srcPos = nodePositions.get(edgeSpec.source) ?? { x: 0, y: 0 };
      const tgtPos = nodePositions.get(edgeSpec.target) ?? { x: 0, y: 0 };
      return {
        id: edgeSpec.id,
        sourceX: srcPos.x + 180, // Right side of node
        sourceY: srcPos.y + 36,  // Center of node
        targetX: tgtPos.x,       // Left side of target
        targetY: tgtPos.y + 36,
        status: live?.status ?? ("idle" as const),
        trafficLevel: live?.trafficLevel ?? ("none" as const),
        metrics: live?.metrics,
      };
    });
  }, [spec.edges, snapshot?.edges, nodePositions, showParticles, vizMode]);

  // Build edge paths for cascade overlay
  const edgePaths = useMemo(() => {
    const map = new Map<string, { sourceX: number; sourceY: number; targetX: number; targetY: number }>();
    for (const edgeSpec of spec.edges) {
      const srcPos = nodePositions.get(edgeSpec.source);
      const tgtPos = nodePositions.get(edgeSpec.target);
      if (srcPos && tgtPos) {
        map.set(edgeSpec.id, {
          sourceX: srcPos.x + 180,
          sourceY: srcPos.y + 36,
          targetX: tgtPos.x,
          targetY: tgtPos.y + 36,
        });
      }
    }
    return map;
  }, [spec.edges, nodePositions]);

  // Build heatmap edge positions
  const heatmapEdgePositions = useMemo(() => {
    const map = new Map<string, { id: string; sourceX: number; sourceY: number; targetX: number; targetY: number }>();
    for (const edgeSpec of spec.edges) {
      const srcPos = nodePositions.get(edgeSpec.source);
      const tgtPos = nodePositions.get(edgeSpec.target);
      if (srcPos && tgtPos) {
        const key = `${edgeSpec.source}->${edgeSpec.target}`;
        map.set(key, {
          id: edgeSpec.id,
          sourceX: srcPos.x + 180,
          sourceY: srcPos.y + 36,
          targetX: tgtPos.x,
          targetY: tgtPos.y + 36,
        });
      }
    }
    return map;
  }, [spec.edges, nodePositions]);

  const faultImpacts = snapshot?.faultImpacts ?? [];
  const heatmapData = snapshot?.heatmap ?? null;

  return (
    <div ref={wrapRef} className={styles.canvasWrap}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeClick={(_e, node) => onNodeSelect(node.id)}
        onPaneClick={() => onNodeSelect(null)}
        onMoveEnd={(_e, viewport) => {
          setViewTransform({ x: viewport.x, y: viewport.y, zoom: viewport.zoom });
        }}
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
