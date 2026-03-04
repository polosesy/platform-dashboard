"use client";

import { useMemo, useCallback, useRef, useState, useEffect } from "react";
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  ReactFlowProvider,
  useNodesState,
  useOnViewportChange,
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
  SubResource,
} from "@aud/types";
import { LiveNode, type LiveNodeData } from "./LiveNode";
import { GroupNode, type GroupNodeData } from "./GroupNode";
import { AnimatedEdge, type AnimatedEdgeData } from "./AnimatedEdge";
import { FaultRipple } from "./FaultRipple";
import { ImpactCascade } from "./ImpactCascade";
import { TrafficHeatmap } from "./TrafficHeatmap";
import { nodeColor } from "../utils/designTokens";
import styles from "../styles.module.css";

type LiveCanvasProps = {
  spec: DiagramSpec;
  snapshot: LiveDiagramSnapshot | null;
  onNodeSelect: (nodeId: string | null) => void;
  onSubResourceSelect?: (sr: SubResource) => void;
  vizMode: VisualizationMode;
  showNetworkFlow: boolean;
  showParticles: boolean;
  showFaultRipple: boolean;
  showHeatmap: boolean;
};

const nodeTypes: NodeTypes = { live: LiveNode, group: GroupNode };
const edgeTypes: EdgeTypes = { animated: AnimatedEdge };

/** Minimum gap between nodes to prevent overlap (px) */
const NODE_MIN_GAP = 20;
const NODE_WIDTH = 220;
const NODE_HEIGHT = 80;

