"use client";

import { memo } from "react";
import { Handle, Position, type NodeProps } from "reactflow";
import type { HealthStatus, PowerState, SparklineData, DiagramIconKind, SubResource } from "@aud/types";
import { nodeColor, defaultTokens } from "../utils/designTokens";
import { getAzureIconUrl } from "../utils/azureIcons";
import { D3Sparkline } from "./D3Sparkline";
import { RESOURCE_KIND_DISPLAY } from "./ResourceDetailPanel";
import styles from "../styles.module.css";

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
const POWER_STATE_RING: Record<string, PowerStateRing> = {
  running:     { health: "ok",       score: 1,    color: "rgba(16,137,62,0.70)",  spin: true },
  starting:    { health: "ok",       score: 0.5,  color: "rgba(0,120,212,0.65)",  spin: true },
  stopping:    { health: "warning",  score: 0.5,  color: "rgba(209,132,0,0.70)",  spin: true },
  stopped:     { health: "warning",  score: 0.3,  color: "rgba(209,132,0,0.60)",  spin: false },
  deallocated: { health: "unknown",  score: 0.15, color: "rgba(20,21,23,0.25)",   spin: false },
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
  "aks-cluster":      { abbr: "AKS",  label: "AKS Cluster" },
  "aks-vmss":         { abbr: "Pool", label: "AKS Node Pool (VMSS)" },
  "aks-ingress":      { abbr: "Ing",  label: "AKS Ingress Controller" },
  "aks-egress":       { abbr: "Egr",  label: "AKS Egress (Firewall)" },
  "gateway":          { abbr: "GW",   label: "Application Gateway" },
  "load-balancer":    { abbr: "LB",   label: "Load Balancer" },
  "firewall":         { abbr: "FW",   label: "Firewall" },
  "db":               { abbr: "DB",   label: "Database" },
  "cache":            { abbr: "Cache", label: "Cache (Redis)" },
  "private-endpoint": { abbr: "PE",   label: "Private Endpoint" },
  "messaging":        { abbr: "Msg",  label: "Messaging Service" },
  "nat-gateway":      { abbr: "NAT",  label: "NAT Gateway (명시적 아웃바운드)" },
};

export const LiveNode = memo(function LiveNode({ id: nodeId, data }: NodeProps<LiveNodeData>) {
  const { label, icon, health, healthScore, metrics, hasAlert, sparklines, endpoint, subResources, onSubResourceSelect, resourceKind, azureResourceId, powerState, archRole, nsgBadge, onNsgSelect, aksClusterArmId, vmssExpanded, onVmssExpand } = data;
  const typeAbbr = resourceKind ? RESOURCE_TYPE_ABBR[resourceKind] : undefined;
  const fullAzureName = azureResourceId ? azureResourceId.split("/").pop() ?? label : label;

  // ── Derive ring visuals from powerState (when available) or health ──
  const ringFromPower = powerState ? POWER_STATE_RING[powerState] : undefined;
  const effectiveHealth: HealthStatus = ringFromPower?.health ?? health;
  const effectiveScore = ringFromPower?.score ?? healthScore;
  const isSpinning = ringFromPower?.spin ?? false;

  const colors = nodeColor(effectiveHealth);
  const ringStroke = ringFromPower?.color ?? colors.ringStroke;
  const pulse = defaultTokens.animation.pulseFrequency[effectiveHealth];

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
            stroke="rgba(20,21,23,0.06)"
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
          {archRole && ARCH_ROLE_BADGE[archRole] && ARCH_ROLE_BADGE[archRole]!.abbr !== typeAbbr && (
            <span className={styles.archRoleBadge} title={ARCH_ROLE_BADGE[archRole]!.label}>
              {ARCH_ROLE_BADGE[archRole]!.abbr}
            </span>
          )}
          {powerState && (
            <span className={styles.powerStateBadge} data-state={powerState}>
              {POWER_STATE_LABEL[powerState] ?? powerState}
            </span>
          )}
          {!powerState && health !== "unknown" && (
            <span className={styles.healthStatusBadge} data-health={health}>
              {health === "ok" ? "OK" : health === "warning" ? "Warn" : "Crit"}
            </span>
          )}
        </div>
        {endpoint && !subResources?.some((sr) => sr.endpoint === endpoint) && (
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
          {vmssExpanded ? "▲ 접기" : "▼ 인스턴스 보기"}
        </button>
      )}
    </div>
  );
});
