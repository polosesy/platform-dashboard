"use client";

// Data sources of this page, honestly: ✓ read now · ↗ Grafana link only · ✕ blocked · ! error · – not set up / not read.
// Loki · Tempo · Pyroscope · Grafana come from /api/observability/sources; unset ones fold into one chip.

import type { ObservabilityDataSourceStatus, ObservabilitySourcesResponse } from "@aud/types";
import { dateLocale, useI18n } from "@/lib/i18n";
import { CHIP_GLYPH, sourceChips, type ChipState, type SourceChip } from "@/lib/dataSources";
import styles from "../styles.module.css";

const TONE: Record<ChipState, string> = {
  read: styles.dsRead!, link: styles.dsLink!, blocked: styles.dsBlocked!, error: styles.dsError!, off: styles.dsOff!, notRead: styles.dsOff!,
};

export function DataSourceBadges({ status, sources }: { status: ObservabilityDataSourceStatus | null; sources: ObservabilitySourcesResponse | null }) {
  const { t, locale } = useI18n();
  const { shown, folded } = sourceChips(status, sources?.sources ?? null);
  if (shown.length === 0) return null;
  const tip = (c: SourceChip) => [
    t(`ob.ds.role.${c.kind}`),
    `${t(`ob.ds.state.${c.state}`)}${c.state === "blocked" ? ` — ${t("ob.ds.why.blocked")}` : c.state === "error" ? ` — ${t("ob.ds.why.error", { detail: c.detail ?? "?" })}` : c.state === "notRead" ? ` — ${t("ob.ds.why.notRead")}` : c.state === "off" && c.kind !== "appInsights" ? ` — ${t("ob.ds.why.linkHint")}` : ""}`,
    ...(c.pipeline ? [t(`ob.ds.pipeline.${c.pipeline}`)] : []),
    ...(c.kind === "loki" && sources?.lokiCheckedAt ? [t("ob.ds.checkedAt", { at: new Date(sources.lokiCheckedAt).toLocaleTimeString(dateLocale(locale)) })] : []),
  ].join("\n");
  const loud = (s: ChipState) => s === "blocked" || s === "error";

  return (
    <ul className={styles.dsBadges} aria-label={t("ob.dataSources")}>
      {shown.map((c) => {
        const body = (
          <>
            <span aria-hidden="true">{CHIP_GLYPH[c.state]}</span> {c.label}
            <span className={loud(c.state) ? styles.dsWord : styles.srOnly}> {t(`ob.ds.state.${c.state}`)}</span>
          </>
        );
        return (
          <li key={c.kind} className={`${styles.dsBadge} ${TONE[c.state]}`} title={tip(c)}>
            {c.href && c.state === "link" ? <a href={c.href} target="_blank" rel="noreferrer">{body}</a> : body}
            {c.href && c.state !== "link" && c.kind !== "grafana" ? <a className={styles.dsExtra} href={c.href} target="_blank" rel="noreferrer" aria-label={`${c.label} Grafana`}>↗</a> : null}
          </li>
        );
      })}
      {folded.length > 0 && (
        <li className={`${styles.dsBadge} ${styles.dsOff}`} title={folded.map((c) => `${c.label} — ${t(`ob.ds.role.${c.kind}`)}`).join("\n")}>
          {t("ob.ds.folded", { n: folded.length })}
        </li>
      )}
    </ul>
  );
}
