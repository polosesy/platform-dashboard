"use client";

import { useMemo, useCallback, useRef, useState, useEffect, useLayoutEffect } from "react";
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  ReactFlowProvider,
  MarkerType,
  useNodesState,
  useReactFlow,
  type Node as FlowNode,
  type Edge as FlowEdge,
  type NodeTypes,
  type EdgeTypes,
  type NodeChange,
} from "reactflow";
import type {
  DiagramNodeSpec,
  DiagramSpec,
  FaultImpact,
  LiveDiagramSnapshot,
  PrivateLinkUsageResponse,
  LiveNode as LiveNodeState,
  SubResource,
  AksVmssInstance,
} from "@aud/types";
import { apiBaseUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiToken } from "@/lib/useApiToken";
import { useI18n } from "@/lib/i18n";
import { liveLayout, LIVE, type LayoutBox } from "@/lib/liveLayout";
import { routeEdges } from "@/lib/liveRoute";
import { shortNamesWithParts } from "@/lib/liveNames";
import { usageThresholds } from "@/lib/liveMetricFormat";
import { useReducedMotion } from "@/lib/useReducedMotion";
import { disconnectedPes, usageChips, usageEdges } from "@/lib/plUsage";
import { edgeLayer, impactView, isDirectedEdge, type EdgeLayer } from "@/lib/liveScope";
import { PARTICLE_TONE_VAR, clipLabel, legendKeys, liveEdgeStyleKey, liveStroke, mergeReversePairs, relationLabel, type ParticleTone } from "@/lib/liveStyle";
import { LiveNode, type LiveNodeData } from "./LiveNode";
import { GroupNode, type EgressInfo, type GroupNodeData, type PeeringInfo } from "./GroupNode";
import { NsgBadgeNode, type NsgBadgeData } from "./NsgBadgeNode";
import { VmssInstanceNode, type VmssInstanceNodeData } from "./VmssInstanceNode";
import { InternetNode, type InternetNodeData } from "./InternetNode";
import { LaneNode, type LaneNodeData } from "./LaneNode";
import { EmptySubnetsNode, type EmptySubnetsNodeData } from "./EmptySubnetsNode";
import { AnimatedEdge, type AnimatedEdgeData } from "./AnimatedEdge";
import { Legend } from "./Legend";
import { cardStatus } from "@/lib/liveStatus";
import styles from "../styles.module.css";
import { rgba } from "@/lib/palette";

type LiveCanvasProps = {
  spec: DiagramSpec;
  snapshot: LiveDiagramSnapshot | null;
  onNodeSelect: (nodeId: string | null) => void;
  onEdgeSelect?: (edgeId: string | null) => void;
  onSubResourceSelect?: (sr: SubResource) => void;
  /** Edge layers switched on in the toolbar's "연결선" menu */
  layers: ReadonlySet<EdgeLayer>;
  /** "트래픽 (실측)": particles on edges with measured traffic */
  trafficOn: boolean;
  /** "연결 강조": hovering a resource dims everything it is not linked to (off = whole picture stays as is) */
  hoverFocus: boolean;
  /**
   * "장애 영향": failing resources in view and their configured neighbours (lib/liveScope scopeImpacts) —
   * empty when the toggle is off. The same list the toolbar counts, so the canvas never dims for an impact
   * outside this view.
   */
  impacts: FaultImpact[];
  /** Who used each Private Endpoint (access / flow logs) — lines, chips and the PE → PaaS state; null = not loaded */
  usage?: PrivateLinkUsageResponse | null;
  /** Selected resource — its subnet ↔ NAT association lines are shown while it is selected */
  selectedNodeId?: string | null;
  focusNodeId?: string | null;
  onVmssInstanceSelect?: (data: VmssInstanceNodeData) => void;
};

const nodeTypes: NodeTypes = {
  live: LiveNode, group: GroupNode, nsgBadge: NsgBadgeNode, vmssInstance: VmssInstanceNode, internet: InternetNode,
  lane: LaneNode, emptySubnets: EmptySubnetsNode,
};
const edgeTypes: EdgeTypes = { animated: AnimatedEdge };

/** Nodes that frame others — never dimmed, never hover targets */
const FRAME_TYPES = new Set(["group", "lane", "emptySubnets"]);

/** Metric values the card shows, compared shallowly */
function sameMetrics(a: LiveNodeState["metrics"], b: LiveNodeState["metrics"]): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => a[k] === b[k]);
}

/** Last sample time of each sparkline — changes whenever a new point arrives */
function lastSparkTs(lines: LiveNodeState["sparklines"]): string {
  return Object.values(lines ?? {}).map((l) => l.timestamps[l.timestamps.length - 1] ?? "").join("|");
}

