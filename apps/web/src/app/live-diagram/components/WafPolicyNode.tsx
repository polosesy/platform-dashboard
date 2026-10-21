"use client";

import { memo, type CSSProperties } from "react";
import { useI18n } from "@/lib/i18n";
import { type NodeProps } from "reactflow";
import type { WafUnit } from "@aud/types";
import { MAX_POLICY_CARDS, type WafSubCard, type WafTone } from "@/lib/liveWaf";
import { middleEllipsis } from "@/lib/liveNames";
import { maskGuids } from "@/lib/mask";
import { LIVE } from "@/lib/liveLayout";
import { HiddenHandles } from "./HiddenHandles";
import { getAzureIconUrl } from "../utils/azureIcons";
import styles from "../styles.module.css";

export type WafPolicyNodeData = {
  card: WafSubCard;
  unit: WafUnit;
  /** The Front Door / Application Gateway card it hangs under */
  parentId: string;
  /** Position under the card (0 = first): the guide line starts at the card for the first, at the one above otherwise */
  index: number;
  onSelect?: (parentId: string, key: string) => void;
  /** "more": show / fold the other policies in place */
  onToggleAll?: (parentId: string) => void;
};

/** A name fitted to a card line: a shortened name ("…" + distinct part) keeps its lead "…" and trims its own middle */
const fitName = (s: string, max: number) => (s.startsWith("…") && [...s].length > max ? `…${middleEllipsis(s.slice(1), max - 1)}` : middleEllipsis(s, max));

const STRIP: Record<WafTone, string> = { neutral: "var(--accent)", public: "var(--warning)", muted: "rgba(var(--ink-rgb), 0.28)" };
const PILL: Record<WafTone, string | undefined> = { neutral: "info", public: "medium", muted: undefined };

/**
 * One WAF policy (or the units without a WAF / not judged) under the card it protects — a resource-card look at the
 * instance height (catalog EDGE-10 / AGW-08). Configuration only: the colour is the policy's mode, never health.
 */
export const WafPolicyNode = memo(function WafPolicyNode({ data }: NodeProps<WafPolicyNodeData>) {
  const { t } = useI18n();
  const { card, unit, parentId, onSelect, onToggleAll } = data;
  const toggle = card.kind === "more";
  const name = card.kind === "policy" ? maskGuids(card.name ?? "")
    : card.kind === "none" ? t("ld.waf.sub.none")
    : card.kind === "unknown" ? t("ld.waf.sub.unknown")
    : toggle ? t(card.expanded ? "ld.waf.sub.lessTitle" : "ld.waf.sub.moreTitle", { n: card.more ?? 0 })
    : t("ld.waf.sub.restTitle", { n: card.more ?? 0 });
  // On the card: the part that tells sibling policies apart (lib/liveWaf shortPolicyNames); the full name in the tooltip
  const shown = card.kind === "policy" ? maskGuids(card.short ?? card.name ?? "") : name;
  const units = t(unit === "listener" ? "ld.waf.sub.listeners" : "ld.waf.sub.domains", { n: card.units });
  const desc = card.kind === "policy"
    ? [units, unit === "listener" && card.level ? t(`ld.waf.level.${card.level}`) : t("ld.waf.sub.rules", { m: card.managed ?? "—", c: card.custom ?? 0 })].join(" · ")
    : card.kind === "none" ? [units, card.endpointNone ? t("ld.waf.sub.endpointNone", { n: card.endpointNone }) : null].filter(Boolean).join(" · ")
    : card.kind === "unknown" ? units
    : toggle ? t(card.expanded ? "ld.waf.sub.less" : "ld.waf.sub.more", { n: MAX_POLICY_CARDS })
    : t("ld.waf.sub.rest");
  const pill = card.kind === "more" || card.kind === "rest" ? null : t(card.pill);
  // The toggle shows / folds the other policies in place (same node id in both states, so focus stays on it);
  // everything else opens the WAF panel
  const act = () => (toggle ? onToggleAll?.(parentId) : onSelect?.(parentId, card.key));

  // Guide line from the card it belongs to (tree "└"): from the parent's bottom edge for the first sub-card, from
  // the middle of the one above for the others — so the column reads as "these belong to that card"
  const up = data.index === 0 ? LIVE.SUB_TOP : LIVE.SUB_GAP + LIVE.SUB_H / 2;
  return (
    <div className={styles.subCardWrap}>
    <span className={styles.subLink} style={{ "--up": `${up}px`, "--mid": `${LIVE.SUB_H / 2}px` } as CSSProperties} aria-hidden="true" />
    <div
      className={`${styles.card} ${styles.cardInstance} ${toggle ? styles.wafToggle : ""}`}
      style={{ "--status": STRIP[card.tone] } as CSSProperties}
      title={[name, pill, desc].filter(Boolean).join(" · ")}
      aria-label={[name, pill].filter(Boolean).join(" · ")}
      aria-expanded={toggle ? !!card.expanded : undefined}
      role="button"
      tabIndex={0}
      onClick={(e) => { e.stopPropagation(); act(); }}
      // stopPropagation: React Flow would also select the node on Enter and run the same action twice
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); act(); } }}
    >
      <HiddenHandles />
      <span className={styles.cardStrip} aria-hidden="true" />

      <div className={`${styles.cardBody} ${styles.lodDetail} ${styles.instDetail}`}>
        <div className={styles.cardRow1}>
          <img src={getAzureIconUrl("waf")} alt="" width={18} height={18} />
          <span className={styles.cardName}>{fitName(shown, pill ? 15 : 20)}</span>
          {pill ? <span className={styles.cardPill} data-tone={PILL[card.tone]}>{pill}</span> : null}
          {toggle ? <span className={styles.wafChevron} aria-hidden="true">{card.expanded ? "▴" : "▾"}</span> : null}
        </div>
        <div className={styles.cardRow2}>
          <span className={styles.cardDesc}>{desc}</span>
        </div>
      </div>

      <div className={`${styles.cardBody} ${styles.lodSummary}`}>
        <div className={styles.cardRow1}>
          <img src={getAzureIconUrl("waf")} alt="" width={24} height={24} />
          <span className={styles.cardNameBig}>{fitName(shown, 13)}</span>
          {toggle ? <span className={styles.wafChevron} aria-hidden="true">{card.expanded ? "▴" : "▾"}</span> : null}
        </div>
      </div>

      <div className={`${styles.cardBody} ${styles.lodGlance}`}>
        <img src={getAzureIconUrl("waf")} alt="" width={32} height={32} />
        <span className={styles.cardNameHuge}>{fitName(shown, 16)}</span>
      </div>
    </div>
    </div>
  );
});
