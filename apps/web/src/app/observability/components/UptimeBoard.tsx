"use client";

// SLO › 글로벌 업타임 — 주요 서비스 (2026-11-19, 2nd): a status page for the services the team designated (SLO › 설정
// '업타임 보드', settings `uptime.services`, in that order). One row per service — name, the newest judged bar's grade
// on the right ("Operational"), the bars, "start —— n % uptime —— now" — and over them a "전체" row (per bar the worst
// grade of the services). Every row shares one time grid (the API reads them with one end and one step) and one merge
// factor (the board's width), so a bar means the same hours in every row. API services/sloUptime.ts getSloUptimeBoard.

import type { SloUptimeBoardResponse, SloUptimeGrade } from "@aud/types";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiQuery } from "@/lib/useApiQuery";
import { dateLocale, useI18n } from "@/lib/i18n";
import { atParam, type TimeRange } from "@/lib/timeRange";
import { gradeCounts, latestGrade, mergeBuckets, mergeFactor, overallBars, type UptimeBar } from "@/lib/sloUptimeView";
import { Button, EmptyState, ErrorNotice, LinkButton, LoadingState, Notice, Panel } from "@/components/ui";
import { UptimeBars, UptimeLegend, useWidth } from "./UptimeBars";
import styles from "../styles.module.css";

export function UptimeBoard({ clusterId, range, onSettings, onOpen }: {
  clusterId: string;
  range: TimeRange;
  onSettings: () => void;
  /** a service's name opens its SLO detail */
  onOpen: (namespace: string, application: string) => void;
}) {
  const { t, locale } = useI18n();
  const atQ = atParam(range);
  const q = useApiQuery(`obs-slo-board:${clusterId}:${atQ ?? "now"}`, (token) =>
    fetchJsonWithBearer<SloUptimeBoardResponse>(apiUrl("/api/observability/slo/uptime-board", { clusterId, at: atQ }), token),
  );
  const d = q.data?.clusterId === clusterId ? q.data : null;
  const [ref, width] = useWidth<HTMLDivElement>();
  const lc = dateLocale(locale);
  const fmt = (ms: number) => new Date(ms).toLocaleString(lc, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

  const n = d?.services[0]?.buckets.length ?? 0;
  const k = mergeFactor(n, width);
  const rows: Array<{ key: string; namespace: string; application: string; bars: UptimeBar[]; failed: string | null }> = (d?.services ?? []).map((s) => ({
    key: `${s.namespace}/${s.application}`, namespace: s.namespace, application: s.application,
    bars: s.metricsState === "ok" && s.buckets.length === n ? mergeBuckets(s.buckets, k, d!.bucketMinutes, s.target) : [],
    failed: s.metricsState === "ok" ? null : t(`hb.m.state.${s.metricsState}`),
  }));
  const measured = rows.filter((r) => r.bars.length);
  const overall = measured.length >= 2 ? overallBars(measured) : null;
  const sub = d ? t("ob.slo.ub.sub", { days: d.windowDays, src: t(`ob.slo.ub.src.${d.windowSource}`) }) : undefined;

  const body = q.error ? <ErrorNotice error={q.error} />
    : !d ? <LoadingState />
    : d.source === "none" ? (
      <EmptyState title={t("ob.slo.ub.none")}>
        <span>{t("ob.slo.ub.noneHint")}</span>
        <Button size="sm" variant="secondary" onClick={onSettings}>{t("ob.slo.ub.pick")}</Button>
      </EmptyState>
    )
    : d.metricsState !== "ok" ? <Notice tone="warning" title={t(`hb.m.state.${d.metricsState}`)}>{d.message ?? ""}</Notice>
    : (
      <div className={styles.upBoard} data-uptime-board>
        {overall ? <Row name={t("ob.slo.ub.overall", { n: measured.length })} label={t("ob.slo.ub.overall", { n: measured.length })} sub={t("ob.slo.ub.overallSub")} grade={latestGrade(overall)} bars={overall} d={d} fmt={fmt}
          tipOf={(i) => overall[i]!.worst.length ? (
            <ul className={styles.upTipList}>
              {overall[i]!.worst.slice(0, 6).map((w) => <li key={w.key}><span className={styles.upTipGrade} data-grade={w.grade}><i aria-hidden="true" />{w.key}</span></li>)}
              {overall[i]!.worst.length > 6 ? <li>+{overall[i]!.worst.length - 6}</li> : null}
            </ul>
          ) : null} overall /> : null}
        {rows.map((r) => (
          r.failed ? (
            <div key={r.key} className={styles.upItem}>
              <div className={styles.upItemHead}><strong>{r.application}</strong><span className={styles.sloUdNs}>{r.namespace}</span><span className={styles.upFailed}>{r.failed}</span></div>
            </div>
          ) : (
            <Row key={r.key} name={<LinkButton onClick={() => onOpen(r.namespace, r.application)}>{r.application}</LinkButton>} label={r.key} sub={r.namespace}
              grade={latestGrade(r.bars)} bars={r.bars} d={d} fmt={fmt} />
          )
        ))}
        <UptimeLegend counts={gradeCounts(overall ?? measured[0]?.bars ?? [])} />
      </div>
    );

  return (
    <Panel title={t("ob.slo.ub.title")} sub={sub} actions={<Button size="sm" variant="ghost" onClick={onSettings}>{t("ob.slo.ub.edit")}</Button>}
      footer={d && d.source !== "none" ? <span>{t(`ob.slo.ub.from.${d.source}`)} · {t("ob.slo.ub.foot")}</span> : undefined}>
      <div ref={ref}>{width > 0 || q.error ? body : null}</div>
    </Panel>
  );
}

function Row({ name, label, sub, grade, bars, d, fmt, tipOf, overall }: {
  name: React.ReactNode; label: string; sub: string; grade: SloUptimeGrade; bars: UptimeBar[]; d: SloUptimeBoardResponse; fmt: (ms: number) => string;
  tipOf?: (i: number) => React.ReactNode; overall?: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className={styles.upItem} data-overall={overall || undefined}>
      <div className={styles.upItemHead}>
        <strong>{name}</strong><span className={styles.sloUdNs}>{sub}</span>
        <span className={styles.upStatus} data-grade={grade}><i aria-hidden="true" />{t(`ob.slo.ud.now.${grade}`)}</span>
      </div>
      <UptimeBars bars={bars} minutes={d.bucketMinutes} from={d.from} to={d.to} fmt={fmt} label={label} tipOf={tipOf} />
    </div>
  );
}
