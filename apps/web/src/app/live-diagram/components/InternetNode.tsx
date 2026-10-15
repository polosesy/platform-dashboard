"use client";

import { memo } from "react";
import { type NodeProps } from "reactflow";
import { HiddenHandles } from "./HiddenHandles";
import { useI18n } from "@/lib/i18n";
import styles from "../styles.module.css";

export type InternetNodeData = {
  label: string;
  /** "ingress" = left terminal feeding public entry points; otherwise the outbound end of the egress rail */
  direction?: "ingress" | "egress";
  /** Egress: outbound paths ending here. Ingress: public entry points it feeds */
  count?: number;
  hasDeprecatedPath?: boolean;
};

function InternetNodeInner({ data }: NodeProps<InternetNodeData>) {
  const { t } = useI18n();
  const { count, hasDeprecatedPath } = data;
  const ingress = data.direction === "ingress";

  return (
    <div className={`${styles.internetNode} ${hasDeprecatedPath ? styles.internetNodeWarn : ""}`} data-direction={ingress ? "ingress" : "egress"}>
      <HiddenHandles />

      {/* Globe icon (inline SVG — no asset dependency) */}
      <div className={styles.internetNodeIcon}>
        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5" />
          <path d="M12 3C12 3 9 7 9 12C9 17 12 21 12 21" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <path d="M12 3C12 3 15 7 15 12C15 17 12 21 12 21" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <path d="M3.5 9H20.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <path d="M3.5 15H20.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </div>

      <span className={styles.internetNodeLabel}>{t(ingress ? "ld.internetIn" : "ld.internetOut")}</span>

      {count !== undefined && count > 0 && (
        <span className={styles.internetNodeCount}>{t(ingress ? "ld.entries" : "ld.paths", { n: count })}</span>
      )}

      {hasDeprecatedPath && <div className={styles.internetNodeDeprecatedBadge}>{t("ld.defaultOutbound")}</div>}
    </div>
  );
}

export const InternetNode = memo(InternetNodeInner);
