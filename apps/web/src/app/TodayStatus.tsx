"use client";

// 개요 › 오늘의 상태 (design draft ⑦ — "the one big thing per screen"): one sentence and a short list from what other
// screens already read. Problems first; a source that did not answer says so (never a zero). Pure: lib/todayStatus.ts.

import Link from "next/link";
import type { HealthSummary, NotificationsResponse, SecurityPostureResponse } from "@aud/types";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiQuery } from "@/lib/useApiQuery";
import { dateLocale, useI18n } from "@/lib/i18n";
import { todayStatus, type TodayLevel } from "@/lib/todayStatus";
import { Chip, Panel, type ChipLevel } from "@/components/ui";
import s from "./home.module.css";

const CHIP: Record<TodayLevel, ChipLevel> = { danger: "danger", warn: "warn", ok: "ok", unknown: "unknown" };

export function TodayStatus() {
  const { t, locale } = useI18n();
  const alerts = useApiQuery("today:alerts", (token) => fetchJsonWithBearer<NotificationsResponse>(apiUrl("/api/notifications"), token));
  const health = useApiQuery("today:health", (token) => fetchJsonWithBearer<HealthSummary>(apiUrl("/api/health/summary"), token));
  const security = useApiQuery("today:security", (token) => fetchJsonWithBearer<SecurityPostureResponse>(apiUrl("/api/security/posture"), token));
  const loading = alerts.loading || health.loading || security.loading;

  const st = todayStatus({
    alerts: {
      failed: !!alerts.error,
      data: alerts.data ? { firingUnacked: alerts.data.counts.firingUnacked, sev1: alerts.data.counts.bySeverity.sev1 ?? 0, sev2: alerts.data.counts.bySeverity.sev2 ?? 0 } : null,
    },
    health: {
      failed: !!health.error,
      sample: !!health.data?.note && /mock|signin/.test(health.data.note),
      data: health.data ? { unavailable: health.data.unavailable, degraded: health.data.degraded, total: health.data.available + health.data.degraded + health.data.unavailable + health.data.unknown } : null,
    },
    security: {
      failed: !!security.error || (!!security.data && !security.data.affected),
      sample: security.data?.source === "mock",
      data: security.data?.affected ? { high: security.data.affected.High, medium: security.data.affected.Medium } : null,
    },
  });
  const headline = loading ? t("today.loading")
    : st.problems ? t("today.headline.problems", { n: st.problems })
    : st.unchecked ? t("today.headline.unchecked", { n: st.unchecked })
    : t("today.headline.ok");

  return (
    <Panel title={t("today.title")} sub={new Date().toLocaleString(dateLocale(locale), { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" })}
      actions={st.sample ? <Chip level="info" glyph={false}>{t("common.sampleData")}</Chip> : undefined}>
      <p className={s.todayHeadline}>{headline}</p>
      <ul className={s.todayList}>
        {st.rows.map((r) => (
          <li key={r.id}>
            <Link href={r.href} className={s.todayRow}>
              <Chip level={CHIP[r.level]}>{t(`today.level.${r.level}`)}</Chip>
              <span className={s.todayText}>{t(r.key, r.params)}</span>
              <span className={s.todayGo} aria-hidden="true">→</span>
            </Link>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
