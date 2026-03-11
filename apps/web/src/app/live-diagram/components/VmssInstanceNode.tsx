"use client";

import { memo } from "react";
import { Handle, Position, type NodeProps } from "reactflow";
import { getAzureIconUrl } from "../utils/azureIcons";
import styles from "../styles.module.css";

export type VmssInstanceNodeData = {
  label: string;
  computerName: string;
  powerState: string;
  privateIp?: string;
  parentVmssId: string;
  onSelect?: (data: VmssInstanceNodeData) => void;
};

type PowerInfo = { color: string; label: string; score: number };

const POWER_INFO: Record<string, PowerInfo> = {
  running:     { color: "#10893e", label: "Running",     score: 1.0 },
  starting:    { color: "#0078d4", label: "Starting",    score: 0.6 },
  stopping:    { color: "#d18400", label: "Stopping",    score: 0.4 },
  stopped:     { color: "#d18400", label: "Stopped",     score: 0.3 },
  deallocated: { color: "#888",    label: "Deallocated", score: 0.1 },
  unknown:     { color: "#aaa",    label: "Unknown",     score: 0.2 },
};

const RING_R = 13;
const RING_STROKE = 2.5;
const CIRCUMFERENCE = 2 * Math.PI * RING_R;

export const VmssInstanceNode = memo(function VmssInstanceNode({
  data,
}: NodeProps<VmssInstanceNodeData>) {
  const { computerName, powerState, privateIp, onSelect } = data;
  const info = POWER_INFO[powerState] ?? POWER_INFO.unknown;

  return (
    <div
      className={styles.vmssInstanceNode}
      onClick={() => onSelect?.(data)}
    >
      <Handle type="target" position={Position.Left} className={styles.handle} style={{ opacity: 0 }} />

      {/* Health ring — same pattern as LiveNode, ring only (no icon inside) */}
      <div className={styles.vmssInstRing}>
        <svg viewBox="0 0 34 34" width={34} height={34}>
          <circle
            cx="17" cy="17" r={RING_R}
            fill="none"
            stroke="rgba(0,0,0,0.07)"
            strokeWidth={RING_STROKE}
          />
          <circle
            cx="17" cy="17" r={RING_R}
            fill="none"
            stroke={info.color}
            strokeWidth={RING_STROKE}
            strokeDasharray={`${info.score * CIRCUMFERENCE} ${CIRCUMFERENCE}`}
            strokeLinecap="round"
            transform="rotate(-90 17 17)"
            style={{ transition: "stroke-dasharray 0.4s ease" }}
          />
        </svg>
      </div>

      {/* Icon + info — same column layout as LiveNode */}
      <div className={styles.vmssInstInfo}>
        <div className={styles.vmssInstIconRow}>
          <img src={getAzureIconUrl("vm")} alt="vm" width={16} height={16} />
          <span className={styles.vmssInstName} title={computerName}>{computerName}</span>
        </div>
        <div className={styles.vmssInstMeta}>
          <span className={styles.vmssInstBadge} data-state={powerState}>
            {info.label}
          </span>
          {privateIp && (
            <span className={styles.vmssInstIp}>{privateIp}</span>
          )}
        </div>
      </div>

      <Handle type="source" position={Position.Right} className={styles.handle} style={{ opacity: 0 }} />
    </div>
  );
});