function LiveCanvasInner({
  spec,
  snapshot,
  onNodeSelect,
  onSubResourceSelect,
  vizMode,
  showNetworkFlow,
  showParticles,
  showFaultRipple,
  showHeatmap,
}: LiveCanvasProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const [viewTransform, setViewTransform] = useState({ x: 0, y: 0, zoom: 1 });

  // ── Hover highlight state ──
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);

  // Compute connected edges + nodes from hovered node
  const { connectedEdgeIds, connectedNodeIds } = useMemo(() => {
    if (!hoveredNodeId) return { connectedEdgeIds: new Set<string>(), connectedNodeIds: new Set<string>() };
    const eIds = new Set<string>();
    const nIds = new Set<string>([hoveredNodeId]);
    for (const e of spec.edges) {
      if (e.source === hoveredNodeId || e.target === hoveredNodeId) {
        eIds.add(e.id);
        nIds.add(e.source);
        nIds.add(e.target);
      }
    }
    return { connectedEdgeIds: eIds, connectedNodeIds: nIds };
  }, [hoveredNodeId, spec.edges]);

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
      setViewTransform({ x: vp.x, y: vp.y, zoom: vp.zoom });
    }, []),
  });

  // Build initial nodes from spec — group nodes first, then resource nodes
  const initialNodes = useMemo(() => {
    // Group nodes MUST come before their children in the array for ReactFlow
    const sorted = [...spec.nodes].sort((a, b) => {
      const aGroup = a.nodeType === "group" ? 0 : 1;
      const bGroup = b.nodeType === "group" ? 0 : 1;
      if (aGroup !== bGroup) return aGroup - bGroup;
      // Among groups, parents before children (no parentId first)
      const aHasParent = a.parentId ? 1 : 0;
      const bHasParent = b.parentId ? 1 : 0;
      return aHasParent - bHasParent;
    });

    const result = sorted.map((nodeSpec) => {
      if (nodeSpec.nodeType === "group") {
        const groupNode: FlowNode<GroupNodeData> = {
          id: nodeSpec.id,
          type: "group",
          position: nodeSpec.position ?? { x: 0, y: 0 },
          draggable: true,
          selectable: true,
          style: {
            width: nodeSpec.width ?? 400,
            height: nodeSpec.height ?? 200,
          },
          data: {
            label: nodeSpec.label,
            icon: nodeSpec.icon,
            subtitle: nodeSpec.metadata?.addressSpace ?? nodeSpec.metadata?.prefix,
          },
        };
        if (nodeSpec.parentId) {
          (groupNode as FlowNode<GroupNodeData> & { parentNode: string }).parentNode = nodeSpec.parentId;
        }
        return groupNode;
      }

      const live = snapshot?.nodes.find((n) => n.id === nodeSpec.id);
      const liveNode: FlowNode<LiveNodeData> = {
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
          endpoint: nodeSpec.endpoint,
          subResources: nodeSpec.subResources,
          onSubResourceSelect,
        },
      };
      if (nodeSpec.parentId) {
        (liveNode as FlowNode<LiveNodeData> & { parentNode: string; extent: string }).parentNode = nodeSpec.parentId;
        (liveNode as FlowNode<LiveNodeData> & { extent: string }).extent = "parent";
      }
      return liveNode;
    });

    // ── Checkpoint 2: Verify parentNode mapping ──
    if (process.env.NODE_ENV !== "production") {
      const specWithParent = spec.nodes.filter((n) => n.parentId);
      type AnyFlowNode = FlowNode & { parentNode?: string; extent?: string };
      const flowWithParent = result.filter((n) => (n as AnyFlowNode).parentNode);
      const allIds = new Set(result.map((n) => n.id));
      const brokenRefs = flowWithParent.filter((n) => !allIds.has((n as AnyFlowNode).parentNode!));
      console.log(
        `[CP2] spec.nodes: ${spec.nodes.length} total, ${specWithParent.length} with parentId` +
        ` → flowNodes: ${result.length} total, ${flowWithParent.length} with parentNode` +
        ` (${brokenRefs.length} broken refs)`,
      );
      // Sample first 5
      for (const n of flowWithParent.slice(0, 5)) {
        const an = n as AnyFlowNode;
        console.log(`[CP2]  "${n.id}" type=${n.type} parentNode="${an.parentNode}" extent="${an.extent}" pos=(${n.position.x},${n.position.y})`);
      }
      if (brokenRefs.length > 0) {
        for (const n of brokenRefs.slice(0, 3)) {
          console.error(`[CP2] BROKEN: "${n.id}" parentNode="${(n as AnyFlowNode).parentNode}" NOT in node array`);
        }
      }
    }

    return result;
  }, [spec.nodes, snapshot?.nodes, onSubResourceSelect]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);

  // Sync nodes with spec: update data for existing, preserve positions
  useEffect(() => {
    setNodes((prev) => {
      const prevById = new Map(prev.map((n) => [n.id, n]));

      // Sort: groups first, parents before children
      const sorted = [...spec.nodes].sort((a, b) => {
        const aGroup = a.nodeType === "group" ? 0 : 1;
        const bGroup = b.nodeType === "group" ? 0 : 1;
        if (aGroup !== bGroup) return aGroup - bGroup;
        const aHasParent = a.parentId ? 1 : 0;
        const bHasParent = b.parentId ? 1 : 0;
        return aHasParent - bHasParent;
      });

      const result = sorted.map((nodeSpec) => {
        const existing = prevById.get(nodeSpec.id);

        if (nodeSpec.nodeType === "group") {
          const data: GroupNodeData = {
            label: nodeSpec.label,
            icon: nodeSpec.icon,
            subtitle: nodeSpec.metadata?.addressSpace ?? nodeSpec.metadata?.prefix,
          };
          if (existing) {
            const updated = { ...existing, data } as FlowNode<GroupNodeData> & { parentNode?: string };
            if (nodeSpec.parentId) updated.parentNode = nodeSpec.parentId;
            else delete updated.parentNode;
            return updated;
          }
          const gn: FlowNode<GroupNodeData> = {
            id: nodeSpec.id,
            type: "group",
            position: nodeSpec.position ?? { x: 0, y: 0 },
            draggable: true,
            selectable: true,
            style: { width: nodeSpec.width ?? 400, height: nodeSpec.height ?? 200 },
            data,
          };
          if (nodeSpec.parentId) {
            (gn as FlowNode<GroupNodeData> & { parentNode: string }).parentNode = nodeSpec.parentId;
          }
          return gn;
        }

        const live = snapshot?.nodes.find((s) => s.id === nodeSpec.id);
        const data: LiveNodeData = {
          label: nodeSpec.label,
          icon: nodeSpec.icon,
          health: live?.health ?? "unknown",
          healthScore: live?.healthScore ?? 0.5,
          metrics: live?.metrics ?? {},
          hasAlert: (live?.activeAlertIds.length ?? 0) > 0,
          sparklines: live?.sparklines,
          endpoint: nodeSpec.endpoint,
          subResources: nodeSpec.subResources,
          onSubResourceSelect,
        };

        if (existing) {
          const updated = { ...existing, data } as FlowNode<LiveNodeData> & { parentNode?: string; extent?: string };
          if (nodeSpec.parentId) {
            updated.parentNode = nodeSpec.parentId;
            updated.extent = "parent";
          } else {
            delete updated.parentNode;
            delete updated.extent;
          }
          return updated;
        }

        const ln: FlowNode<LiveNodeData> = {
          id: nodeSpec.id,
          type: "live" as const,
          position: nodeSpec.position ?? { x: 0, y: 0 },
          draggable: true,
          data,
        };
        if (nodeSpec.parentId) {
          (ln as FlowNode<LiveNodeData> & { parentNode: string; extent: string }).parentNode = nodeSpec.parentId;
          (ln as FlowNode<LiveNodeData> & { extent: string }).extent = "parent";
        }
        return ln;
      });

      // ── Checkpoint 3: Verify parentNode survives setNodes ──
      if (process.env.NODE_ENV !== "production") {
        type AnyFlowNode = FlowNode & { parentNode?: string };
        const withParent = result.filter((n) => (n as AnyFlowNode).parentNode);
        const prevWithParent = prev.filter((n) => (n as AnyFlowNode).parentNode);
        console.log(
          `[CP3] setNodes sync: prev ${prev.length} nodes (${prevWithParent.length} with parentNode)` +
          ` → next ${result.length} nodes (${withParent.length} with parentNode)`,
        );
      }

      return result;
    });
  }, [spec.nodes, snapshot?.nodes, setNodes, onSubResourceSelect]);

  // ── Hover: set node className for CSS dimming ──
  useEffect(() => {
    if (!hoveredNodeId) {
      setNodes((prev) => {
        const needsUpdate = prev.some((n) => n.className);
        if (!needsUpdate) return prev;
        return prev.map((n) => n.className ? { ...n, className: "" } : n);
      });
      return;
    }
    setNodes((prev) => prev.map((n) => ({
      ...n,
      className: connectedNodeIds.has(n.id) ? "node-highlighted" : "node-dimmed",
    })));
  }, [hoveredNodeId, connectedNodeIds, setNodes]);

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
        if (!dragged || dragged.type === "group") return prev;

        // FIX: Skip collision detection for contained nodes (inside VNet/Subnet).
        // These nodes use extent="parent" which already constrains them within
        // their parent bounds. Running collision detection would use positions
        // in different coordinate systems and push nodes outside their parent.
        type AnyFlowNode = typeof dragged & { parentNode?: string };
        if ((dragged as AnyFlowNode).parentNode) return prev;

        let { x, y } = dragged.position;
        let adjusted = false;

        for (const other of prev) {
          if (other.id === draggedId || other.type === "group") continue;
          // FIX: Only check collision against other top-level nodes
          if ((other as AnyFlowNode).parentNode) continue;

          const dx = x - other.position.x;
          const dy = y - other.position.y;
          const overlapX = NODE_WIDTH + NODE_MIN_GAP - Math.abs(dx);
          const overlapY = NODE_HEIGHT + NODE_MIN_GAP - Math.abs(dy);

          if (overlapX > 0 && overlapY > 0) {
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

  // ── Build edges with hover highlight flags ──
  const particlesEnabled = showParticles && vizMode === "2d-animated";

  const edges: FlowEdge<AnimatedEdgeData>[] = useMemo(() => {
    if (!showNetworkFlow) return [];
    return spec.edges.map((edgeSpec) => {
      const live = snapshot?.edges.find((e) => e.id === edgeSpec.id);
      const isHighlighted = hoveredNodeId ? connectedEdgeIds.has(edgeSpec.id) : false;
      const isDimmed = hoveredNodeId ? !connectedEdgeIds.has(edgeSpec.id) : false;
      return {
        id: edgeSpec.id,
        source: edgeSpec.source,
        target: edgeSpec.target,
        type: "animated",
        data: {
          status: live?.status ?? "idle",
          trafficLevel: live?.trafficLevel ?? "none",
          label: edgeSpec.label,
          edgeKind: edgeSpec.edgeKind,
          confidence: edgeSpec.confidence,
          isHighlighted,
          isDimmed,
          showParticles: particlesEnabled,
        },
      };
    });
  }, [spec.edges, snapshot?.edges, hoveredNodeId, connectedEdgeIds, particlesEnabled, showNetworkFlow]);

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

  // ── Hover handlers ──
  const handleNodeMouseEnter = useCallback((_e: React.MouseEvent, node: FlowNode) => {
    if (node.type !== "group") setHoveredNodeId(node.id);
  }, []);
  const handleNodeMouseLeave = useCallback(() => {
    setHoveredNodeId(null);
  }, []);

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
        onNodeMouseEnter={handleNodeMouseEnter}
        onNodeMouseLeave={handleNodeMouseLeave}
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
  // key={spec.id} forces full ReactFlow remount when diagram changes
  // — clears stale nodes/edges/viewport from previous diagram
  return (
    <ReactFlowProvider key={props.spec.id}>
      <LiveCanvasInner {...props} />
    </ReactFlowProvider>
  );
}
