"use client";

import type { HubbleCoverage } from "@aud/types";
import { useI18n } from "@/lib/i18n";
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

// i18n keys
const SOURCE_LABEL: Record<HubbleCoverage["source"], string> = {
  agents: "hb.cov.src.agents",
  relay: "hb.cov.src.relay",
  "api-proxy": "hb.cov.src.apiProxy",
  "flow-logs": "hb.cov.src.flowLogs",
};

/**
 * Which nodes and how much time the Hubble data behind a view covers. Each node
 * keeps only a few thousand recent flows, so on busy clusters the real window is
 * often shorter than the one selected.
 */
export function CoverageNote({ coverage, requestedMinutes }: Props) {
  const { t } = useI18n();
  if (!coverage) return null;

  const missingNodes = coverage.nodesTotal > 0 && coverage.nodesObserved < coverage.nodesTotal;
  const spans = coverage.nodes
    .map((n) => spanMinutes(n.oldest, n.newest))
    .filter((m): m is number => m !== null);
  const spanText = spans.length > 1 ? ` ${t("hb.cov.perNode", { min: Math.min(...spans), max: Math.max(...spans) })}` : "";
  const shortWindow =
    requestedMinutes !== undefined &&
    coverage.nodes.some((n) => n.bufferFull) &&
    coverage.commonWindowMinutes < requestedMinutes - 0.1;
  const failed = coverage.nodes.filter((n) => n.error);

  const detail = [
    `${t("hb.cov.source")}: ${t(SOURCE_LABEL[coverage.source])}`,
    ...coverage.nodes.map(
      (n) =>
        `${n.nodeName}: ${n.error ? `${t("hb.cov.failed")} — ${n.error}` : `${t("hb.cov.nodeLine", { n: n.events.toLocaleString(), min: spanMinutes(n.oldest, n.newest) ?? 0 })}${n.bufferFull ? ` ${t("hb.cov.bufferFull")}` : ""}`}`,
    ),
  ].join("\n");

  return (
    <div className={`${styles.coverageNote} ${missingNodes || shortWindow ? styles.coverageWarn : ""}`} title={detail}>
      <span className={styles.coverageItem}>
        {t("hb.node")} <strong>{coverage.nodesObserved}</strong>
        {coverage.nodesTotal > 0 && <>/{coverage.nodesTotal}</>}
      </span>
      <span className={styles.coverageItem}>
        {t("hb.cov.common")} <strong>{t("hb.minutes", { n: coverage.commonWindowMinutes })}</strong>
        {spanText}
      </span>
      {coverage.duplicatesRemoved > 0 && (
        <span className={styles.coverageItem}>
          {t("hb.cov.dupes", { n: coverage.duplicatesRemoved.toLocaleString() })}
        </span>
      )}
      {shortWindow && (
        <span className={styles.coverageHint}>
          {t("hb.cov.short", { req: requestedMinutes ?? 0, common: coverage.commonWindowMinutes })}
        </span>
      )}
      {failed.length > 0 && (
        <span className={styles.coverageHint}>
          {t("hb.cov.noResponse")}: {failed.map((n) => n.nodeName).join(", ")}
        </span>
      )}
    </div>
  );
}
