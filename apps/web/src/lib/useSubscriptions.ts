"use client";

import type { AzureSubscriptionsResponse } from "@aud/types";
import { apiUrl, fetchJsonWithBearer } from "./api";
import { useApiQuery } from "./useApiQuery";
import { sharedLoad, useScopeChoice } from "./scopeStore";

/**
 * Subscriptions from the API allow-list plus the selected one — shared by every screen and the scope bar
 * (lib/scopeStore). Until the user picks one, the first subscription is selected.
 */
export function useSubscriptions() {
  const { data, error } = useApiQuery("subscriptions", (token) =>
    sharedLoad(`subscriptions|${token ? "user" : "anon"}`, () => fetchJsonWithBearer<AzureSubscriptionsResponse>(apiUrl("/api/azure/subscriptions"), token)),
  );
  const subscriptions = data?.subscriptions ?? [];
  const [chosen, setSubscriptionId] = useScopeChoice("subscription");
  // A choice from another connection set (signed out → in) that is not in this list falls back to the first one
  const subscriptionId = (chosen && subscriptions.some((s) => s.subscriptionId === chosen) ? chosen : "") || subscriptions[0]?.subscriptionId || "";

  // "loaded" also on failure, so pages still fetch (API falls back to its default subscription)
  return { subscriptions, subscriptionId, setSubscriptionId, loaded: data !== undefined || error !== null };
}
