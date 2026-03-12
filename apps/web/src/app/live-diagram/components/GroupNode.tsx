"use client";

import { memo } from "react";
import { Handle, Position, type NodeProps, NodeResizer } from "reactflow";
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

export type NatGwBadgeInfo = {
  nodeId: string;
  label: string;
  azureResourceId?: string;
};

export type GroupNodeData = {
  label: string;
  icon: DiagramIconKind;
  subtitle?: string;  // CIDR display (addressSpace for VNet, prefix for Subnet)
  region?: string;    // Azure region code — shown as badge on VNet nodes
  nsgBadges?: NsgBadgeInfo[];
  natGwBadge?: NatGwBadgeInfo;
  onNsgSelect?: (nodeId: string) => void;
  onNatGwToggle?: (nodeId: string) => void;
};

export const GroupNode = memo(function GroupNode({ data, selected }: NodeProps<GroupNodeData>) {
  const { label, icon, subtitle, region, nsgBadges, natGwBadge, onNsgSelect, onNatGwToggle } = data;
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
          {/* NAT GW badge — right corner of subnet header, click to expand to card */}
          {natGwBadge && (
            <button
              type="button"
              className={styles.natGwBadge}
              style={{ marginLeft: "auto" }}
              onClick={(e) => { e.stopPropagation(); onNatGwToggle?.(natGwBadge.nodeId); }}
              title={`${natGwBadge.label} — 클릭하여 카드 펼치기`}
            >
              <img
                src={getAzureIconUrl("natGateway")}
                alt="nat-gateway"
                width={16}
                height={16}
              />
            </button>
          )}
        </div>
      </div>
      {/* Hidden handles — allow programmatic edges from/to subnet GroupNodes */}
      <Handle type="source" position={Position.Right} style={{ opacity: 0, pointerEvents: "none" }} />
      <Handle type="target" position={Position.Left} style={{ opacity: 0, pointerEvents: "none" }} />
      {/* NAT GW source handle — orange dot positioned at badge right edge (inside subnet border) */}
      {natGwBadge && (
        <Handle
          id="natgw-source"
          type="source"
          position={Position.Right}
          style={{
            top: 19,
            right: 8,
            width: 8,
            height: 8,
            background: "rgba(251, 146, 60, 0.85)",
            border: "2px solid rgb(251, 146, 60)",
            borderRadius: "50%",
            pointerEvents: "none",
          }}
        />
      )}
    </>
  );
});
