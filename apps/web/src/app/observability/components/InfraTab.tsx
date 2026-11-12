"use client";

import type { NodeResourceSummary } from "@aud/types";
import { useI18n } from "@/lib/i18n";
import styles from "../styles.module.css";
import { formatBytes } from "@/lib/format";
import { Cell, Chip, EmptyState, Grid, Notice, Panel, Stat, Toolbar, type ChipLevel } from "@/components/ui";

function GaugeBar({ pct }: { pct: number | null }) {
  if (pct === null) return <span className={styles.gaugeNa}>N/A</span>;
  const clamped = Math.min(100, Math.round(pct));
  const cls = clamped >= 85 ? styles.gaugeCrit : clamped >= 70 ? styles.gaugeWarn : styles.gaugeOk;
  return (
    <div className={styles.gauge}>
      <div className={styles.gaugeBar}>
        <div className={`${styles.gaugeFill} ${cls}`} style={{ width: `${clamped}%` }} />
      </div>
      <span className={styles.gaugeLabel}>{clamped}%</span>
    </div>
  );
}

const NODE_CHIP: Record<NodeResourceSummary["status"], ChipLevel> = { Ready: "ok", NotReady: "danger", Unknown: "unknown" };

function PressureIndicators({ conditions }: { conditions: NodeResourceSummary["conditions"] }) {
  const pressures = conditions.filter((c) => c.type !== "Ready" && c.status === "True");
  if (pressures.length === 0) return null;
  return <div className={styles.nodeChips}>{pressures.map((c) => <Chip key={c.type} level="danger">{c.type}</Chip>)}</div>;
}

/** Node cards: today's state whatever the time range (`past` = the picker shows a past range — say so louder) */
export function InfraTab({ nodes, past = false }: { nodes: NodeResourceSummary[]; past?: boolean }) {
  const { t } = useI18n();
  if (nodes.length === 0) {
    return (
      <EmptyState title={t("ob.noNodes")}>{t("ob.noNodesHint")}</EmptyState>
    );
  }

  const ready = nodes.filter((n) => n.status === "Ready").length;
  const notReady = nodes.filter((n) => n.status === "NotReady").length;
  // A node whose pods were not read makes the total unknown (a sum that skips it would read as measured)
  const pods = nodes.some((x) => x.podCount === null) ? null : nodes.reduce((n, x) => n + (x.podCount as number), 0);

  return (
    <div className={styles.stack}>
      {past ? <Notice tone="info">{t("ob.nodesNowPast")}</Notice> : <Toolbar end={<Chip level="plain" glyph={false}>{t("ob.nodesNow")}</Chip>} />}
      <Grid>
        <Cell span={3}><Stat label={t("ob.allNodes")} value={nodes.length} /></Cell>
        <Cell span={3}><Stat label={<><span aria-hidden="true">●</span> Ready</>} value={ready} tone="success" /></Cell>
        <Cell span={3}><Stat label={<><span aria-hidden="true">■</span> NotReady</>} value={notReady} tone={notReady ? "high" : undefined} /></Cell>
        <Cell span={3}><Stat label={t("ob.podsTotal")} value={pods === null ? "—" : pods} hint={pods === null ? t("ob.podsUnread") : undefined} /></Cell>
        {nodes.map((node) => (
          <Cell span={3} key={node.name}>
            <Panel as="article" level={node.status === "NotReady" ? "danger" : undefined}
              title={<span title={node.name}>{node.name}</span>}
              actions={<Chip level={NODE_CHIP[node.status] ?? "unknown"}>{node.status}</Chip>}
              footer={<span className={styles.nodeFoot}>
                {node.podCount === null ? t("ob.podsUnread") : t("ob.podsN", { n: node.podCount })}
                {node.cpuCapacityMillicores != null ? ` · CPU ${node.cpuCapacityMillicores}m` : ""}
                {node.memoryCapacityMiB != null ? ` · Mem ${Math.round(node.memoryCapacityMiB / 1024)}Gi` : ""}
              </span>}>
              <div className={styles.nodeMetrics}>
                <div>
                  <div className={styles.nodeMetricLabel}>CPU</div>
                  <GaugeBar pct={node.cpuUsagePct} />
                </div>
                <div>
                  <div className={styles.nodeMetricLabel}>{t("ob.memory")}</div>
                  <GaugeBar pct={node.memoryUsagePct} />
                </div>
              </div>
              {node.diskUsagePct !== null && (
                <div className={styles.nodeDisk}>
                  <div className={styles.nodeMetricLabel}>{t("ob.disk")}{node.diskCapacityGB !== null ? ` · ${node.diskCapacityGB}GB` : ""}</div>
                  <GaugeBar pct={node.diskUsagePct} />
                </div>
              )}
              {(node.networkRxBytesPerSec !== null || node.networkTxBytesPerSec !== null) && (
                <div className={styles.nodeNetRow}>
                  <span className={styles.nodeNetLabel}>NET</span>
                  {node.networkRxBytesPerSec !== null && <span className={styles.nodeNetValue}>↓ {formatBytes(node.networkRxBytesPerSec)}/s</span>}
                  {node.networkTxBytesPerSec !== null && <span className={styles.nodeNetValue}>↑ {formatBytes(node.networkTxBytesPerSec)}/s</span>}
                </div>
              )}
              <PressureIndicators conditions={node.conditions} />
            </Panel>
          </Cell>
        ))}
      </Grid>
    </div>
  );
}
