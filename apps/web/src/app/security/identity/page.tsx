"use client";

import Link from "next/link";
import { EmptyState, LoadingState, Notice, Panel, Stat } from "@/components/ui";
import { useI18n } from "@/lib/i18n";
import { useSecurity } from "../SecurityContext";
import { FindingsTable, PostureNotices, SecurityHeader, useGap } from "../components";
import s from "../security.module.css";

/** ID·권한 (CIEM) — Defender IdentityAndAccess recommendations, shown as Defender reports them. */
export default function SecurityIdentityPage() {
  const { t } = useI18n();
  const { posture } = useSecurity();
  const recGap = useGap("recommendations");
  const recs = (posture?.recommendations ?? []).filter((r) => r.domain === "identity");
  const top = [...recs].sort((a, b) => b.unhealthy - a.unhealthy).slice(0, 5);

  return (
    <div className={s.page}>
      <SecurityHeader />
      <PostureNotices />
      <Notice tone="info">{t("sec.identityHint")}</Notice>
      {!posture ? (
        <LoadingState />
      ) : recGap ? (
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
            <FindingsTable recommendations={recs} showDomain={false} />
          </Panel>
        </>
      )}
      <Notice tone="info">
        <Link href="/policies?tab=permissions" className={s.linkMore}>{t("sec.clusterRbac")} →</Link>
      </Notice>
    </div>
  );
}
