"use client";

import { useState } from "react";
import type { AzureSubscriptionsResponse } from "@aud/types";
import { apiUrl, fetchJsonWithBearer } from "./api";
import { useApiQuery } from "./useApiQuery";

/**
 * Subscriptions from the API allow-list plus the selected one.
 * Until the user picks one, the first subscription is selected.
 */
export function useSubscriptions() {
  const { data, error } = useApiQuery("subscriptions", (token) =>
    fetchJsonWithBearer<AzureSubscriptionsResponse>(apiUrl("/api/azure/subscriptions"), token),
  );
  const subscriptions = data?.subscriptions ?? [];
  const [chosen, setSubscriptionId] = useState("");
  const subscriptionId = chosen || subscriptions[0]?.subscriptionId || "";

  // "loaded" also on failure, so pages still fetch (API falls back to its default subscription)
  return { subscriptions, subscriptionId, setSubscriptionId, loaded: data !== undefined || error !== null };
}
