"use client";

// Shared state for every /security/* page. It lives in the route layout, so the
// selected subscription and the posture response survive moving between the pages
// (one request per subscription, not one per page).

import { useI18n } from "@/lib/i18n";
import { createContext, useContext, type ReactNode } from "react";
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
};

const SecurityCtx = createContext<SecurityState | null>(null);

export function SecurityProvider({ children }: { children: ReactNode }) {
  const { subscriptions, subscriptionId, setSubscriptionId, loaded } = useSubscriptions();
  // The recommendation texts come in the app's language (Microsoft's own Korean texts — API services/assessmentTexts.ts)
  const { locale } = useI18n();
  const q = useApiQuery(loaded ? `posture:${subscriptionId}:${locale}` : null, (token) =>
    fetchJsonWithBearer<SecurityPostureResponse>(apiUrl("/api/security/posture", { subscriptionId: subscriptionId || undefined, lang: locale }), token),
  );
  return (
    <SecurityCtx.Provider
      value={{ subscriptions, subscriptionId, setSubscriptionId, posture: q.data, error: q.error, loading: q.loading || !loaded, ready: loaded, reload: q.reload }}
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
