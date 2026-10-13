"use client";

import { InteractionRequiredAuthError } from "@azure/msal-browser";
import { useMsal } from "@azure/msal-react";
import { useCallback } from "react";

/**
 * Bearer token for the API (OBO on the server). Returns null when signed out or when the
 * session needs an interactive sign-in again — callers then use the API's anonymous path.
 */
export function useApiToken() {
  const { instance, accounts } = useMsal();

  return useCallback(async () => {
    const scope = process.env.NEXT_PUBLIC_AZURE_AD_API_SCOPE;
    if (!scope) return null;
    // Calls before MsalProvider finished initializing would throw uninitialized_public_client_application
    await instance.initialize();
    const account = instance.getActiveAccount() ?? accounts[0];
    if (!account) return null;

    try {
      const resp = await instance.acquireTokenSilent({ account, scopes: [scope] });
      return resp.accessToken;
    } catch (e) {
      if (e instanceof InteractionRequiredAuthError) {
        console.warn("[auth] session expired — sign in again", e.errorCode);
        return null;
      }
      throw e;
    }
  }, [accounts, instance]);
}
