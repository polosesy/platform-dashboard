"use client";

import { memo } from "react";
import { Handle, Position, type NodeProps } from "reactflow";
import type { HealthStatus, PowerState, SparklineData, DiagramIconKind, SubResource } from "@aud/types";
import { nodeColor, defaultTokens } from "../utils/designTokens";
import { getAzureIconUrl } from "../utils/azureIcons";
import { D3Sparkline } from "./D3Sparkline";
import { RESOURCE_KIND_DISPLAY } from "./ResourceDetailPanel";
import styles from "../styles.module.css";

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

// Azure CAF resource type abbreviations
const RESOURCE_TYPE_ABBR: Record<string, string> = {
  vm: "VM", vmss: "VMSS", aks: "AKS", containerApp: "CA",
  functionApp: "Func", appService: "App Svc", sql: "SQL",
  storage: "Storage", redis: "Redis", cosmosDb: "Cosmos",
  postgres: "PgSQL", keyVault: "KV", appGateway: "App GW",
  lb: "LB", frontDoor: "AFD", trafficManager: "TM",
  firewall: "FW", appInsights: "App Insights", logAnalytics: "Log Analytics",
  nic: "NIC", dns: "DNS", privateEndpoint: "PE",
  serviceBus: "Service Bus", eventHub: "Event Hub",
};

export const LiveNode = memo(function LiveNode({ data }: NodeProps<LiveNodeData>) {
  const { label, icon, health, healthScore, metrics, hasAlert, sparklines, endpoint, subResources, onSubResourceSelect, resourceKind, azureResourceId, powerState } = data;
  const typeAbbr = resourceKind ? RESOURCE_TYPE_ABBR[resourceKind] : undefined;
  const fullAzureName = azureResourceId ? azureResourceId.split("/").pop() ?? label : label;
  const colors = nodeColor(health);
  const pulse = defaultTokens.animation.pulseFrequency[health];

  const topMetrics = Object.entries(metrics)
    .filter(([, v]) => v != null)
    .slice(0, 3);

  // Get first available sparkline
  const primarySparkline = sparklines
    ? Object.values(sparklines).find((s) => s.values.length >= 2)
    : undefined;

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

      {/* Health ring */}
      <div className={styles.ringWrap}>
        <svg viewBox="0 0 40 40" width={40} height={40}>
          {/* Background ring */}
          <circle
            cx="20" cy="20" r={RING_R}
            fill="none"
            stroke="rgba(20,21,23,0.06)"
            strokeWidth={RING_STROKE}
          />
          {/* Health arc */}
          <circle
            cx="20" cy="20" r={RING_R}
            fill="none"
            stroke={colors.ringStroke}
            strokeWidth={RING_STROKE}
            strokeDasharray={`${healthScore * CIRCUMFERENCE} ${CIRCUMFERENCE}`}
            strokeLinecap="round"
            transform="rotate(-90 20 20)"
            style={{ transition: `stroke-dasharray ${defaultTokens.animation.transitionDuration}ms ease` }}
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

      {/* Sparkline under health ring */}
      {primarySparkline && (
        <div className={styles.sparklineWrap}>
          <D3Sparkline
            values={primarySparkline.values}
            width={80}
            height={22}
            color={colors.ringStroke}
          />
        </div>
      )}

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
          {powerState && powerState !== "unknown" && (
            <span className={styles.powerStateBadge} data-state={powerState}>
              {POWER_STATE_LABEL[powerState] ?? powerState}
            </span>
          )}
        </div>
        {endpoint && (
          <div className={styles.nodeEndpoint} title={endpoint}>{endpoint}</div>
        )}
      </div>

      {/* Metric badges */}
      {topMetrics.length > 0 && (
        <div className={styles.metricBadges}>
          {topMetrics.map(([key, val]) => (
            <div key={key} className={styles.metricBadge}>
              <span className={styles.metricKey}>{key}</span>
              <span className={styles.metricVal}>{fmtMetric(val)}</span>
            </div>
          ))}
        </div>
      )}

      {/* Sub-resource chips (NIC bound to VM, Frontend IP in AppGW) */}
      {subResources && subResources.length > 0 && (
        <div className={styles.subResourceChips}>
          {subResources.map((sr) => (
            <div
              key={sr.id}
              className={styles.subResourceChip}
              title={`${sr.label}${sr.endpoint ? `: ${sr.endpoint}` : ""}`}
            >
              <img
                src={getAzureIconUrl(sr.kind === "nic" ? "nic" : "appGateway")}
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
        </div>
      )}

      <Handle type="source" position={Position.Right} className={styles.handle} />
    </div>
  );
});
