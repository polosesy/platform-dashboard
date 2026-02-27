"use client";

import "reactflow/dist/style.css";

import { useState, useEffect, useCallback, lazy, Suspense } from "react";
import type { LiveAlert, VisualizationMode, AzureSubscriptionOption, AzureSubscriptionsResponse } from "@aud/types";
import { apiBaseUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiToken } from "@/lib/useApiToken";
import { useDiagramSpec } from "./hooks/useDiagramSpec";
import { useLiveSnapshot } from "./hooks/useLiveSnapshot";
import { LiveCanvas } from "./components/LiveCanvas";
import { AlertSidebar } from "./components/AlertSidebar";
import { FaultTimeline } from "./components/FaultTimeline";
import styles from "./styles.module.css";

const Canvas3D = lazy(() =>
  import("./components/three/Canvas3D").then((m) => ({ default: m.Canvas3D })),
);

type UpdateMode = "polling" | "sse";

const VIZ_LABELS: Record<VisualizationMode, string> = {
  "2d": "2D Standard",
  "2d-animated": "2D Animated",
  "3d": "3D Topology",
};

export default function LiveDiagramPage() {
  const getApiToken = useApiToken();
  const [diagramId, setDiagramId] = useState("prod-infra");
  const [mode, setMode] = useState<UpdateMode>("polling");
  const [vizMode, setVizMode] = useState<VisualizationMode>("2d-animated");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  // Overlay toggles
  const [showParticles, setShowParticles] = useState(true);
  const [showFaultRipple, setShowFaultRipple] = useState(true);
  const [showHeatmap, setShowHeatmap] = useState(false);
  const [showTimeline, setShowTimeline] = useState(false);

  // Generate from Azure
  const [subscriptions, setSubscriptions] = useState<AzureSubscriptionOption[]>([]);
  const [subscriptionId, setSubscriptionId] = useState("");
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getApiToken()
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
  }, [getApiToken]);

  const handleGenerate = useCallback(async () => {
    setGenerating(true);
    setGenerateError(null);
    try {
      const token = await getApiToken();
      const resp = await fetchJsonWithBearer<{ ok: boolean; diagram: { id: string } }>(
        `${apiBaseUrl()}/api/live/diagrams/generate`,
        token,
        {
          method: "POST",
          body: JSON.stringify(subscriptionId ? { subscriptionId } : {}),
        },
      );
      if (resp.ok && resp.diagram?.id) {
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

  const handleAlertClick = useCallback((alert: LiveAlert) => {
    const nodeId = alert.affectedNodeIds[0];
    if (nodeId) setSelectedNodeId(nodeId);
  }, []);

  const error = specError || snapError;
  const faultCount = snapshot?.faultImpacts?.length ?? 0;
  const alertCount = snapshot?.alerts.length ?? 0;

  return (
    <div className={styles.page}>
      {/* Header */}
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <div className={styles.title}>Live Architecture</div>
          <div className={styles.subTitle}>
            {spec ? spec.name : specLoading ? "Loading..." : "No diagram"}
            {snapshot && ` · Updated ${new Date(snapshot.generatedAt).toLocaleTimeString()}`}
          </div>
        </div>

        <div className={styles.headerRight}>
          {/* Connection status */}
          <div
            className={styles.statusDot}
            style={{ background: connected ? "rgba(16,137,62,0.75)" : "rgba(216,59,1,0.75)" }}
          />
          <span className={styles.statusLabel}>{connected ? "Live" : "Disconnected"}</span>

          {/* Visualization mode selector */}
          <div className={styles.modeGroup}>
            {(["2d", "2d-animated", "3d"] as VisualizationMode[]).map((m) => (
              <button
                key={m}
                type="button"
                className={`${styles.modeBtn} ${vizMode === m ? styles.modeBtnActive : ""}`}
                onClick={() => setVizMode(m)}
              >
                {VIZ_LABELS[m]}
              </button>
            ))}
          </div>

          {/* Update mode selector */}
          <select
            className={styles.select}
            value={mode}
            onChange={(e) => setMode(e.target.value as UpdateMode)}
          >
            <option value="polling">Polling (30s)</option>
            <option value="sse">SSE Stream</option>
          </select>

          <button className={styles.refreshBtn} onClick={refresh} type="button">
            Refresh
          </button>

          {/* Generate from Azure */}
          <div className={styles.generateGroup}>
            <select
              className={styles.select}
              value={subscriptionId}
              onChange={(e) => setSubscriptionId(e.target.value)}
              disabled={subscriptions.length === 0}
              aria-label="Subscription"
            >
              {subscriptions.length === 0 ? <option value="">Subscription</option> : null}
              {subscriptions.map((s) => (
                <option key={s.subscriptionId} value={s.subscriptionId}>
                  {s.name ? `${s.name}` : s.subscriptionId}
                </option>
              ))}
            </select>
            <button
              className={styles.generateBtn}
              onClick={handleGenerate}
              disabled={generating}
              type="button"
            >
              {generating ? "Generating..." : "Generate from Azure"}
            </button>
          </div>
        </div>
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
                Nodes <span className={styles.statVal}>{snapshot.topology.nodeCount}</span>
              </div>
              <div className={styles.stat}>
                Edges <span className={styles.statVal}>{snapshot.topology.edgeCount}</span>
              </div>
              <div className={styles.stat}>
                Bindings <span className={styles.statVal}>{snapshot.topology.resolvedBindings}</span>
              </div>
              <div className={styles.stat}>
                Alerts <span className={styles.statVal}>{alertCount}</span>
              </div>
              {faultCount > 0 && (
                <div className={`${styles.stat} ${styles.statFault}`}>
                  Faults <span className={styles.statVal}>{faultCount}</span>
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
                checked={showParticles}
                onChange={(e) => setShowParticles(e.target.checked)}
              />
              <span>Particles</span>
            </label>
            <label className={styles.overlayToggle}>
              <input
                type="checkbox"
                checked={showFaultRipple}
                onChange={(e) => setShowFaultRipple(e.target.checked)}
              />
              <span>Fault Ripple</span>
            </label>
            <label className={styles.overlayToggle}>
              <input
                type="checkbox"
                checked={showHeatmap}
                onChange={(e) => setShowHeatmap(e.target.checked)}
              />
              <span>Heatmap</span>
            </label>
            <label className={styles.overlayToggle}>
              <input
                type="checkbox"
                checked={showTimeline}
                onChange={(e) => setShowTimeline(e.target.checked)}
              />
              <span>Timeline</span>
            </label>
          </div>
        )}
      </div>

      {/* Canvas + Sidebars */}
      {spec && (
        <div className={styles.canvasGrid}>
          {vizMode === "3d" ? (
            <Suspense
              fallback={
                <div className={styles.canvasWrap}>
                  <div className={styles.loadingCenter}>Loading 3D...</div>
                </div>
              }
            >
              <Canvas3D
                spec={spec}
                snapshot={snapshot}
                onNodeSelect={setSelectedNodeId}
              />
            </Suspense>
          ) : (
            <LiveCanvas
              spec={spec}
              snapshot={snapshot}
              onNodeSelect={setSelectedNodeId}
              vizMode={vizMode}
              showParticles={showParticles}
              showFaultRipple={showFaultRipple}
              showHeatmap={showHeatmap}
            />
          )}

          {/* Right sidebar: alerts or timeline */}
          <div className={styles.sidebarStack}>
            {showTimeline && alertCount > 0 ? (
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
