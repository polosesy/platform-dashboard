"use client";

import { memo } from "react";
import { useI18n } from "@/lib/i18n";
import { Handle, Position, type NodeProps } from "reactflow";
import type { AksNodeCondition } from "@aud/types";
import { getAzureIconUrl } from "../utils/azureIcons";
import styles from "../styles.module.css";
import { rgba } from "@/lib/palette";

export type VmssInstanceNodeData = {
  label: string;
  computerName: string;
  powerState: string;
  provisioningState?: string;
  privateIp?: string;
  nodePoolName?: string;
  nodeImageVersion?: string;
  conditions?: AksNodeCondition[];
  parentVmssId: string;
  onSelect?: (data: VmssInstanceNodeData) => void;
};

// Matches LiveNode POWER_STATE_RING pattern exactly
type PowerInfo = { color: string; label: string; score: number; spin: boolean };

const POWER_INFO: Record<string, PowerInfo> = {
  running:     { color: rgba("ok", 0.7),  label: "ld.power.running",     score: 1,    spin: true },
  starting:    { color: rgba("accent", 0.65),  label: "ld.power.starting",    score: 0.5,  spin: true },
  stopping:    { color: rgba("warning", 0.7),  label: "ld.power.stopping",    score: 0.5,  spin: true },
  stopped:     { color: rgba("warning", 0.6),  label: "ld.power.stopped",     score: 0.3,  spin: false },
  deallocated: { color: rgba("ink", 0.25),   label: "ld.power.deallocated", score: 0.15, spin: false },
  unknown:     { color: rgba("ink", 0.3),label: "ld.power.unknown",   score: 0.2,  spin: false },
};

const RING_R = 13;
const RING_STROKE = 2.5;
const CIRCUMFERENCE = 2 * Math.PI * RING_R;

export const VmssInstanceNode = memo(function VmssInstanceNode({
  data,
}: NodeProps<VmssInstanceNodeData>) {
  const { t } = useI18n();
  const { computerName, powerState, privateIp, onSelect } = data;
  const info = POWER_INFO[powerState] ?? POWER_INFO.unknown;

  return (
    <div
      className={styles.vmssInstanceNode}
      data-state={powerState}
      onClick={() => onSelect?.(data)}
    >
      <Handle type="target" position={Position.Left} className={styles.handle} style={{ opacity: 0 }} />

      {/* Health ring — mirrors LiveNode ring pattern exactly */}
      <div className={styles.vmssInstRing}>
        <svg viewBox="0 0 34 34" width={34} height={34}>
          <circle
            cx="17" cy="17" r={RING_R}
            fill="none"
            stroke={rgba("ink", 0.06)}
            strokeWidth={RING_STROKE}
          />
          <circle
            cx="17" cy="17" r={RING_R}
            fill="none"
            stroke={info.color}
            strokeWidth={RING_STROKE}
            strokeDasharray={info.spin
              ? `${0.75 * CIRCUMFERENCE} ${0.25 * CIRCUMFERENCE}`
              : `${info.score * CIRCUMFERENCE} ${CIRCUMFERENCE}`}
            strokeLinecap="round"
            transform="rotate(-90 17 17)"
            className={info.spin ? styles.vmssInstRingSpin : undefined}
            style={info.spin ? undefined : { transition: "stroke-dasharray 0.4s ease" }}
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
            {t(info.label)}
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
