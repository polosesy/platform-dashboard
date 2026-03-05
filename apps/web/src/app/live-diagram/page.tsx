"use client";

import "reactflow/dist/style.css";

import { useState, useEffect, useCallback, useMemo, lazy, Suspense } from "react";
import type { LiveAlert, VisualizationMode, AzureSubscriptionOption, AzureSubscriptionsResponse, AzureTenantOption, AzureTenantsResponse, DiagramSpec, LiveDiagramSnapshot, EdgeNetworkDetail } from "@aud/types";
import { apiBaseUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiToken } from "@/lib/useApiToken";
import { useI18n } from "@/lib/i18n";
import { useDiagramSpec } from "./hooks/useDiagramSpec";
import { useLiveSnapshot } from "./hooks/useLiveSnapshot";
import { LiveCanvas } from "./components/LiveCanvas";
import { AlertSidebar } from "./components/AlertSidebar";
import { FaultTimeline } from "./components/FaultTimeline";
import { ResourceDetailPanel } from "./components/ResourceDetailPanel";
import { EdgeDetailPanel } from "./components/EdgeDetailPanel";
import styles from "./styles.module.css";

const Canvas3D = lazy(() =>
  import("./components/three/Canvas3D").then((m) => ({ default: m.Canvas3D })),
);

type UpdateMode = "polling" | "sse";

function buildConnectedEdges(
  spec: DiagramSpec,
  snapshot: LiveDiagramSnapshot | null,
  nodeId: string,
) {
  const result: Array<{
    edgeSpec: DiagramSpec["edges"][number];
    liveEdge?: LiveDiagramSnapshot["edges"][number];
    peerLabel: string;
    direction: "inbound" | "outbound";
  }> = [];

  for (const edge of spec.edges) {
    if (edge.source !== nodeId && edge.target !== nodeId) continue;
    const isOutbound = edge.source === nodeId;
    const peerId = isOutbound ? edge.target : edge.source;
    const peerNode = spec.nodes.find((n) => n.id === peerId);
    const liveEdge = snapshot?.edges.find((e) => e.id === edge.id);
    result.push({
      edgeSpec: edge,
      liveEdge,
      peerLabel: peerNode?.label ?? peerId,
      direction: isOutbound ? "outbound" : "inbound",
    });
  }

  return result;
}

