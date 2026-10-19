"use client";

import { InteractionRequiredAuthError } from "@azure/msal-browser";
import { useMsal } from "@azure/msal-react";
import { useCallback } from "react";
import { useWebConfig } from "./webConfig";

/**
 * Bearer token for the API (OBO on the server). Returns null when signed out or when the
 * session needs an interactive sign-in again — callers then use the API's anonymous path.
 */
export function useApiToken() {
  const { instance, accounts } = useMsal();
  const scope = useWebConfig().apiScope;

  return useCallback(async () => {
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
  }, [accounts, instance, scope]);
}
