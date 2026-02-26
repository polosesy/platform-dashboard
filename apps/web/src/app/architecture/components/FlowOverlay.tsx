import type { ArchitectureFlowOverlayResponse, ArchitectureFlowEdgeMetric } from "@aud/types";
import type { PlaybackItem } from "../hooks/useFlowOverlay";
import { formatBytes } from "../utils/graphUtils";
import styles from "../styles.module.css";

type FlowOverlayProps = {
  flowEnabled: boolean;
  flowStage: 1 | 2;
  flowOverlay: ArchitectureFlowOverlayResponse | null;
  overlayTopList: ArchitectureFlowEdgeMetric[];
  playbackList: PlaybackItem[];
  playbackIndex: number;
};

export function FlowOverlay({
  flowEnabled,
  flowStage,
  flowOverlay,
  overlayTopList,
  playbackList,
  playbackIndex,
}: FlowOverlayProps) {
  return (
    <div className={styles.section}>
      <div className={styles.sectionTitle}>Network flows</div>
      <div className={styles.row}>
        <div className={styles.key}>Overlay</div>
        <div className={styles.value}>{flowEnabled ? "on" : "off"}</div>
      </div>
      {flowEnabled ? (
        <>
          <div className={styles.row}>
            <div className={styles.key}>Stage</div>
            <div className={styles.value}>{flowStage === 1 ? "Step 1 (overlay)" : "Step 2 (playback)"}</div>
          </div>
          <div className={styles.row}>
            <div className={styles.key}>Window</div>
            <div className={styles.value}>{flowOverlay ? `${flowOverlay.lookbackMinutes}m` : "-"}</div>
          </div>
          {flowStage === 2 && playbackList.length ? (
            <div className={styles.row}>
              <div className={styles.key}>Now</div>
              <div className={styles.value}>
                {(() => {
                  const i = Math.max(0, Math.min(playbackList.length - 1, playbackIndex));
                  const m = playbackList[i]!.metric;
                  const s = m.source.split("/subnets/").at(-1) ?? m.source;
                  const t = m.target.split("/subnets/").at(-1) ?? m.target;
                  return `${s} → ${t}`;
                })()}
              </div>
            </div>
          ) : null}
          <div className={styles.row}>
            <div className={styles.key}>Edges</div>
            <div className={styles.value}>{flowOverlay ? String(flowOverlay.edges.length) : "-"}</div>
          </div>
          {flowOverlay?.unmatchedPairs?.length ? (
            <div className={styles.row}>
              <div className={styles.key}>Unmatched</div>
              <div className={styles.value}>{String(flowOverlay.unmatchedPairs.length)}</div>
            </div>
          ) : null}
          {flowOverlay?.note ? (
            <div className={styles.row}>
              <div className={styles.key}>Note</div>
              <div className={styles.value}>{flowOverlay.note}</div>
            </div>
          ) : null}

          {overlayTopList.length ? (
            <div className={styles.miniTable}>
              {overlayTopList.map((e) => (
                <div key={`${e.source}->${e.target}`} className={styles.miniRow}>
                  <div className={styles.miniPair}>
                    {e.source.split("/subnets/").at(-1) ?? e.source} → {e.target.split("/subnets/").at(-1) ?? e.target}
                  </div>
                  <div className={styles.miniVal}>{formatBytes(e.totalBytes)}</div>
                </div>
              ))}
            </div>
          ) : (
            <div className={styles.inspectorEmpty}>No flow data mapped yet.</div>
          )}
        </>
      ) : (
        <div className={styles.inspectorEmpty}>Enable overlay to visualize subnet flows.</div>
      )}
    </div>
  );
}
