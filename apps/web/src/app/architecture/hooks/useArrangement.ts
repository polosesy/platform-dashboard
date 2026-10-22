"use client";

import { useStoredArrangement } from "@/lib/useStoredArrangement";

const KEY = (subscriptionId: string) => `aud.arch.arrange.v1:${subscriptionId || "sample"}`;

/** The viewer's manual arrangement of the infrastructure diagram for one subscription (lib/useStoredArrangement) */
export function useArrangement(subscriptionId: string) {
  return useStoredArrangement(KEY(subscriptionId));
}
