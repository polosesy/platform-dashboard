"use client";

import { useMsal } from "@azure/msal-react";
import type { MeResponse } from "@aud/types";
import { apiUrl, fetchJsonWithBearer } from "./api";
import { useApiQuery } from "./useApiQuery";

/** Who the platform thinks the signed-in user is: platform role and the Azure connections that role reaches */
export function useMe() {
  const { instance, accounts } = useMsal();
  const account = instance.getActiveAccount() ?? accounts[0];
  // Re-ask when the account changes (sign-in / sign-out)
  return useApiQuery<MeResponse>(
    `me:${account?.homeAccountId ?? "anonymous"}`,
    (token) => fetchJsonWithBearer<MeResponse>(apiUrl("/api/me"), token),
    { tokenOptional: true },
  );
}
