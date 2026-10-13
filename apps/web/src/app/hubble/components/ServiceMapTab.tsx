"use client";

import { useState, useEffect, useCallback, useMemo, memo, useRef } from "react";
import { useI18n } from "@/lib/i18n";
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
  HubbleK8sService,
  HubbleFlow,
  HubbleFlowsResponse,
} from "@aud/types";
import { apiBaseUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiToken } from "@/lib/useApiToken";
import styles from "../styles.module.css";
import { CoverageNote } from "./CoverageNote";

type Props = { clusterId: string };

// ── Service Type 아이콘/라벨 ──

const SERVICE_TYPE_META: Record<HubbleServiceType, { icon: string; label: string; color: string }> = {
  workload:       { icon: "⬡", label: "hb.type.workload",       color: "rgba(0,120,212,0.15)" },
  world:          { icon: "🌐", label: "hb.type.world",       color: "rgba(107,76,154,0.15)" },
  host:           { icon: "🖥", label: "hb.type.host",           color: "rgba(20,21,23,0.08)" },
  health:         { icon: "♡", label: "hb.type.health",         color: "rgba(20,21,23,0.06)" },
  dns:            { icon: "◈", label: "hb.type.dns",            color: "rgba(0,150,136,0.15)" },
  init:           { icon: "◎", label: "hb.type.init",           color: "rgba(20,21,23,0.06)" },
  unmanaged:      { icon: "◇", label: "hb.type.unmanaged",      color: "rgba(209,132,0,0.12)" },
  "kube-apiserver": { icon: "⎈", label: "hb.type.apiserver",  color: "rgba(50,100,200,0.12)" },
  "remote-node":  { icon: "⊞", label: "hb.type.remoteNode",   color: "rgba(20,21,23,0.08)" },
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
  k8sServices?: HubbleK8sService[];
};

const ServiceNode = memo(function ServiceNode({ data }: NodeProps<ServiceNodeData>) {
  const { t } = useI18n();
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
            <span className={styles.svcNodeTypeBadge}>{t(meta.label)}</span>
          )}
        </div>
        <div className={styles.svcNodeName} title={data.workloadName}>{data.workloadName}</div>
        {/* K8s Service 배지 */}
        {data.k8sServices && data.k8sServices.length > 0 && (
          <div className={styles.svcNodeSvcBadges}>
            {data.k8sServices.map((svc) => (
              <span
                key={svc.serviceName}
                className={styles.svcNodeSvcBadge}
                title={`${svc.type} · ${svc.clusterIP} · ${t("hb.endpoints", { n: svc.endpoints.length })}`}
              >
                ◉ {svc.serviceName}
                <span className={styles.svcNodeEpCount}>
                  {svc.endpoints.filter((e) => e.ready).length}/{svc.endpoints.length}
                </span>
              </span>
            ))}
          </div>
        )}
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

// ── Namespace Group Node ──

type NsGroupData = { label: string; nodeCount: number; isExternal: boolean };

const NsGroupNode = memo(function NsGroupNode({ data }: NodeProps<NsGroupData>) {
  return (
    <div className={`${styles.nsGroupNode} ${data.isExternal ? styles.nsGroupExternal : ""}`}>
      <span className={styles.nsGroupLabel}>{data.label}</span>
    </div>
  );
});

const nodeTypes: NodeTypes = { service: ServiceNode, nsGroup: NsGroupNode };

// ── d3-force Layout ──

type ForceNode = SimulationNodeDatum & { id: string; namespace: string };
type ForceLink = SimulationLinkDatum<ForceNode> & { flowCount: number };

