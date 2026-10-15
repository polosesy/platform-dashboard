"use client";

import { useEffect, useRef, useState } from "react";
import type { DiagramNodeSpec, LivePeering } from "@aud/types";
import { useI18n } from "@/lib/i18n";
import { parsePeerings, peeringIssue, peeringSummary, sortPeerings } from "@/lib/livePeering";
import { maskGuids } from "@/lib/mask";
import { Button } from "@/components/ui";
import { CopyButton, KV, Section } from "./primitives";
import styles from "../../styles.module.css";

/**
 * A VNet's peerings (catalog EDGE-02): this side's state and flags, the other side's when the dashboard sees that
 * VNet ("확인 불가" otherwise), gateway transit, address spaces. A row opens itself when its header chip was
 * clicked. No Azure call — everything comes from the diagram.
 */
export function PeeringSection({ node, focusKey, onOpenVnet, onAddVnet }: {
  node: DiagramNodeSpec;
  focusKey?: string | null;
  onOpenVnet?: (vnetNodeId: string) => void;
  onAddVnet?: (vnetNodeId: string) => void;
}) {
  const { t } = useI18n();
  const list = sortPeerings(parsePeerings(node.metadata?.peerings));
  const [open, setOpen] = useState<string | null>(focusKey ?? null);
  const rowRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { if (focusKey !== undefined) setOpen(focusKey ?? null); }, [focusKey]);
  useEffect(() => { if (open && rowRef.current) rowRef.current.scrollIntoView({ block: "nearest" }); }, [open]);
  if (!list.length) return null;
  const sum = peeringSummary(list);
  const total = Number(node.metadata?.peeringCount ?? list.length);
  const yesNo = (v: boolean | null | undefined) => (v == null ? t("ld.peering.unknownValue") : v ? t("ld.peering.yes") : t("ld.peering.no"));
  const portalBase = node.azureResourceId && !node.azureResourceId.startsWith("/subscriptions/mock/") ? `https://portal.azure.com/#@/resource${node.azureResourceId}` : null;

  const detail = (p: LivePeering) => {
    const issue = peeringIssue(p);
    const spaceDiffers = p.remoteCurrentSpace && p.remoteCurrentSpace.join() !== p.remoteSpace.join();
    return (
      <div className={styles.peeringDetail}>
        {issue.reasons.length ? <div className={styles.dpMuted}>{issue.reasons.map((r) => t(r)).join(" · ")}</div> : null}
        <KV label={t("ld.peering.col.state")}>
          {t(`ld.peering.state.${p.state}`)}{p.sync ? ` · ${t(`ld.peering.sync.${p.sync}`)}` : ""}
          {" / "}{p.other ? `${t(`ld.peering.state.${p.other.state}`)}${p.other.sync ? ` · ${t(`ld.peering.sync.${p.other.sync}`)}` : ""}` : t("ld.peering.otherUnknown")}
        </KV>
        {(["access", "forwarded", "gatewayTransit", "useRemoteGateways"] as const).map((f) => (
          <KV key={f} label={t(`ld.peering.flag.${f}`)}>{yesNo(p[f])} / {p.other ? yesNo(p.other[f]) : t("ld.peering.otherUnknown")}</KV>
        ))}
        {p.transit ? <KV label={t("ld.peering.transitLabel")}>{t(`ld.peering.transit.${p.transit}`)}</KV> : null}
        <KV label={t("ld.peering.remoteSpace")}>{p.remoteSpace.length ? p.remoteSpace.join(", ") : t("ld.peering.unknownValue")}</KV>
        {spaceDiffers ? <KV label={t("ld.peering.remoteCurrent")}>{p.remoteCurrentSpace!.join(", ")}</KV> : null}
        {p.localSubnets || p.remoteSubnets ? (
          <KV label={t("ld.peering.subnetPeering")}>{[...(p.localSubnets ?? []), "→", ...(p.remoteSubnets ?? [])].join(" ")}</KV>
        ) : null}
        <div className={styles.dpActions}>
          {p.id ? (
            <>
              <Button size="sm" onClick={() => onOpenVnet?.(p.id!)}>{t("ld.peering.open")}</Button>
              <Button size="sm" onClick={() => onAddVnet?.(p.id!)}>{t("ld.peering.add")}</Button>
            </>
          ) : <span className={styles.dpMuted}>{t("ld.peering.outside")}</span>}
          {portalBase && p.link ? <a className={styles.dpPortal} href={`${portalBase}/virtualNetworkPeerings/${encodeURIComponent(p.link)}`} target="_blank" rel="noreferrer">{t("ld.panel.portal")} ↗</a> : null}
          {node.azureResourceId && p.link ? <CopyButton value={`${node.azureResourceId}/virtualNetworkPeerings/${p.link}`} /> : null}
        </div>
      </div>
    );
  };

  return (
    <Section id="peerings" title={t("ld.peering.title")} count={total}>
      <div className={styles.dpMuted}>
        {t("ld.peering.overview", { connected: list.filter((p) => p.state === "Connected").length, problems: sum.problems, provides: sum.provides, uses: sum.uses })}
        {total > list.length ? ` · ${t("ld.peering.capped", { n: list.length, total })}` : ""}
      </div>
      {list.map((p) => {
        const issue = peeringIssue(p);
        const isOpen = open === p.key;
        return (
          <div key={p.key} ref={isOpen ? rowRef : undefined} className={styles.peeringItem} data-open={isOpen || undefined}>
            <button type="button" className={styles.dpConn} onClick={() => setOpen(isOpen ? null : p.key)} aria-expanded={isOpen}>
              <span className={styles.dpConnArrow}>{p.transit ? "⇄" : "↔"}</span>
              <span className={styles.dpConnRel} data-tone={issue.tone}>{t(`ld.peering.state.${p.state}`)}</span>
              <span className={styles.dpConnPeer}>
                <span className={styles.dpConnName}><span className={styles.dpConnText} title={maskGuids(p.name)}>{maskGuids(p.name)}</span></span>
                <span className={styles.dpConnWhere}>{p.remoteSpace.slice(0, 2).join(", ")}{p.remoteSpace.length > 2 ? ` +${p.remoteSpace.length - 2}` : ""}{p.id ? "" : ` · ${t("ld.peering.outsideShort")}`}</span>
              </span>
            </button>
            {isOpen ? detail(p) : null}
          </div>
        );
      })}
    </Section>
  );
}
