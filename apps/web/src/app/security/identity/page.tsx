"use client";

import Link from "next/link";
import { EmptyState, LoadingState, Notice, Panel, Stat } from "@/components/ui";
import { useI18n } from "@/lib/i18n";
import { useSecurity } from "../SecurityContext";
import { FindingsTable, PostureNotices, SecurityHeader, useGap } from "../components";
import { TeamScopeBar } from "../TeamScope";
import { recsInBucket } from "@/lib/teamScope";
import s from "../security.module.css";

/** ID·권한 (CIEM) — Defender IdentityAndAccess recommendations, shown as Defender reports them. */
export default function SecurityIdentityPage() {
  const { t } = useI18n();
  const { posture, team } = useSecurity();
  const b = team.bucket;
  const recGap = useGap("recommendations");
  const all = (posture?.recommendations ?? []).filter((r) => r.domain === "identity");
  const recs = b ? (b.findings ? recsInBucket(all, b, team.rules) : []) : all;
  const top = [...recs].sort((a, b) => b.unhealthy - a.unhealthy).slice(0, 5);

  return (
    <div className={s.page}>
      <SecurityHeader />
      <PostureNotices />
      <Notice tone="info">{t("sec.identityHint")}</Notice>
      {posture && posture.source !== "mock" ? <TeamScopeBar team={team} note={b ? t("sec.team.findingsNote") : undefined} /> : null}
      {!posture ? (
        <LoadingState />
      ) : recGap || (b && !b.findings) ? (
        <EmptyState title={t("sec.collectFailed")} />
      ) : (
        <>
          {top.length ? (
            <div className={s.stats}>
              {top.map((r) => (
                <Stat key={r.key} label={r.title} value={r.unhealthy} tone={r.severity === "High" ? "high" : r.severity === "Medium" ? "medium" : undefined} />
              ))}
            </div>
          ) : null}
          <Panel>
            <FindingsTable key={b?.id ?? ""} recommendations={recs} showDomain={false} scoped={!!b} />
          </Panel>
        </>
      )}
      <Notice tone="info">
        <Link href="/policies?tab=permissions" className={s.linkMore}>{t("sec.clusterRbac")} →</Link>
      </Notice>
    </div>
  );
}
