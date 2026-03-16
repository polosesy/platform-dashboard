"use client";

import { useMemo, useCallback, useRef, useState, useEffect } from "react";
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  ReactFlowProvider,
  useNodesState,

  useOnViewportChange,
  useReactFlow,
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
  AksVmssInstance,
} from "@aud/types";
import { apiBaseUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiToken } from "@/lib/useApiToken";
import { LiveNode, type LiveNodeData } from "./LiveNode";
import { GroupNode, type GroupNodeData, type NatGwBadgeInfo } from "./GroupNode";
import { NsgBadgeNode, type NsgBadgeData } from "./NsgBadgeNode";
import { VmssInstanceNode, type VmssInstanceNodeData } from "./VmssInstanceNode";
import { InternetNode, type InternetNodeData } from "./InternetNode";
import { AnimatedEdge, type AnimatedEdgeData } from "./AnimatedEdge";
import { FaultRipple } from "./FaultRipple";
import { ImpactCascade } from "./ImpactCascade";
import { TrafficHeatmap } from "./TrafficHeatmap";
import { nodeColor } from "../utils/designTokens";
import styles from "../styles.module.css";

/** Filter mode determines layout and fitView behavior */
type FilterMode = "overview" | "single-focus" | "multi-focus";

type LiveCanvasProps = {
  spec: DiagramSpec;
  snapshot: LiveDiagramSnapshot | null;
  onNodeSelect: (nodeId: string | null) => void;
  onEdgeSelect?: (edgeId: string | null) => void;
  onSubResourceSelect?: (sr: SubResource) => void;
  vizMode: VisualizationMode;
  showNetworkFlow: boolean;
  showParticles: boolean;
  showFaultRipple: boolean;
  showHeatmap: boolean;
  fitViewTrigger?: string;
  isFiltered?: boolean;
  focusNodeId?: string | null;
  onVmssInstanceSelect?: (data: VmssInstanceNodeData) => void;
};

const nodeTypes: NodeTypes = { live: LiveNode, group: GroupNode, nsgBadge: NsgBadgeNode, vmssInstance: VmssInstanceNode, internet: InternetNode };
const edgeTypes: EdgeTypes = { animated: AnimatedEdge };

/** Minimum gap between nodes to prevent overlap (px) */
const NODE_MIN_GAP = 20;
const NODE_WIDTH = 220;
const NODE_HEIGHT = 100;
const NSG_BADGE_WIDTH = 140;
const NSG_BADGE_HEIGHT = 24;

