"use client";

import { PublicClientApplication } from "@azure/msal-browser";
import { MsalProvider } from "@azure/msal-react";
import { useMemo } from "react";
import { msalConfig } from "@/lib/msal";

export function Providers({ children }: { children: React.ReactNode }) {
  const instance = useMemo(() => new PublicClientApplication(msalConfig), []);
  return <MsalProvider instance={instance}>{children}</MsalProvider>;
}
