"use client";

import { useState, useEffect, useCallback, useMemo, memo, useRef } from "react";
import ReactFlow, {
  type Node,
  type Edge,
  type NodeTypes,
  type NodeProps,
  Handle,
  Position,
  useNodesState,
  useEdgesState,
  Background,
  Controls,
  MiniMap,
  MarkerType,
} from "reactflow";
import "reactflow/dist/style.css";
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  forceX,
  forceY,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from "d3-force";
import type {
  HubbleServiceMapResponse,
  HubbleServiceNode,
  HubbleServiceEdge,
  HubbleServiceType,
} from "@aud/types";
import { apiBaseUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiToken } from "@/lib/useApiToken";
import styles from "../styles.module.css";

type Props = { clusterId: string };

// ── Service Type 아이콘/라벨 ──

const SERVICE_TYPE_META: Record<HubbleServiceType, { icon: string; label: string; color: string }> = {
  workload:       { icon: "⬡", label: "Workload",       color: "rgba(0,120,212,0.15)" },
  world:          { icon: "🌐", label: "External",       color: "rgba(107,76,154,0.15)" },
  host:           { icon: "🖥", label: "Host",           color: "rgba(20,21,23,0.08)" },
  dns:            { icon: "◈", label: "DNS",            color: "rgba(0,150,136,0.15)" },
  init:           { icon: "◎", label: "Init",           color: "rgba(20,21,23,0.06)" },
  unmanaged:      { icon: "◇", label: "Unmanaged",      color: "rgba(209,132,0,0.12)" },
  "kube-apiserver": { icon: "⎈", label: "API Server",  color: "rgba(50,100,200,0.12)" },
  "remote-node":  { icon: "⊞", label: "Remote Node",   color: "rgba(20,21,23,0.08)" },
};

// ── Custom Service Node ──

type ServiceNodeData = {
  namespace: string;
  workloadName: string;
  serviceType: HubbleServiceType;
  podCount: number;
  totalFlows: number;
  forwardedFlows: number;
  droppedFlows: number;
  httpErrorCount: number;
  avgLatencyMs: number | null;
  dnsQueryCount: number;
  dnsErrorCount: number;
  healthStatus: "ok" | "warn" | "crit";
  selected: boolean;
};

const ServiceNode = memo(function ServiceNode({ data }: NodeProps<ServiceNodeData>) {
  const meta = SERVICE_TYPE_META[data.serviceType] ?? SERVICE_TYPE_META.workload;
  const statusCls =
    data.healthStatus === "crit" ? styles.svcNodeCrit
    : data.healthStatus === "warn" ? styles.svcNodeWarn
    : styles.svcNodeOk;

  return (
    <>
      <Handle type="target" position={Position.Top} className={styles.handleHidden} />
      <Handle type="target" position={Position.Left} className={styles.handleHidden} />
      <div className={`${styles.svcNode} ${statusCls} ${data.selected ? styles.svcNodeSelected : ""}`}
        style={{ background: meta.color }}>
        <div className={styles.svcNodeHeader}>
          <span className={styles.svcNodeIcon}>{meta.icon}</span>
          <span className={styles.svcNodeNs}>{data.namespace || "external"}</span>
          {data.serviceType !== "workload" && (
            <span className={styles.svcNodeTypeBadge}>{meta.label}</span>
          )}
        </div>
        <div className={styles.svcNodeName} title={data.workloadName}>{data.workloadName}</div>
        <div className={styles.svcNodeMetrics}>
          <span className={styles.svcNodeMetric}>
            <span className={`${styles.svcNodeDot} ${data.droppedFlows > 0 ? styles.dotRed : styles.dotGreen}`} />
            {data.totalFlows.toLocaleString()}
          </span>
          {data.podCount > 0 && (
            <span className={styles.svcNodeMetric}>
              <span className={`${styles.svcNodeDot} ${styles.dotGray}`} />
              {data.podCount}p
            </span>
          )}
          {data.avgLatencyMs !== null && (
            <span className={styles.svcNodeMetric}>{data.avgLatencyMs}ms</span>
          )}
          {data.dnsQueryCount > 0 && (
            <span className={styles.svcNodeMetric}>
              <span className={`${styles.svcNodeDot} ${data.dnsErrorCount > 0 ? styles.dotYellow : styles.dotGreen}`} />
              {data.dnsQueryCount} dns
            </span>
          )}
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} className={styles.handleHidden} />
      <Handle type="source" position={Position.Right} className={styles.handleHidden} />
    </>
  );
});

