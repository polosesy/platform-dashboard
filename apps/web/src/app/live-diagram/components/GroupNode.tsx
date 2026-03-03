"use client";

import { memo } from "react";
import { type NodeProps, NodeResizer } from "reactflow";
import { getAzureIconUrl } from "../utils/azureIcons";
import { scopeStyle } from "../utils/designTokens";
import type { DiagramIconKind } from "@aud/types";
import styles from "../styles.module.css";

export type GroupNodeData = {
  label: string;
  icon: DiagramIconKind;
};

export const GroupNode = memo(function GroupNode({ data, selected }: NodeProps<GroupNodeData>) {
  const { label, icon } = data;
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
    </>
  );
});
