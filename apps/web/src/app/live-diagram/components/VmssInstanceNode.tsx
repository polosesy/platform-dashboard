"use client";

import { memo, type CSSProperties } from "react";
import { useI18n } from "@/lib/i18n";
import { type NodeProps } from "reactflow";
import { HiddenHandles } from "./HiddenHandles";
import type { AksNodeCondition, PowerState } from "@aud/types";
import { cardStatus } from "@/lib/liveStatus";
import { instanceHealth } from "@/lib/liveInstance";
import { middleEllipsis } from "@/lib/liveNames";
import { getAzureIconUrl } from "../utils/azureIcons";
import styles from "../styles.module.css";

export type VmssInstanceNodeData = {
  label: string;
  computerName: string;
  powerState: string;
  provisioningState?: string;
  privateIp?: string;
  nodePoolName?: string;
  nodeImageVersion?: string;
  conditions?: AksNodeCondition[];
  conditionsSource?: "kubernetes" | "platformMetric" | "containerInsights";
  parentVmssId: string;
  onSelect?: (data: VmssInstanceNodeData) => void;
};

/**
 * One instance of an AKS node-pool scale set, drawn as a resource card (same strip, name row, status pill and
 * zoom levels as LiveNode) at a lower height — an instance has no metric row. The status comes from the Kubernetes
 * node conditions when the API returned them (lib/liveInstance), else the power state alone (grey: running is
 * not health).
 */
export const VmssInstanceNode = memo(function VmssInstanceNode({ data }: NodeProps<VmssInstanceNodeData>) {
  const { t } = useI18n();
  const { computerName, privateIp, nodePoolName, onSelect } = data;
  const power = (["running", "stopped", "deallocated", "starting", "stopping"].includes(data.powerState) ? data.powerState : "unknown") as PowerState;
  const health = instanceHealth(data.conditions, data.conditionsSource);
  const status = cardStatus(health.status, power);
  const desc = [t("ld.inst.kind"), nodePoolName, privateIp].filter(Boolean).join(" · ");
  const title = [computerName, health.reason ? t(health.reason) : null].filter(Boolean).join(" — ");

  return (
    <div
      className={`${styles.card} ${styles.cardInstance}`}
      data-tone={status.tone}
      style={{ "--status": status.color } as CSSProperties}
      title={title}
      aria-label={computerName}
      onClick={() => onSelect?.(data)}
    >
      <HiddenHandles />
      <span className={styles.cardStrip} aria-hidden="true" />

      <div className={`${styles.cardBody} ${styles.lodDetail} ${styles.instDetail}`}>
        <div className={styles.cardRow1}>
          <img src={getAzureIconUrl("vm")} alt="" width={18} height={18} />
          <span className={styles.cardName}>{middleEllipsis(computerName, 18)}</span>
          <span className={styles.cardPill} data-tone={status.tone}>{status.glyph} {t(status.key)}</span>
        </div>
        <div className={styles.cardRow2}>
          <span className={styles.cardDesc}>{desc}</span>
        </div>
      </div>

      <div className={`${styles.cardBody} ${styles.lodSummary}`}>
        <div className={styles.cardRow1}>
          <img src={getAzureIconUrl("vm")} alt="" width={24} height={24} />
          <span className={styles.cardNameBig}>{middleEllipsis(computerName, 13)}</span>
        </div>
      </div>

      <div className={`${styles.cardBody} ${styles.lodGlance}`}>
        <img src={getAzureIconUrl("vm")} alt="" width={32} height={32} />
        <span className={styles.cardNameHuge}>{middleEllipsis(computerName, 16)}</span>
      </div>
    </div>
  );
});