const nodeTypes: NodeTypes = { service: ServiceNode };

// ── d3-force Layout ──

type ForceNode = SimulationNodeDatum & { id: string; namespace: string };
type ForceLink = SimulationLinkDatum<ForceNode> & { flowCount: number };

function computeForceLayout(
  svcNodes: HubbleServiceNode[],
  svcEdges: HubbleServiceEdge[],
  selectedNodeId: string | null,
): { nodes: Node<ServiceNodeData>[]; edges: Edge[] } {
  if (svcNodes.length === 0) return { nodes: [], edges: [] };

  const NODE_W = 200;
  const NODE_H = 90;

  // namespace별 그룹 인덱스 (forceY 타겟용)
  const nsSet = [...new Set(svcNodes.map((n) => n.namespace || "external"))];
  const nsIndex = new Map(nsSet.map((ns, i) => [ns, i]));

  // d3-force 시뮬레이션 노드
  const forceNodes: ForceNode[] = svcNodes.map((n) => ({
    id: n.id,
    namespace: n.namespace || "external",
    x: (nsIndex.get(n.namespace || "external") ?? 0) * 300 + Math.random() * 100,
    y: Math.random() * 400,
  }));

  const nodeIdSet = new Set(svcNodes.map((n) => n.id));
  const forceLinks: ForceLink[] = svcEdges
    .filter((e) => nodeIdSet.has(e.sourceId) && nodeIdSet.has(e.destinationId))
    .map((e) => ({
      source: e.sourceId,
      target: e.destinationId,
      flowCount: e.metrics.flowCount,
    }));

  // 시뮬레이션 실행 (동기)
  const simulation = forceSimulation<ForceNode>(forceNodes)
    .force("link", forceLink<ForceNode, ForceLink>(forceLinks)
      .id((d) => d.id)
      .distance(180)
      .strength((link) => Math.min(1, 0.3 + Math.log2((link as ForceLink).flowCount + 1) * 0.05)))
    .force("charge", forceManyBody().strength(-400).distanceMax(600))
    .force("center", forceCenter(400, 300))
    .force("collide", forceCollide(NODE_W * 0.6))
    .force("x", forceX<ForceNode>()
      .x((d) => (nsIndex.get(d.namespace) ?? 0) * 350)
      .strength(0.15))
    .force("y", forceY<ForceNode>()
      .y(300)
      .strength(0.05))
    .stop();

  // tick 300회 (수렴)
  for (let i = 0; i < 300; i++) simulation.tick();

  // 노드 맵
  const nodeById = new Map(svcNodes.map((n) => [n.id, n]));
  const posMap = new Map(forceNodes.map((fn) => [fn.id, { x: fn.x ?? 0, y: fn.y ?? 0 }]));

  const nodes: Node<ServiceNodeData>[] = svcNodes.map((n) => {
    const pos = posMap.get(n.id) ?? { x: 0, y: 0 };
    const healthStatus: ServiceNodeData["healthStatus"] =
      n.metrics.droppedFlows > n.metrics.totalFlows * 0.1 ? "crit"
      : n.metrics.droppedFlows > 0 || n.metrics.httpErrorCount > 0 ? "warn"
      : "ok";

    return {
      id: n.id,
      type: "service",
      position: { x: pos.x - NODE_W / 2, y: pos.y - NODE_H / 2 },
      data: {
        namespace: n.namespace,
        workloadName: n.workloadName,
        serviceType: n.serviceType,
        podCount: n.podCount,
        totalFlows: n.metrics.totalFlows,
        forwardedFlows: n.metrics.forwardedFlows,
        droppedFlows: n.metrics.droppedFlows,
        httpErrorCount: n.metrics.httpErrorCount,
        avgLatencyMs: n.metrics.avgLatencyMs,
        dnsQueryCount: n.metrics.dnsQueryCount,
        dnsErrorCount: n.metrics.dnsErrorCount,
        healthStatus,
        selected: n.id === selectedNodeId,
      },
    };
  });

  const edges: Edge[] = svcEdges
    .filter((e) => nodeIdSet.has(e.sourceId) && nodeIdSet.has(e.destinationId))
    .map((e) => {
      const isDropped = e.verdict === "DROPPED";
      const hasErrors = e.metrics.httpErrorRate > 0.05;
      const strokeColor = isDropped ? "rgba(196,43,28,0.6)"
        : hasErrors ? "rgba(209,132,0,0.6)"
        : "rgba(0,120,212,0.35)";

      const label = [
        e.protocol !== "UNKNOWN" ? e.protocol : "",
        e.port > 0 ? `:${e.port}` : "",
        e.metrics.avgLatencyMs ? ` ${e.metrics.avgLatencyMs}ms` : "",
      ].filter(Boolean).join("");

      return {
        id: e.id,
        source: e.sourceId,
        target: e.destinationId,
        type: "default",
        animated: e.verdict === "FORWARDED" && e.metrics.flowCount > 5,
        style: {
          stroke: strokeColor,
          strokeWidth: Math.min(5, Math.max(1, Math.log2(e.metrics.flowCount + 1))),
          strokeDasharray: isDropped ? "5 3" : undefined,
        },
        label: label || undefined,
        labelStyle: { fontSize: 9, fill: "rgba(20,21,23,0.5)" },
        labelBgStyle: { fill: "rgba(248,249,250,0.9)" },
        labelBgPadding: [4, 2] as [number, number],
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 12,
          height: 12,
          color: strokeColor,
        },
        ...(e.bidirectional ? {
          markerStart: {
            type: MarkerType.ArrowClosed,
            width: 10,
            height: 10,
            color: strokeColor,
          },
        } : {}),
      };
    });

  return { nodes, edges };
}

