"use client";

import { memo } from "react";
import { useI18n } from "@/lib/i18n";
import { type NodeProps } from "reactflow";
import { HiddenHandles } from "./HiddenHandles";
import { FullNameTag } from "./NameParts";
import type { NamePart } from "@/lib/liveNames";
import { maskGuids } from "@/lib/mask";
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

/** How a subnet reaches the Internet (from the generator's `egressVia`) */
export type EgressInfo = {
  via: "nat" | "lb-snat" | "default" | "none" | "unknown";
  /** NAT Gateway name and node id (the chip selects the NAT card on the egress rail) */
  name?: string;
  natId?: string;
};

export type PeeringInfo = { name: string; state: string };

export type GroupNodeData = {
  label: string;
  icon: DiagramIconKind;
  subtitle?: string;  // CIDR display (addressSpace for VNet, prefix for Subnet)
  region?: string;    // Azure region code — shown as badge on VNet nodes
  nsgBadges?: NsgBadgeInfo[];
  onNsgSelect?: (nodeId: string) => void;
  egress?: EgressInfo;
  /** NICs without a VM in this subnet (folded into a count) */
  nicCount?: number;
  peerings?: PeeringInfo[];
  /** Subnet name without the words its VNet repeats (full name in a tag while selected) */
  shortLabel?: string;
  /** The full name split into the words the short name kept and dropped */
  nameParts?: NamePart[];
  /** Selected — shows the full-name tag over a shortened subnet name */
  focused?: boolean;
};

export const GroupNode = memo(function GroupNode({ data }: NodeProps<GroupNodeData>) {
  const { t } = useI18n();
  const { label, icon, subtitle, region, nsgBadges, onNsgSelect, egress, nicCount, peerings, shortLabel, focused, nameParts } = data;
  const scope = scopeStyle(icon);
  const isSubnet = icon === "subnet";

  const nsg = nsgBadges && nsgBadges.length > 0 && (
    <div className={styles.groupNsgBadges}>
      {nsgBadges.map((b) => (
        <button
          key={b.nodeId}
          type="button"
          className={`${styles.nsgBadge} ${styles.nsgBadgeCompact}`}
          onClick={(e) => { e.stopPropagation(); onNsgSelect?.(b.nodeId); }}
          title={b.label}
        >
          <img src={getAzureIconUrl(b.icon)} alt="nsg" width={12} height={12} className={styles.nsgBadgeIcon} />
        </button>
      ))}
    </div>
  );

  return (
    <>
      <div
        className={styles.groupNode}
        style={{ borderColor: scope.borderColor, borderStyle: scope.borderStyle, borderWidth: scope.borderWidth, background: scope.background }}
      >
        {isSubnet ? (
          <div className={styles.subnetHeader}>
            <div className={styles.subnetHeaderLine}>
              {nsg}
              <img src={getAzureIconUrl(icon)} alt={icon} width={16} height={16} className={styles.groupNodeIcon} />
              <span className={styles.groupNodeLabel} title={label}>{shortLabel || label}</span>
              {/* At a distance line 2 is hidden; the outbound path stays visible as a dot here */}
              {egress && <span className={styles.egressDot} data-via={egress.via} title={egress.via === "nat" ? t("ld.egress.nat", { name: egress.name ?? "" }) : t(`ld.egress.${egress.via}`)} />}
            </div>
            <div className={`${styles.subnetHeaderLine} ${styles.lodDetailBlock}`}>
              {subtitle && <span className={styles.groupNodeSubtitle}>{subtitle}</span>}
              {egress && (
                <button
                  type="button"
                  className={styles.egressChip}
                  data-via={egress.via}
                  title={t(`ld.egress.${egress.via}.hint`)}
                  onClick={(e) => { if (egress.natId) { e.stopPropagation(); onNsgSelect?.(egress.natId); } }}
                >
                  {egress.via === "nat" ? t("ld.egress.nat", { name: egress.name ?? "" }) : t(`ld.egress.${egress.via}`)}
                </button>
              )}
              {nicCount ? <span className={styles.nicChip} title={t("ld.nicCount.hint")}>{t("ld.nicCount", { n: nicCount })}</span> : null}
            </div>
          </div>
        ) : (
          <div className={styles.groupNodeHeader}>
            {nsg}
            <img src={getAzureIconUrl(icon)} alt={icon} width={16} height={16} className={styles.groupNodeIcon} />
            <span className={styles.groupNodeLabel} title={label}>{label}</span>
            {region && <span className={styles.groupNodeRegion}>{formatAzureRegion(region)}</span>}
            {subtitle && <span className={styles.groupNodeSubtitle}>{subtitle}</span>}
            {peerings && peerings.length > 0 && (
              <span className={styles.peeringStubs}>
                {peerings.map((p) => (
                  <span key={p.name} className={styles.peeringStub} data-state={p.state === "Connected" ? "ok" : "warn"} title={t("ld.peering.hint", { name: p.name, state: p.state })}>
                    ↔ {p.name}
                  </span>
                ))}
              </span>
            )}
          </div>
        )}
      </div>
      <HiddenHandles />
      {/* The VNet header already shows its full name; subnets get the tag when their name is shortened */}
      {isSubnet && focused && shortLabel && shortLabel !== label && <FullNameTag fullName={maskGuids(label)} original={label} parts={nameParts} offset={2} />}
    </>
  );
});
