"use client";

import { PublicClientApplication } from "@azure/msal-browser";
import { MsalProvider } from "@azure/msal-react";
import { useMemo } from "react";
import { msalConfig } from "@/lib/msal";
import { I18nProvider } from "@/lib/i18n";

export function Providers({ children }: { children: React.ReactNode }) {
  const instance = useMemo(() => new PublicClientApplication(msalConfig), []);
  return (
    <MsalProvider instance={instance}>
      <I18nProvider>{children}</I18nProvider>
    </MsalProvider>
  );
}
