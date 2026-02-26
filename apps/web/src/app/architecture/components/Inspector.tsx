import type { ArchitectureNode, ArchitectureFlowOverlayResponse, ArchitectureFlowEdgeMetric, ReservationUtilizationResponse } from "@aud/types";
import type { PlaybackItem } from "../hooks/useFlowOverlay";
import { FlowOverlay } from "./FlowOverlay";
import { ReservationPanel } from "./ReservationPanel";
import styles from "../styles.module.css";

type InspectorProps = {
  selected: ArchitectureNode | null;
  flowEnabled: boolean;
  flowStage: 1 | 2;
  flowOverlay: ArchitectureFlowOverlayResponse | null;
  overlayTopList: ArchitectureFlowEdgeMetric[];
  playbackList: PlaybackItem[];
  playbackIndex: number;
  riGrain: "daily" | "monthly";
  setRiGrain: (grain: "daily" | "monthly") => void;
  ri: ReservationUtilizationResponse | null;
};

export function Inspector({
  selected,
  flowEnabled,
  flowStage,
  flowOverlay,
  overlayTopList,
  playbackList,
  playbackIndex,
  riGrain,
  setRiGrain,
  ri,
}: InspectorProps) {
  return (
    <aside className={styles.inspector}>
      <div className={styles.inspectorTitle}>Inspector</div>

      {!selected ? (
        <div className={styles.inspectorEmpty}>Select a node to see details.</div>
      ) : (
        <div className={styles.inspectorBody}>
          <div className={styles.row}>
            <div className={styles.key}>Name</div>
            <div className={styles.value}>{selected.name}</div>
          </div>
          <div className={styles.row}>
            <div className={styles.key}>Kind</div>
            <div className={styles.value}>{selected.kind}</div>
          </div>
          <div className={styles.row}>
            <div className={styles.key}>Health</div>
            <div className={styles.value}>{selected.health ?? "unknown"}</div>
          </div>
          {selected.location ? (
            <div className={styles.row}>
              <div className={styles.key}>Location</div>
              <div className={styles.value}>{selected.location}</div>
            </div>
          ) : null}
          {selected.azureId ? (
            <div className={styles.row}>
              <div className={styles.key}>Azure ID</div>
              <div className={styles.valueMono}>{selected.azureId}</div>
            </div>
          ) : null}

          {selected.metrics ? (
            <div className={styles.section}>
              <div className={styles.sectionTitle}>Key metrics</div>
              {Object.entries(selected.metrics).map(([k, v]) => (
                <div key={k} className={styles.row}>
                  <div className={styles.key}>{k}</div>
                  <div className={styles.value}>{v}</div>
                </div>
              ))}
            </div>
          ) : null}

          <FlowOverlay
            flowEnabled={flowEnabled}
            flowStage={flowStage}
            flowOverlay={flowOverlay}
            overlayTopList={overlayTopList}
            playbackList={playbackList}
            playbackIndex={playbackIndex}
          />

          <ReservationPanel riGrain={riGrain} setRiGrain={setRiGrain} ri={ri} />

          {selected.tags ? (
            <div className={styles.section}>
              <div className={styles.sectionTitle}>Tags</div>
              {Object.entries(selected.tags).map(([k, v]) => (
                <div key={k} className={styles.row}>
                  <div className={styles.key}>{k}</div>
                  <div className={styles.value}>{v}</div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      )}
    </aside>
  );
}