function LiveCanvasInner({
  spec,
  snapshot,
  onNodeSelect,
  onEdgeSelect,
  onSubResourceSelect,
  vizMode,
  showNetworkFlow,
  showParticles,
  showFaultRipple,
  showHeatmap,
  fitViewTrigger,
  isFiltered,
  focusNodeId,
  onVmssInstanceSelect,
}: LiveCanvasProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const [viewTransform, setViewTransform] = useState({ x: 0, y: 0, zoom: 1 });
  const [showMiniMap, setShowMiniMap] = useState(true);
  const reactFlowInstance = useReactFlow();

  // Track pre-drag positions for group node snap-back (overlap prevention)
  const dragStartPos = useRef<Record<string, { x: number; y: number }>>({});
  // Track group nodes the user has manually repositioned — preserve through spec refreshes
  const userPositionedIds = useRef<Set<string>>(new Set());

  // ── VMSS expand state: ref-based to avoid triggering fitView on expand/collapse ──
  const expandedVmssIds = useRef<Set<string>>(new Set());
  const vmssInstanceCache = useRef<Map<string, AksVmssInstance[]>>(new Map());
  const getApiToken = useApiToken();
  // Stable ref for onVmssInstanceSelect — avoids stale closure in inject callback
  const onVmssInstanceSelectRef = useRef(onVmssInstanceSelect);
  onVmssInstanceSelectRef.current = onVmssInstanceSelect;
  // handleVmssExpand ref — handler defined after useNodesState, but needs to be accessible in initialNodes
  const handleVmssExpandRef = useRef<((nodeId: string, azureResourceId: string, aksClusterArmId?: string) => void) | null>(null);
  const stableVmssExpand = useCallback((nodeId: string, azureResourceId: string, aksClusterArmId?: string) => {
    handleVmssExpandRef.current?.(nodeId, azureResourceId, aksClusterArmId);
  }, []);

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

  // Build NSG → target map for embedded rendering (Cat 1/2/3)
  // nsgAttachedTo in metadata tells us which node the NSG badge should embed into
  const nsgByTarget = useMemo(() => {
    const map = new Map<string, Array<{ nodeId: string; label: string; icon: string; azureResourceId?: string }>>();
    for (const nodeSpec of spec.nodes) {
      const targetId = nodeSpec.metadata?.nsgAttachedTo;
      if (!targetId || nodeSpec.icon !== "nsg") continue;
      const arr = map.get(targetId) ?? [];
      arr.push({
        nodeId: nodeSpec.id,
        label: nodeSpec.label,
        icon: nodeSpec.icon,
        azureResourceId: nodeSpec.azureResourceId,
      });
      map.set(targetId, arr);
    }
    return map;
  }, [spec.nodes]);

  // Set of NSG node IDs that are embedded (not rendered as separate ReactFlow nodes)
  const embeddedNsgIds = useMemo(() => {
    const ids = new Set<string>();
    for (const nodeSpec of spec.nodes) {
      if (nodeSpec.metadata?.nsgAttachedTo) ids.add(nodeSpec.id);
    }
    return ids;
  }, [spec.nodes]);


  // Build NAT GW badge map keyed by subnetId (from subnet metadata natGwBadgeId)
  const natGwBySubnet = useMemo(() => {
    const map = new Map<string, NatGwBadgeInfo>();
    for (const nodeSpec of spec.nodes) {
      const natGwBadgeId = nodeSpec.metadata?.natGwBadgeId;
      if (!natGwBadgeId || nodeSpec.nodeType !== "group") continue;
      map.set(nodeSpec.id, {
        nodeId: natGwBadgeId,
        label: nodeSpec.metadata?.natGwBadgeLabel ?? "NAT Gateway",
        azureResourceId: nodeSpec.metadata?.natGwBadgeAzureId,
      });
    }
    return map;
  }, [spec.nodes]);

  // Handler: clicking an embedded NSG badge selects the NSG node (for detail panel)
  const handleNsgSelect = useCallback((nodeId: string) => {
    onNodeSelect(nodeId);
  }, [onNodeSelect]);

  // Handler: clicking NAT GW badge selects the NAT GW card (opens detail panel)
  const handleNatGwSelect = useCallback((nodeId: string) => {
    onNodeSelect(nodeId);
  }, [onNodeSelect]);

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

    const result: FlowNode[] = [];
    for (const nodeSpec of sorted) {
      // Skip embedded NSGs — they render as badges inside parent GroupNode
      if (embeddedNsgIds.has(nodeSpec.id)) continue;

      if (nodeSpec.nodeType === "group") {
        // Inject embedded NSG badges + NAT GW badge for this group
        const attachedNsgs = nsgByTarget.get(nodeSpec.id);
        const attachedNatGw = natGwBySubnet.get(nodeSpec.id);
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
            region: nodeSpec.icon === "vnet" ? (nodeSpec.location ?? undefined) : undefined,
            nsgBadges: attachedNsgs?.map((n) => ({
              nodeId: n.nodeId,
              label: n.label,
              icon: n.icon as GroupNodeData["icon"],
              azureResourceId: n.azureResourceId,
            })),
            natGwBadge: attachedNatGw,
            onNsgSelect: handleNsgSelect,
            onNatGwToggle: handleNatGwSelect,
          },
        };
        if (nodeSpec.parentId) {
          (groupNode as FlowNode<GroupNodeData> & { parentNode: string; extent: string }).parentNode = nodeSpec.parentId;
          (groupNode as FlowNode<GroupNodeData> & { extent: string }).extent = "parent";
        }
        result.push(groupNode);
        continue;
      }

      // Internet sentinel node — outbound traffic destination (per VNet)
      if (nodeSpec.resourceKind === "internet") {
        const methodCount = parseInt(nodeSpec.metadata?.outboundMethodCount ?? "0", 10);
        const internetNode: FlowNode<InternetNodeData> = {
          id: nodeSpec.id,
          type: "internet",
          position: nodeSpec.position ?? { x: 0, y: 0 },
          draggable: true,
          data: {
            label: nodeSpec.label,
            outboundMethodCount: methodCount,
            hasDeprecatedPath: nodeSpec.metadata?.hasDeprecatedPath === "true",
          },
        };
        result.push(internetNode);
        continue;
      }

      // Cat 4: detached/standalone NSG — render as separate nsgBadge node
      const isNsg = nodeSpec.resourceKind === "nsg" || nodeSpec.icon === "nsg";
      if (isNsg) {
        const badgeNode: FlowNode<NsgBadgeData> = {
          id: nodeSpec.id,
          type: "nsgBadge",
          position: nodeSpec.position ?? { x: 0, y: 0 },
          draggable: true,
          zIndex: 10,
          style: { width: NSG_BADGE_WIDTH, height: NSG_BADGE_HEIGHT },
          data: {
            label: nodeSpec.label,
            icon: nodeSpec.icon,
            resourceKind: nodeSpec.resourceKind,
            azureResourceId: nodeSpec.azureResourceId,
            detached: nodeSpec.metadata?.detached === "true",
          },
        };
        if (nodeSpec.parentId) {
          (badgeNode as FlowNode<NsgBadgeData> & { parentNode: string; extent: string }).parentNode = nodeSpec.parentId;
          (badgeNode as FlowNode<NsgBadgeData> & { extent: string }).extent = "parent";
        }
        result.push(badgeNode);
        continue;
      }

      const live = snapshot?.nodes.find((n) => n.id === nodeSpec.id);

      // Inject embedded NSG badge for this live node (Cat 2/3: VM/NIC-attached)
      const attachedNsgs = nsgByTarget.get(nodeSpec.id);
      const firstNsg = attachedNsgs?.[0];

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
          resourceKind: nodeSpec.resourceKind,
          azureResourceId: nodeSpec.azureResourceId,
          powerState: live?.powerState,
          archRole: nodeSpec.metadata?.archRole,
          archGroupId: nodeSpec.metadata?.archGroupId,
          nsgBadge: firstNsg ? {
            nodeId: firstNsg.nodeId,
            label: firstNsg.label,
            icon: firstNsg.icon as LiveNodeData["icon"],
            azureResourceId: firstNsg.azureResourceId,
          } : undefined,
          onNsgSelect: handleNsgSelect,
          vmssExpanded: expandedVmssIds.current.has(nodeSpec.id),
          onVmssExpand: nodeSpec.metadata?.archRole === "aks-vmss" ? stableVmssExpand : undefined,
        },
      };
      if (nodeSpec.parentId) {
        (liveNode as FlowNode<LiveNodeData> & { parentNode: string; extent: string }).parentNode = nodeSpec.parentId;
        (liveNode as FlowNode<LiveNodeData> & { extent: string }).extent = "parent";
      }
      result.push(liveNode);
    }

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
  // expandedVmssIds, expandedNatGwIds are refs — intentionally excluded from deps
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec.nodes, snapshot?.nodes, onSubResourceSelect, embeddedNsgIds, nsgByTarget, natGwBySubnet, handleNsgSelect, stableVmssExpand, handleNatGwSelect]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);

  // ── VMSS expand handler (needs setNodes from above) ──
  const handleVmssExpand = useCallback(async (vmssNodeId: string, azureResourceId: string, aksClusterArmId?: string) => {
    const isExpanded = expandedVmssIds.current.has(vmssNodeId);

    // Toggle: if already expanded, collapse
    if (isExpanded) {
      expandedVmssIds.current.delete(vmssNodeId);
      setNodes((prev: FlowNode[]) => prev
        .filter((n: FlowNode) => {
          const d = n.data as VmssInstanceNodeData | undefined;
          return n.type !== "vmssInstance" || d?.parentVmssId !== vmssNodeId;
        })
        .map((n: FlowNode) =>
          n.id === vmssNodeId
            ? { ...n, data: { ...n.data, vmssExpanded: false } }
            : n,
        ));
      return;
    }

    // Mark expanded + update button label immediately
    expandedVmssIds.current.add(vmssNodeId);
    setNodes((prev: FlowNode[]) => prev.map((n: FlowNode) =>
      n.id === vmssNodeId
        ? { ...n, data: { ...n.data, vmssExpanded: true } }
        : n,
    ));

    // Fetch instances if not cached
    if (!vmssInstanceCache.current.has(vmssNodeId)) {
      try {
        const token = await getApiToken().catch(() => null);
        const url = `${apiBaseUrl()}/api/live/vmss-instances?resourceId=${encodeURIComponent(azureResourceId)}${aksClusterArmId ? `&aksClusterId=${encodeURIComponent(aksClusterArmId)}` : ""}`;
        const data = await fetchJsonWithBearer<{ instances: AksVmssInstance[] }>(url, token);
        vmssInstanceCache.current.set(vmssNodeId, data.instances ?? []);
      } catch {
        vmssInstanceCache.current.set(vmssNodeId, []);
      }
    }

    const instances = vmssInstanceCache.current.get(vmssNodeId) ?? [];
    if (instances.length === 0) return;

    // Inject instance nodes below the VMSS node
    setNodes((prev: FlowNode[]) => {
      const vmssNode = prev.find((n: FlowNode) => n.id === vmssNodeId);
      if (!vmssNode) return prev;

      // Single-column — instances stack vertically under parent VMSS node.
      const INST_W = 200;
      const INST_H = 54;
      const INST_GAP = 6;
      const vmssW = vmssNode.width ?? NODE_WIDTH;
      const vmssH = vmssNode.height ?? NODE_HEIGHT;
      const instX = Math.round((vmssW - INST_W) / 2);

      const instanceNodes: (FlowNode<VmssInstanceNodeData> & { parentNode: string })[] = instances.map((inst, i) => ({
        id: `vmss-inst-${vmssNodeId}-${inst.instanceId}`,
        type: "vmssInstance" as const,
        parentNode: vmssNodeId,
        position: {
          x: instX,
          y: vmssH + 20 + i * (INST_H + INST_GAP),
        },
        draggable: false,
        selectable: true,
        style: { width: INST_W, height: INST_H },
        data: {
          label: inst.computerName || `instance-${inst.instanceId}`,
          computerName: inst.computerName || `instance-${inst.instanceId}`,
          powerState: inst.powerState,
          provisioningState: inst.provisioningState,
          privateIp: inst.privateIp,
          nodePoolName: inst.nodePoolName,
          nodeImageVersion: inst.nodeImageVersion,
          conditions: inst.conditions,
          parentVmssId: vmssNodeId,
          onSelect: onVmssInstanceSelectRef.current,
        },
      }));

      // Remove old instances for this VMSS (if any), then add new
      const filtered = prev.filter((n: FlowNode) => {
        const d = n.data as VmssInstanceNodeData | undefined;
        return n.type !== "vmssInstance" || d?.parentVmssId !== vmssNodeId;
      });
      return [...filtered, ...instanceNodes];
    });
  }, [getApiToken, setNodes]);
  handleVmssExpandRef.current = handleVmssExpand;

  // Stable ref to reactFlowInstance.
  // useReactFlow() returns a new object on every render in ReactFlow v11,
  // so storing it in a ref lets us call fitView without unstable deps.
  const rfRef = useRef(reactFlowInstance);
  rfRef.current = reactFlowInstance;

  // Stable ref for snapshot — read in the filter-change effect without being in its deps.
  // The snapshot-update effect (Effect B) handles health/status refreshes independently.
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;

  // Stable ref for isFiltered — lets Effect A read current value without deps.
  const isFilteredRef = useRef(isFiltered);
  isFilteredRef.current = isFiltered;

  // Pre-computed fitBounds from compact layout (avoids relying on DOM-measured node.width/height).
  // Set in Effect A before calling setFitVersion; read in the fitBounds effect.
  const fitBoundsRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null);

  // Spec-derived top-level group IDs — authoritative source for both compact layout and fitBounds.
  const topGroupIds = useMemo(
    () => spec.nodes.filter((n) => n.nodeType === "group" && !n.parentId).map((n) => n.id),
    [spec.nodes],
  );
  const topGroupIdsRef = useRef(topGroupIds);
  topGroupIdsRef.current = topGroupIds;

  // fitVersion incremented by Effect A on every filter/spec change; drives the fitBounds effect.
  const [fitVersion, setFitVersion] = useState(0);
  const fitModeRef = useRef<FilterMode>("overview");
  const executedFitVersionRef = useRef(0);

  // ── Viewport fit: fires once per fitVersion, deferred to rAF ──
  // Uses pre-computed bounds (fitBoundsRef) for multi-focus to bypass stale DOM measurements.
  // overview    → fitView all nodes
  // single-focus → fitView explicit node IDs
  // multi-focus  → fitBounds with pre-computed centered bounds
  useEffect(() => {
    if (fitVersion === 0) return;
    if (fitVersion === executedFitVersionRef.current) return;
    executedFitVersionRef.current = fitVersion;

    const mode = fitModeRef.current;
    const bounds = fitBoundsRef.current;
    const targetIds = topGroupIdsRef.current.slice();

    const rafId = requestAnimationFrame(() => {
      const rf = rfRef.current;

      if (process.env.NODE_ENV !== "production") {
        const liveTargets = rf.getNodes().filter((n) => new Set(targetIds).has(n.id));
        console.log("[fitBounds] viewport adjust", {
          mode,
          computedBounds: bounds,
          targetIds,
          liveTargets: liveTargets.map((n) => ({
            id: n.id,
            pos: n.position,
            w: n.width,
            h: n.height,
          })),
        });
      }

      if (bounds) {
        // overview/multi-focus: use pre-computed centered bounds — bypasses stale DOM measurements
        rf.fitBounds(bounds, { padding: 0.2, duration: 400 });
      } else if (mode === "overview") {
        rf.fitView({ padding: 0.15, duration: 400 });
      } else {
        // single-focus: fitView with explicit node IDs
        rf.fitView({
          nodes: targetIds.length > 0 ? targetIds.map((id) => ({ id })) : undefined,
          padding: 0.2,
          duration: 400,
        });
      }
    });

    return () => cancelAnimationFrame(rafId);
  // rfRef, fitModeRef, fitBoundsRef, topGroupIdsRef are stable refs — intentionally excluded
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitVersion]);

  // ── Focus node: zoom to a specific node when focusNodeId changes ──
  // focusNodeId format: "nodeId:timestamp" (timestamp ensures re-trigger for same node)
  useEffect(() => {
    if (!focusNodeId) return;
    const nodeId = focusNodeId.replace(/:\d+$/, "");
    const rf = rfRef.current;
    if (!rf) return;
    const rafId = requestAnimationFrame(() => {
      rf.fitView({
        nodes: [{ id: nodeId }],
        padding: 0.5,
        duration: 500,
      });
    });
    return () => cancelAnimationFrame(rafId);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusNodeId]);

  // ── Effect A: Filter change — full node rebuild + compact layout ──
  // Triggered only by spec.nodes changes (filter/diagram changes).
  // Snapshot health updates are handled separately in Effect B.
  useEffect(() => {
    const currentSnapshot = snapshotRef.current;
    const currentIsFiltered = isFilteredRef.current;
    const COMPACT_GAP = 60;

    // Determine mode from spec
    const topGroupsFromSpec = spec.nodes.filter((n) => n.nodeType === "group" && !n.parentId);
    const mode: FilterMode = !currentIsFiltered
      ? "overview"
      : topGroupsFromSpec.length <= 1
      ? "single-focus"
      : "multi-focus";

    fitModeRef.current = mode;

    // ── Pre-compute compact plan OUTSIDE setNodes (safe to write refs here) ──
    // Compact positions are centered around x=0 so the layout feels balanced.
    // Computed from spec dimensions (nodeSpec.width/height) — no DOM measurement needed.
    type CompactPlan = {
      pos: Map<string, { x: number; y: number }>;
      bounds: { x: number; y: number; width: number; height: number };
    };
    let compactPlan: CompactPlan | null = null;

    if ((mode === "multi-focus" || mode === "overview") && topGroupsFromSpec.length > 1) {
      const sorted = [...topGroupsFromSpec].sort(
        (a, b) => (a.position?.x ?? 0) - (b.position?.x ?? 0),
      );
      const widths = sorted.map((n) => n.width ?? 400);
      const heights = sorted.map((n) => n.height ?? 200);
      const totalWidth =
        widths.reduce((s, w) => s + w, 0) + COMPACT_GAP * (sorted.length - 1);
      const maxH = heights.length > 0 ? Math.max(...heights) : 200;
      const startX = -Math.round(totalWidth / 2);

      const pos = new Map<string, { x: number; y: number }>();
      let cx = startX;
      for (let i = 0; i < sorted.length; i++) {
        pos.set(sorted[i].id, { x: cx, y: 0 });
        cx += widths[i] + COMPACT_GAP;
      }
      compactPlan = { pos, bounds: { x: startX, y: 0, width: totalWidth, height: maxH } };

      if (process.env.NODE_ENV !== "production") {
        console.log("[compact-layout] plan", {
          selectedVnetIds: sorted.map((n) => n.id),
          compactTargets: sorted.map((n, i) => ({
            id: n.id,
            specPos: n.position,
            compactPos: pos.get(n.id),
            specW: widths[i],
            specH: heights[i],
            directChildren: spec.nodes
              .filter((sn) => sn.parentId === n.id)
              .map((sn) => ({ id: sn.id, relativePos: sn.position })),
          })),
          bounds: { x: startX, y: 0, width: totalWidth, height: maxH },
        });
      }
    }

    // ── External standalone node delta-offset (multi-focus subgraph layout) ──
    // VNet group children (parentId set) follow parents automatically via ReactFlow transform.
    // But external standalone nodes (no parentId, not VNet groups) connected via edges
    // to VNet descendants stay at spec coordinates — creating long dangling edges.
    // Fix: compute each selected VNet's positional delta (compact − spec), then apply
    // that same delta to any external node reachable via edge traversal from the subgraph.
    let externalDeltaPos: Map<string, { x: number; y: number }> | null = null;

    if ((mode === "multi-focus" || mode === "overview") && compactPlan) {
      const nodeById = new Map(spec.nodes.map((n) => [n.id, n]));
      const topGroupIdSet = new Set(topGroupsFromSpec.map((n) => n.id));

      // Step 1: Walk parentId chain up to find each node's root VNet
      const nodeToRootVnet = new Map<string, string>();
      for (const n of spec.nodes) {
        let cursor: (typeof spec.nodes)[0] | undefined = n;
        while (cursor?.parentId) cursor = nodeById.get(cursor.parentId);
        if (cursor && topGroupIdSet.has(cursor.id)) nodeToRootVnet.set(n.id, cursor.id);
      }

      // Step 2: Assign unassigned external nodes to VNets via edge traversal
      for (const edge of spec.edges) {
        const sv = nodeToRootVnet.get(edge.source);
        const tv = nodeToRootVnet.get(edge.target);
        if (sv && !nodeToRootVnet.has(edge.target)) nodeToRootVnet.set(edge.target, sv);
        else if (tv && !nodeToRootVnet.has(edge.source)) nodeToRootVnet.set(edge.source, tv);
      }

      // Step 3: Compute ABSOLUTE positions for external standalone nodes.
      // Group by owner VNet and place in a grid directly below the VNet's compact position.
      // This replaces the previous delta-offset approach which left nodes far from their VNet
      // because it only applied the VNet's horizontal shift, not a proximity correction.
      const externalByVnet = new Map<string, string[]>();
      for (const n of spec.nodes) {
        if (n.parentId || topGroupIdSet.has(n.id)) continue;
        const ownerVnet = nodeToRootVnet.get(n.id);
        if (!ownerVnet) continue;
        const arr = externalByVnet.get(ownerVnet) ?? [];
        arr.push(n.id);
        externalByVnet.set(ownerVnet, arr);
      }

      externalDeltaPos = new Map();
      for (const [vnetId, extNodeIds] of externalByVnet) {
        const compactVnetPos = compactPlan.pos.get(vnetId);
        if (!compactVnetPos) continue;
        const vnetSpec = nodeById.get(vnetId);
        const vnetH = vnetSpec?.height ?? 300;
        const COLS = Math.min(extNodeIds.length, 4);
        extNodeIds.forEach((id, i) => {
          const col = i % COLS;
          const row = Math.floor(i / COLS);
          externalDeltaPos!.set(id, {
            x: compactVnetPos.x + col * (NODE_WIDTH + COMPACT_GAP),
            y: compactVnetPos.y + vnetH + COMPACT_GAP + row * (NODE_HEIGHT + Math.round(COMPACT_GAP / 2)),
          });
        });
      }
    }

    // fitBounds: extend to include external delta-offset nodes so viewport covers full subgraph
    if (compactPlan) {
      if (externalDeltaPos && externalDeltaPos.size > 0) {
        let minX = compactPlan.bounds.x;
        let minY = compactPlan.bounds.y;
        let maxX = compactPlan.bounds.x + compactPlan.bounds.width;
        let maxY = compactPlan.bounds.y + compactPlan.bounds.height;
        for (const [nodeId, pos] of externalDeltaPos) {
          const sn = spec.nodes.find((n) => n.id === nodeId);
          const w = sn?.width ?? NODE_WIDTH;
          const h = sn?.height ?? NODE_HEIGHT;
          minX = Math.min(minX, pos.x);
          minY = Math.min(minY, pos.y);
          maxX = Math.max(maxX, pos.x + w);
          maxY = Math.max(maxY, pos.y + h);
        }
        fitBoundsRef.current = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
      } else {
        fitBoundsRef.current = compactPlan.bounds;
      }
    } else {
      fitBoundsRef.current = null;
    }

    // Single-focus: place external standalone nodes near the focused VNet.
    // In single-focus mode there is no compact layout, so external nodes would render at
    // their raw spec coordinates (which may be far below all VNets).
    // Override: position them in a grid directly below the focused VNet.
    if (mode === "single-focus" && topGroupsFromSpec.length === 1) {
      const focusedVnet = topGroupsFromSpec[0]!;
      const vnetX = focusedVnet.position?.x ?? 0;
      const vnetY = focusedVnet.position?.y ?? 0;
      const vnetH = focusedVnet.height ?? 300;
      const vnetW = focusedVnet.width ?? 400;

      const externalNodes = spec.nodes.filter((n) => !n.parentId && n.nodeType !== "group");
      if (externalNodes.length > 0) {
        externalDeltaPos = new Map();
        const COLS = Math.min(externalNodes.length, 4);
        externalNodes.forEach((n, i) => {
          const col = i % COLS;
          const row = Math.floor(i / COLS);
          externalDeltaPos!.set(n.id, {
            x: vnetX + col * (NODE_WIDTH + COMPACT_GAP),
            y: vnetY + vnetH + COMPACT_GAP + row * (NODE_HEIGHT + Math.round(COMPACT_GAP / 2)),
          });
        });
        // Set fitBoundsRef to cover VNet + external nodes together
        const rows = Math.ceil(externalNodes.length / COLS);
        const extTotalW = COLS * (NODE_WIDTH + COMPACT_GAP);
        const extTotalH = rows * (NODE_HEIGHT + Math.round(COMPACT_GAP / 2));
        fitBoundsRef.current = {
          x: vnetX,
          y: vnetY,
          width: Math.max(vnetW, extTotalW),
          height: vnetH + COMPACT_GAP + extTotalH,
        };
      }
    }

    setNodes((prev) => {
      const prevById = new Map(prev.map((n) => [n.id, n]));

      // Sort: groups first, then parents before children
      const sorted = [...spec.nodes].sort((a, b) => {
        const aGroup = a.nodeType === "group" ? 0 : 1;
        const bGroup = b.nodeType === "group" ? 0 : 1;
        if (aGroup !== bGroup) return aGroup - bGroup;
        return (a.parentId ? 1 : 0) - (b.parentId ? 1 : 0);
      });

      const result: FlowNode[] = [];
      for (const nodeSpec of sorted) {
        if (embeddedNsgIds.has(nodeSpec.id)) continue;

        const existing = prevById.get(nodeSpec.id);

        if (nodeSpec.nodeType === "group") {
          const attachedNsgs = nsgByTarget.get(nodeSpec.id);
          const attachedNatGw = natGwBySubnet.get(nodeSpec.id);
          const data: GroupNodeData = {
            label: nodeSpec.label,
            icon: nodeSpec.icon,
            subtitle: nodeSpec.metadata?.addressSpace ?? nodeSpec.metadata?.prefix,
            region: nodeSpec.icon === "vnet" ? (nodeSpec.location ?? undefined) : undefined,
            nsgBadges: attachedNsgs?.map((n) => ({
              nodeId: n.nodeId,
              label: n.label,
              icon: n.icon as GroupNodeData["icon"],
              azureResourceId: n.azureResourceId,
            })),
            natGwBadge: attachedNatGw,
            onNsgSelect: handleNsgSelect,
            onNatGwToggle: handleNatGwSelect,
          };
          // Position: compact plan > user-dragged existing > spec > existing > origin
          // compact plan always wins for multi-focus top-level VNets (no existing.position preserve)
          const compactPos = compactPlan?.pos.get(nodeSpec.id);
          const position = compactPos
            ? compactPos
            : userPositionedIds.current.has(nodeSpec.id)
            ? (existing?.position ?? nodeSpec.position ?? { x: 0, y: 0 })
            : (nodeSpec.position ?? existing?.position ?? { x: 0, y: 0 });

          if (existing) {
            const updated = {
              ...existing,
              data,
              style: { width: nodeSpec.width ?? 400, height: nodeSpec.height ?? 200 },
              position,
            } as FlowNode<GroupNodeData> & { parentNode?: string; extent?: string };
            if (nodeSpec.parentId) {
              updated.parentNode = nodeSpec.parentId;
              updated.extent = "parent";
            } else {
              delete updated.parentNode;
              delete updated.extent;
            }
            result.push(updated);
            continue;
          }
          const gn: FlowNode<GroupNodeData> = {
            id: nodeSpec.id,
            type: "group",
            position,
            draggable: true,
            selectable: true,
            style: { width: nodeSpec.width ?? 400, height: nodeSpec.height ?? 200 },
            data,
          };
          if (nodeSpec.parentId) {
            (gn as FlowNode<GroupNodeData> & { parentNode: string; extent: string }).parentNode = nodeSpec.parentId;
            (gn as FlowNode<GroupNodeData> & { extent: string }).extent = "parent";
          }
          result.push(gn);
          continue;
        }

        // Internet sentinel node (update path)
        if (nodeSpec.resourceKind === "internet") {
          const methodCount = parseInt(nodeSpec.metadata?.outboundMethodCount ?? "0", 10);
          const idata: InternetNodeData = {
            label: nodeSpec.label,
            outboundMethodCount: methodCount,
            hasDeprecatedPath: nodeSpec.metadata?.hasDeprecatedPath === "true",
          };
          const extPosInternet = externalDeltaPos?.get(nodeSpec.id);
          if (existing) {
            result.push({ ...existing, data: idata, position: extPosInternet ?? nodeSpec.position ?? existing.position });
            continue;
          }
          result.push({
            id: nodeSpec.id,
            type: "internet",
            position: extPosInternet ?? nodeSpec.position ?? { x: 0, y: 0 },
            draggable: true,
            data: idata,
          } as FlowNode<InternetNodeData>);
          continue;
        }

        // Cat 4: detached/standalone NSG
        const isNsg = nodeSpec.resourceKind === "nsg" || nodeSpec.icon === "nsg";
        if (isNsg) {
          const badgeData: NsgBadgeData = {
            label: nodeSpec.label,
            icon: nodeSpec.icon,
            resourceKind: nodeSpec.resourceKind,
            azureResourceId: nodeSpec.azureResourceId,
            detached: nodeSpec.metadata?.detached === "true",
          };
          if (existing) {
            const updated = { ...existing, data: badgeData, type: "nsgBadge", zIndex: 10 } as FlowNode<NsgBadgeData> & { parentNode?: string; extent?: string };
            if (nodeSpec.parentId) {
              updated.parentNode = nodeSpec.parentId;
              updated.extent = "parent";
            } else {
              delete updated.parentNode;
              delete updated.extent;
              const extPos = externalDeltaPos?.get(nodeSpec.id);
              if (extPos) updated.position = extPos;
            }
            result.push(updated);
            continue;
          }
          const extPosBadge = !nodeSpec.parentId ? externalDeltaPos?.get(nodeSpec.id) : undefined;
          const bn: FlowNode<NsgBadgeData> = {
            id: nodeSpec.id,
            type: "nsgBadge",
            position: extPosBadge ?? nodeSpec.position ?? { x: 0, y: 0 },
            draggable: true,
            zIndex: 10,
            style: { width: NSG_BADGE_WIDTH, height: NSG_BADGE_HEIGHT },
            data: badgeData,
          };
          if (nodeSpec.parentId) {
            (bn as FlowNode<NsgBadgeData> & { parentNode: string; extent: string }).parentNode = nodeSpec.parentId;
            (bn as FlowNode<NsgBadgeData> & { extent: string }).extent = "parent";
          }
          result.push(bn);
          continue;
        }

        // Live resource node
        const live = currentSnapshot?.nodes.find((s) => s.id === nodeSpec.id);
        const attachedNsgs = nsgByTarget.get(nodeSpec.id);
        const firstNsg = attachedNsgs?.[0];
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
          resourceKind: nodeSpec.resourceKind,
          azureResourceId: nodeSpec.azureResourceId,
          powerState: live?.powerState,
          archRole: nodeSpec.metadata?.archRole,
          archGroupId: nodeSpec.metadata?.archGroupId,
          nsgBadge: firstNsg
            ? {
                nodeId: firstNsg.nodeId,
                label: firstNsg.label,
                icon: firstNsg.icon as LiveNodeData["icon"],
                azureResourceId: firstNsg.azureResourceId,
              }
            : undefined,
          onNsgSelect: handleNsgSelect,
          aksClusterArmId: nodeSpec.metadata?.aksClusterArmId,
          vmssExpanded: expandedVmssIds.current.has(nodeSpec.id),
          onVmssExpand: nodeSpec.metadata?.archRole === "aks-vmss" ? stableVmssExpand : undefined,
        };
        if (existing) {
          const updated = { ...existing, data } as FlowNode<LiveNodeData> & { parentNode?: string; extent?: string };
          if (nodeSpec.parentId) {
            updated.parentNode = nodeSpec.parentId;
            updated.extent = "parent";
          } else {
            delete updated.parentNode;
            delete updated.extent;
            const extPos = externalDeltaPos?.get(nodeSpec.id);
            if (extPos) updated.position = extPos;
          }
          result.push(updated);
          continue;
        }
        const extPosLive = !nodeSpec.parentId ? externalDeltaPos?.get(nodeSpec.id) : undefined;
        const ln: FlowNode<LiveNodeData> = {
          id: nodeSpec.id,
          type: "live" as const,
          position: extPosLive ?? nodeSpec.position ?? { x: 0, y: 0 },
          draggable: true,
          data,
        };
        if (nodeSpec.parentId) {
          (ln as FlowNode<LiveNodeData> & { parentNode: string; extent: string }).parentNode = nodeSpec.parentId;
          (ln as FlowNode<LiveNodeData> & { extent: string }).extent = "parent";
        }
        result.push(ln);
      }

      if (process.env.NODE_ENV !== "production") {
        type AnyFN = FlowNode & { parentNode?: string };
        if (compactPlan) {
          const targetIds = [...compactPlan.pos.keys()];
          const finalPositions = result
            .filter((n) => targetIds.includes(n.id))
            .map((n) => ({ id: n.id, finalPos: n.position, parentNode: (n as AnyFN).parentNode }));
          const liveChildrenByVnet = targetIds.map((vnetId) => ({
            vnetId,
            children: result
              .filter((n) => (n as AnyFN).parentNode === vnetId)
              .map((n) => n.id),
          }));
          console.log("[compact-layout] committed", {
            targetIds,
            finalPositions,
            liveChildrenByVnet,
            bounds: compactPlan.bounds,
          });
        }
      }

      // Preserve expanded VMSS instance nodes from previous state
      const vmssInstNodes = prev.filter((n) => n.type === "vmssInstance");
      if (vmssInstNodes.length > 0) {
        result.push(...vmssInstNodes);
      }

      return result;
    });

    // Trigger viewport fit after layout is committed
    setFitVersion((v) => v + 1);
  // snapshotRef, isFilteredRef, fitBoundsRef, fitModeRef are stable refs — intentionally excluded
  // eslint-disable-next-line react-hooks/exhaustive-deps
  // expandedVmssIds is a ref — intentionally excluded from deps
  }, [spec.nodes, onSubResourceSelect, setNodes, embeddedNsgIds, nsgByTarget, handleNsgSelect, stableVmssExpand]);

  // ── Effect B: Snapshot update — health/status only, positions untouched ──
  // Triggered only by snapshot changes. Never modifies positions, parentNode, or structure.
  useEffect(() => {
    if (!snapshot?.nodes) return;
    const liveNodes = snapshot.nodes;
    setNodes((prev) =>
      prev.map((n) => {
        if (n.type !== "live") return n;
        const live = liveNodes.find((s) => s.id === n.id);
        if (!live) return n;
        const prev_ = n.data as LiveNodeData;
        const next: LiveNodeData = {
          ...prev_,
          health: live.health ?? "unknown",
          healthScore: live.healthScore ?? 0.5,
          metrics: live.metrics ?? {},
          hasAlert: (live.activeAlertIds?.length ?? 0) > 0,
          sparklines: live.sparklines,
          powerState: live.powerState,
        };
        // Skip update if nothing changed
        if (
          prev_.health === next.health &&
          prev_.healthScore === next.healthScore &&
          prev_.powerState === next.powerState &&
          prev_.hasAlert === next.hasAlert
        )
          return n;
        return { ...n, data: next };
      }),
    );
  }, [snapshot?.nodes, setNodes]);

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

  // ── Group node drag: record position before drag begins ──
  const handleNodeDragStart = useCallback((_e: React.MouseEvent, node: FlowNode) => {
    if (node.type === "group") {
      dragStartPos.current[node.id] = { ...node.position };
    }
  }, []);

  // ── Group node drag stop: snap back if overlapping a sibling group ──
  // setTimeout(0) is required: in React 18, onNodeDragStop fires BEFORE the final
  // onNodesChange(dragging: false) update is batched. Without the timeout, prev
  // inside setNodes has the pre-final position, and the subsequent onNodesChange
  // batch overrides our snap-back. Running after the tick ensures prev reflects
  // the actual committed final position.
  const handleNodeDragStop = useCallback((_e: React.MouseEvent, node: FlowNode) => {
    if (node.type !== "group") return;

    setTimeout(() => {
      setNodes((prev) => {
        type AnyNode = FlowNode & { parentNode?: string };

        // Look up node from latest state — has the final dragged position
        const dragged = prev.find((n) => n.id === node.id);
        if (!dragged) {
          delete dragStartPos.current[node.id];
          return prev;
        }

        const parentId = (dragged as AnyNode).parentNode;
        const dw = (dragged.style?.width as number) ?? 400;
        const dh = (dragged.style?.height as number) ?? 200;
        const GAP = 10;

        const siblingGroups = prev.filter((n) => {
          if (n.id === node.id || n.type !== "group") return false;
          return (n as AnyNode).parentNode === parentId;
        });

        const hasOverlap = siblingGroups.some((sib) => {
          const sw = (sib.style?.width as number) ?? 400;
          const sh = (sib.style?.height as number) ?? 200;
          return !(
            dragged.position.x + dw + GAP <= sib.position.x ||
            sib.position.x + sw + GAP <= dragged.position.x ||
            dragged.position.y + dh + GAP <= sib.position.y ||
            sib.position.y + sh + GAP <= dragged.position.y
          );
        });

        if (hasOverlap) {
          const orig = dragStartPos.current[node.id];
          delete dragStartPos.current[node.id];
          if (!orig) return prev;
          return prev.map((n) => (n.id === node.id ? { ...n, position: orig } : n));
        }

        // Drag successful — mark as user-positioned so spec refreshes don't reset it
        userPositionedIds.current.add(node.id);
        delete dragStartPos.current[node.id];
        return prev;
      });
    }, 0);
  }, [setNodes]);

  // ── Build edges with hover highlight flags ──
  const particlesEnabled = showParticles && vizMode === "2d-animated";

  const edges: FlowEdge<AnimatedEdgeData>[] = useMemo(() => {
    if (!showNetworkFlow) return [];
    const result: FlowEdge<AnimatedEdgeData>[] = [];
    for (const edgeSpec of spec.edges) {
      const live = snapshot?.edges.find((e) => e.id === edgeSpec.id);
      const isHighlighted = hoveredNodeId ? connectedEdgeIds.has(edgeSpec.id) : false;
      const isDimmed = hoveredNodeId ? !connectedEdgeIds.has(edgeSpec.id) : false;
      result.push({
        id: edgeSpec.id,
        source: edgeSpec.source,
        target: edgeSpec.target,
        // natgw-association: route from the orange dot handle on the subnet badge
        sourceHandle: edgeSpec.edgeKind === "natgw-association" ? "natgw-source" : undefined,
        type: "animated",
        data: {
          status: live?.status ?? "idle",
          trafficLevel: live?.trafficLevel ?? "none",
          label: edgeSpec.label,
          edgeKind: edgeSpec.edgeKind,
          flowType: edgeSpec.flowType,
          confidence: edgeSpec.confidence,
          isHighlighted,
          isDimmed,
          showParticles: particlesEnabled,
        },
      });
    }
    return result;
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
        onNodeClick={(_e, node) => {
          if (node.type === "vmssInstance") {
            // Route vmssInstance clicks to dedicated callback, not node selection
            const d = node.data as VmssInstanceNodeData;
            onVmssInstanceSelect?.(d);
          } else {
            onNodeSelect(node.id);
          }
        }}
        onEdgeClick={(_e, edge) => onEdgeSelect?.(edge.id)}
        onPaneClick={() => { onNodeSelect(null); onEdgeSelect?.(null); }}
        onNodeMouseEnter={handleNodeMouseEnter}
        onNodeMouseLeave={handleNodeMouseLeave}
        onNodeDragStart={handleNodeDragStart}
        onNodeDragStop={handleNodeDragStop}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        minZoom={0.05}
        maxZoom={4}
        proOptions={{ hideAttribution: true }}
        elevateEdgesOnSelect={true}
      >
        <Background gap={20} size={1} color="rgba(20,21,23,0.06)" />
        <Controls />
        {showMiniMap && (
          <MiniMap
            nodeColor={(n) => {
              const health = (n.data as LiveNodeData | undefined)?.health ?? "unknown";
              return nodeColor(health).ringStroke;
            }}
            maskColor="rgba(247,248,250,0.85)"
            style={{ borderRadius: 12, border: "1px solid rgba(20,21,23,0.10)" }}
          />
        )}
      </ReactFlow>
      <button
        type="button"
        className={styles.miniMapToggle}
        onClick={() => setShowMiniMap((v) => !v)}
        title={showMiniMap ? "Hide mini-map" : "Show mini-map"}
      >
        {showMiniMap ? "⊟" : "⊞"}
      </button>

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
