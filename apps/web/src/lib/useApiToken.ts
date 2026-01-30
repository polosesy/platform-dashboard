"use client";

import { useMsal } from "@azure/msal-react";
import { useCallback } from "react";

export function useApiToken() {
  const { instance, accounts } = useMsal();

  return useCallback(async () => {
    const scope = process.env.NEXT_PUBLIC_AZURE_AD_API_SCOPE;
    if (!scope) return null;
    const account = accounts[0];
    if (!account) return null;

    const resp = await instance.acquireTokenSilent({
      account,
      scopes: [scope]
    });
    return resp.accessToken;
  }, [accounts, instance]);
}
