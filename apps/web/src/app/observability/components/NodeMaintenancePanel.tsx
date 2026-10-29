"use client";

// AKS 모니터링 › 노드 — node maintenance: what Azure did to the nodes (Activity Log), when and by whom, inside which
// planned window (maintenanceConfigurations), and what the nodes went through (kube-state-metrics: surge, cordon,
// NotReady, re-registration, kernel / kubelet). API services/nodeMaintenance.ts. Facts only — an episode with no
// Azure operation says "no record of who", never a guess.

import { useState } from "react";
import type { NodeMaintEpisode, NodeMaintSourceState, NodeMaintWindow, NodeMaintenanceResponse } from "@aud/types";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiQuery } from "@/lib/useApiQuery";
import { dateLocale, useI18n } from "@/lib/i18n";
import { durationText, nodeCounts, spanMs, versionChange } from "@/lib/nodeMaintView";
import { Badge, EmptyState, ErrorNotice, LoadingState, Notice, Panel, Segmented, type BadgeTone } from "@/components/ui";
import styles from "../styles.module.css";

const DAYS = [7, 14, 30] as const;
type T = (k: string, v?: Record<string, string | number>) => string;
const STATUS_TONE: Record<NodeMaintEpisode["status"], BadgeTone> = { succeeded: "success", failed: "high", inProgress: "info", unknown: "neutral" };
const SOURCE_TONE: Record<NodeMaintSourceState, BadgeTone> = { ok: "success", empty: "neutral", forbidden: "medium", failed: "medium", notConfigured: "neutral" };

export function NodeMaintenancePanel({ clusterId }: { clusterId: string }) {
  const { t } = useI18n();
  const [days, setDays] = useState<(typeof DAYS)[number]>(14);
  const q = useApiQuery(clusterId ? `node-maint:${clusterId}:${days}` : null, (token) =>
    fetchJsonWithBearer<NodeMaintenanceResponse>(apiUrl("/api/observability/node-maintenance", { clusterId, days }), token),
  );
  const d = q.data?.clusterId === clusterId && q.data.days === days ? q.data : null;
  return (
    <Panel
      title={t("nm.title")}
      sub={t("nm.sub", { n: days })}
      actions={<Segmented label={t("nm.range")} items={DAYS.map((n) => ({ id: n, label: t("nm.days", { n }) }))} value={days} onChange={setDays} />}
    >
      <ErrorNotice error={q.error} />
      {!d ? (q.loading ? <LoadingState /> : null) : <Body d={d} />}
    </Panel>
  );
}

