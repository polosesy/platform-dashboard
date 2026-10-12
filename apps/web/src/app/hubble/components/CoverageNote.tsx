"use client";

import type { HubbleCoverage } from "@aud/types";
import styles from "../styles.module.css";

type Props = {
  coverage: HubbleCoverage | undefined;
  /** Time window the user picked, if the view has one */
  requestedMinutes?: number;
};

function spanMinutes(oldest: string | null, newest: string | null): number | null {
  if (!oldest || !newest) return null;
  return Math.round(((Date.parse(newest) - Date.parse(oldest)) / 60_000) * 10) / 10;
}

const SOURCE_LABEL: Record<HubbleCoverage["source"], string> = {
  agents: "노드별 cilium agent",
  relay: "hubble-relay",
  "api-proxy": "API proxy",
};

/**
 * Which nodes and how much time the Hubble data behind a view covers. Each node
 * keeps only a few thousand recent flows, so on busy clusters the real window is
 * often shorter than the one selected.
 */
export function CoverageNote({ coverage, requestedMinutes }: Props) {
  if (!coverage) return null;

  const missingNodes = coverage.nodesTotal > 0 && coverage.nodesObserved < coverage.nodesTotal;
  const spans = coverage.nodes
    .map((n) => spanMinutes(n.oldest, n.newest))
    .filter((m): m is number => m !== null);
  const spanText = spans.length > 1 ? ` (노드별 ${Math.min(...spans)}–${Math.max(...spans)}분)` : "";
  const shortWindow =
    requestedMinutes !== undefined &&
    coverage.nodes.some((n) => n.bufferFull) &&
    coverage.commonWindowMinutes < requestedMinutes - 0.1;
  const failed = coverage.nodes.filter((n) => n.error);

  const detail = [
    `수집: ${SOURCE_LABEL[coverage.source]}`,
    ...coverage.nodes.map(
      (n) =>
        `${n.nodeName}: ${n.error ? `실패 — ${n.error}` : `${n.events.toLocaleString()}건, ${spanMinutes(n.oldest, n.newest) ?? 0}분${n.bufferFull ? " (버퍼 가득 참)" : ""}`}`,
    ),
  ].join("\n");

  return (
    <div className={`${styles.coverageNote} ${missingNodes || shortWindow ? styles.coverageWarn : ""}`} title={detail}>
      <span className={styles.coverageItem}>
        노드 <strong>{coverage.nodesObserved}</strong>
        {coverage.nodesTotal > 0 && <>/{coverage.nodesTotal}</>}
      </span>
      <span className={styles.coverageItem}>
        공통 관측 <strong>{coverage.commonWindowMinutes}분</strong>
        {spanText}
      </span>
      {coverage.duplicatesRemoved > 0 && (
        <span className={styles.coverageItem}>
          중복 관측 {coverage.duplicatesRemoved.toLocaleString()}건 제거
        </span>
      )}
      {shortWindow && (
        <span className={styles.coverageHint}>
          선택한 {requestedMinutes}분 중 모든 노드가 보관한 구간은 {coverage.commonWindowMinutes}분입니다 — Hubble 노드 버퍼가 가득 차
          오래된 플로우는 남아 있지 않습니다.
        </span>
      )}
      {failed.length > 0 && (
        <span className={styles.coverageHint}>
          응답 없는 노드: {failed.map((n) => n.nodeName).join(", ")}
        </span>
      )}
    </div>
  );
}
