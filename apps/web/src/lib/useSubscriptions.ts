"use client";

import type { AzureSubscriptionsResponse } from "@aud/types";
import { apiUrl, fetchJsonWithBearer } from "./api";
import { useApiQuery } from "./useApiQuery";
import { sharedLoad, useScopeChoice } from "./scopeStore";
import { initialSubscription, useViewPrefs, visibleSubscriptions } from "./viewPrefs";

/**
 * Subscriptions from the API allow-list plus the selected one — shared by every screen and the scope bar
 * (lib/scopeStore). Until the user picks one, the first subscription is selected.
 */
export function useSubscriptions() {
  const { data, error } = useApiQuery("subscriptions", (token) =>
    sharedLoad(`subscriptions|${token ? "user" : "anon"}`, () => fetchJsonWithBearer<AzureSubscriptionsResponse>(apiUrl("/api/azure/subscriptions"), token)),
  );
  const all = data?.subscriptions ?? [];
  // 설정 › 보기 설정: the subscription filter (hidden ones left out — never all of them) and the start subscription
  const [prefs] = useViewPrefs();
  const { list: subscriptions, hiddenCount } = visibleSubscriptions(all, prefs);
  const [chosen, setSubscriptionId] = useScopeChoice("subscription");
  // A choice from another connection set (signed out → in) or now hidden falls back to the start one, else the first
  const subscriptionId = initialSubscription(subscriptions, chosen, prefs.start);

  // "loaded" also on failure, so pages still fetch (API falls back to its default subscription)
  return { subscriptions, all, hiddenCount, subscriptionId, setSubscriptionId, loaded: data !== undefined || error !== null };
}