function computeForceLayout(
  svcNodes: HubbleServiceNode[],
  svcEdges: HubbleServiceEdge[],
  selectedNodeId: string | null,
  cachedPositions?: Map<string, { x: number; y: number }>,
): { nodes: Node[]; edges: Edge[]; positions: Map<string, { x: number; y: number }> } {
  if (svcNodes.length === 0) return { nodes: [], edges: [], positions: new Map() };

  const NODE_W = 200;
  const NODE_H = 90;
  const COL_ITEMS = 4; // namespace 열 내 최대 노드 행 수

  // workload namespace vs external/특수 노드 분리
  const EXTERNAL_TYPES = new Set<string>(["world", "host", "health", "dns", "init", "unmanaged", "kube-apiserver", "remote-node"]);
  const workloadNs = [...new Set(
    svcNodes.filter((n) => !EXTERNAL_TYPES.has(n.serviceType) && n.namespace).map((n) => n.namespace),
  )].sort();
  const externalNs = [...new Set(
    svcNodes.filter((n) => EXTERNAL_TYPES.has(n.serviceType) || !n.namespace).map((n) => n.namespace || "external"),
  )];
  // namespace 인덱스: workload 먼저, external은 오른쪽 별도 영역
  const nsIndex = new Map<string, number>();
  workloadNs.forEach((ns, i) => nsIndex.set(ns, i));
  const externalStartIdx = workloadNs.length + 1; // gap
  externalNs.forEach((ns, i) => { if (!nsIndex.has(ns)) nsIndex.set(ns, externalStartIdx + i); });
  const nsSet = [...new Set([...workloadNs, ...externalNs])];

  // namespace별 노드 그룹핑 (결정론적 정렬)
  const nodesByNs = new Map<string, HubbleServiceNode[]>();
  for (const n of [...svcNodes].sort((a, b) => a.id.localeCompare(b.id))) {
    const ns = n.namespace || "external";
    if (!nodesByNs.has(ns)) nodesByNs.set(ns, []);
    nodesByNs.get(ns)!.push(n);
  }

  // 결정론적 그리드 초기 위치 계산
  const hasCache = cachedPositions && cachedPositions.size > 0;
  const ZONE_GAP = 500; // workload ↔ external 간격
  const NS_SPREAD = 400; // namespace 간 X 간격
  const ROW_GAP = 130; // 노드 간 Y 간격
  const COL_GAP = 260; // namespace 내 열 간 X 간격

  // namespace별 X 기준 좌표
  const nsBaseX = new Map<string, number>();
  for (const ns of nsSet) {
    const isExternal = !workloadNs.includes(ns);
    const idx = nsIndex.get(ns) ?? 0;
    nsBaseX.set(ns, isExternal
      ? workloadNs.length * NS_SPREAD + ZONE_GAP + (idx - externalStartIdx) * NS_SPREAD
      : idx * NS_SPREAD);
  }

  const forceNodes: ForceNode[] = svcNodes.map((n) => {
    const cached = cachedPositions?.get(n.id);
    if (cached) return { id: n.id, namespace: n.namespace || "external", x: cached.x, y: cached.y };

    const ns = n.namespace || "external";
    const members = nodesByNs.get(ns) ?? [];
    const memberIdx = members.findIndex((m) => m.id === n.id);
    const col = Math.floor(memberIdx / COL_ITEMS);
    const row = memberIdx % COL_ITEMS;
    const baseX = nsBaseX.get(ns) ?? 0;
    return {
      id: n.id,
      namespace: ns,
      x: baseX + col * COL_GAP,
      y: 60 + row * ROW_GAP,
    };
  });

  const nodeIdSet = new Set(svcNodes.map((n) => n.id));
  const forceLinks: ForceLink[] = svcEdges
    .filter((e) => nodeIdSet.has(e.sourceId) && nodeIdSet.has(e.destinationId))
    .map((e) => ({
      source: e.sourceId,
      target: e.destinationId,
      flowCount: e.metrics.flowCount,
    }));

  // 노드별 타겟 X 위치 (namespace 존 분리)
  const nodeTargetX = new Map<string, number>();
  for (const n of svcNodes) {
    const ns = n.namespace || "external";
    nodeTargetX.set(n.id, nsBaseX.get(ns) ?? 0);
  }

  // 노드별 타겟 Y 위치 (그리드 기준)
  const nodeTargetY = new Map<string, number>();
  for (const n of svcNodes) {
    const ns = n.namespace || "external";
    const members = nodesByNs.get(ns) ?? [];
    const memberIdx = members.findIndex((m) => m.id === n.id);
    const row = memberIdx % COL_ITEMS;
    nodeTargetY.set(n.id, 60 + row * ROW_GAP);
  }

  // 시뮬레이션 — 캐시가 있으면 짧게, 없으면 수렴
  const ticks = hasCache ? 30 : 200;
  const simulation = forceSimulation<ForceNode>(forceNodes)
    .force("link", forceLink<ForceNode, ForceLink>(forceLinks)
      .id((d) => d.id)
      .distance(180)
      .strength((link) => Math.min(0.5, 0.15 + Math.log2((link as ForceLink).flowCount + 1) * 0.03)))
    .force("charge", forceManyBody().strength(-300).distanceMax(500))
    .force("collide", forceCollide(NODE_W * 0.75))
    .force("x", forceX<ForceNode>()
      .x((d) => nodeTargetX.get(d.id) ?? 0)
      .strength(0.6))
    .force("y", forceY<ForceNode>()
      .y((d) => nodeTargetY.get(d.id) ?? 300)
      .strength(0.3))
    .stop();

  for (let i = 0; i < ticks; i++) simulation.tick();

  // 위치 맵 (캐시로 반환)
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
        k8sServices: n.k8sServices,
      },
    };
  });

  // Namespace 그룹 노드 — 같은 namespace 노드를 감싸는 배경 박스
  const NS_BOX_PAD = 50;
  const nsGroupNodes: Node<NsGroupData>[] = [];
  for (const ns of nsSet) {
    const members = nodes.filter((n) => (n.data.namespace || "external") === ns);
    if (members.length === 0) continue;
    const xs = members.map((n) => n.position.x);
    const ys = members.map((n) => n.position.y);
    const minX = Math.min(...xs) - NS_BOX_PAD;
    const minY = Math.min(...ys) - NS_BOX_PAD - 20;
    const maxX = Math.max(...xs) + NODE_W + NS_BOX_PAD;
    const maxY = Math.max(...ys) + NODE_H + NS_BOX_PAD;
    const isExternal = !workloadNs.includes(ns);
    nsGroupNodes.push({
      id: `ns-group-${ns}`,
      type: "nsGroup",
      position: { x: minX, y: minY },
      data: { label: isExternal ? `${ns} (external)` : ns, nodeCount: members.length, isExternal },
      style: { width: maxX - minX, height: maxY - minY },
      selectable: false,
      draggable: false,
      zIndex: -1,
    });
  }

  const allNodes = [...nsGroupNodes, ...nodes];

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

  return { nodes: allNodes, edges, positions: posMap };
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
  const { t } = useI18n();
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
        <button className={styles.detailPanelClose} onClick={onClose} aria-label={t("hb.close")}>✕</button>
      </div>

      <div className={styles.detailPanelMeta}>
        <div className={styles.detailPanelMetaRow}>
          <span>{t("hb.namespace")}</span><span>{node.namespace || "—"}</span>
        </div>
        <div className={styles.detailPanelMetaRow}>
          <span>{t("hb.typeLabel")}</span><span>{t(meta.label)}</span>
        </div>
        <div className={styles.detailPanelMetaRow}>
          <span>Identity</span><span>{node.identity}</span>
        </div>
        <div className={styles.detailPanelMetaRow}>
          <span>{t("hb.podCount")}</span><span>{node.podCount}</span>
        </div>
      </div>

      {/* 메트릭 */}
      <div className={styles.detailPanelSection}>
        <h4 className={styles.detailPanelSectionTitle}>{t("hb.metrics")}</h4>
        <div className={styles.detailMetricGrid}>
          <div className={styles.detailMetricItem}>
            <span className={styles.detailMetricValue}>{node.metrics.totalFlows.toLocaleString()}</span>
            <span className={styles.detailMetricLabel}>{t("hb.totalFlows")}</span>
          </div>
          <div className={styles.detailMetricItem}>
            <span className={styles.detailMetricValue}>{node.metrics.forwardedFlows.toLocaleString()}</span>
            <span className={styles.detailMetricLabel}>{t("hb.verdict.FORWARDED")}</span>
          </div>
          <div className={styles.detailMetricItem}>
            <span className={`${styles.detailMetricValue} ${node.metrics.droppedFlows > 0 ? styles.textRed : ""}`}>
              {node.metrics.droppedFlows.toLocaleString()} ({droppedPct}%)
            </span>
            <span className={styles.detailMetricLabel}>{t("hb.verdict.DROPPED")}</span>
          </div>
          {node.metrics.avgLatencyMs !== null && (
            <div className={styles.detailMetricItem}>
              <span className={styles.detailMetricValue}>{node.metrics.avgLatencyMs}ms</span>
              <span className={styles.detailMetricLabel}>{t("hb.avgLatency")}</span>
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
              <span className={styles.detailMetricLabel}>{t("hb.httpRequests")}</span>
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
              <span className={styles.detailMetricLabel}>{t("hb.dnsQueries")}</span>
            </div>
          )}
        </div>
      </div>

      {/* K8s Service */}
      {node.k8sServices && node.k8sServices.length > 0 && (
        <div className={styles.detailPanelSection}>
          <h4 className={styles.detailPanelSectionTitle}>Kubernetes Service ({node.k8sServices.length})</h4>
          {node.k8sServices.map((svc) => (
            <div key={svc.serviceName} className={styles.detailSvcBlock}>
              <div className={styles.detailSvcHeader}>
                <span className={styles.detailSvcName}>◉ {svc.serviceName}</span>
                <span className={styles.detailSvcType}>{svc.type}</span>
              </div>
              <div className={styles.detailPanelMetaRow}>
                <span>ClusterIP</span><span>{svc.clusterIP}</span>
              </div>
              <div className={styles.detailPanelMetaRow}>
                <span>{t("hb.ports")}</span>
                <span>{svc.ports.map((p) => `${p.port}→${p.targetPort}/${p.protocol}`).join(", ")}</span>
              </div>
              <div className={styles.detailPanelMetaRow}>
                <span>{t("hb.selector")}</span>
                <span>{Object.entries(svc.selector).map(([k, v]) => `${k}=${v}`).join(", ")}</span>
              </div>
              {svc.endpoints.length > 0 && (
                <div className={styles.detailEpTable}>
                  <div className={styles.detailEpHeader}>
                    <span>Pod</span><span>IP</span><span>{t("hb.node")}</span><span>{t("hb.status")}</span>
                  </div>
                  {svc.endpoints.map((ep) => (
                    <div key={ep.podName} className={styles.detailEpRow}>
                      <span className={styles.detailEpPod} title={ep.podName}>
                        {ep.podName.replace(/-[a-z0-9]{5,10}-[a-z0-9]{5}$/, "…")}
                      </span>
                      <span className={styles.detailEpIp}>{ep.podIP}</span>
                      <span className={styles.detailEpNode} title={ep.nodeName}>
                        {ep.nodeName.split("/").pop()?.slice(-12) ?? ""}
                      </span>
                      <span className={`${styles.detailEpStatus} ${ep.ready ? styles.dotGreen : styles.dotRed}`}>
                        {ep.ready ? "Ready" : "NotReady"}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* 라벨 */}
      {Object.keys(node.labels).length > 0 && (
        <div className={styles.detailPanelSection}>
          <h4 className={styles.detailPanelSectionTitle}>{t("hb.labels")}</h4>
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
          <h4 className={styles.detailPanelSectionTitle}>{t("hb.inbound", { n: inbound.length })}</h4>
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
          <h4 className={styles.detailPanelSectionTitle}>{t("hb.outbound", { n: outbound.length })}</h4>
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
  const { t, locale } = useI18n();
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

  // 위치 캐시 — 데이터 갱신 시 기존 배치 유지
  const positionCacheRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  // 데이터 fingerprint — 동일 노드 구성이면 레이아웃 재계산 생략
  const dataFingerprintRef = useRef<string>("");

  const fetchMap = useCallback(async () => {
    if (!clusterId) return;
    setLoading(true);
    setError(null);
    try {
      const token = await getApiToken();
      const params = new URLSearchParams({
        clusterId,
        timeWindow: String(timeWindow),
        lang: locale,
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
  }, [clusterId, getApiToken, timeWindow, nsFilter, locale]);

  useEffect(() => {
    fetchMap();
    const iv = setInterval(fetchMap, 30_000);
    return () => clearInterval(iv);
  }, [fetchMap]);

  // 필터 변경 시 캐시 + fingerprint 초기화 (새로운 레이아웃 필요)
  useEffect(() => {
    positionCacheRef.current = new Map();
    dataFingerprintRef.current = "";
  }, [verdictFilter, searchTerm]);

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

    // fingerprint: 노드 ID 집합이 동일하면 위치 재계산 생략 (메트릭만 업데이트)
    const fp = filteredNodes.map((n) => n.id).sort().join("|");
    const skipLayout = fp === dataFingerprintRef.current && positionCacheRef.current.size > 0;
    dataFingerprintRef.current = fp;

    if (skipLayout) {
      // 노드 구성 동일 → 기존 위치 유지, data만 갱신
      const layout = computeForceLayout(filteredNodes, filteredEdges, selectedNodeId, positionCacheRef.current);
      positionCacheRef.current = layout.positions;
      setNodes(layout.nodes);
      setEdges(layout.edges);
    } else {
      const layout = computeForceLayout(filteredNodes, filteredEdges, selectedNodeId, positionCacheRef.current);
      positionCacheRef.current = layout.positions;
      setNodes(layout.nodes);
      setEdges(layout.edges);
    }
  }, [mapData, verdictFilter, searchTerm, setNodes, setEdges]); // selectedNodeId 제거!

  // 선택 변경 시 레이아웃 재계산 없이 data.selected만 업데이트
  useEffect(() => {
    setNodes((prev) =>
      prev.map((n) => ({
        ...n,
        data: { ...n.data, selected: n.id === selectedNodeId },
      })),
    );
  }, [selectedNodeId, setNodes]);

  // 노드 클릭
  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedNodeId((prev) => (prev === node.id ? null : node.id));
  }, []);

  // 선택된 노드 데이터
  const selectedNode = useMemo(
    () => mapData?.nodes.find((n) => n.id === selectedNodeId) ?? null,
    [mapData, selectedNodeId],
  );

  // ── Flow 테이블 데이터 ──
  const [flows, setFlows] = useState<HubbleFlow[]>([]);
  const [flowsLoading, setFlowsLoading] = useState(false);
  const [selectedFlow, setSelectedFlow] = useState<HubbleFlow | null>(null);

  const fetchFlows = useCallback(async () => {
    if (!clusterId) return;
    setFlowsLoading(true);
    try {
      const token = await getApiToken();
      const params = new URLSearchParams({ clusterId, limit: "500", lang: locale });
      if (nsFilter) params.set("namespace", nsFilter);
      if (verdictFilter) params.set("verdict", verdictFilter);
      const data = await fetchJsonWithBearer<HubbleFlowsResponse>(
        `${apiBaseUrl()}/api/hubble/flows?${params}`,
        token,
      );
      // Same rule as the map edges: replies would show server→client with an ephemeral port
      setFlows(data.flows.filter((f) => !f.isReply));
    } catch { /* 무시 — map 오류와 별개 */ }
    finally { setFlowsLoading(false); }
  }, [clusterId, getApiToken, nsFilter, verdictFilter, locale]);

  useEffect(() => {
    fetchFlows();
    const iv = setInterval(fetchFlows, 15_000);
    return () => clearInterval(iv);
  }, [fetchFlows]);

  // 검색 필터된 flows
  const filteredFlows = useMemo(() => {
    if (!searchTerm) return flows;
    const q = searchTerm.toLowerCase();
    return flows.filter(
      (f) =>
        f.source.workloadName.toLowerCase().includes(q) ||
        f.destination.workloadName.toLowerCase().includes(q),
    );
  }, [flows, searchTerm]);

  // 뷰 모드: Visual(맵) / Table
  const [viewMode, setViewMode] = useState<"visual" | "table">("visual");

  // FLOWS 패널 접기/펼치기
  const [flowsExpanded, setFlowsExpanded] = useState(true);

  // 수신 상태 표시
  const isReceiving = loading || flowsLoading;

  if (loading && !mapData) {
    return (
      <div className={styles.loadingRow}>
        <span className={styles.spinner} />
        <span>{t("hb.map.loading")}</span>
      </div>
    );
  }

  if (error) {
    return <div className={styles.errorMsg}>{t("hb.map.error")}: {error}</div>;
  }

  return (
    <div>
      {/* ── Unified Toolbar (Hubble UI 스타일) ── */}
      <div className={styles.mapToolbar}>
        <select
          className={styles.mapToolbarSelect}
          value={nsFilter}
          onChange={(e) => setNsFilter(e.target.value)}
        >
          <option value="">{t("hb.allNamespaces")}</option>
          {mapData?.namespaces.map((ns) => (
            <option key={ns} value={ns}>{ns}</option>
          ))}
        </select>

        <input
          type="text"
          className={styles.mapToolbarSearch}
          placeholder={t("hb.filterPlaceholder")}
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          style={{ minWidth: 300 }}
        />

        <select
          className={styles.mapToolbarSelect}
          value={verdictFilter}
          onChange={(e) => setVerdictFilter(e.target.value)}
        >
          <option value="">{t("hb.anyVerdict")}</option>
          <option value="FORWARDED">{t("hb.verdict.FORWARDED")}</option>
          <option value="DROPPED">{t("hb.verdict.DROPPED")}</option>
          <option value="AUDIT">{t("hb.verdict.AUDIT")}</option>
        </select>

        <select
          className={styles.mapToolbarSelect}
          value={timeWindow}
          onChange={(e) => setTimeWindow(Number(e.target.value))}
        >
          {[1, 5, 15, 30, 60].map((m) => <option key={m} value={m}>{t("hb.minutes", { n: m })}</option>)}
        </select>

        {/* Visual / Table 토글 */}
        <div className={styles.viewToggle}>
          <button
            className={`${styles.viewToggleBtn} ${viewMode === "visual" ? styles.viewToggleActive : ""}`}
            onClick={() => setViewMode("visual")}
          >
            {t("hb.visual")}
          </button>
          <button
            className={`${styles.viewToggleBtn} ${viewMode === "table" ? styles.viewToggleActive : ""}`}
            onClick={() => setViewMode("table")}
          >
            {t("ins.combos.table")}
          </button>
        </div>

        {/* 수신 상태 */}
        <span className={styles.mapToolbarStats}>
          <span className={`${styles.receivingDot} ${isReceiving ? styles.receivingActive : ""}`} />
          {isReceiving ? t("hb.receiving") : t("hb.mapStats", { n: mapData?.nodes.length ?? 0, f: filteredFlows.length })}
        </span>
      </div>

      <CoverageNote coverage={mapData?.coverage} requestedMinutes={mapData?.timeWindowMinutes} />

      {viewMode === "visual" ? (
        <>
          {/* ── Map + Detail Panel ── */}
          <div className={styles.mapLayout}>
            <div className={`${styles.mapContainer} ${selectedNode ? styles.mapContainerWithPanel : ""}`}
              style={{
                height: flowsExpanded ? "calc(50vh - 80px)" : "calc(100vh - 200px)",
                minHeight: 320,
                transition: "height 0.3s ease",
              }}>
              {nodes.length === 0 ? (
                <div className={styles.noDataBanner} style={{ marginTop: 80 }}>
                  <strong>{t("hb.map.noData")}</strong>
                  {t("hb.map.noDataHint")}
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

            {selectedNode && mapData && (
              <NodeDetailPanel
                node={selectedNode}
                edges={mapData.edges}
                allNodes={mapData.nodes}
                onClose={() => setSelectedNodeId(null)}
              />
            )}
          </div>

          {/* ── Flow Table (하단, 접기/펼치기) ── */}
          <div className={styles.visualFlowSection}>
            <button
              className={styles.flowCollapseBtn}
              onClick={() => { setFlowsExpanded((v) => !v); if (flowsExpanded) setSelectedFlow(null); }}
            >
              <span className={`${styles.flowCollapseArrow} ${flowsExpanded ? styles.flowCollapseOpen : ""}`}>
                ▶
              </span>
              <span className={styles.sectionTitle}>{t("hub.view.flows")}</span>
              <span className={styles.toolbarCount}>{filteredFlows.length}</span>
            </button>

            {flowsExpanded && (
              <div className={styles.visualFlowLayout}>
                <div className={`${styles.flowTableContainer} ${selectedFlow ? styles.flowTableWithDetail : ""}`}
                  style={{ maxHeight: "calc(50vh - 120px)" }}>
                  <table className={styles.flowTable}>
                    <thead>
                      <tr>
                        <th>{t("hb.col.source")}</th>
                        <th>{t("hb.col.destination")}</th>
                        <th>{t("hb.col.dstPort")}</th>
                        <th>{t("hb.col.verdict")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredFlows.slice(0, 300).map((f, i) => (
                        <tr
                          key={i}
                          className={`${styles.flowRow} ${f.verdict === "DROPPED" ? styles.flowRowDropped : ""} ${selectedFlow === f ? styles.flowRowSelected : ""}`}
                          onClick={() => setSelectedFlow((prev) => (prev === f ? null : f))}
                        >
                          <td>
                            <span style={{ fontWeight: 600 }}>{f.source.workloadName}</span>{" "}
                            <span className={styles.flowNs}>{f.source.namespace}</span>
                          </td>
                          <td>
                            <span style={{ fontWeight: 600 }}>{f.destination.workloadName}</span>{" "}
                            <span className={styles.flowNs}>{f.destination.namespace}</span>
                          </td>
                          <td className={styles.flowMono}>{f.destinationPort || "—"}</td>
                          <td>
                            <span className={`${styles.verdictBadge} ${
                              f.verdict === "DROPPED" ? styles.verdictDropped
                              : f.verdict === "AUDIT" ? styles.verdictAudit
                              : styles.verdictForwarded
                            }`}>{f.verdict.toLowerCase()}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {filteredFlows.length === 0 && !flowsLoading && (
                    <div className={styles.noDataBanner}>{t("hb.noFlows")}</div>
                  )}
                </div>

                {/* Flow Detail Panel */}
                {selectedFlow && (
                  <FlowDetailPanel flow={selectedFlow} onClose={() => setSelectedFlow(null)} />
                )}
              </div>
            )}
          </div>
        </>
      ) : (
        /* ── Table-only 모드 ── */
        <div className={styles.visualFlowLayout}>
          <div className={`${styles.flowTableContainer} ${selectedFlow ? styles.flowTableWithDetail : ""}`}>
            <table className={styles.flowTable}>
              <thead>
                <tr>
                  <th>{t("hb.col.time")}</th>
                  <th>{t("hb.col.source")}</th>
                  <th>{t("hb.col.destination")}</th>
                  <th>{t("hb.col.dstPort")}</th>
                  <th>{t("hb.col.protocol")}</th>
                  <th>{t("hb.col.verdict")}</th>
                  <th>{t("hb.col.direction")}</th>
                </tr>
              </thead>
              <tbody>
                {filteredFlows.slice(0, 500).map((f, i) => (
                  <tr
                    key={i}
                    className={`${styles.flowRow} ${f.verdict === "DROPPED" ? styles.flowRowDropped : ""} ${selectedFlow === f ? styles.flowRowSelected : ""}`}
                    onClick={() => setSelectedFlow((prev) => (prev === f ? null : f))}
                  >
                    <td className={styles.flowMono}>{formatFlowTime(f.time)}</td>
                    <td>
                      <span style={{ fontWeight: 600 }}>{f.source.workloadName}</span>{" "}
                      <span className={styles.flowNs}>{f.source.namespace}</span>
                    </td>
                    <td>
                      <span style={{ fontWeight: 600 }}>{f.destination.workloadName}</span>{" "}
                      <span className={styles.flowNs}>{f.destination.namespace}</span>
                    </td>
                    <td className={styles.flowMono}>{f.destinationPort || "—"}</td>
                    <td><span className={styles.protocolBadge}>{f.l4Protocol}</span></td>
                    <td>
                      <span className={`${styles.verdictBadge} ${
                        f.verdict === "DROPPED" ? styles.verdictDropped
                        : f.verdict === "AUDIT" ? styles.verdictAudit
                        : styles.verdictForwarded
                      }`}>{f.verdict.toLowerCase()}</span>
                    </td>
                    <td style={{ fontSize: 10, color: "rgba(20,21,23,0.5)" }}>
                      {f.trafficDirection.toLowerCase()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filteredFlows.length === 0 && !flowsLoading && (
              <div className={styles.noDataBanner}>{t("hb.noFlows")}</div>
            )}
          </div>

          {selectedFlow && (
            <FlowDetailPanel flow={selectedFlow} onClose={() => setSelectedFlow(null)} />
          )}
        </div>
      )}
    </div>
  );
}

// ── Helpers ──

function formatFlowTime(iso: string) {
  try {
    return new Date(iso).toLocaleTimeString("ko-KR", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return iso.slice(11, 19);
  }
}

// ── Flow Detail Panel ──

function FlowDetailPanel({ flow, onClose }: { flow: HubbleFlow; onClose: () => void }) {
  const { t } = useI18n();
  return (
    <div className={styles.flowDetailPanel}>
      <div className={styles.detailPanelHeader}>
        <span className={styles.detailPanelTitle}>{t("hb.fd.title")}</span>
        <button className={styles.detailPanelClose} onClick={onClose} aria-label={t("hb.close")}>✕</button>
      </div>

      <div className={styles.flowDetailBody}>
        <FlowDetailRow label={t("hb.fd.time")} value={flow.time} />
        <FlowDetailRow label={t("hb.col.verdict")}>
          <span className={`${styles.verdictBadge} ${
            flow.verdict === "DROPPED" ? styles.verdictDropped
            : flow.verdict === "AUDIT" ? styles.verdictAudit
            : styles.verdictForwarded
          }`}>{flow.verdict.toLowerCase()}</span>
        </FlowDetailRow>
        <FlowDetailRow label={t("hb.fd.direction")} value={flow.trafficDirection.toLowerCase()} />
        <FlowDetailRow label={t("hb.fd.eventType")} value={flow.type} />
        {flow.l4Protocol !== "UNKNOWN" && (
          <FlowDetailRow label={t("hb.col.protocol")} value={flow.l4Protocol} />
        )}
        {flow.l7?.http && (
          <>
            <FlowDetailRow label={t("hb.fd.httpMethod")} value={flow.l7.http.method} />
            <FlowDetailRow label={t("hb.fd.httpStatus")} value={String(flow.l7.http.code)} />
            {flow.l7.http.url && <FlowDetailRow label="URL" value={flow.l7.http.url} />}
          </>
        )}
        {flow.l7?.dns && (
          <FlowDetailRow label={t("hb.fd.dnsQuery")} value={flow.l7.dns.query} />
        )}
        {flow.dropReasonDesc && (
          <FlowDetailRow label={t("hb.fd.dropReason")} value={flow.dropReasonDesc} />
        )}

        <div className={styles.flowDetailDivider} />

        <FlowDetailRow label={t("hb.fd.srcPod")} value={flow.source.podName || "—"} />
        <FlowDetailRow label={t("hb.fd.srcIdentity")} value={String(flow.source.identity)} />
        <FlowDetailRow label={t("hb.fd.srcNs")} value={flow.source.namespace || "—"} />
        {flow.sourcePort > 0 && <FlowDetailRow label={t("hb.fd.srcPort")} value={String(flow.sourcePort)} />}

        <div className={styles.flowDetailDivider} />

        <FlowDetailRow label={t("hb.fd.dstPod")} value={flow.destination.podName || "—"} />
        <FlowDetailRow label={t("hb.fd.dstIdentity")} value={String(flow.destination.identity)} />
        <FlowDetailRow label={t("hb.fd.dstNs")} value={flow.destination.namespace || "—"} />
        {flow.destinationPort > 0 && <FlowDetailRow label={t("hb.fd.dstPort")} value={String(flow.destinationPort)} />}

        {flow.nodeName && (
          <>
            <div className={styles.flowDetailDivider} />
            <FlowDetailRow label={t("hb.node")} value={flow.nodeName} />
          </>
        )}

        {flow.summary && (
          <>
            <div className={styles.flowDetailDivider} />
            <FlowDetailRow label={t("hb.fd.summary")} value={flow.summary} />
          </>
        )}
      </div>
    </div>
  );
}

function FlowDetailRow({
  label,
  value,
  children,
}: {
  label: string;
  value?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className={styles.flowDetailRow}>
      <span className={styles.flowDetailLabel}>{label}</span>
      <span className={styles.flowDetailValue}>{children ?? value}</span>
    </div>
  );
}
