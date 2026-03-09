"use client";

import { memo } from "react";
import { type NodeProps, NodeResizer } from "reactflow";
import { getAzureIconUrl } from "../utils/azureIcons";
import { scopeStyle } from "../utils/designTokens";
import { formatAzureRegion } from "../utils/regionFormat";
import type { DiagramIconKind } from "@aud/types";
import styles from "../styles.module.css";

export type NsgBadgeInfo = {
  nodeId: string;
  label: string;
  icon: DiagramIconKind;
  azureResourceId?: string;
};

export type GroupNodeData = {
  label: string;
  icon: DiagramIconKind;
  subtitle?: string;  // CIDR display (addressSpace for VNet, prefix for Subnet)
  region?: string;    // Azure region code — shown as badge on VNet nodes
  nsgBadges?: NsgBadgeInfo[];
  onNsgSelect?: (nodeId: string) => void;
};

export const GroupNode = memo(function GroupNode({ data, selected }: NodeProps<GroupNodeData>) {
  const { label, icon, subtitle, region, nsgBadges, onNsgSelect } = data;
  const scope = scopeStyle(icon);

  return (
    <>
      <NodeResizer
        isVisible={selected}
        minWidth={200}
        minHeight={120}
        color={scope.borderColor}
        handleClassName={styles.groupResizeHandle}
        lineClassName={styles.groupResizeLine}
      />
      <div
        className={styles.groupNode}
        style={{
          borderColor: scope.borderColor,
          borderStyle: scope.borderStyle,
          borderWidth: scope.borderWidth,
          background: scope.background,
        }}
      >
        <div className={styles.groupNodeHeader}>
          {/* NSG badge(s) at top-left — Cat 1: subnet-attached NSGs, compact icon-only */}
          {nsgBadges && nsgBadges.length > 0 && (
            <div className={styles.groupNsgBadges}>
              {nsgBadges.map((nsg) => (
                <button
                  key={nsg.nodeId}
                  type="button"
                  className={`${styles.nsgBadge} ${styles.nsgBadgeCompact}`}
                  onClick={(e) => { e.stopPropagation(); onNsgSelect?.(nsg.nodeId); }}
                  title={nsg.label}
                >
                  <img
                    src={getAzureIconUrl(nsg.icon)}
                    alt="nsg"
                    width={12}
                    height={12}
                    className={styles.nsgBadgeIcon}
                  />
                </button>
              ))}
            </div>
          )}
          <img
            src={getAzureIconUrl(icon)}
            alt={icon}
            width={16}
            height={16}
            className={styles.groupNodeIcon}
          />
          <span className={styles.groupNodeLabel}>{label}</span>
          {region && <span className={styles.groupNodeRegion}>{formatAzureRegion(region)}</span>}
          {subtitle && <span className={styles.groupNodeSubtitle}>{subtitle}</span>}
        </div>
      </div>
    </>
  );
});