export function Body({ d, compact = false }: { d: NodeMaintenanceResponse; compact?: boolean }) {
  const { t, locale } = useI18n();
  const fmt = (iso: string) => new Date(iso).toLocaleString(dateLocale(locale), { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const episodes = compact ? d.episodes.slice(0, 3) : d.episodes;
  return (
    <div className={styles.nm}>
      <div className={styles.nmSources}>
        {(["activityLog", "config", "metrics"] as const).map((k) => (
          <Badge key={k} tone={SOURCE_TONE[d.sources[k]]} title={t(`nm.src.${k}.hint`)}>{`${t(`nm.src.${k}`)} · ${t(`nm.srcState.${d.sources[k]}`)}`}</Badge>
        ))}
        {!compact && <span className={styles.stackMuted}>{t("nm.step", { n: d.stepMinutes })}</span>}
      </div>
      {d.activityLogPartial ? <Notice tone="warning">{t("nm.partial")}</Notice> : null}

      {d.config ? <Config d={d} fmt={fmt} compact={compact} /> : null}

      {episodes.length === 0 ? (
        <EmptyState title={t("nm.none", { n: d.days })}>{d.sources.activityLog !== "ok" && d.sources.activityLog !== "empty" ? t("nm.noneUnknown") : null}</EmptyState>
      ) : (
        <ol className={styles.nmList}>
          {episodes.map((e) => <Episode key={e.id} e={e} fmt={fmt} compact={compact} />)}
        </ol>
      )}
      {compact && d.episodes.length > episodes.length ? <p className={styles.stackMuted}>{t("nm.more", { n: d.episodes.length - episodes.length })}</p> : null}

      {!compact && d.unplanned.length ? (
        <Notice tone="warning" title={t("nm.unplanned", { n: d.unplanned.length })}>
          <ul className={styles.nmPlain}>
            {d.unplanned.slice(0, 10).map((u) => (
              <li key={`${u.node}@${u.start}`}>
                <span className={styles.mono}>{u.node}</span> · {fmt(u.start)} → {u.end ? fmt(u.end) : t("nm.now")} ({durationText(t, spanMs(u.start, u.end, Date.now()))})
              </li>
            ))}
          </ul>
          {t("nm.unplannedHint")}
        </Notice>
      ) : null}
    </div>
  );
}

function scheduleText(t: T, w: NodeMaintWindow): string {
  const s = w.schedule;
  const when = s.kind === "relativeMonthly" ? t("nm.sched.relMonthly", { n: s.interval, week: t(`nm.week.${(s.weekIndex ?? "").toLowerCase()}`), dow: t(`nm.dow.${(s.dayOfWeek ?? "").toLowerCase()}`) })
    : s.kind === "absoluteMonthly" ? t("nm.sched.absMonthly", { n: s.interval, d: s.dayOfMonth ?? "?" })
    : s.kind === "weekly" ? t("nm.sched.weekly", { n: s.interval, dow: t(`nm.dow.${(s.dayOfWeek ?? "").toLowerCase()}`) })
    : s.kind === "daily" ? t("nm.sched.daily", { n: s.interval })
    : t("nm.sched.other");
  return `${when} ${w.startTime ?? ""} (UTC${w.utcOffset ?? ""})${w.durationHours ? ` · ${t("nm.hours", { n: w.durationHours })}` : ""}`;
}

function Config({ d, fmt, compact }: { d: NodeMaintenanceResponse; fmt: (iso: string) => string; compact: boolean }) {
  const { t } = useI18n();
  const c = d.config!;
  return (
    <div className={styles.nmConfig}>
      <div>
        <span className={styles.stackMuted}>{t("nm.channels")}</span>{" "}
        {t("nm.channel.cluster", { v: c.upgradeChannel ?? t("nm.notSet") })} · {t("nm.channel.nodeOs", { v: c.nodeOSUpgradeChannel ?? t("nm.notSet") })}
      </div>
      {c.windows.length ? (
        <ul className={styles.nmPlain}>
          {c.windows.map((w) => (
            <li key={w.name}>
              <b>{t(`nm.win.${w.name}`) === `nm.win.${w.name}` ? w.name : t(`nm.win.${w.name}`)}</b> — {scheduleText(t, w)}
              {w.next ? <span className={styles.stackMuted}> · {t("nm.next", { at: fmt(w.next) })}</span> : null}
            </li>
          ))}
        </ul>
      ) : <div className={styles.stackMuted}>{t("nm.noWindows")}</div>}
      {!compact && c.pools.length ? (
        <div className={styles.stackMuted}>
          {c.pools.map((p) => `${p.name}${p.nodeImageVersion ? ` · ${p.nodeImageVersion}` : ""}${p.maxSurge ? ` · ${t("nm.surgeSetting", { v: p.maxSurge })}` : ""}${p.drainTimeoutMinutes ? ` · ${t("nm.drainSetting", { n: p.drainTimeoutMinutes })}` : ""}`).join("  /  ")}
        </div>
      ) : null}
    </div>
  );
}

function Episode({ e, fmt, compact }: { e: NodeMaintEpisode; fmt: (iso: string) => string; compact: boolean }) {
  const { t } = useI18n();
  const now = Date.now();
  const v = versionChange(e);
  const n = nodeCounts(e);
  const facts = [
    e.pools.length ? t("nm.pools", { v: e.pools.join(", ") }) : null,
    v ? t(`nm.version.${v.kind}`, { from: v.from, to: v.to }) : null,
    n.surge ? t("nm.n.surge", { n: n.surge }) : null,
    n.reRegistered ? t("nm.n.reRegistered", { n: n.reRegistered }) : null,
    n.notReady ? t("nm.n.notReady", { n: n.notReady }) : null,
    e.podsRestarted !== null ? t("nm.n.pods", { n: e.podsRestarted }) : null,
    e.failedOps ? t("nm.n.failedOps", { n: e.failedOps }) : null,
    e.resourceHealth ? t("nm.n.rh", { n: e.resourceHealth }) : null,
  ].filter(Boolean);
  return (
    <li className={styles.nmEpisode} data-status={e.status}>
      <div className={styles.nmHead}>
        <strong>{t(`nm.kind.${e.kind}`)}</strong>
        <Badge tone={STATUS_TONE[e.status]}>{t(`nm.status.${e.status}`)}</Badge>
        <Badge title={t(`nm.by.${e.initiator}.hint`)}>{t(`nm.by.${e.initiator}`)}</Badge>
        {e.inWindow !== undefined ? (
          <Badge tone={e.inWindow ? "neutral" : "medium"}>{e.inWindow ? t("nm.inWindow", { w: t(`nm.win.${e.inWindow}`) === `nm.win.${e.inWindow}` ? e.inWindow : t(`nm.win.${e.inWindow}`) }) : t("nm.outWindow")}</Badge>
        ) : null}
      </div>
      <div className={styles.nmWhen}>
        {fmt(e.start)} → {e.end ? fmt(e.end) : t("nm.now")} <span className={styles.stackMuted}>({durationText(t, spanMs(e.start, e.end, now))} · {t("nm.ago", { dur: durationText(t, now - Date.parse(e.start)) })})</span>
      </div>
      {facts.length ? <div className={styles.nmFacts}>{facts.join(" · ")}</div> : null}
      {!compact && (e.nodes.length || e.operations.length) ? (
        <details className={styles.nmDetails}>
          <summary>{t("nm.details", { nodes: e.nodes.length, ops: e.operations.length })}</summary>
          {e.nodes.length ? (
            <table className={styles.stackTable}>
              <thead><tr><th>{t("nm.col.node")}</th><th>{t("nm.col.cordon")}</th><th>{t("nm.col.notReady")}</th><th>{t("nm.col.reRegistered")}</th><th>{t("nm.col.change")}</th></tr></thead>
              <tbody>
                {e.nodes.map((nd) => (
                  <tr key={nd.node}>
                    <td className={styles.mono}>{nd.node}{nd.surge ? <span className={styles.stackMuted}> · {t("nm.surgeNode", { at: fmt(nd.surge.created) })}{nd.surge.removed ? ` → ${fmt(nd.surge.removed)}` : ""}</span> : null}</td>
                    <td>{nd.cordoned ? `${fmt(nd.cordoned.start)} → ${nd.cordoned.end ? fmt(nd.cordoned.end) : t("nm.now")}` : "—"}</td>
                    <td>{nd.notReady ? `${fmt(nd.notReady.start)} → ${nd.notReady.end ? fmt(nd.notReady.end) : t("nm.now")}${nd.notReady.times > 1 ? ` (×${nd.notReady.times})` : ""}` : "—"}</td>
                    <td>{nd.reRegistered ? fmt(nd.reRegistered) : "—"}</td>
                    <td className={styles.mono}>{nd.kubelet ? `${nd.kubelet.from} → ${nd.kubelet.to}` : nd.kernel ? `${nd.kernel.from} → ${nd.kernel.to}` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          {e.operations.length ? (
            <table className={styles.stackTable}>
              <thead><tr><th>{t("nm.col.time")}</th><th>{t("nm.col.op")}</th><th>{t("nm.col.status")}</th><th>{t("nm.col.target")}</th><th>{t("nm.col.count")}</th></tr></thead>
              <tbody>
                {e.operations.map((o) => (
                  <tr key={`${o.op}|${o.status}|${o.target}`}>
                    <td>{fmt(o.time)}</td><td className={styles.mono}>{o.op}</td>
                    <td className={/failed/i.test(o.status) ? styles.stackBad : undefined}>{o.status}</td>
                    <td className={styles.mono}>{o.target}</td><td>{o.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </details>
      ) : null}
    </li>
  );
}