function parsePeerings(raw: string | undefined): PeeringInfo[] | undefined {
  if (!raw) return undefined;
  try {
    const list = JSON.parse(raw) as Array<{ name?: string; state?: string }>;
    return list.map((p) => ({ name: String(p.name ?? ""), state: String(p.state ?? "Unknown") })).filter((p) => p.name);
  } catch {
    return undefined;
  }
}

function LiveCanvasInner({
  spec,
  snapshot,
  onNodeSelect,
  onEdgeSelect,
  onSubResourceSelect,
  layers,
  trafficOn,
  hoverFocus,
  impacts,
  usage,
  selectedNodeId,
  focusNodeId,
  onVmssInstanceSelect,
}: LiveCanvasProps) {
  const { t } = useI18n();
  const reduceMotion = useReducedMotion();
  const [showMiniMap, setShowMiniMap] = useState(true);
  const reactFlowInstance = useReactFlow();

  // ── VMSS expand state: ref-based to avoid triggering a relayout on expand/collapse ──
  const expandedVmssIds = useRef<Set<string>>(new Set());
  const vmssInstanceCache = useRef<Map<string, AksVmssInstance[]>>(new Map());
  const getApiToken = useApiToken();
  const onVmssInstanceSelectRef = useRef(onVmssInstanceSelect);
  useLayoutEffect(() => { onVmssInstanceSelectRef.current = onVmssInstanceSelect; });
  const handleVmssExpandRef = useRef<((nodeId: string, azureResourceId: string, aksClusterArmId?: string) => void) | null>(null);
  const stableVmssExpand = useCallback((nodeId: string, azureResourceId: string, aksClusterArmId?: string) => {
    handleVmssExpandRef.current?.(nodeId, azureResourceId, aksClusterArmId);
  }, []);

  // ── Layout (lib/liveLayout): grid of subnets, lanes outside the VNet, empty subnets folded ──
  const [expandedEmpty, setExpandedEmpty] = useState<ReadonlySet<string>>(() => new Set());
  const toggleEmpty = useCallback((vnetId: string) => {
    setExpandedEmpty((prev) => {
      const next = new Set(prev);
      if (next.has(vnetId)) next.delete(vnetId);
      else next.add(vnetId);
      return next;
    });
  }, []);
  const layout = useMemo(() => liveLayout(spec, { expandedEmpty }), [spec, expandedEmpty]);
  const nodeById = useMemo(() => new Map(spec.nodes.map((n) => [n.id, n])), [spec.nodes]);
  // Short names inside this view (the VNet's own words dropped) — cards and subnet headers
  const nameInfo = useMemo(() => {
    const byId = new Map(spec.nodes.map((n) => [n.id, n]));
    const vnetOf = (id: string): string | undefined => {
      const self = byId.get(id);
      if (self?.metadata?.ghostOf) return self.metadata.ghostOf;
      let cur = self;
      const seen = new Set<string>();
      while (cur?.parentId && !seen.has(cur.id)) { seen.add(cur.id); cur = byId.get(cur.parentId); }
      return cur && cur !== self && cur.icon === "vnet" ? cur.label : undefined;
    };
    // Subnets and cards are named separately (a subnet "web" and a card "web" do not collide on screen);
    // NSGs drawn as badges have no name of their own on the canvas
    const entry = (n: DiagramNodeSpec) => ({ id: n.id, label: n.label, kind: n.resourceKind ?? n.icon });
    const subnets = spec.nodes.filter((n) => n.nodeType === "group" && n.icon !== "vnet").map(entry);
    const cards = spec.nodes.filter((n) => n.nodeType !== "group" && !n.metadata?.nsgAttachedTo).map(entry);
    return new Map([...shortNamesWithParts(subnets, vnetOf), ...shortNamesWithParts(cards, vnetOf)]);
  }, [spec.nodes]);
  const names = useMemo(() => new Map([...nameInfo].map(([id, v]) => [id, v.text])), [nameInfo]);
  // Selected resource / subnet — its full-name tag shows. Read by the node build (ref, so a selection does not
  // rebuild every node) and patched into the two nodes that change by the effect below.
  const selectedRef = useRef(selectedNodeId ?? null);
  /** One line for kinds the API reads no metric for: where a Private Endpoint leads, how many subnets a NAT serves */
  const relationOf = useMemo(() => {
    const m = new Map<string, string>();
    const SERVICE: Record<string, string> = { keyVault: "Key Vault", storage: "Storage", redis: "Redis", appService: "App Service", functionApp: "Functions", sql: "SQL", postgres: "PostgreSQL", cosmosDb: "Cosmos DB", serviceBus: "Service Bus", eventHub: "Event Hubs" };
    for (const e of spec.edges) {
      if (e.edgeKind === "privateLink") {
        const tgt = spec.nodes.find((n) => n.id === e.target);
        const k = tgt?.resourceKind ?? tgt?.icon ?? "";
        if (!m.has(e.source)) m.set(e.source, t("ld.card.peTarget", { target: SERVICE[k] ?? k }));
      }
    }
    const natCount = new Map<string, number>();
    for (const e of spec.edges) if (e.edgeKind === "natgw-association") natCount.set(e.target, (natCount.get(e.target) ?? 0) + 1);
    for (const [id, n] of natCount) m.set(id, t("ld.card.natSubnets", { n }));
    return m;
  }, [spec.nodes, spec.edges, t]);
  /** Spec nodes drawn as their own React Flow node */
  const renderedIds = useMemo(() => new Set(spec.nodes.filter((n) => !layout.hidden.has(n.id)).map((n) => n.id)), [spec.nodes, layout.hidden]);
  // Observed Private Link use (workload → PE) joins the configured lines after layout — the picture never moves
  const usageLines = useMemo(() => usageEdges(usage, nodeById, renderedIds), [usage, nodeById, renderedIds]);
  const allEdges = useMemo(() => (usageLines.length ? [...spec.edges, ...usageLines] : spec.edges), [spec.edges, usageLines]);
  const disconnected = useMemo(() => disconnectedPes(usage), [usage]);
  const chipsByNode = useMemo(() => usageChips(usage), [usage]);
  // Read when cards are rebuilt (layout effect) so a rebuild keeps the chips
  const chipsRef = useRef(chipsByNode);
  useLayoutEffect(() => { chipsRef.current = chipsByNode; }, [chipsByNode]);

  // ── Hover highlight state (resources dim the rest; a hovered subnet only reveals its NAT association) ──
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [hoveredGroupId, setHoveredGroupId] = useState<string | null>(null);
  const { connectedEdgeIds, connectedNodeIds } = useMemo(() => {
    if (!hoveredNodeId) return { connectedEdgeIds: new Set<string>(), connectedNodeIds: new Set<string>() };
    const eIds = new Set<string>();
    const nIds = new Set<string>([hoveredNodeId]);
    for (const e of allEdges) {
      if (e.source === hoveredNodeId || e.target === hoveredNodeId) {
        eIds.add(e.id);
        nIds.add(e.source);
        nIds.add(e.target);
      }
    }
    return { connectedEdgeIds: eIds, connectedNodeIds: nIds };
  }, [hoveredNodeId, allEdges]);

  // ── Fault impact roles (configured links, one hop — computed by the API) ──
  const { active: impactActive, roles: impactRoles, edgeIds: impactEdgeIds } = useMemo(() => impactView(impacts), [impacts]);
  // Read when cards are rebuilt (layout effect) so a rebuild keeps the impact badges
  const impactRolesRef = useRef(impactRoles);
  useLayoutEffect(() => { impactRolesRef.current = impactRoles; });

  // NSGs embedded as badges on their subnet / NIC / VM (nsgAttachedTo)
  const nsgByTarget = useMemo(() => {
    const map = new Map<string, Array<{ nodeId: string; label: string; icon: string; azureResourceId?: string }>>();
    for (const n of spec.nodes) {
      const targetId = n.metadata?.nsgAttachedTo;
      if (!targetId || n.icon !== "nsg") continue;
      const arr = map.get(targetId) ?? [];
      arr.push({ nodeId: n.id, label: n.label, icon: n.icon, azureResourceId: n.azureResourceId });
      map.set(targetId, arr);
    }
    return map;
  }, [spec.nodes]);

  /** Clicking a badge or chip (NSG, NAT) selects that resource for the detail panel */
  const handleBadgeSelect = useCallback((nodeId: string) => onNodeSelect(nodeId), [onNodeSelect]);

  // Nodes are (re)built from the layout by the layout effect below — the first render starts empty
  const [nodes, setNodes, onNodesChange] = useNodesState([]);

  // ── VMSS expand handler ──
  const handleVmssExpand = useCallback(async (vmssNodeId: string, azureResourceId: string, aksClusterArmId?: string) => {
    if (expandedVmssIds.current.has(vmssNodeId)) {
      expandedVmssIds.current.delete(vmssNodeId);
      setNodes((prev: FlowNode[]) => prev
        .filter((n: FlowNode) => n.type !== "vmssInstance" || (n.data as VmssInstanceNodeData | undefined)?.parentVmssId !== vmssNodeId)
        .map((n: FlowNode) => (n.id === vmssNodeId ? { ...n, data: { ...n.data, vmssExpanded: false } } : n)));
      return;
    }
    expandedVmssIds.current.add(vmssNodeId);
    setNodes((prev: FlowNode[]) => prev.map((n: FlowNode) => (n.id === vmssNodeId ? { ...n, data: { ...n.data, vmssExpanded: true } } : n)));

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

    // Instances stack in one column under the VMSS card
    setNodes((prev: FlowNode[]) => {
      const vmssNode = prev.find((n: FlowNode) => n.id === vmssNodeId);
      if (!vmssNode) return prev;
      const INST_W = 200;
      const INST_H = 54;
      const INST_GAP = 6;
      const vmssW = vmssNode.width ?? LIVE.CARD_W;
      const vmssH = vmssNode.height ?? LIVE.CARD_H;
      const instX = Math.round((vmssW - INST_W) / 2);
      const instanceNodes: (FlowNode<VmssInstanceNodeData> & { parentNode: string })[] = instances.map((inst, i) => ({
        id: `vmss-inst-${vmssNodeId}-${inst.instanceId}`,
        type: "vmssInstance" as const,
        parentNode: vmssNodeId,
        position: { x: instX, y: vmssH + 20 + i * (INST_H + INST_GAP) },
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
      const others = prev.filter((n: FlowNode) => n.type !== "vmssInstance" || (n.data as VmssInstanceNodeData | undefined)?.parentVmssId !== vmssNodeId);
      return [...others, ...instanceNodes];
    });
  }, [getApiToken, setNodes]);
  useLayoutEffect(() => { handleVmssExpandRef.current = handleVmssExpand; });

  // useReactFlow() returns a new object every render in v11 — keep the latest in a ref for effects
  const rfRef = useRef(reactFlowInstance);
  useLayoutEffect(() => { rfRef.current = reactFlowInstance; });
  // Latest snapshot for the layout effect (health / metrics updates are Effect B's job)
  const snapshotRef = useRef(snapshot);
  useLayoutEffect(() => { snapshotRef.current = snapshot; });

  // ── Focus node: zoom to a specific node ("nodeId:timestamp" re-triggers for the same node) ──
  useEffect(() => {
    if (!focusNodeId) return;
    const nodeId = focusNodeId.replace(/:\d+$/, "");
    const rafId = requestAnimationFrame(() => {
      rfRef.current.fitView({ nodes: [{ id: nodeId }], padding: 0.5, duration: 500 });
    });
    return () => cancelAnimationFrame(rafId);
  }, [focusNodeId]);

  // ── Layout effect: rebuild every node from the layout (scope change, new diagram, empty subnets toggled) ──
  const lastFitKey = useRef("");
  useEffect(() => {
    const currentSnapshot = snapshotRef.current;
    const pos = (id: string): LayoutBox | undefined => layout.items.get(id);
    const placeOf = (n: DiagramNodeSpec) => {
      const box = pos(n.id);
      const parent = box?.parent ?? undefined;
      return {
        position: box ? { x: box.x, y: box.y } : (n.position ?? { x: 0, y: 0 }),
        ...(parent ? { parentNode: parent, extent: "parent" as const } : {}),
      };
    };

    const out: FlowNode[] = [];
    // Lanes first (they parent cards), then VNets, subnets, folded rows, then cards — parents before children
    for (const l of layout.lanes) {
      out.push({
        id: l.id, type: "lane", position: { x: l.x, y: l.y }, draggable: false, selectable: false,
        // The wrapper lets pointer events through (panning, cards inside); the title is decoration
        style: { width: l.w, height: l.h, pointerEvents: "none" },
        data: { label: l.label, lane: l.lane } satisfies LaneNodeData,
      });
    }
    const groups = spec.nodes
      .filter((n) => n.nodeType === "group" && renderedIds.has(n.id))
      .sort((a, b) => (a.parentId ? 1 : 0) - (b.parentId ? 1 : 0));
    for (const n of groups) {
      const box = pos(n.id);
      const egressVia = n.metadata?.egressVia as EgressInfo["via"] | undefined;
      const data: GroupNodeData = {
        label: n.label,
        icon: n.icon,
        subtitle: n.metadata?.addressSpace ?? n.metadata?.prefix,
        region: n.icon === "vnet" ? n.location : undefined,
        nsgBadges: nsgByTarget.get(n.id)?.map((b) => ({ nodeId: b.nodeId, label: b.label, icon: b.icon as GroupNodeData["icon"], azureResourceId: b.azureResourceId })),
        onNsgSelect: handleBadgeSelect,
        egress: egressVia ? { via: egressVia, name: n.metadata?.egressName, natId: n.metadata?.natGwBadgeId } : undefined,
        nicCount: layout.nicCount.get(n.id),
        peerings: parsePeerings(n.metadata?.peerings),
        shortLabel: n.icon === "subnet" ? names.get(n.id) : undefined,
        nameParts: n.icon === "subnet" ? nameInfo.get(n.id)?.parts : undefined,
        focused: n.id === selectedRef.current,
      };
      out.push({
        id: n.id, type: "group", ...placeOf(n), draggable: false, selectable: true,
        // The wrapper lets pointer events through; the header (pointer-events: auto) stays clickable
        style: { width: box?.w ?? n.width ?? 400, height: box?.h ?? n.height ?? 200, pointerEvents: "none" },
        data,
      });
    }
    // "No connections" frame inside a VNet (after the VNet node — React Flow needs parents first). Decoration
    // only: the subnets inside keep the VNet as parent, the frame lets every pointer event through
    for (const s of layout.sections) {
      out.push({
        id: s.id, type: "lane", position: { x: s.x, y: s.y }, parentNode: s.vnetId, extent: "parent",
        draggable: false, selectable: false, style: { width: s.w, height: s.h, pointerEvents: "none" },
        data: { label: s.label, lane: "section", count: s.count } satisfies LaneNodeData,
      });
    }
    for (const s of layout.summaries) {
      out.push({
        id: s.id, type: "emptySubnets", position: { x: s.x, y: s.y }, parentNode: s.vnetId, extent: "parent",
        draggable: false, selectable: false, style: { width: s.w, height: s.h },
        data: { vnetId: s.vnetId, names: s.names, expanded: s.expanded, onToggle: toggleEmpty } satisfies EmptySubnetsNodeData,
      });
    }
    for (const n of spec.nodes) {
      if (n.nodeType === "group" || !renderedIds.has(n.id)) continue;
      const kind = n.resourceKind ?? n.icon;
      if (kind === "internet") {
        const direction = n.metadata?.direction === "ingress" ? "ingress" : "egress";
        out.push({
          id: n.id, type: "internet", ...placeOf(n), draggable: false,
          // Exactly the layout size — content height must not move the handles off the line (it drew a jog)
          style: { width: LIVE.INTERNET_W, height: LIVE.INTERNET_H },
          data: {
            label: n.label,
            direction,
            count: parseInt((direction === "ingress" ? n.metadata?.entryCount : n.metadata?.outboundMethodCount) ?? "0", 10),
            hasDeprecatedPath: n.metadata?.hasDeprecatedPath === "true",
          } satisfies InternetNodeData,
        });
        continue;
      }
      if (kind === "nsg") {
        out.push({
          id: n.id, type: "nsgBadge", ...placeOf(n), draggable: false, zIndex: 10,
          style: { width: LIVE.NSG_W, height: LIVE.NSG_H },
          data: { label: n.label, icon: n.icon, resourceKind: n.resourceKind, azureResourceId: n.azureResourceId, detached: n.metadata?.detached === "true" } satisfies NsgBadgeData,
        });
        continue;
      }
      const live = currentSnapshot?.nodes.find((s) => s.id === n.id);
      const firstNsg = nsgByTarget.get(n.id)?.[0];
      const data: LiveNodeData = {
        label: n.label,
        icon: n.icon,
        health: live?.health ?? "unknown",
        healthScore: live?.healthScore ?? 0.5,
        metrics: live?.metrics ?? {},
        hasAlert: (live?.activeAlertIds.length ?? 0) > 0,
        sparklines: live?.sparklines,
        endpoint: n.endpoint,
        subResources: n.subResources,
        onSubResourceSelect,
        resourceKind: n.resourceKind,
        azureResourceId: n.azureResourceId,
        powerState: live?.powerState,
        archRole: n.metadata?.archRole,
        archGroupId: n.metadata?.archGroupId,
        nsgBadge: firstNsg ? { nodeId: firstNsg.nodeId, label: firstNsg.label, icon: firstNsg.icon as LiveNodeData["icon"], azureResourceId: firstNsg.azureResourceId } : undefined,
        onNsgSelect: handleBadgeSelect,
        aksClusterArmId: n.metadata?.aksClusterArmId,
        vmssExpanded: expandedVmssIds.current.has(n.id),
        onVmssExpand: n.metadata?.archRole === "aks-vmss" ? stableVmssExpand : undefined,
        isUnused: n.metadata?.unused === "true",
        ghostOf: n.metadata?.ghostOf,
        shortName: names.get(n.id),
        nameParts: nameInfo.get(n.id)?.parts,
        focused: n.id === selectedRef.current,
        boundMetrics: Object.entries(n.bindings).filter(([, b]) => b.source !== "composite").map(([k]) => k),
        usageWarn: usageThresholds(n.bindings),
        healthRules: n.bindings.health?.rules,
        plChips: chipsRef.current.get(n.id),
        metricsState: currentSnapshot?.coverage?.sources.metrics,
        relation: relationOf.get(n.id),
        impact: impactRolesRef.current.get(n.id),
      };
      out.push({ id: n.id, type: "live", ...placeOf(n), draggable: false, data });
    }

    setNodes((prev) => [...out, ...prev.filter((n) => n.type === "vmssInstance" && out.some((o) => o.id === (n.data as VmssInstanceNodeData).parentVmssId))]);

    // Fit once per scope (not when a folded row is opened — the user is looking at that spot)
    const fitKey = `${spec.id}|${spec.nodes.length}|${spec.nodes[0]?.id ?? ""}`;
    if (fitKey === lastFitKey.current) return;
    lastFitKey.current = fitKey;
    const rafId = requestAnimationFrame(() => rfRef.current.fitBounds(layout.bounds, { padding: 0.06, duration: 300 }));
    return () => cancelAnimationFrame(rafId);
  }, [spec, layout, renderedIds, nsgByTarget, handleBadgeSelect, onSubResourceSelect, stableVmssExpand, toggleEmpty, setNodes, names, nameInfo, relationOf]);

  // ── Selection → full-name tag: only the previously and newly selected nodes get new data ──
  useEffect(() => {
    const prevId = selectedRef.current;
    const nextId = selectedNodeId ?? null;
    selectedRef.current = nextId;
    if (prevId === nextId) return;
    setNodes((prev) => prev.map((n) => {
      if (n.id !== prevId && n.id !== nextId) return n;
      if (n.type !== "live" && n.type !== "group") return n;
      return { ...n, data: { ...n.data, focused: n.id === nextId } };
    }));
  }, [selectedNodeId, setNodes]);

  // Keyboard selection (Tab to a card, Enter) opens the panel like a click does
  const handleNodesChange = useCallback((changes: NodeChange[]) => {
    onNodesChange(changes);
    for (const c of changes) {
      if (c.type !== "select" || !c.selected) continue;
      const type = rfRef.current.getNode(c.id)?.type;
      if (type === "live" || type === "group") onNodeSelect(c.id);
    }
  }, [onNodesChange, onNodeSelect]);

  // ── Effect B: Snapshot update — health/status only, positions untouched ──
  useEffect(() => {
    if (!snapshot?.nodes) return;
    const liveNodes = new Map(snapshot.nodes.map((s) => [s.id, s]));
    setNodes((prev) =>
      prev.map((n) => {
        if (n.type !== "live") return n;
        const live = liveNodes.get(n.id);
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
          metricsState: snapshot.coverage?.sources.metrics,
        };
        // Skip update only if nothing the card shows changed — metric values and the trend included
        if (
          prev_.health === next.health &&
          prev_.healthScore === next.healthScore &&
          prev_.powerState === next.powerState &&
          prev_.hasAlert === next.hasAlert &&
          prev_.metricsState === next.metricsState &&
          sameMetrics(prev_.metrics, next.metrics) &&
          lastSparkTs(prev_.sparklines) === lastSparkTs(next.sparklines)
        )
          return n;
        return { ...n, data: next };
      }),
    );
  }, [snapshot?.nodes, snapshot?.coverage, setNodes]);

  // ── Hover / fault impact: node className for CSS dimming, impact role for the card badge ──
  // Hover wins while it lasts; with impact on, resources outside every impact are dimmed (frames stay).
  useEffect(() => {
    setNodes((prev) => {
      let changed = false;
      const next = prev.map((n) => {
        const frame = FRAME_TYPES.has(n.type ?? "");
        const cls = frame
          ? ""
          : hoveredNodeId && hoverFocus
            ? (connectedNodeIds.has(n.id) ? "node-highlighted" : "node-dimmed")
            : impactActive && !impactRoles.has(n.id) ? "node-impact-dimmed" : "";
        const role = n.type === "live" ? impactRoles.get(n.id) : undefined;
        const roleChanged = n.type === "live" && (n.data as LiveNodeData).impact !== role;
        if ((n.className ?? "") === cls && !roleChanged) return n;
        changed = true;
        return { ...n, className: cls, ...(roleChanged ? { data: { ...n.data, impact: role } } : {}) };
      });
      return changed ? next : prev;
    });
  }, [hoveredNodeId, hoverFocus, connectedNodeIds, impactActive, impactRoles, setNodes, layout]);

  // ── Edges: layer filter, one line per relationship, arrowheads for directed kinds, labels on hover ──
  const visibleEdgeSpecs = useMemo(() => {
    const focus = new Set([hoveredNodeId, hoveredGroupId, selectedNodeId].filter(Boolean) as string[]);
    return allEdges.filter((e) => {
      if (!renderedIds.has(e.source) || !renderedIds.has(e.target)) return false;
      if (!layers.has(edgeLayer(e, nodeById))) return false;
      // Subnet → NAT association: only while the subnet or the NAT is hovered / selected (the chip says it otherwise)
      if (e.edgeKind === "natgw-association") return focus.has(e.source) || focus.has(e.target);
      return true;
    });
  }, [allEdges, renderedIds, layers, nodeById, hoveredNodeId, hoveredGroupId, selectedNodeId]);

  const merged = useMemo(() => {
    const { drop, both } = mergeReversePairs(visibleEdgeSpecs);
    return { list: visibleEdgeSpecs.filter((e) => !drop.has(e.id)), both };
  }, [visibleEdgeSpecs]);
  // Handles and path of every line (lib/liveRoute) — right angles through the corridors between boxes
  const routes = useMemo(() => routeEdges(layout, merged.list), [layout, merged.list]);

  const edges: FlowEdge<AnimatedEdgeData>[] = useMemo(() => {
    const liveById = new Map((snapshot?.edges ?? []).map((e) => [e.id, e]));
    const { both } = merged;
    const result: FlowEdge<AnimatedEdgeData>[] = [];
    for (const e of merged.list) {
      const route = routes.get(e.id);
      const live = liveById.get(e.id);
      const styleKey = liveEdgeStyleKey(e, nodeById);
      const onImpactPath = impactActive && impactEdgeIds.has(e.id);
      const color = onImpactPath ? rgba("danger", 0.85) : liveStroke(styleKey);
      const arrow = { type: MarkerType.ArrowClosed, width: 14, height: 14, color };
      const rel = relationLabel(e, nodeById);
      // A Private Endpoint whose connection is not approved: grey, labelled, no comets
      const cut = e.edgeKind === "privateLink" && disconnected.has(e.source);
      result.push({
        id: e.id,
        source: e.source,
        target: e.target,
        type: "animated",
        // Lines and their labels draw above the VNet / subnet boxes (React Flow puts edges under nodes by default);
        // routing keeps them off the cards, so nothing is hidden by drawing them on top
        zIndex: 1000,
        sourceHandle: route?.sourceHandle ?? "s-r",
        targetHandle: route?.targetHandle ?? "t-l",
        markerEnd: isDirectedEdge(e) || both.has(e.id) ? arrow : undefined,
        markerStart: both.has(e.id) ? arrow : undefined,
        data: {
          styleKey,
          status: live?.status ?? "normal",
          trafficLevel: live?.trafficLevel ?? "none",
          label: cut ? t("ld.plu.disconnected") : rel ? clipLabel(t(rel.key, rel.vars)) : undefined,
          disconnected: cut,
          isHighlighted: hoveredNodeId ? connectedEdgeIds.has(e.id) : false,
          isDimmed: hoveredNodeId && hoverFocus ? !connectedEdgeIds.has(e.id) : false,
          showParticles: trafficOn,
          reduceMotion,
          measured: live?.metricsSource === "measured",
          impact: !impactActive ? undefined : onImpactPath ? "path" : "dim",
          route,
        },
      });
    }
    return result;
  }, [merged, routes, snapshot?.edges, nodeById, impactActive, impactEdgeIds, hoveredNodeId, hoverFocus, connectedEdgeIds, trafficOn, reduceMotion, disconnected, t]);

  // ── Private Link chips on PE / PaaS cards (only nodes whose chips change get new data) ──
  useEffect(() => {
    setNodes((prev) => {
      let changed = false;
      const next = prev.map((n) => {
        if (n.type !== "live") return n;
        const want = chipsByNode.get(n.id);
        const have = (n.data as LiveNodeData).plChips;
        if (JSON.stringify(want ?? null) === JSON.stringify(have ?? null)) return n;
        changed = true;
        return { ...n, data: { ...n.data, plChips: want } };
      });
      return changed ? next : prev;
    });
  }, [chipsByNode, setNodes]);

  // ── Level of detail by zoom: a data attribute on the wrapper, CSS swaps what cards show (no re-render) ──
  const wrapRef = useRef<HTMLDivElement>(null);
  const lodRef = useRef("");
  const applyLod = useCallback((z: number) => {
    const cur = lodRef.current;
    // Hysteresis: detail ≥ 0.78 in / < 0.72 out, outline < 0.40 in / ≥ 0.44 out
    const next = !cur
      ? (z >= 0.75 ? "detail" : z < 0.42 ? "glance" : "summary")
      : cur === "detail"
        ? (z >= 0.72 ? "detail" : z < 0.40 ? "glance" : "summary")
        : cur === "glance"
          ? (z < 0.44 ? "glance" : z >= 0.78 ? "detail" : "summary")
          : (z >= 0.78 ? "detail" : z < 0.40 ? "glance" : "summary");
    if (next === cur) return;
    lodRef.current = next;
    if (wrapRef.current) wrapRef.current.dataset.lod = next;
  }, []);

  const legendLines = useMemo(() => legendKeys(visibleEdgeSpecs, nodeById), [visibleEdgeSpecs, nodeById]);
  const hasGhost = useMemo(() => spec.nodes.some((n) => n.metadata?.ghostOf), [spec.nodes]);

  // ── Hover handlers ──
  const handleNodeMouseEnter = useCallback((_e: React.MouseEvent, node: FlowNode) => {
    if (node.type === "group") setHoveredGroupId(node.id);
    else if (!FRAME_TYPES.has(node.type ?? "")) setHoveredNodeId(node.id);
  }, [setHoveredGroupId, setHoveredNodeId]);
  const handleNodeMouseLeave = useCallback(() => { setHoveredNodeId(null); setHoveredGroupId(null); }, [setHoveredGroupId, setHoveredNodeId]);

  return (
    <div className={styles.canvasWrap} ref={wrapRef}>
      {/* Comet tail gradients, one per colour (url(#ld-ptail-*) from every edge). Not display:none — Firefox drops it */}
      <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
        <defs>
          {(Object.keys(PARTICLE_TONE_VAR) as ParticleTone[]).map((k) => (
            <linearGradient key={k} id={`ld-ptail-${k}`} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" style={{ stopColor: `rgb(var(${PARTICLE_TONE_VAR[k]}))`, stopOpacity: 0 }} />
              <stop offset="0.5" style={{ stopColor: `rgb(var(${PARTICLE_TONE_VAR[k]}))`, stopOpacity: 0.3 }} />
              <stop offset="1" style={{ stopColor: `rgb(var(${PARTICLE_TONE_VAR[k]}))`, stopOpacity: 0.95 }} />
            </linearGradient>
          ))}
        </defs>
      </svg>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={handleNodesChange}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeClick={(_e, node) => {
          if (node.type === "vmssInstance") onVmssInstanceSelect?.(node.data as VmssInstanceNodeData);
          else if (node.type !== "lane" && node.type !== "emptySubnets") onNodeSelect(node.id);
        }}
        onEdgeClick={(_e, edge) => onEdgeSelect?.(edge.id)}
        onPaneClick={() => { onNodeSelect(null); onEdgeSelect?.(null); }}
        onNodeMouseEnter={handleNodeMouseEnter}
        onNodeMouseLeave={handleNodeMouseLeave}
        onMove={(_e, vp) => applyLod(vp.zoom)}
        onInit={(rf) => applyLod(rf.getZoom())}
        nodesDraggable={false}
        minZoom={0.05}
        maxZoom={4}
        proOptions={{ hideAttribution: true }}
        elevateNodesOnSelect={false}
        elevateEdgesOnSelect={true}
      >
        <Background gap={20} size={1} color={rgba("ink", 0.06)} />
        <Controls />
        {showMiniMap && (
          <MiniMap
            nodeColor={(n) => {
              if (FRAME_TYPES.has(n.type ?? "")) return rgba("ink", 0.05);
              // Same status the card shows (lib: cardStatus — unknown and "running only" stay grey)
              const d = n.data as LiveNodeData | undefined;
              return cardStatus(d?.health ?? "unknown", d?.powerState, d?.impact).color;
            }}
            maskColor={rgba("canvas", 0.85)}
            style={{ borderRadius: 12, border: `1px solid ${rgba("ink", 0.1)}` }}
          />
        )}
      </ReactFlow>
      <Legend lines={legendLines} impact={impactActive} ghost={hasGhost} traffic={trafficOn} />
      <button
        type="button"
        className={styles.miniMapToggle}
        onClick={() => setShowMiniMap((v) => !v)}
        title={t(showMiniMap ? "ld.minimap.hide" : "ld.minimap.show")}
      >
        {showMiniMap ? "⊟" : "⊞"}
      </button>
    </div>
  );
}

export function LiveCanvas(props: LiveCanvasProps) {
  // key={spec.id} forces a full React Flow remount when the diagram changes (no stale nodes / viewport)
  return (
    <ReactFlowProvider key={props.spec.id}>
      <LiveCanvasInner {...props} />
    </ReactFlowProvider>
  );
}
