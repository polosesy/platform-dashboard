"use client";

// 개요 › 브리핑: what matters in this environment right now, in sentences — subscription sources (alerts, Resource
// Health, Defender) and the selected cluster's (workload heatmap, SLO, Warning events, Kubernetes version). Each
// source answers on its own: still reading = "reading", failed = "not checked" (never a zero). Pure: lib/briefing.ts.

import Link from "next/link";
import type {
  AksClusterConfigResponse, HealthSummary, KubeEventsResponse, NotificationsResponse, SecurityPostureResponse,
  WorkloadHeatmapResponse, WorkloadSloResponse,
} from "@aud/types";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiQuery } from "@/lib/useApiQuery";
import { useAksClusters } from "@/lib/useAksClusters";
import { dateLocale, useI18n } from "@/lib/i18n";
import { briefing, headlineKey, type BriefGroup, type BriefLevel, type BriefSource } from "@/lib/briefing";
import { poolsBehind, upgradeState } from "@/lib/aksConfigView";
import { isRecent } from "@/lib/kubeEventsView";
import { Chip, CopyButton, Panel, type ChipLevel } from "@/components/ui";
import s from "./home.module.css";

const CHIP: Record<BriefLevel, ChipLevel> = { danger: "danger", warn: "warn", info: "info", ok: "ok", unknown: "unknown", loading: "neutral" };
const GROUPS: BriefGroup[] = ["now", "know", "fine"];

type Q<T> = { data?: T; loading: boolean; error?: unknown };
/** One query → one source: no key = off, no answer yet = loading, an error (or an answer the mapper rejects) = failed */
function source<T, D>(q: Q<T>, on: boolean, waiting: boolean, map: (d: T) => D | null): BriefSource<D> {
  if (waiting) return { state: "loading" };
  if (!on) return { state: "off" };
  if (q.error) return { state: "failed" };
  if (!q.data) return { state: "loading" };
  const data = map(q.data);
  return data ? { state: "ok", data } : { state: "failed" };
}

