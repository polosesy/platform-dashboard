"use client";

import { memo } from "react";
import { type NodeProps } from "reactflow";
import { getAzureIconUrl } from "../utils/azureIcons";
import type { DiagramIconKind } from "@aud/types";
import styles from "../styles.module.css";

export type GroupNodeData = {
  label: string;
  icon: DiagramIconKind;
};

export const GroupNode = memo(function GroupNode({ data }: NodeProps<GroupNodeData>) {
  const { label, icon } = data;
  const isVnet = icon === "vnet";

  return (
    <div
      className={`${styles.groupNode} ${isVnet ? styles.groupNodeVnet : styles.groupNodeSubnet}`}
    >
      <div className={styles.groupNodeHeader}>
        <img
          src={getAzureIconUrl(icon)}
          alt={icon}
          width={16}
          height={16}
          className={styles.groupNodeIcon}
        />
        <span className={styles.groupNodeLabel}>{label}</span>
      </div>
    </div>
  );
});
