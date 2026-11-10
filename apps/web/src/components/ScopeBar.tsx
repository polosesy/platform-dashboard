"use client";

// The scope bar (design draft ⑦ "범위 막대"): what this screen looks at — 구독 › 클러스터 — in one place at the top of
// every page that has a scope (navConfig PAGE_SCOPE). The choice is shared by all screens (lib/scopeStore), so moving
// between AKS screens keeps the cluster. When no cluster list can be read (signed out, no rights) the cluster can be
// typed as its ARM ID, as the cluster screens allowed before.

import { usePathname } from "next/navigation";
import { useState } from "react";
import { activeNavItem, PAGE_SCOPE } from "@/lib/navConfig";
import { useI18n } from "@/lib/i18n";
import { useSubscriptions } from "@/lib/useSubscriptions";
import { useAksClusters } from "@/lib/useAksClusters";
import { SubscriptionSelect } from "./SubscriptionSelect";
import { Select } from "./ui";
import s from "./ScopeBar.module.css";

export function ScopeBar() {
  const pathname = usePathname();
  const { t } = useI18n();
  const item = activeNavItem(pathname);
  const scope = item ? PAGE_SCOPE[item.href] ?? [] : [];
  if (!scope.length) return null;
  return <ScopeBarFor scope={scope} label={t("scope.label")} />;
}

/** Only what can be shown: no subscription list (signed out, nothing allowed) = no subscription field — and no bar at all */
function ScopeBarFor({ scope, label }: { scope: ReadonlyArray<"subscription" | "cluster">; label: string }) {
  const { subscriptions, subscriptionId, setSubscriptionId } = useSubscriptions();
  const showSub = scope.includes("subscription") && subscriptions.length > 0;
  const showCluster = scope.includes("cluster");
  if (!showSub && !showCluster) return null;
  return (
    <div className={s.bar} role="group" aria-label={label}>
      {showSub ? <SubscriptionSelect subscriptions={subscriptions} value={subscriptionId} onChange={setSubscriptionId} /> : null}
      {showSub && showCluster ? <span className={s.sep} aria-hidden="true">›</span> : null}
      {showCluster ? <ClusterScope /> : null}
    </div>
  );
}

function ClusterScope() {
  const { t } = useI18n();
  const { clusters, clusterId, setClusterId, loading } = useAksClusters();
  const [draft, setDraft] = useState<string | null>(null);
  if (clusters.length > 0) {
    return (
      <Select label={t("common.cluster")} value={clusterId} onChange={setClusterId}
        options={clusters.map((c) => ({ value: c.id, label: c.location ? `${c.name} (${c.location})` : c.name }))} />
    );
  }
  const commit = () => { if (draft !== null) setClusterId(draft.trim()); setDraft(null); };
  return (
    <label className={s.field}>
      <span className={s.label}>{t("common.cluster")}</span>
      <input className={s.input} type="text" value={draft ?? clusterId} placeholder={loading ? t("common.loading") : t("hub.clusterIdPlaceholder")}
        onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === "Enter") commit(); }} />
    </label>
  );
}