export default function LiveDiagramPage() {
  const { t } = useI18n();
  const getApiToken = useApiToken();
  const [diagramId, setDiagramId] = useState("prod-infra");
  const [mode, setMode] = useState<UpdateMode>("polling");
  const [vizMode, setVizMode] = useState<VisualizationMode>("2d-animated");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [edgeDetail, setEdgeDetail] = useState<EdgeNetworkDetail | null>(null);
  const [edgeDetailLoading, setEdgeDetailLoading] = useState(false);

  const handleNodeSelect = useCallback((nodeId: string | null) => {
    setSelectedNodeId(nodeId);
    if (nodeId) setSelectedEdgeId(null);
  }, []);

  const handleEdgeSelect = useCallback((edgeId: string | null) => {
    setSelectedEdgeId(edgeId);
    if (edgeId) setSelectedNodeId(null);
  }, []);

  // Overlay toggles
  const [showNetworkFlow, setShowNetworkFlow] = useState(true);
  const [showParticles, setShowParticles] = useState(true);
  const [showFaultRipple, setShowFaultRipple] = useState(true);
  const [showHeatmap, setShowHeatmap] = useState(false);
  const [showTimeline, setShowTimeline] = useState(false);

  // Tenant & Subscription context
  const [tenants, setTenants] = useState<AzureTenantOption[]>([]);
  const [tenantId, setTenantId] = useState("");
  const [subscriptions, setSubscriptions] = useState<AzureSubscriptionOption[]>([]);
  const [subscriptionId, setSubscriptionId] = useState("");
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);

  // VNet / Region filter state
  const [selectedVnet, setSelectedVnet] = useState<string>("");     // "" = 전체
  const [selectedRegion, setSelectedRegion] = useState<string>(""); // "" = 전체

  // Fetch tenants on mount
  useEffect(() => {
    let cancelled = false;
    getApiToken()
      .catch(() => null)
      .then((token) =>
        fetchJsonWithBearer<AzureTenantsResponse>(
          `${apiBaseUrl()}/api/azure/tenants`,
          token,
        ),
      )
      .then((resp) => {
        if (cancelled) return;
        const list = resp.tenants ?? [];
        setTenants(list);
        setTenantId((prev) => prev || list[0]?.tenantId || "");
      })
      .catch(() => {
        if (cancelled) return;
        setTenants([]);
      });
    return () => { cancelled = true; };
  }, [getApiToken]);

  // Fetch subscriptions (re-fetch when tenantId changes)
  useEffect(() => {
    let cancelled = false;
    getApiToken()
      .catch(() => null)
      .then((token) =>
        fetchJsonWithBearer<AzureSubscriptionsResponse>(
          `${apiBaseUrl()}/api/azure/subscriptions`,
          token,
        ),
      )
      .then((resp) => {
        if (cancelled) return;
        const subs = resp.subscriptions ?? [];
        setSubscriptions(subs);
        setSubscriptionId((prev) => prev || subs[0]?.subscriptionId || "");
      })
      .catch(() => {
        if (cancelled) return;
        setSubscriptions([]);
      });
    return () => { cancelled = true; };
  }, [getApiToken, tenantId]);

  const handleGenerate = useCallback(async () => {
    setGenerating(true);
    setGenerateError(null);
    try {
      const token = await getApiToken().catch(() => null);
      const resp = await fetchJsonWithBearer<{
        ok: boolean;
        diagram: DiagramSpec;
        _diagnostics?: {
          graphNodes: number;
          graphEdges: number;
          specNodes: number;
          specEdges: number;
          nodesWithParent: number;
          groupNodes: number;
        };
        _containment?: {
          subnetParentCount: number;
          resourceSubnetCount: number;
          pass1: number;
          pass1b: number;
          pass2Nic: number;
          pass2Other: number;
          pass3: number;
          pass4: number;
          pass5: number;
          sampleChains: string[];
          edgeKindCounts: Record<string, number>;
          graphNodeCounts?: { vnet: number; subnet: number; nic: number; total: number };
        };
        _source?: string;
        _verification?: {
          counts: { vnetCount: number; subnetCount: number; nicCount: number; vmCount: number };
          subnetSamples: Array<{ id: string; parentId: string | null; label: string }>;
          nicSamples: Array<{ id: string; parentId: string | null; label: string }>;
        };
      }>(
        `${apiBaseUrl()}/api/live/diagrams/generate`,
        token,
        {
          method: "POST",
          body: JSON.stringify(subscriptionId ? { subscriptionId } : {}),
        },
      );
      if (resp.ok && resp.diagram?.id) {
        // Log diagnostics for debugging containment
        console.log(`[Generate] Source: ${resp._source ?? "unknown"}`);
        if (resp._diagnostics) {
          console.log("[Generate] Diagnostics:", resp._diagnostics);
        }
        if (resp._containment) {
          const c = resp._containment;
          console.log("[Generate] Containment:", c);
          if (c.graphNodeCounts) {
            console.log(`[Generate] Graph nodes: ${c.graphNodeCounts.total} total, VNet=${c.graphNodeCounts.vnet}, Subnet=${c.graphNodeCounts.subnet}, NIC=${c.graphNodeCounts.nic}`);
          }
          console.log(`[Generate] Containment passes: P1=${c.pass1} P1b=${c.pass1b} P2nic=${c.pass2Nic} P2other=${c.pass2Other} P3=${c.pass3} P4=${c.pass4} P5=${c.pass5}`);
          console.log(`[Generate] Result: ${c.subnetParentCount} subnet→vnet, ${c.resourceSubnetCount} resource→subnet`);
          console.log("[Generate] Edge kinds:", c.edgeKindCounts);
          for (const chain of c.sampleChains) {
            console.log(`[Generate]   ${chain}`);
          }
        }
        // Verification logs (requirement #4)
        if (resp._verification) {
          const v = resp._verification;
          console.log(`[Generate] Verification counts: VNet=${v.counts.vnetCount}, Subnet=${v.counts.subnetCount}, NIC=${v.counts.nicCount}, VM=${v.counts.vmCount}`);
          console.log("[Generate] Subnet samples:", v.subnetSamples);
          console.log("[Generate] NIC samples:", v.nicSamples);
        }
        // Log parentId distribution from returned spec
        const groups = resp.diagram.nodes.filter((n) => n.nodeType === "group");
        const withParent = resp.diagram.nodes.filter((n) => n.parentId);
        console.log(`[Generate] Spec: ${resp.diagram.nodes.length} nodes, ${groups.length} groups, ${withParent.length} with parentId`);
        for (const g of groups) {
          const children = resp.diagram.nodes.filter((n) => n.parentId === g.id);
          console.log(`[Generate]   Group "${g.id}" (${g.label}): ${children.length} children`);
        }
        setDiagramId(resp.diagram.id);
      }
    } catch (e: unknown) {
      setGenerateError(e instanceof Error ? e.message : "Generation failed");
    } finally {
      setGenerating(false);
    }
  }, [getApiToken, subscriptionId]);

  const { spec, error: specError, loading: specLoading } = useDiagramSpec(diagramId);
  const { snapshot, error: snapError, connected, refresh } = useLiveSnapshot(diagramId, mode);

  // ── VNet / Region option extraction ──
  const vnetOptions = useMemo(() => {
    if (!spec) return [];
    return spec.nodes
      .filter((n) => n.nodeType === "group" && n.icon === "vnet")
      .map((n) => ({ id: n.id, label: n.label }));
  }, [spec]);

  const regionOptions = useMemo(() => {
    if (!spec) return [];
    return [...new Set(spec.nodes.map((n) => n.location).filter(Boolean))] as string[];
  }, [spec]);

  // ── Filtered spec (VNet + Region) ──
  const filteredSpec = useMemo(() => {
    if (!spec) return spec;
    if (!selectedVnet && !selectedRegion) return spec;

    // Build set of visible node IDs
    let visibleNodeIds: Set<string>;

    if (selectedVnet) {
      // Include the VNet group itself + all children (parentId chain)
      visibleNodeIds = new Set<string>();
      visibleNodeIds.add(selectedVnet);

      // BFS: find all descendants via parentId
      const queue = [selectedVnet];
      while (queue.length > 0) {
        const parentId = queue.shift()!;
        for (const n of spec.nodes) {
          if (n.parentId === parentId && !visibleNodeIds.has(n.id)) {
            visibleNodeIds.add(n.id);
            queue.push(n.id);
          }
        }
      }

      // Also include external resources connected via edges from visible nodes
      for (const edge of spec.edges) {
        if (visibleNodeIds.has(edge.source) && !visibleNodeIds.has(edge.target)) {
          visibleNodeIds.add(edge.target);
        }
        if (visibleNodeIds.has(edge.target) && !visibleNodeIds.has(edge.source)) {
          visibleNodeIds.add(edge.source);
        }
      }
    } else {
      visibleNodeIds = new Set(spec.nodes.map((n) => n.id));
    }

    // Region filter: further restrict
    if (selectedRegion) {
      const regionNodeIds = new Set(
        spec.nodes.filter((n) => n.location === selectedRegion).map((n) => n.id),
      );
      // Walk parent chain upward for each matching node (subnet → VNet)
      for (const n of spec.nodes) {
        if (regionNodeIds.has(n.id)) {
          let cur = n;
          while (cur.parentId) {
            regionNodeIds.add(cur.parentId);
            const parent = spec.nodes.find((p) => p.id === cur.parentId);
            if (!parent) break;
            cur = parent;
          }
        }
      }
      // Also include child groups that contain region-matching nodes
      // (e.g., subnets that contain matching resources)
      for (const n of spec.nodes) {
        if (n.nodeType === "group" && !regionNodeIds.has(n.id)) {
          const hasChild = spec.nodes.some((c) => c.parentId === n.id && regionNodeIds.has(c.id));
          if (hasChild) regionNodeIds.add(n.id);
        }
      }
      // Intersect with VNet filter
      visibleNodeIds = new Set([...visibleNodeIds].filter((id) => regionNodeIds.has(id)));
    }

    // Ensure all parent chains are fully included
    // (add missing ancestors so parentId refs don't break)
    for (const n of spec.nodes) {
      if (visibleNodeIds.has(n.id) && n.parentId) {
        let cur = n;
        while (cur.parentId && !visibleNodeIds.has(cur.parentId)) {
          // Only add parent if it's in the original spec
          const parent = spec.nodes.find((p) => p.id === cur.parentId);
          if (!parent) break;
          visibleNodeIds.add(parent.id);
          cur = parent;
        }
      }
    }

    // Build filtered nodes — strip parentId if parent is still not visible
    // (edge-connected external nodes from other VNets)
    const filteredNodes = spec.nodes
      .filter((n) => visibleNodeIds.has(n.id))
      .map((n) => {
        if (n.parentId && !visibleNodeIds.has(n.parentId)) {
          return { ...n, parentId: undefined };
        }
        return n;
      });

    const filteredEdges = spec.edges.filter(
      (e) => visibleNodeIds.has(e.source) && visibleNodeIds.has(e.target),
    );

    return { ...spec, nodes: filteredNodes, edges: filteredEdges };
  }, [spec, selectedVnet, selectedRegion]);

  // Reset selected node when filter changes (node may no longer be visible)
  useEffect(() => {
    if (selectedNodeId && filteredSpec) {
      const stillVisible = filteredSpec.nodes.some((n) => n.id === selectedNodeId);
      if (!stillVisible) setSelectedNodeId(null);
    }
  }, [filteredSpec, selectedNodeId]);

  const handleAlertClick = useCallback((alert: LiveAlert) => {
    const nodeId = alert.affectedNodeIds[0];
    if (nodeId) handleNodeSelect(nodeId);
  }, [handleNodeSelect]);

  const error = specError || snapError;
  const faultCount = snapshot?.faultImpacts?.length ?? 0;
  const alertCount = snapshot?.alerts.length ?? 0;

  // Build connected edges for the selected node's detail panel
  const connectedEdges = useMemo(() => {
    if (!selectedNodeId || !filteredSpec) return [];
    return buildConnectedEdges(filteredSpec, snapshot, selectedNodeId);
  }, [selectedNodeId, filteredSpec, snapshot]);

  // Edge detail fetch + 1-minute auto-refresh
  useEffect(() => {
    if (!selectedEdgeId || !filteredSpec) { setEdgeDetail(null); return; }
    let cancelled = false;

    async function load() {
      setEdgeDetailLoading(true);
      try {
        const token = await getApiToken().catch(() => null);
        const data = await fetchJsonWithBearer<EdgeNetworkDetail>(
          `${apiBaseUrl()}/api/live/edge-detail?diagramId=${diagramId}&edgeId=${encodeURIComponent(selectedEdgeId!)}`,
          token,
        );
        if (!cancelled) setEdgeDetail(data);
      } catch { /* ignore */ }
      finally { if (!cancelled) setEdgeDetailLoading(false); }
    }

    void load();
    const timer = setInterval(() => { void load(); }, 60_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [selectedEdgeId, filteredSpec, diagramId, getApiToken]);

  return (
    <div className={styles.page}>
      {/* Header */}
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <div className={styles.title}>{t("live.title")}</div>
          <div className={styles.subTitle}>
            {spec ? spec.name : specLoading ? t("live.loading") : t("live.noDiagram")}
            {snapshot && ` · ${t("live.updated")} ${new Date(snapshot.generatedAt).toLocaleTimeString()}`}
          </div>
        </div>

        <div className={styles.headerRight}>
          {/* Connection status */}
          <div
            className={styles.statusDot}
            style={{ background: connected ? "rgba(16,137,62,0.75)" : "rgba(216,59,1,0.75)" }}
          />
          <span className={styles.statusLabel}>{connected ? t("live.connected") : t("live.disconnected")}</span>

          {/* Visualization mode selector */}
          <div className={styles.modeGroup}>
            {(["2d", "2d-animated", "3d"] as VisualizationMode[]).map((m) => (
              <button
                key={m}
                type="button"
                className={`${styles.modeBtn} ${vizMode === m ? styles.modeBtnActive : ""}`}
                onClick={() => setVizMode(m)}
              >
                {t(`viz.${m}`)}
              </button>
            ))}
          </div>

          {/* Update mode selector */}
          <select
            className={styles.select}
            value={mode}
            onChange={(e) => setMode(e.target.value as UpdateMode)}
          >
            <option value="polling">{t("live.polling")}</option>
            <option value="sse">{t("live.sse")}</option>
          </select>

          <button className={styles.refreshBtn} onClick={refresh} type="button">
            {t("live.refresh")}
          </button>
        </div>
      </div>

      {/* Tenant & Subscription Selector Bar */}
      <div className={styles.selectorBar}>
        <div className={styles.selectorGroup}>
          <span className={styles.selectorLabel}>{t("live.tenant")}</span>
          <select
            className={styles.select}
            value={tenantId}
            onChange={(e) => setTenantId(e.target.value)}
            disabled={tenants.length === 0}
            aria-label={t("live.tenant")}
          >
            {tenants.length === 0 ? <option value="">{t("live.selectTenant")}</option> : null}
            {tenants.map((tn) => (
              <option key={tn.tenantId} value={tn.tenantId}>
                {tn.displayName ?? tn.tenantId}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.selectorDivider} />
        <div className={styles.selectorGroup}>
          <span className={styles.selectorLabel}>{t("live.subscription")}</span>
          <select
            className={styles.select}
            value={subscriptionId}
            onChange={(e) => setSubscriptionId(e.target.value)}
            disabled={subscriptions.length === 0}
            aria-label={t("live.subscription")}
          >
            {subscriptions.length === 0 ? <option value="">{t("live.subscription")}</option> : null}
            {subscriptions.map((s) => (
              <option key={s.subscriptionId} value={s.subscriptionId}>
                {s.name ?? s.subscriptionId}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.selectorDivider} />
        <button
          className={styles.generateBtn}
          onClick={handleGenerate}
          disabled={generating}
          type="button"
        >
          {generating ? t("live.generating") : t("live.generateFromAzure")}
        </button>
        {spec && (
          <>
            <div className={styles.selectorDivider} />
            <div className={styles.selectorGroup}>
              <span className={styles.selectorLabel}>{t("live.region")}</span>
              <select
                className={styles.select}
                value={selectedRegion}
                onChange={(e) => setSelectedRegion(e.target.value)}
                disabled={regionOptions.length === 0}
                aria-label={t("live.region")}
              >
                <option value="">{t("live.allRegions")}</option>
                {regionOptions.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </div>
            <div className={styles.selectorDivider} />
            <div className={styles.selectorGroup}>
              <span className={styles.selectorLabel}>{t("live.vnet")}</span>
              <select
                className={styles.select}
                value={selectedVnet}
                onChange={(e) => setSelectedVnet(e.target.value)}
                disabled={vnetOptions.length === 0}
                aria-label={t("live.vnet")}
              >
                <option value="">{t("live.allVnets")}</option>
                {vnetOptions.map((v) => (
                  <option key={v.id} value={v.id}>{v.label}</option>
                ))}
              </select>
            </div>
          </>
        )}
      </div>

      {(error || generateError) && (
        <div className={styles.error}>{error || generateError}</div>
      )}

      {/* Overlay controls + Topology stats */}
      <div className={styles.controlBar}>
        <div className={styles.statsBar}>
          {snapshot?.topology && (
            <>
              <div className={styles.stat}>
                {t("live.nodes")} <span className={styles.statVal}>{snapshot.topology.nodeCount}</span>
              </div>
              <div className={styles.stat}>
                {t("live.edges")} <span className={styles.statVal}>{snapshot.topology.edgeCount}</span>
              </div>
              <div className={styles.stat}>
                {t("live.bindings")} <span className={styles.statVal}>{snapshot.topology.resolvedBindings}</span>
              </div>
              <div className={styles.stat}>
                {t("live.alerts")} <span className={styles.statVal}>{alertCount}</span>
              </div>
              {faultCount > 0 && (
                <div className={`${styles.stat} ${styles.statFault}`}>
                  {t("live.faults")} <span className={styles.statVal}>{faultCount}</span>
                </div>
              )}
            </>
          )}
        </div>

        {vizMode !== "3d" && (
          <div className={styles.overlayToggles}>
            <label className={styles.overlayToggle}>
              <input
                type="checkbox"
                checked={showNetworkFlow}
                onChange={(e) => setShowNetworkFlow(e.target.checked)}
              />
              <span>{t("live.networkFlow")}</span>
            </label>
            <label className={styles.overlayToggle}>
              <input
                type="checkbox"
                checked={showParticles}
                onChange={(e) => setShowParticles(e.target.checked)}
              />
              <span>{t("live.particles")}</span>
            </label>
            <label className={styles.overlayToggle}>
              <input
                type="checkbox"
                checked={showFaultRipple}
                onChange={(e) => setShowFaultRipple(e.target.checked)}
              />
              <span>{t("live.faultRipple")}</span>
            </label>
            <label className={styles.overlayToggle}>
              <input
                type="checkbox"
                checked={showHeatmap}
                onChange={(e) => setShowHeatmap(e.target.checked)}
              />
              <span>{t("live.heatmap")}</span>
            </label>
            <label className={styles.overlayToggle}>
              <input
                type="checkbox"
                checked={showTimeline}
                onChange={(e) => setShowTimeline(e.target.checked)}
              />
              <span>{t("live.timeline")}</span>
            </label>
          </div>
        )}
      </div>

      {/* Canvas + Sidebars */}
      {filteredSpec && (
        <div className={styles.canvasGrid}>
          {vizMode === "3d" ? (
            <Suspense
              fallback={
                <div className={styles.canvasWrap}>
                  <div className={styles.loadingCenter}>{t("live.loading3d")}</div>
                </div>
              }
            >
              <Canvas3D
                spec={filteredSpec}
                snapshot={snapshot}
                onNodeSelect={handleNodeSelect}
              />
            </Suspense>
          ) : (
            <LiveCanvas
              spec={filteredSpec}
              snapshot={snapshot}
              onNodeSelect={handleNodeSelect}
              onEdgeSelect={handleEdgeSelect}
              vizMode={vizMode}
              showNetworkFlow={showNetworkFlow}
              showParticles={showParticles}
              showFaultRipple={showFaultRipple}
              showHeatmap={showHeatmap}
            />
          )}

          {/* Right sidebar: edge detail, node detail, alerts, or timeline */}
          <div className={styles.sidebarStack}>
            {selectedEdgeId ? (
              <EdgeDetailPanel
                detail={edgeDetail}
                loading={edgeDetailLoading}
                edgeSpec={filteredSpec.edges.find((e) => e.id === selectedEdgeId) ?? null}
                liveEdge={snapshot?.edges.find((e) => e.id === selectedEdgeId)}
                onClose={() => handleEdgeSelect(null)}
              />
            ) : selectedNodeId ? (
              <ResourceDetailPanel
                nodeSpec={filteredSpec.nodes.find((n) => n.id === selectedNodeId) ?? null}
                liveNode={snapshot?.nodes.find((n) => n.id === selectedNodeId) ?? null}
                alerts={snapshot?.alerts.filter((a) => a.affectedNodeIds.includes(selectedNodeId)) ?? []}
                alertRules={snapshot?.alertRules?.filter((r) => r.affectedNodeIds.includes(selectedNodeId)) ?? []}
                connectedEdges={connectedEdges}
                onClose={() => handleNodeSelect(null)}
              />
            ) : showTimeline && alertCount > 0 ? (
              <FaultTimeline
                alerts={snapshot?.alerts ?? []}
                onAlertClick={handleAlertClick}
              />
            ) : (
              <AlertSidebar
                alerts={snapshot?.alerts ?? []}
                onAlertClick={handleAlertClick}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
