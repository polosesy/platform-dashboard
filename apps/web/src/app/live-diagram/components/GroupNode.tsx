"use client";

import { memo } from "react";
import type { LivePeering } from "@aud/types";
import { peeringIssue, peeringSummary, sortPeerings } from "@/lib/livePeering";
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

export type PeeringInfo = LivePeering;

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
  /** How many peering name chips fit on the header's peering row (lib/livePeering peeringChipFit) */
  peerFit?: number;
  /** A peering chip, the summary or "+n" was clicked (key null = the whole list) */
  onPeeringSelect?: (vnetId: string, key: string | null) => void;
  /** Subnet name without the words its VNet repeats (full name in a tag while selected) */
  shortLabel?: string;
  /** The full name split into the words the short name kept and dropped */
  nameParts?: NamePart[];
  /** Selected — shows the full-name tag over a shortened subnet name */
  focused?: boolean;
};

export const GroupNode = memo(function GroupNode({ id, data }: NodeProps<GroupNodeData>) {
  const { t } = useI18n();
  const { label, icon, subtitle, region, nsgBadges, onNsgSelect, egress, nicCount, peerings, shortLabel, focused, nameParts, peerFit = 0, onPeeringSelect } = data;
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
          </div>
        )}
        {/* Peerings: one row under the VNet header — summary, the chips that fit (problems first), "+n" */}
        {!isSubnet && peerings && peerings.length > 0 && (() => {
          const sorted = sortPeerings(peerings);
          const sum = peeringSummary(peerings);
          const shown = sorted.slice(0, peerFit);
          const pick = (key: string | null) => (e: React.MouseEvent) => { e.stopPropagation(); onPeeringSelect?.(id, key); };
          return (
            <div className={`${styles.peeringRow} nodrag nopan`}>
              <button type="button" className={styles.peeringSummary} data-tone={sum.problems ? "warn" : undefined} onClick={pick(null)} title={t("ld.peering.summaryHint")}>
                ↔ {t("ld.peering.summary", { n: sum.n })}{sum.problems ? ` · ${t("ld.peering.problems", { n: sum.problems })}` : ""}
              </button>
              {shown.map((p) => {
                const issue = peeringIssue(p);
                return (
                  <button key={p.key} type="button" className={styles.peeringStub} data-state={issue.tone} onClick={pick(p.key)}
                    title={[p.name, t(`ld.peering.state.${p.state}`), ...issue.reasons.map((r) => t(r)), p.transit ? t(`ld.peering.transit.${p.transit}`) : null].filter(Boolean).join(" · ")}>
                    {p.transit ? "⇄ " : "↔ "}{p.name}
                  </button>
                );
              })}
              {sorted.length > shown.length ? (
                <button type="button" className={styles.peeringMore} onClick={pick(null)} title={t("ld.peering.summaryHint")}>+{sorted.length - shown.length}</button>
              ) : null}
            </div>
          );
        })()}
      </div>
      <HiddenHandles />
      {/* The VNet header already shows its full name; subnets get the tag when their name is shortened */}
      {isSubnet && focused && shortLabel && shortLabel !== label && <FullNameTag fullName={maskGuids(label)} original={label} parts={nameParts} offset={2} />}
    </>
  );
});
