"use client";

import { memo } from "react";
import { useI18n } from "@/lib/i18n";
import { type NodeProps } from "reactflow";
import { HiddenHandles } from "./HiddenHandles";
import type { DiagramIconKind } from "@aud/types";
import { getAzureIconUrl } from "../utils/azureIcons";
import styles from "../styles.module.css";

export type NsgBadgeData = {
  label: string;
  icon: DiagramIconKind;
  resourceKind?: string;
  azureResourceId?: string;
  /** Cat 4: standalone/detached NSG — no subnet, NIC, or VM association */
  detached?: boolean;
};

export const NsgBadgeNode = memo(function NsgBadgeNode({ data }: NodeProps<NsgBadgeData>) {
  const { t } = useI18n();
  if (data.detached) {
    return (
      <div className={`${styles.nsgBadge} ${styles.nsgBadgeDetached}`}>
        <HiddenHandles />
        <span className={styles.nsgDetachedX}>X</span>
        <img
          src={getAzureIconUrl(data.icon)}
          alt="nsg"
          width={14}
          height={14}
          className={styles.nsgBadgeIcon}
        />
        <span className={styles.nsgBadgeLabel}>{data.label}</span>
        <div className={styles.nsgDetachedTooltip}>
          {t("ld.nsgDetached")}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.nsgBadge}>
      <HiddenHandles />
      <img
        src={getAzureIconUrl(data.icon)}
        alt="nsg"
        width={14}
        height={14}
        className={styles.nsgBadgeIcon}
      />
      <span className={styles.nsgBadgeLabel}>{data.label}</span>
    </div>
  );
});
