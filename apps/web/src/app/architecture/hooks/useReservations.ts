"use client";

import { useEffect, useState } from "react";
import type { ReservationUtilizationResponse } from "@aud/types";
import { apiBaseUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiToken } from "@/lib/useApiToken";

async function loadReservationUtilization(
  bearerToken: string | null,
  grain: "daily" | "monthly",
  subscriptionId?: string
): Promise<ReservationUtilizationResponse> {
  const url = new URL(`${apiBaseUrl()}/api/reservations/utilization`);
  url.searchParams.set("grain", grain);
  if (subscriptionId) url.searchParams.set("subscriptionId", subscriptionId);
  return await fetchJsonWithBearer<ReservationUtilizationResponse>(url.toString(), bearerToken);
}

export function useReservations(subscriptionId: string) {
  const getApiToken = useApiToken();
  const [riGrain, setRiGrain] = useState<"daily" | "monthly">("monthly");
  const [ri, setRi] = useState<ReservationUtilizationResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!subscriptionId) return;
    getApiToken()
      .then((token) => loadReservationUtilization(token, riGrain, subscriptionId || undefined))
      .then((r) => {
        if (cancelled) return;
        setRi(r);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setRi({
          generatedAt: new Date().toISOString(),
          grain: riGrain,
          utilizedPercentage: 0,
          usedHours: 0,
          reservedHours: 0,
          subscriptions: [],
          note: e instanceof Error ? e.message : "reservations error",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [getApiToken, riGrain, subscriptionId]);

  return { riGrain, setRiGrain, ri };
}
