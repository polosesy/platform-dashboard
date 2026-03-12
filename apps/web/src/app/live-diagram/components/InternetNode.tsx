"use client";

import { memo } from "react";
import { Handle, Position, type NodeProps } from "reactflow";
import styles from "../styles.module.css";

export type InternetNodeData = {
  label: string;
  outboundMethodCount?: number;
  hasDeprecatedPath?: boolean;
};

function InternetNodeInner({ data }: NodeProps<InternetNodeData>) {
  const { label, outboundMethodCount, hasDeprecatedPath } = data;

  return (
    <div className={`${styles.internetNode} ${hasDeprecatedPath ? styles.internetNodeWarn : ""}`}>
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />

      {/* Globe icon (inline SVG — no asset dependency) */}
      <div className={styles.internetNodeIcon}>
        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5" />
          <path
            d="M12 3C12 3 9 7 9 12C9 17 12 21 12 21"
            stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
          />
          <path
            d="M12 3C12 3 15 7 15 12C15 17 12 21 12 21"
            stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
          />
          <path d="M3.5 9H20.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <path d="M3.5 15H20.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </div>

      <span className={styles.internetNodeLabel}>{label}</span>

      {outboundMethodCount !== undefined && outboundMethodCount > 0 && (
        <span className={styles.internetNodeCount}>{outboundMethodCount}개 경로</span>
      )}

      {hasDeprecatedPath && (
        <div className={styles.internetNodeDeprecatedBadge}>
          기본 아웃바운드 감지
        </div>
      )}

      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
    </div>
  );
}

export const InternetNode = memo(InternetNodeInner);
