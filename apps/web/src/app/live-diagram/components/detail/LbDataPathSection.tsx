"use client";

import type { DiagramNodeSpec } from "@aud/types";
import { lbDataPath } from "@/lib/lbDataPath";
import { formatMetric } from "@/lib/liveMetricFormat";
import { useI18n } from "@/lib/i18n";
import { Section, TwoLine } from "./primitives";
import styles from "../../styles.module.css";

const GLYPH = { ok: "●", low: "▲", down: "■", unmeasured: "○" } as const;

/**
 * A load balancer's data path per rule-bound frontend (lib/lbDataPath): the card's single number is Azure's average over
 * every frontend IP × port — no loss rate — so the frontends are listed with their own value and the state is judged
 * on them (API healthEvidence). A frontend at 0 % usually has no healthy backend behind its rules (Learn: data path
 * availability needs a healthy backend instance) — the panel says where to look, not why.
 */
export function LbDataPathSection({ node, metrics }: { node: DiagramNodeSpec; metrics: Record<string, number | null> }) {
  const { t } = useI18n();
  const dp = lbDataPath(node.metadata?.frontends, metrics);
  if (!dp) return null;
  const avg = metrics.dataPath;
  return (
    <Section id="lbdp" title={t("ld.lbdp.title")} count={dp.frontends.length}>
      {dp.frontends.map((f) => {
        const v = f.value == null ? null : formatMetric("dataPath", f.value);
        return (
          <TwoLine
            key={f.ip}
            mono
            copy={f.ip}
            main={<>{GLYPH[f.level]} {f.ip}</>}
            sub={v ? `${t("ld.metric.dataPath")} ${v.value}${v.unit} · ${t(`ld.lbdp.level.${f.level}`)}` : t("ld.lbdp.level.unmeasured")}
          />
        );
      })}
      {avg != null ? <div className={styles.dpMuted}>{t("ld.lbdp.avgNote", { avg: formatMetric("dataPath", avg).value })}</div> : null}
      {dp.down > 0 ? <div className={styles.dpMuted}>{t("ld.lbdp.downHint")}</div> : null}
    </Section>
  );
}
