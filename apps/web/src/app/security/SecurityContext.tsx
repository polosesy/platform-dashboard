"use client";

import { usePathname } from "next/navigation";

// Shared state for every /security/* page. It lives in the route layout, so the
// selected subscription and the posture response survive moving between the pages
// (one request per subscription, not one per page).

import { useI18n } from "@/lib/i18n";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useTeamScope, type TeamScopeState } from "./TeamScope";
import type { AzureSubscriptionOption, SecurityPostureResponse } from "@aud/types";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiQuery } from "@/lib/useApiQuery";
import { useSubscriptions } from "@/lib/useSubscriptions";

type SecurityState = {
  subscriptions: AzureSubscriptionOption[];
  subscriptionId: string;
  setSubscriptionId: (id: string) => void;
  posture: SecurityPostureResponse | undefined;
  error: string | null;
  loading: boolean;
  /** The subscription list has loaded (subscriptionId is final) */
  ready: boolean;
  reload: () => void;
  /** 팀 범위 (security-roadmap 5.7): one choice for 보안 개요 · 보안 권고 · ID·권한 · 위협 탐지 (and the issue list) */
  team: TeamScopeState;
};

/** The pages whose numbers split by resource group (the rest are subscription-level or cluster-scoped) */
const TEAM_PAGES = ["/security", "/security/findings", "/security/identity", "/security/threats"];

const SecurityCtx = createContext<SecurityState | null>(null);

export function SecurityProvider({ children }: { children: ReactNode }) {
  const { subscriptions, subscriptionId, setSubscriptionId, loaded } = useSubscriptions();
  // The recommendation texts come in the app's language (Microsoft's own Korean texts — API services/assessmentTexts.ts)
  const { locale } = useI18n();
  // 그래프 탐색 reads the cluster, not the Defender posture — no posture read there
  const path = usePathname();
  const needsPosture = !path.startsWith("/security/explore");
  const q = useApiQuery(loaded && needsPosture ? `posture:${subscriptionId}:${locale}` : null, (token) =>
    fetchJsonWithBearer<SecurityPostureResponse>(apiUrl("/api/security/posture", { subscriptionId: subscriptionId || undefined, lang: locale }), token),
  );
  const recs = useMemo(() => q.data?.recommendations ?? [], [q.data]);
  const team = useTeamScope(subscriptionId, !!q.data && q.data.source !== "mock" && TEAM_PAGES.includes(path), recs);
  return (
    <SecurityCtx.Provider
      value={{ subscriptions, subscriptionId, setSubscriptionId, posture: q.data, error: q.error, loading: q.loading || !loaded, ready: loaded, reload: q.reload, team }}
    >
      {children}
    </SecurityCtx.Provider>
  );
}

export function useSecurity(): SecurityState {
  const v = useContext(SecurityCtx);
  if (!v) throw new Error("useSecurity must be used under /security (SecurityProvider)");
  return v;
}