// ── Node Detail Panel ──

function NodeDetailPanel({
  node,
  edges,
  allNodes,
  onClose,
}: {
  node: HubbleServiceNode;
  edges: HubbleServiceEdge[];
  allNodes: HubbleServiceNode[];
  onClose: () => void;
}) {
  const meta = SERVICE_TYPE_META[node.serviceType] ?? SERVICE_TYPE_META.workload;
  const nodeMap = new Map(allNodes.map((n) => [n.id, n]));

  // 이 노드에 연결된 엣지
  const connectedEdges = edges.filter(
    (e) => e.sourceId === node.id || e.destinationId === node.id,
  );

  // 인바운드/아웃바운드 분류
  const inbound = connectedEdges.filter((e) => e.destinationId === node.id);
  const outbound = connectedEdges.filter((e) => e.sourceId === node.id);

  const droppedPct = node.metrics.totalFlows > 0
    ? ((node.metrics.droppedFlows / node.metrics.totalFlows) * 100).toFixed(1)
    : "0";

  return (
    <div className={styles.detailPanel}>
      <div className={styles.detailPanelHeader}>
        <div>
          <span className={styles.detailPanelIcon}>{meta.icon}</span>
          <span className={styles.detailPanelTitle}>{node.workloadName}</span>
        </div>
        <button className={styles.detailPanelClose} onClick={onClose}>✕</button>
      </div>

      <div className={styles.detailPanelMeta}>
        <div className={styles.detailPanelMetaRow}>
          <span>Namespace</span><span>{node.namespace || "—"}</span>
        </div>
        <div className={styles.detailPanelMetaRow}>
          <span>유형</span><span>{meta.label}</span>
        </div>
        <div className={styles.detailPanelMetaRow}>
          <span>Identity</span><span>{node.identity}</span>
        </div>
        <div className={styles.detailPanelMetaRow}>
          <span>Pod 수</span><span>{node.podCount}</span>
        </div>
      </div>

      {/* 메트릭 */}
      <div className={styles.detailPanelSection}>
        <h4 className={styles.detailPanelSectionTitle}>메트릭</h4>
        <div className={styles.detailMetricGrid}>
          <div className={styles.detailMetricItem}>
            <span className={styles.detailMetricValue}>{node.metrics.totalFlows.toLocaleString()}</span>
            <span className={styles.detailMetricLabel}>전체 플로우</span>
          </div>
          <div className={styles.detailMetricItem}>
            <span className={styles.detailMetricValue}>{node.metrics.forwardedFlows.toLocaleString()}</span>
            <span className={styles.detailMetricLabel}>Forwarded</span>
          </div>
          <div className={styles.detailMetricItem}>
            <span className={`${styles.detailMetricValue} ${node.metrics.droppedFlows > 0 ? styles.textRed : ""}`}>
              {node.metrics.droppedFlows.toLocaleString()} ({droppedPct}%)
            </span>
            <span className={styles.detailMetricLabel}>Dropped</span>
          </div>
          {node.metrics.avgLatencyMs !== null && (
            <div className={styles.detailMetricItem}>
              <span className={styles.detailMetricValue}>{node.metrics.avgLatencyMs}ms</span>
              <span className={styles.detailMetricLabel}>평균 레이턴시</span>
            </div>
          )}
          {node.metrics.httpRequestsTotal > 0 && (
            <div className={styles.detailMetricItem}>
              <span className={styles.detailMetricValue}>
                {node.metrics.httpRequestsTotal.toLocaleString()}
                {node.metrics.httpErrorCount > 0 && (
                  <span className={styles.textRed}> ({node.metrics.httpErrorCount} err)</span>
                )}
              </span>
              <span className={styles.detailMetricLabel}>HTTP 요청</span>
            </div>
          )}
          {node.metrics.dnsQueryCount > 0 && (
            <div className={styles.detailMetricItem}>
              <span className={styles.detailMetricValue}>
                {node.metrics.dnsQueryCount}
                {node.metrics.dnsErrorCount > 0 && (
                  <span className={styles.textRed}> ({node.metrics.dnsErrorCount} err)</span>
                )}
              </span>
              <span className={styles.detailMetricLabel}>DNS 쿼리</span>
            </div>
          )}
        </div>
      </div>

      {/* 라벨 */}
      {Object.keys(node.labels).length > 0 && (
        <div className={styles.detailPanelSection}>
          <h4 className={styles.detailPanelSectionTitle}>라벨</h4>
          <div className={styles.detailLabelList}>
            {Object.entries(node.labels).map(([k, v]) => (
              <span key={k} className={styles.detailLabel}>{k}={v}</span>
            ))}
          </div>
        </div>
      )}

      {/* 인바운드 연결 */}
      {inbound.length > 0 && (
        <div className={styles.detailPanelSection}>
          <h4 className={styles.detailPanelSectionTitle}>인바운드 ({inbound.length})</h4>
          <div className={styles.detailConnList}>
            {inbound.map((e) => {
              const peer = nodeMap.get(e.sourceId);
              return (
                <div key={e.id} className={styles.detailConnItem}>
                  <span className={`${styles.detailConnDir} ${styles.detailConnIn}`}>←</span>
                  <span className={styles.detailConnName}>{peer?.workloadName ?? e.sourceId}</span>
                  <span className={styles.detailConnProto}>{e.protocol} :{e.port}</span>
                  <span className={styles.detailConnFlows}>{e.metrics.flowCount.toLocaleString()}</span>
                  {e.verdict === "DROPPED" && <span className={styles.verdictDropped}>DROP</span>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 아웃바운드 연결 */}
      {outbound.length > 0 && (
        <div className={styles.detailPanelSection}>
          <h4 className={styles.detailPanelSectionTitle}>아웃바운드 ({outbound.length})</h4>
          <div className={styles.detailConnList}>
            {outbound.map((e) => {
              const peer = nodeMap.get(e.destinationId);
              return (
                <div key={e.id} className={styles.detailConnItem}>
                  <span className={`${styles.detailConnDir} ${styles.detailConnOut}`}>→</span>
                  <span className={styles.detailConnName}>{peer?.workloadName ?? e.destinationId}</span>
                  <span className={styles.detailConnProto}>{e.protocol} :{e.port}</span>
                  <span className={styles.detailConnFlows}>{e.metrics.flowCount.toLocaleString()}</span>
                  {e.verdict === "DROPPED" && <span className={styles.verdictDropped}>DROP</span>}
                  {e.l7Summary?.httpMethods && (
                    <span className={styles.detailConnL7}>{e.l7Summary.httpMethods.join(", ")}</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main Component ──

export function ServiceMapTab({ clusterId }: Props) {
  const getApiToken = useApiToken();

  const [mapData, setMapData] = useState<HubbleServiceMapResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);

  // 필터 상태
  const [nsFilter, setNsFilter] = useState<string>("");
  const [timeWindow, setTimeWindow] = useState(5);
  const [verdictFilter, setVerdictFilter] = useState<string>("");
  const [searchTerm, setSearchTerm] = useState("");

  // 선택된 노드
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const fetchMap = useCallback(async () => {
    if (!clusterId) return;
    setLoading(true);
    setError(null);
    try {
      const token = await getApiToken();
      const params = new URLSearchParams({
        clusterId,
        timeWindow: String(timeWindow),
      });
      if (nsFilter) params.set("namespace", nsFilter);
      const data = await fetchJsonWithBearer<HubbleServiceMapResponse>(
        `${apiBaseUrl()}/api/hubble/service-map?${params}`,
        token,
      );
      setMapData(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [clusterId, getApiToken, timeWindow, nsFilter]);

  useEffect(() => {
    fetchMap();
    const iv = setInterval(fetchMap, 30_000);
    return () => clearInterval(iv);
  }, [fetchMap]);

  // 필터링된 노드/엣지 계산 + d3-force 레이아웃
  useEffect(() => {
    if (!mapData) return;

    let filteredNodes = mapData.nodes;
    let filteredEdges = mapData.edges;

    // verdict 필터
    if (verdictFilter) {
      filteredEdges = filteredEdges.filter((e) => e.verdict === verdictFilter);
      const activeNodeIds = new Set(filteredEdges.flatMap((e) => [e.sourceId, e.destinationId]));
      filteredNodes = filteredNodes.filter((n) => activeNodeIds.has(n.id));
    }

    // 검색 필터
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      filteredNodes = filteredNodes.filter(
        (n) => n.workloadName.toLowerCase().includes(term) || n.namespace.toLowerCase().includes(term),
      );
      const activeNodeIds = new Set(filteredNodes.map((n) => n.id));
      filteredEdges = filteredEdges.filter(
        (e) => activeNodeIds.has(e.sourceId) && activeNodeIds.has(e.destinationId),
      );
    }

    const layout = computeForceLayout(filteredNodes, filteredEdges, selectedNodeId);
    setNodes(layout.nodes);
    setEdges(layout.edges);
  }, [mapData, verdictFilter, searchTerm, selectedNodeId, setNodes, setEdges]);

  // 노드 클릭
  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedNodeId((prev) => (prev === node.id ? null : node.id));
  }, []);

  // 선택된 노드 데이터
  const selectedNode = useMemo(
    () => mapData?.nodes.find((n) => n.id === selectedNodeId) ?? null,
    [mapData, selectedNodeId],
  );

  if (loading && !mapData) {
    return (
      <div className={styles.loadingRow}>
        <span className={styles.spinner} />
        <span>서비스 맵 로딩 중...</span>
      </div>
    );
  }

  if (error) {
    return <div className={styles.errorMsg}>Service Map 오류: {error}</div>;
  }

  return (
    <div>
      {/* Toolbar */}
      <div className={styles.mapToolbar}>
        <select
          className={styles.mapToolbarSelect}
          value={nsFilter}
          onChange={(e) => setNsFilter(e.target.value)}
        >
          <option value="">전체 네임스페이스</option>
          {mapData?.namespaces.map((ns) => (
            <option key={ns} value={ns}>{ns}</option>
          ))}
        </select>

        <select
          className={styles.mapToolbarSelect}
          value={verdictFilter}
          onChange={(e) => setVerdictFilter(e.target.value)}
        >
          <option value="">전체 Verdict</option>
          <option value="FORWARDED">Forwarded</option>
          <option value="DROPPED">Dropped</option>
          <option value="AUDIT">Audit</option>
        </select>

        <select
          className={styles.mapToolbarSelect}
          value={timeWindow}
          onChange={(e) => setTimeWindow(Number(e.target.value))}
        >
          <option value={1}>1분</option>
          <option value={5}>5분</option>
          <option value={15}>15분</option>
          <option value={30}>30분</option>
          <option value={60}>60분</option>
        </select>

        <input
          type="text"
          className={styles.mapToolbarSearch}
          placeholder="서비스 검색..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
        />

        <button className={styles.mapToolbarRefresh} onClick={fetchMap} disabled={loading}>
          {loading ? "⟳" : "↻"} 새로고침
        </button>

        <span className={styles.mapToolbarStats}>
          {mapData ? `${mapData.nodes.length} 서비스 · ${mapData.edges.length} 연결 · ${mapData.totalFlowsAnalyzed.toLocaleString()} 플로우` : ""}
        </span>
      </div>

      {/* Summary Cards */}
      {mapData && (
        <div className={styles.summaryCards}>
          <div className={styles.summaryCard}>
            <div className={styles.summaryCardLabel}>서비스</div>
            <div className={styles.summaryCardValue}>{mapData.nodes.length}</div>
            <div className={styles.summaryCardSub}>
              {mapData.namespaces.length} ns
            </div>
          </div>
          <div className={styles.summaryCard}>
            <div className={styles.summaryCardLabel}>연결</div>
            <div className={styles.summaryCardValue}>{mapData.edges.length}</div>
            <div className={styles.summaryCardSub}>
              {mapData.edges.filter((e) => e.bidirectional).length} 양방향
            </div>
          </div>
          <div className={styles.summaryCard}>
            <div className={styles.summaryCardLabel}>분석된 플로우</div>
            <div className={styles.summaryCardValue}>{mapData.totalFlowsAnalyzed.toLocaleString()}</div>
            <div className={styles.summaryCardSub}>{timeWindow}분 윈도우</div>
          </div>
          <div className={styles.summaryCard}>
            <div className={styles.summaryCardLabel}>Dropped</div>
            <div className={`${styles.summaryCardValue} ${
              mapData.edges.some((e) => e.verdict === "DROPPED") ? styles.textRed : ""
            }`}>
              {mapData.edges.reduce((s, e) => s + e.metrics.droppedCount, 0).toLocaleString()}
            </div>
          </div>
          <div className={styles.summaryCard}>
            <div className={styles.summaryCardLabel}>외부 트래픽</div>
            <div className={styles.summaryCardValue}>
              {mapData.nodes.filter((n) => n.serviceType === "world").length}
            </div>
          </div>
        </div>
      )}

      {/* Map + Detail Panel Layout */}
      <div className={styles.mapLayout}>
        {/* ReactFlow Canvas */}
        <div className={`${styles.mapContainer} ${selectedNode ? styles.mapContainerWithPanel : ""}`}>
          {nodes.length === 0 ? (
            <div className={styles.noDataBanner} style={{ marginTop: 80 }}>
              <strong>서비스 맵 데이터 없음</strong>
              Hubble 플로우 데이터가 아직 수집되지 않았습니다.
            </div>
          ) : (
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onNodeClick={onNodeClick}
              nodeTypes={nodeTypes}
              fitView
              fitViewOptions={{ padding: 0.3 }}
              minZoom={0.1}
              maxZoom={3}
              proOptions={{ hideAttribution: true }}
            >
              <Background gap={20} size={1} color="rgba(20,21,23,0.04)" />
              <Controls showInteractive={false} />
              <MiniMap
                nodeColor={(n) => {
                  const d = n.data as ServiceNodeData;
                  if (d.healthStatus === "crit") return "rgba(196,43,28,0.6)";
                  if (d.healthStatus === "warn") return "rgba(209,132,0,0.6)";
                  if (d.serviceType === "world") return "rgba(107,76,154,0.5)";
                  if (d.serviceType === "dns") return "rgba(0,150,136,0.5)";
                  return "rgba(16,137,62,0.4)";
                }}
                maskColor="rgba(248,249,250,0.8)"
                style={{ borderRadius: 6 }}
              />
            </ReactFlow>
          )}
        </div>

        {/* Detail Panel */}
        {selectedNode && mapData && (
          <NodeDetailPanel
            node={selectedNode}
            edges={mapData.edges}
            allNodes={mapData.nodes}
            onClose={() => setSelectedNodeId(null)}
          />
        )}
      </div>

      {/* Legend */}
      <div className={styles.mapLegend}>
        <span className={styles.mapLegendTitle}>범례</span>
        <span className={styles.mapLegendItem}>
          <span className={styles.mapLegendLine} style={{ background: "rgba(16,137,62,0.5)" }} /> OK
        </span>
        <span className={styles.mapLegendItem}>
          <span className={styles.mapLegendLine} style={{ background: "rgba(209,132,0,0.6)" }} /> 경고
        </span>
        <span className={styles.mapLegendItem}>
          <span className={styles.mapLegendLine} style={{ background: "rgba(196,43,28,0.6)" }} /> 위험
        </span>
        <span className={styles.mapLegendSep}>|</span>
        <span className={styles.mapLegendItem}>
          <span className={styles.mapLegendLine} style={{ background: "rgba(0,120,212,0.35)", height: 2 }} /> 정상 플로우
        </span>
        <span className={styles.mapLegendItem}>
          <span className={styles.mapLegendLine} style={{ background: "rgba(196,43,28,0.6)", borderStyle: "dashed" }} /> Dropped
        </span>
        <span className={styles.mapLegendItem}>↔ 양방향</span>
        <span className={styles.mapLegendSep}>|</span>
        {Object.entries(SERVICE_TYPE_META).slice(0, 4).map(([key, meta]) => (
          <span key={key} className={styles.mapLegendItem}>{meta.icon} {meta.label}</span>
        ))}
      </div>
    </div>
  );
}
