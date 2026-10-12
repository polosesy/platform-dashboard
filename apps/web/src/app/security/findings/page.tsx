"use client";

import { Suspense } from "react";
import Link from "next/link";
import type { PostureDomain } from "@aud/types";
import { EmptyState, LoadingState, Notice, Panel, Tabs } from "@/components/ui";
import { useI18n } from "@/lib/i18n";
import { useQueryParam } from "@/lib/useQueryParam";
import { useSecurity } from "../SecurityContext";
import { FindingsTable, PostureNotices, SecurityHeader, useGap, useLabel } from "../components";
import s from "../security.module.css";

/** Identity has its own page (/security/identity), so it is not a tab here. */
const TAB_DOMAINS = ["all", "network", "data", "compute", "container", "appServices", "other"] as const;
type TabDomain = (typeof TAB_DOMAINS)[number];

function Findings() {
  const { t } = useI18n();
  const label = useLabel();
  const { posture } = useSecurity();
  const recGap = useGap("recommendations");
  const [domain, setDomain] = useQueryParam<TabDomain>("domain", TAB_DOMAINS, "all");

  const recs = posture?.recommendations ?? [];
  const inTab = (d: TabDomain) => (d === "all" ? recs : recs.filter((r) => r.domain === (d as PostureDomain)));
  const shown = inTab(domain);

  return (
    <div className={s.page}>
      <SecurityHeader />
      <PostureNotices />
      <Tabs
        label={t("nav.item.securityFindings")}
        idPrefix="finding-tab"
        value={domain}
        onChange={setDomain}
        items={TAB_DOMAINS.map((d) => ({ id: d, label: label("sec.domain", d), count: posture && !recGap ? inTab(d).length : undefined }))}
      />
      <div role="tabpanel" aria-labelledby={`finding-tab-${domain}`} className={s.page}>
        {!posture ? (
          <LoadingState />
        ) : recGap ? (
          <EmptyState title={t("sec.collectFailed")} />
        ) : (
          <Panel flush={false}>
            <FindingsTable key={domain} recommendations={shown} showDomain={domain === "all"} />
          </Panel>
        )}
        {domain === "network" ? (
          <Notice tone="info">
            <Link href="/policies?tab=network" className={s.linkMore}>{t("sec.clusterNetwork")} →</Link>
          </Notice>
        ) : null}
        <Notice tone="info">
          {t("sec.identityElsewhere")} — <Link href="/security/identity" className={s.linkMore}>{t("nav.item.securityIdentity")} →</Link>
        </Notice>
      </div>
    </div>
  );
}

export default function SecurityFindingsPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <Findings />
    </Suspense>
  );
}