export function Briefing() {
  const { t, locale } = useI18n();
  const { clusters, clusterId, loading: clustersLoading, note } = useAksClusters();
  // Sample clusters (anonymous) cannot be read — their rows are left out instead of four "not checked" lines
  const id = note ? "" : (clusterId ?? "");
  const on = !!id;
  const cluster = clusters.find((c) => c.id === id)?.name ?? "";

  const alerts = useApiQuery("brief:alerts", (token) => fetchJsonWithBearer<NotificationsResponse>(apiUrl("/api/notifications"), token));
  const health = useApiQuery("brief:health", (token) => fetchJsonWithBearer<HealthSummary>(apiUrl("/api/health/summary"), token));
  const security = useApiQuery("brief:security", (token) => fetchJsonWithBearer<SecurityPostureResponse>(apiUrl("/api/security/posture"), token));
  const heat = useApiQuery(on ? `brief:heat:${id}` : null, (token) =>
    fetchJsonWithBearer<WorkloadHeatmapResponse>(apiUrl("/api/observability/heatmap", { clusterId: id, window: "60" }), token));
  const slo = useApiQuery(on ? `brief:slo:${id}` : null, (token) =>
    fetchJsonWithBearer<WorkloadSloResponse>(apiUrl("/api/observability/slo", { clusterId: id }), token));
  const events = useApiQuery(on ? `brief:events:${id}` : null, (token) =>
    fetchJsonWithBearer<KubeEventsResponse>(apiUrl("/api/observability/events", { clusterId: id, limit: "500" }), token));
  const config = useApiQuery(on ? `brief:config:${id}` : null, (token) =>
    fetchJsonWithBearer<AksClusterConfigResponse>(apiUrl("/api/kubernetes/cluster-config", { clusterId: id }), token));

  const b = briefing({
    cluster,
    alerts: source(alerts, true, false, (d) => ({ firingUnacked: d.counts.firingUnacked, high: (d.counts.bySeverity.sev1 ?? 0) + (d.counts.bySeverity.sev2 ?? 0) })),
    health: {
      ...source(health, true, false, (d) => ({ unavailable: d.unavailable, degraded: d.degraded, total: d.available + d.degraded + d.unavailable + d.unknown })),
      sample: !!health.data?.note && /mock|signin/.test(health.data.note),
    },
    security: {
      ...source(security, true, false, (d) => (d.affected ? { high: d.affected.High, medium: d.affected.Medium } : null)),
      sample: security.data?.source === "mock",
    },
    workloads: source(heat, on, clustersLoading, (d) => {
      if (d.metricsState !== "ok") return null;
      // AKS-managed workloads are not ours to fix — they stay out of the count, as on the heatmap's flag strip
      const own = d.workloads.filter((w) => !w.managed);
      const danger = own.filter((w) => w.worst === "danger");
      return { danger: danger.length, warn: own.filter((w) => w.worst === "warn").length, total: own.length, worst: danger[0] ? `${danger[0].namespace}/${danger[0].workload}` : undefined };
    }),
    slo: source(slo, on, clustersLoading, (d) => {
      if (d.metricsState !== "ok") return null;
      const burning = d.services.filter((x) => x.state === "fastBurn" || x.state === "slowBurn");
      const exhausted = d.services.filter((x) => x.state === "exhausted");
      const first = burning[0] ?? exhausted[0];
      return { burning: burning.length, exhausted: exhausted.length, total: d.services.length, worst: first ? `${first.namespace}/${first.application || "—"}` : undefined };
    }),
    events: source(events, on, clustersLoading, (d) => {
      const now = Date.parse(d.generatedAt);
      const recent = d.events.filter((e) => isRecent(e, now));
      const byReason = new Map<string, number>();
      for (const e of recent) byReason.set(e.reason, (byReason.get(e.reason) ?? 0) + 1);
      const top = [...byReason].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))[0]?.[0];
      return { recent: recent.length, total: d.total ?? d.events.length, topReason: top };
    }),
    version: source(config, on, clustersLoading, (d) => {
      const up = upgradeState(d.version);
      return { state: up.state, to: up.to, current: d.version.current ?? "", poolsBehind: poolsBehind(d).length };
    }),
  });

  const headline = t(headlineKey(b), { n: b.act, unchecked: b.unchecked });
  const text = [headline, ...b.rows.filter((r) => r.level !== "loading").map((r) => `[${t(`brief.level.${r.level}`)}] ${t(r.key, r.params)}`)].join("\n");
  const when = new Date().toLocaleString(dateLocale(locale), { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" });

  return (
    <Panel title={t("brief.title")} sub={cluster ? t("brief.sub.cluster", { when, cluster }) : when}
      actions={<>
        {b.sample ? <Chip level="info" glyph={false}>{t("common.sampleData")}</Chip> : null}
        <CopyButton text={text} label={t("brief.copy")} copiedLabel={t("brief.copied")} />
      </>}>
      <p className={s.todayHeadline} aria-live="polite">{headline}</p>
      {GROUPS.map((g) => {
        const rows = b.rows.filter((r) => r.group === g);
        if (!rows.length) return null;
        return (
          <section key={g} className={s.briefGroup} aria-label={t(`brief.group.${g}`)}>
            <h3 className={s.briefGroupTitle}>{t(`brief.group.${g}`)} <span className={s.briefCount}>{rows.length}</span></h3>
            <ul className={s.todayList}>
              {rows.map((r) => (
                <li key={r.id}>
                  <Link href={r.href} className={s.todayRow}>
                    <Chip level={CHIP[r.level]}>{t(`brief.level.${r.level}`)}</Chip>
                    <span className={s.todayText}>{t(r.key, r.params)}</span>
                    <span className={s.todayGo} aria-hidden="true">→</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      {!on && !clustersLoading ? <p className={s.briefNote}>{t(note ? "brief.note.signin" : "brief.note.noCluster")}</p> : null}
    </Panel>
  );
}
