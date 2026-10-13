"use client";

import { memo, type CSSProperties } from "react";
import { useI18n } from "@/lib/i18n";
import { Handle, Position, type NodeProps } from "reactflow";
import type { HealthStatus, PowerState, SparklineData, DiagramIconKind, SubResource } from "@aud/types";
import { nodeColor, defaultTokens } from "../utils/designTokens";
import { getAzureIconUrl } from "../utils/azureIcons";
import { D3Sparkline } from "./D3Sparkline";
import { RESOURCE_KIND_DISPLAY } from "./ResourceDetailPanel";
import styles from "../styles.module.css";
import { rgba } from "@/lib/palette";

export type NsgBadgeInfo = {
  nodeId: string;
  label: string;
  icon: DiagramIconKind;
  azureResourceId?: string;
};

export type LiveNodeData = {
  label: string;
  icon: DiagramIconKind;
  health: HealthStatus;
  healthScore: number;
  metrics: Record<string, number | null>;
  hasAlert: boolean;
  sparklines?: Record<string, SparklineData>;
  endpoint?: string;
  subResources?: SubResource[];
  onSubResourceSelect?: (sr: SubResource) => void;
  resourceKind?: string;
  azureResourceId?: string;
  powerState?: PowerState;
  archRole?: string;
  archGroupId?: string;
  nsgBadge?: NsgBadgeInfo;
  onNsgSelect?: (nodeId: string) => void;
  aksClusterArmId?: string;
  vmssExpanded?: boolean;
  onVmssExpand?: (nodeId: string, azureResourceId: string, aksClusterArmId?: string) => void;
  isUnused?: boolean; // public IP not attached to any resource
};

const RING_R = defaultTokens.dimensions.healthRingRadius;
const RING_STROKE = defaultTokens.dimensions.healthRingStroke;
const CIRCUMFERENCE = 2 * Math.PI * RING_R;

