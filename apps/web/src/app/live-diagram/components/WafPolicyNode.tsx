"use client";

import { memo, type CSSProperties } from "react";
import { useI18n } from "@/lib/i18n";
import { type NodeProps } from "reactflow";
import type { WafUnit } from "@aud/types";
import type { WafSubCard, WafTone } from "@/lib/liveWaf";
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
};

const STRIP: Record<WafTone, string> = { neutral: "var(--accent)", public: "var(--warning)", muted: "rgba(var(--ink-rgb), 0.28)" };
const PILL: Record<WafTone, string | undefined> = { neutral: "info", public: "medium", muted: undefined };

/**
 * One WAF policy (or the units without a WAF / not judged) under the card it protects — a resource-card look at the
 * instance height (catalog EDGE-10 / AGW-08). Configuration only: the colour is the policy's mode, never health.
 */
export const WafPolicyNode = memo(function WafPolicyNode({ data }: NodeProps<WafPolicyNodeData>) {
  const { t } = useI18n();
  const { card, unit, parentId, onSelect } = data;
  const name = card.kind === "policy" ? maskGuids(card.name ?? "")
    : card.kind === "none" ? t("ld.waf.sub.none")
    : card.kind === "unknown" ? t("ld.waf.sub.unknown")
    : t("ld.waf.sub.moreTitle", { n: card.more ?? 0 });
  const units = t(unit === "listener" ? "ld.waf.sub.listeners" : "ld.waf.sub.domains", { n: card.units });
  const desc = card.kind === "policy"
    ? [units, unit === "listener" && card.level ? t(`ld.waf.level.${card.level}`) : t("ld.waf.sub.rules", { m: card.managed ?? "—", c: card.custom ?? 0 })].join(" · ")
    : card.kind === "none" ? [units, card.endpointNone ? t("ld.waf.sub.endpointNone", { n: card.endpointNone }) : null].filter(Boolean).join(" · ")
    : card.kind === "unknown" ? units
    : t("ld.waf.sub.more");
  const pill = card.kind === "more" ? null : t(card.pill);

  // Guide line from the card it belongs to (tree "└"): from the parent's bottom edge for the first sub-card, from
  // the middle of the one above for the others — so the column reads as "these belong to that card"
  const up = data.index === 0 ? LIVE.SUB_TOP : LIVE.SUB_GAP + LIVE.SUB_H / 2;
  return (
    <div className={styles.subCardWrap}>
    <span className={styles.subLink} style={{ "--up": `${up}px`, "--mid": `${LIVE.SUB_H / 2}px` } as CSSProperties} aria-hidden="true" />
    <div
      className={`${styles.card} ${styles.cardInstance}`}
      style={{ "--status": STRIP[card.tone] } as CSSProperties}
      title={[name, pill, desc].filter(Boolean).join(" · ")}
      aria-label={[name, pill].filter(Boolean).join(" · ")}
      role="button"
      tabIndex={0}
      onClick={(e) => { e.stopPropagation(); onSelect?.(parentId, card.key); }}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect?.(parentId, card.key); } }}
    >
      <HiddenHandles />
      <span className={styles.cardStrip} aria-hidden="true" />

      <div className={`${styles.cardBody} ${styles.lodDetail} ${styles.instDetail}`}>
        <div className={styles.cardRow1}>
          <img src={getAzureIconUrl("waf")} alt="" width={18} height={18} />
          <span className={styles.cardName}>{middleEllipsis(name, 18)}</span>
          {pill ? <span className={styles.cardPill} data-tone={PILL[card.tone]}>{pill}</span> : null}
        </div>
        <div className={styles.cardRow2}>
          <span className={styles.cardDesc}>{desc}</span>
        </div>
      </div>

      <div className={`${styles.cardBody} ${styles.lodSummary}`}>
        <div className={styles.cardRow1}>
          <img src={getAzureIconUrl("waf")} alt="" width={24} height={24} />
          <span className={styles.cardNameBig}>{middleEllipsis(name, 13)}</span>
        </div>
      </div>

      <div className={`${styles.cardBody} ${styles.lodGlance}`}>
        <img src={getAzureIconUrl("waf")} alt="" width={32} height={32} />
        <span className={styles.cardNameHuge}>{middleEllipsis(name, 16)}</span>
      </div>
    </div>
    </div>
  );
});
