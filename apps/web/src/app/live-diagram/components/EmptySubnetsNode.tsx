"use client";

import { memo } from "react";
import { type NodeProps } from "reactflow";
import { HiddenHandles } from "./HiddenHandles";
import { useI18n } from "@/lib/i18n";
import styles from "../styles.module.css";

export type EmptySubnetsNodeData = {
  vnetId: string;
  names: string[];
  /** The subnets are shown — this row folds them again */
  expanded: boolean;
  onToggle: (vnetId: string) => void;
};

/** One row for a VNet's subnets that hold no resources — click to show them, click again to fold them */
export const EmptySubnetsNode = memo(function EmptySubnetsNode({ data }: NodeProps<EmptySubnetsNodeData>) {
  const { t } = useI18n();
  const n = data.names.length;
  return (
    <button
      type="button"
      className={styles.emptySubnets}
      title={data.names.join("\n")}
      aria-expanded={data.expanded}
      data-expanded={data.expanded || undefined}
      onClick={(e) => { e.stopPropagation(); data.onToggle(data.vnetId); }}
    >
      <HiddenHandles />
      {data.expanded ? `${t("ld.emptySubnets.fold", { n })} ▴` : `${t("ld.emptySubnets", { n })} ▸`}
    </button>
  );
});
