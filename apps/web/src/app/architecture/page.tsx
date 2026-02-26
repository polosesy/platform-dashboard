"use client";

import "reactflow/dist/style.css";

import { useMemo } from "react";
import { apiBaseUrl } from "@/lib/api";
import { useArchitectureGraph } from "./hooks/useArchitectureGraph";
import { useFlowOverlay } from "./hooks/useFlowOverlay";
import { useReservations } from "./hooks/useReservations";
import { GraphCanvas } from "./components/GraphCanvas";
import { Inspector } from "./components/Inspector";
import styles from "./styles.module.css";

export default function ArchitecturePage() {
  const {
    selected,
    setSelected,
    graph,
    error,
    subscriptions,
    subscriptionId,
    setSubscriptionId,
    nodes,
    edges,
    onNodesChange,
    onEdgesChange,
  } = useArchitectureGraph();

  const flow = useFlowOverlay(subscriptionId);
  const reservations = useReservations(subscriptionId);

  const edgesForRender = useMemo(() => {
    if (!flow.flowEnabled) return edges;
    return [...edges, ...flow.flowEdges];
  }, [edges, flow.flowEdges, flow.flowEnabled]);

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <div className={styles.title}>Architecture Map</div>
          <div className={styles.subTitle}>
            {graph ? `Generated: ${new Date(graph.generatedAt).toLocaleString()}` : "Loading..."}
          </div>
        </div>
        <div className={styles.headerRight}>
          <div className={styles.meta}>
            <span className={styles.metaKey}>API</span>
            <span className={styles.metaValue}>{apiBaseUrl()}</span>
          </div>

          <div className={styles.controls}>
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
                  {s.name ? `${s.name} (${s.subscriptionId})` : s.subscriptionId}
                </option>
              ))}
            </select>

            <label className={styles.toggle}>
              <input type="checkbox" checked={flow.flowEnabled} onChange={(e) => flow.setFlowEnabled(e.target.checked)} />
              <span className={styles.toggleText}>Flow overlay</span>
            </label>

            <select
              className={styles.select}
              value={flow.flowStage}
              onChange={(e) => flow.setFlowStage(Number(e.target.value) === 2 ? 2 : 1)}
              disabled={!flow.flowEnabled}
              aria-label="Flow overlay stage"
            >
              <option value={1}>Step 1 · Overlay</option>
              <option value={2}>Step 2 · Playback</option>
            </select>

            <select
              className={styles.select}
              value={flow.flowLookbackMinutes}
              onChange={(e) => flow.setFlowLookbackMinutes(Number(e.target.value))}
              disabled={!flow.flowEnabled}
            >
              {[15, 60, 360, 1440].map((m) => (
                <option key={m} value={m}>
                  {m >= 60 ? (m === 60 ? "1h" : m === 360 ? "6h" : "24h") : `${m}m`}
                </option>
              ))}
            </select>

            <select
              className={styles.select}
              value={flow.flowTop}
              onChange={(e) => flow.setFlowTop(Number(e.target.value))}
              disabled={!flow.flowEnabled}
            >
              {[10, 20, 30, 50].map((n) => (
                <option key={n} value={n}>
                  top {n}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {error ? <div className={styles.error}>Failed to load: {error}</div> : null}

      <div className={styles.canvas}>
        <GraphCanvas
          nodes={nodes}
          edges={edgesForRender}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={setSelected}
        />

        <Inspector
          selected={selected}
          flowEnabled={flow.flowEnabled}
          flowStage={flow.flowStage}
          flowOverlay={flow.flowOverlay}
          overlayTopList={flow.overlayTopList}
          playbackList={flow.playbackList}
          playbackIndex={flow.playbackIndex}
          riGrain={reservations.riGrain}
          setRiGrain={reservations.setRiGrain}
          ri={reservations.ri}
        />
      </div>
    </div>
  );
}
