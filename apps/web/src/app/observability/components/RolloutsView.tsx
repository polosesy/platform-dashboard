"use client";

// 서비스 (APM) › 배포 — rollouts (a Deployment's new ReplicaSet, kube-state-metrics) with the image before and after and
// the same-name service's server spans 30 minutes before vs after (API services/rollouts.ts). The numbers side by side —
// no verdict. A rollback to an existing ReplicaSet creates none and is not listed (said under the table).

import { useState } from "react";
import Link from "next/link";
import type { RolloutRed, RolloutsResponse } from "@aud/types";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiQuery } from "@/lib/useApiQuery";
import { dateLocale, useI18n } from "@/lib/i18n";
import { Chip, CodeBlock, EmptyState, ErrorNotice, LoadingState, Notice, Panel, Segmented } from "@/components/ui";
import { answersAt, atParam, type TimeRange } from "@/lib/timeRange";
import { useRangeRefresh } from "@/lib/useTimeRange";
import { countText, errorRateText, quantileText } from "@/lib/redView";
import { imageChanges, imageRepo, imageTag } from "@/lib/apmMoreView";
import styles from "../styles.module.css";

export function RolloutsView({ clusterId, range, nonce, report }: { clusterId: string; range: TimeRange; nonce: number; report?: (id: string, loading: boolean) => void }) {
  const { t, locale } = useI18n();
  const [days, setDays] = useState<"1" | "7">("1");
  const atQ = atParam(range);
  const q = useApiQuery(clusterId ? `obs-rollouts:${clusterId}:${days}:${atQ ?? "now"}` : null, (token) =>
    fetchJsonWithBearer<RolloutsResponse>(apiUrl("/api/observability/rollouts", { clusterId, days, at: atQ }), token),
  );
  useRangeRefresh("rollouts", nonce, q.loading, q.reload, report);
  const d = q.data?.clusterId === clusterId && String(q.data.windowDays) === days && answersAt(q.data.at, atQ) ? q.data : null;

  const picker = <Segmented label={t("ob.ro.window")} value={days} onChange={setDays} items={[{ id: "1", label: t("ob.ro.days1") }, { id: "7", label: t("ob.ro.days7") }]} />;
  if (q.error) return <ErrorNotice error={q.error} />;
  if (!d) return <LoadingState label={t("ob.ro.loading")} />;
  if (d.metricsState !== "ok") {
    return <Notice tone={d.metricsState === "noWorkspace" ? "info" : "warning"} title={t(`hb.m.state.${d.metricsState}`)}>{t(`hb.m.stateHint.${d.metricsState}`)}{d.message ? ` (${d.message})` : ""}</Notice>;
  }
  const lc = dateLocale(locale);
  const red = (r: RolloutRed | null, minutes: number) => r === null ? <span className={styles.sloCellSub}>—</span> : (
    <>
      <span className={styles.sloCellMain}>{t("ob.ro.req", { n: countText(r.requests, lc), m: minutes })}</span>
      <span className={styles.sloCellSub}>{t("ob.ro.err", { r: errorRateText(r.errorRate), n: countText(r.errors, lc) })} · p95 {quantileText(r.p95, d.buckets)}</span>
    </>
  );
  return (
    <Panel title={t("ob.ro.title")} sub={t("ob.ro.sub")} actions={picker}
      footer={<span>{t("ob.ro.foot")}</span>}>
      <p className={styles.sloText}>{t("ob.ro.summary", { n: d.rollouts.length + d.more, c: d.rollouts.length, s: d.rollouts.filter((r) => r.service).length, d: Number(days) })}</p>
      {d.rollouts.length === 0 ? <EmptyState title={t("ob.ro.none", { d: Number(days) })} /> : (
        <div className={styles.sloTableWrap}>
          <table className={styles.sloTable}>
            <thead><tr>
              <th>{t("ob.ro.col.when")}</th><th>{t("ob.ro.col.deployment")}</th><th>{t("ob.ro.col.image")}</th>
              <th>{t("ob.ro.col.before")}</th><th>{t("ob.ro.col.after")}</th>
            </tr></thead>
            <tbody>
              {d.rollouts.map((r) => (
                <tr key={`${r.namespace}/${r.replicaset}`}>
                  <td><span className={styles.sloCellSub}>{new Date(r.at).toLocaleString(lc)}</span></td>
                  <td>
                    <span className={styles.sloCellMain}>{r.deployment}</span>
                    <span className={styles.sloCellSub}>{r.namespace} · <Link href={`/observability?wl=${encodeURIComponent(`${r.namespace}/${r.deployment}`)}`}>{t("ob.apm.toWorkload")}</Link></span>
                  </td>
                  <td>
                    {imageChanges(r).map((c) => (
                      <span key={c.container} className={styles.sloCellSub} title={`${c.from ?? "—"} → ${c.to ?? "—"}`}>
                        {c.container}: {c.from ? imageTag(c.from) : t("ob.ro.unknown")} → {c.to ? imageTag(c.to) : t("ob.ro.notRunning")}{c.changed ? "" : ` (${t("ob.ro.same")})`}
                        {c.to && c.from && imageRepo(c.to) !== imageRepo(c.from) ? ` · ${imageRepo(c.to)}` : ""}
                      </span>
                    ))}
                    {r.images.length === 0 && (r.previousImages ?? []).length === 0 ? <span className={styles.sloCellSub}>{t("ob.ro.noImages")}</span> : null}
                    {r.imagesAt === "rollout" ? <span className={styles.sloCellSub}>{t("ob.ro.replaced")}</span> : null}
                  </td>
                  <td>{r.service ? red(r.before, 30) : <span className={styles.sloCellSub}>{t("ob.ro.noService")}</span>}</td>
                  <td>{r.service ? (r.afterMinutes >= 1 ? red(r.after, r.afterMinutes) : <span className={styles.sloCellSub}>{t("ob.ro.tooRecent")}</span>) : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {d.more > 0 ? <p className={styles.sloCellSub}>{t("ob.ro.more", { n: d.more })}</p> : null}
      {d.gaps?.length ? <Chip level="unknown">{t("ob.err.gaps", { q: d.gaps.map((g) => g.query).join(", ") })}</Chip> : null}
      <details className={styles.sloCellSub}>
        <summary>{t("ob.apm.howMeasured")}</summary>
        {Object.entries(d.queries).map(([k, v]) => <CodeBlock key={k} label={k} code={v} copyLabel={t("ob.slo.copy")} copiedLabel={t("ob.slo.copied")} />)}
      </details>
    </Panel>
  );
}
