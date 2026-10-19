"use client";

import { EventType, PublicClientApplication, type AuthenticationResult, type EventMessage } from "@azure/msal-browser";
import { broadcastResponseToMainFrame } from "@azure/msal-browser/redirect-bridge";
import { MsalProvider } from "@azure/msal-react";
import { useMemo } from "react";
import { isAuthPopupResponse, msalConfigFor } from "@/lib/msal";
import type { WebRuntimeConfig } from "@/lib/runtimeConfig";
import { WebConfigProvider } from "@/lib/webConfig";
import { I18nProvider, useI18n } from "@/lib/i18n";

/*
 * MSAL v5 popup sign-in: Entra redirects the popup to redirectUri (this app) with the auth
 * response in the URL, and the opener waits for it on a BroadcastChannel. The bridge reads and
 * clears the URL synchronously, so it must run at module load — before MsalProvider's
 * handleRedirectPromise could touch the hash. Without this the opener times out after 60 s.
 */
const popupResponse = typeof window !== "undefined" && isAuthPopupResponse(window.location);
const popupBridge: Promise<void> | null = popupResponse
  ? broadcastResponseToMainFrame().catch((e: unknown) => {
      console.error("[auth] could not hand the sign-in response to the main window", e);
    })
  : null;

function createMsal(config: WebRuntimeConfig): PublicClientApplication | null {
  // PublicClientApplication requires the Web Crypto API (secure contexts only — HTTPS or localhost).
  try {
    const pca = new PublicClientApplication(msalConfigFor(config));
    // Keep an active account so token calls never depend on accounts[] ordering
    pca.addEventCallback((ev: EventMessage) => {
      if ((ev.eventType === EventType.LOGIN_SUCCESS || ev.eventType === EventType.ACQUIRE_TOKEN_SUCCESS) && ev.payload) {
        const account = (ev.payload as AuthenticationResult).account;
        if (account) pca.setActiveAccount(account);
      }
    });
    return pca;
  } catch {
    return null;
  }
}

function PopupBridgeNotice() {
  const { t } = useI18n();
  return (
    <div style={{ display: "grid", placeItems: "center", minHeight: "100vh", fontFamily: "system-ui", color: "#555" }}>
      {t("auth.popupRelay")}
    </div>
  );
}

function InsecureContextNotice() {
  const { t } = useI18n();
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "100vh", padding: 32, fontFamily: "system-ui", textAlign: "center" }}>
      <h2 style={{ marginBottom: 12 }}>{t("auth.httpsTitle")}</h2>
      <p style={{ color: "#555", marginBottom: 8 }}>{t("auth.httpsBody")}</p>
      <p style={{ color: "#888", fontSize: 13 }}>
        {t("auth.httpsHint1")}<code>localhost</code>{t("auth.httpsHint2")}
      </p>
    </div>
  );
}

/** `config` = the sign-in settings the server read for this page (one image, any host — lib/runtimeConfig.ts) */
export function Providers({ children, config }: { children: React.ReactNode; config: WebRuntimeConfig }) {
  const instance = useMemo(() => (popupResponse ? null : createMsal(config)), [config]);

  if (popupBridge) {
    // This window only relays the response and closes itself; never start the app inside it.
    return (
      <I18nProvider>
        <PopupBridgeNotice />
      </I18nProvider>
    );
  }

  if (!instance) {
    return (
      <I18nProvider>
        <InsecureContextNotice />
      </I18nProvider>
    );
  }

  return (
    <WebConfigProvider value={config}>
      <MsalProvider instance={instance}>
        <I18nProvider>{children}</I18nProvider>
      </MsalProvider>
    </WebConfigProvider>
  );
}
