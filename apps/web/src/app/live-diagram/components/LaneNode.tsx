"use client";

import { memo } from "react";
import type { NodeProps } from "reactflow";
import { useI18n } from "@/lib/i18n";
import type { LaneKind } from "@/lib/liveLayout";
import styles from "../styles.module.css";

export type LaneNodeData = {
  /** i18n key of the lane title */
  label: string;
  /** A lane outside the VNets, or "section": the "no connections" frame inside a VNet */
  lane: LaneKind | "section";
  /** Members (shown in the section title) */
  count?: number;
};

/**
 * A titled column around cards outside the VNet (inbound Internet, egress rail, PaaS groups, outside, other VNets,
 * unused · detached), or the "no connections" frame inside a VNet
 */
export const LaneNode = memo(function LaneNode({ data }: NodeProps<LaneNodeData>) {
  const { t } = useI18n();
  return (
    <div className={styles.laneNode} data-lane={data.lane}>
      <div className={styles.laneTitle}>{t(data.label, { n: data.count ?? 0 })}</div>
    </div>
  );
});