export function fmtMetric(val: number | null): string {
  if (val == null) return "-";
  if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(1)}M`;
  if (val >= 1_000) return `${(val / 1_000).toFixed(1)}K`;
  return val % 1 === 0 ? String(val) : val.toFixed(1);
}

const POWER_STATE_LABEL: Record<string, string> = {
  running: "Running",
  stopped: "Stopped",
  deallocated: "Deallocated",
  starting: "Starting",
  stopping: "Stopping",
};

// PowerState → ring visual mapping
type PowerStateRing = { health: HealthStatus; score: number; color: string; spin: boolean };
const MAX_METRIC_CHIPS = 2;
/** Short chip labels so two chips and the trend fit one line; the full name is in the chip tooltip */
const METRIC_SHORT: Record<string, string> = {
  cpu: "CPU", memory: "Mem", network: "Net", throughput: "Thru", requests: "Req", errors: "Err",
  availability: "Avail", transactions: "Txn", storage: "Stor", ru: "RU", rps: "RPS", latency: "Lat",
  executions: "Exec", dtu: "DTU", dataPath: "Path", connections: "Conn",
};
const MAX_SUB_CHIPS = 2;

const HEALTH_RANK: Record<HealthStatus, number> = { unknown: 0, ok: 0, warning: 1, critical: 2 };

const POWER_STATE_RING: Record<string, PowerStateRing> = {
  running:     { health: "ok",       score: 1,    color: rgba("ok", 0.7),  spin: true },
  starting:    { health: "ok",       score: 0.5,  color: rgba("accent", 0.65),  spin: true },
  stopping:    { health: "warning",  score: 0.5,  color: rgba("warning", 0.7),  spin: true },
  stopped:     { health: "warning",  score: 0.3,  color: rgba("warning", 0.6),  spin: false },
  deallocated: { health: "unknown",  score: 0.15, color: rgba("ink", 0.25),   spin: false },
};

// Azure CAF resource type abbreviations
const RESOURCE_TYPE_ABBR: Record<string, string> = {
  vm: "VM", vmss: "VMSS", aks: "AKS", containerApp: "CA",
  functionApp: "Func", appService: "App Svc", sql: "SQL",
  storage: "Storage", redis: "Redis", cosmosDb: "Cosmos",
  postgres: "PgSQL", keyVault: "KV", appGateway: "App GW",
  lb: "LB", frontDoor: "AFD", trafficManager: "TM",
  firewall: "FW", natGateway: "NAT GW", appInsights: "App Insights", logAnalytics: "Log Analytics",
  nic: "NIC", nsg: "NSG", dns: "DNS", privateEndpoint: "PE",
  serviceBus: "Service Bus", eventHub: "Event Hub",
};

// Architecture role badges — only shown when role provides extra context beyond type
const ARCH_ROLE_BADGE: Record<string, { abbr: string; label: string }> = {
  // label = i18n key
  "aks-cluster":      { abbr: "AKS",  label: "ld.role.aksCluster" },
  "aks-vmss":         { abbr: "Pool", label: "ld.role.aksVmss" },
  "aks-ingress":      { abbr: "Ing",  label: "ld.role.aksIngress" },
  "aks-egress":       { abbr: "Egr",  label: "ld.role.aksEgress" },
  "gateway":          { abbr: "GW",   label: "ld.role.gateway" },
  "load-balancer":    { abbr: "LB",   label: "ld.role.lb" },
  "firewall":         { abbr: "FW",   label: "ld.role.firewall" },
  "db":               { abbr: "DB",   label: "ld.role.db" },
  "cache":            { abbr: "Cache", label: "ld.role.cache" },
  "private-endpoint": { abbr: "PE",   label: "ld.role.pe" },
  "messaging":        { abbr: "Msg",  label: "ld.role.messaging" },
  "nat-gateway":      { abbr: "NAT",  label: "ld.role.nat" },
};

export const LiveNode = memo(function LiveNode({ id: nodeId, data }: NodeProps<LiveNodeData>) {
  const { t } = useI18n();
  const { label, icon, health, healthScore, metrics, hasAlert, sparklines, endpoint, subResources, resourceKind, azureResourceId, powerState, archRole, nsgBadge, onNsgSelect, aksClusterArmId, vmssExpanded, onVmssExpand, isUnused } = data;
  const typeAbbr = resourceKind ? RESOURCE_TYPE_ABBR[resourceKind] : undefined;
  const fullAzureName = azureResourceId ? azureResourceId.split("/").pop() ?? label : label;

  // ── Ring visuals: power state, unless the metrics say something worse ──
  // A "running" power state (often assumed for LB / App Gateway / Firewall) must not paint a node
  // green while its metric-based health is warning or critical.
  const ringFromPower = powerState ? POWER_STATE_RING[powerState] : undefined;
  const metricWorse = !!ringFromPower && HEALTH_RANK[health] > HEALTH_RANK[ringFromPower.health];
  const fromPower = ringFromPower && !metricWorse ? ringFromPower : undefined;
  const effectiveHealth: HealthStatus = fromPower?.health ?? health;
  const effectiveScore = fromPower?.score ?? healthScore;
  const isSpinning = fromPower?.spin ?? false;

  const colors = nodeColor(effectiveHealth);
  const ringStroke = fromPower?.color ?? colors.ringStroke;
  // Sparkline = metric trend, coloured by the metric-based health (power state says nothing about it)
  const trendColor = nodeColor(health === "unknown" ? effectiveHealth : health).ringStroke;
  const pulse = defaultTokens.animation.pulseFrequency[effectiveHealth];

  // Get first available sparkline
  const primarySparkline = sparklines
    ? Object.values(sparklines).find((s) => s.values.length >= 2)
    : undefined;

  // Fixed card anatomy (the API lays cards out on a fixed height budget — 100 px, +26 with sub-resources):
  //   header (ring · name · badges) / metric strip (≤ 2 chips | trend slot) / sub-resource strip (one line)
  // The trend metric's chip comes first and carries the trend colour, so the line has a visible owner.
  const metricEntries = Object.entries(metrics).filter(([, v]) => v != null);
  const trendMetric = primarySparkline?.metric;
  const orderedMetrics = trendMetric
    ? [...metricEntries.filter(([k]) => k === trendMetric), ...metricEntries.filter(([k]) => k !== trendMetric)]
    : metricEntries;
  const topMetrics = orderedMetrics.slice(0, MAX_METRIC_CHIPS);
  const metricsTitle = orderedMetrics.map(([k, v]) => `${k} ${fmtMetric(v)}`).join(" · ");
  const subs = subResources ?? [];
  // Two fit on one line as IP-only chips; three or more collapse to the first one + "+N"
  const shownSubs = subs.length > MAX_SUB_CHIPS ? subs.slice(0, 1) : subs;
  const hiddenSubs = subs.slice(shownSubs.length);

  return (
    <div
      className={styles.liveNode}
      style={{
        background: colors.fill,
        borderColor: colors.border,
        boxShadow: `0 8px 20px ${colors.shadow}`,
      }}
    >
      <Handle type="target" position={Position.Left} className={styles.handle} />

      {/* Embedded NSG badge — Cat 2/3: VM/NIC-attached NSG */}
      {nsgBadge && (
        <div className={styles.liveNsgBadge}>
          <button
            type="button"
            className={styles.nsgBadge}
            onClick={(e) => { e.stopPropagation(); onNsgSelect?.(nsgBadge.nodeId); }}
            title={nsgBadge.label}
          >
            <img
              src={getAzureIconUrl(nsgBadge.icon)}
              alt="nsg"
              width={12}
              height={12}
              className={styles.nsgBadgeIcon}
            />
            <span className={styles.nsgBadgeLabel}>{nsgBadge.label}</span>
          </button>
        </div>
      )}

      {/* Health ring */}
      <div className={styles.ringWrap}>
        <svg viewBox="0 0 40 40" width={40} height={40}>
          {/* Background ring */}
          <circle
            cx="20" cy="20" r={RING_R}
            fill="none"
            stroke={rgba("ink", 0.06)}
            strokeWidth={RING_STROKE}
          />
          {/* Health / PowerState arc */}
          <circle
            cx="20" cy="20" r={RING_R}
            fill="none"
            stroke={ringStroke}
            strokeWidth={RING_STROKE}
            strokeDasharray={isSpinning
              ? `${0.75 * CIRCUMFERENCE} ${0.25 * CIRCUMFERENCE}`
              : `${effectiveScore * CIRCUMFERENCE} ${CIRCUMFERENCE}`}
            strokeLinecap="round"
            transform="rotate(-90 20 20)"
            className={isSpinning ? styles.healthRingSpin : undefined}
            style={isSpinning ? undefined : { transition: `stroke-dasharray ${defaultTokens.animation.transitionDuration}ms ease` }}
          />
          {/* Alert indicator */}
          {hasAlert && (
            <circle cx="34" cy="6" r="4" fill={defaultTokens.colors.alert.critical}>
              {pulse > 0 && (
                <animate attributeName="r" values="3;5.5;3" dur={`${pulse}s`} repeatCount="indefinite" />
              )}
            </circle>
          )}
        </svg>
      </div>

      {/* Node info */}
      <div className={styles.nodeInfo} title={fullAzureName}>
        <div className={styles.nodeLabel} style={{ color: colors.text }}>
          {label}
        </div>
        <div className={styles.nodeIcon}>
          <img src={getAzureIconUrl(icon)} alt={icon} width={20} height={20} />
          {typeAbbr && (
            <span className={styles.nodeTypeAbbr} title={RESOURCE_KIND_DISPLAY[resourceKind!] ?? resourceKind}>
              {typeAbbr}
            </span>
          )}
          {archRole && ARCH_ROLE_BADGE[archRole] && ARCH_ROLE_BADGE[archRole]!.abbr !== typeAbbr && (
            <span className={styles.archRoleBadge} title={t(ARCH_ROLE_BADGE[archRole]!.label)}>
              {ARCH_ROLE_BADGE[archRole]!.abbr}
            </span>
          )}
          {powerState && (
            <span className={styles.powerStateBadge} data-state={powerState}>
              {POWER_STATE_LABEL[powerState] ?? powerState}
            </span>
          )}
          {(!powerState || metricWorse) && health !== "unknown" && (
            <span className={styles.healthStatusBadge} data-health={health}>
              {health === "ok" ? "OK" : health === "warning" ? "Warn" : "Crit"}
            </span>
          )}
          {isUnused && (
            <span className={styles.unusedBadge} title={t("ld.unusedPipHint")}>
              {t("ld.unused")}
            </span>
          )}
        </div>
        {endpoint && !subResources?.some((sr) => sr.endpoint === endpoint) && (
          <div className={styles.nodeEndpoint} title={endpoint}>{endpoint}</div>
        )}
      </div>

      {/* Metric strip: chips on the left, the trend always in the same right-hand slot */}
      {(topMetrics.length > 0 || primarySparkline) && (
        <div
          className={styles.metricBadges}
          data-trend={primarySparkline ? "on" : undefined}
          style={{ "--trend": trendColor } as CSSProperties}
          title={metricsTitle}
        >
          <div className={styles.metricChips}>
            {topMetrics.map(([key, val]) => (
              <div key={key} className={styles.metricBadge} data-trend={key === trendMetric || undefined} title={`${key} ${fmtMetric(val)}`}>
                <span className={styles.metricKey}>{METRIC_SHORT[key] ?? key}</span>
                <span className={styles.metricVal}>{fmtMetric(val)}</span>
              </div>
            ))}
          </div>
          {primarySparkline && (
            <div className={styles.sparklineWrap} title={primarySparkline.metric}>
              <D3Sparkline values={primarySparkline.values} width={40} height={20} color={trendColor} />
            </div>
          )}
        </div>
      )}

      {/* Sub-resource chips (NIC bound to VM, Frontend IP in AppGW) */}
      {subs.length > 0 && (
        <div className={styles.subResourceChips} data-compact={subs.length > 1 || undefined}>
          {shownSubs.map((sr) => (
            <div
              key={sr.id}
              className={styles.subResourceChip}
              title={`${sr.label}${sr.endpoint ? `: ${sr.endpoint}` : ""}`}
            >
              <img
                src={getAzureIconUrl(sr.kind === "nic" ? "nic" : sr.kind === "publicIP" ? "publicIP" : "appGateway")}
                alt={sr.kind}
                width={12}
                height={12}
              />
              <span className={styles.subResourceLabel}>{sr.label}</span>
              {sr.endpoint && (
                <span className={styles.subResourceEndpoint}>{sr.endpoint}</span>
              )}
            </div>
          ))}
          {hiddenSubs.length > 0 && (
            <span
              className={styles.subResourceMore}
              title={hiddenSubs.map((sr) => `${sr.label}${sr.endpoint ? `: ${sr.endpoint}` : ""}`).join("\n")}
            >
              +{hiddenSubs.length}
            </span>
          )}
        </div>
      )}

      <Handle type="source" position={Position.Right} className={styles.handle} />

      {/* VMSS expand/collapse toggle */}
      {archRole === "aks-vmss" && azureResourceId && onVmssExpand && (
        <button
          type="button"
          className={styles.vmssExpandBtn}
          onClick={(e) => { e.stopPropagation(); onVmssExpand(nodeId, azureResourceId, aksClusterArmId); }}
        >
          {vmssExpanded ? `▲ ${t("ld.collapse")}` : `▼ ${t("ld.showInstances")}`}
        </button>
      )}
    </div>
  );
});
