"use client";

import { EventType, PublicClientApplication, type AuthenticationResult, type EventMessage } from "@azure/msal-browser";
import { broadcastResponseToMainFrame } from "@azure/msal-browser/redirect-bridge";
import { MsalProvider } from "@azure/msal-react";
import { useMemo } from "react";
import { isAuthPopupResponse, msalConfig } from "@/lib/msal";
import { I18nProvider } from "@/lib/i18n";

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

function createMsal(): PublicClientApplication | null {
  // PublicClientApplication requires the Web Crypto API (secure contexts only — HTTPS or localhost).
  try {
    const pca = new PublicClientApplication(msalConfig);
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

export function Providers({ children }: { children: React.ReactNode }) {
  const instance = useMemo(() => (popupResponse ? null : createMsal()), []);

  if (popupBridge) {
    // This window only relays the response and closes itself; never start the app inside it.
    return (
      <I18nProvider>
        <div style={{ display: "grid", placeItems: "center", minHeight: "100vh", fontFamily: "system-ui", color: "#555" }}>
          로그인 처리 중… 이 창은 자동으로 닫힙니다.
        </div>
      </I18nProvider>
    );
  }

  if (!instance) {
    return (
      <I18nProvider>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "100vh", padding: 32, fontFamily: "system-ui", textAlign: "center" }}>
          <h2 style={{ marginBottom: 12 }}>HTTPS 연결이 필요합니다</h2>
          <p style={{ color: "#555", marginBottom: 8 }}>브라우저 인증(MSAL)은 보안 컨텍스트에서만 동작합니다.</p>
          <p style={{ color: "#888", fontSize: 13 }}>
            HTTPS 또는 <code>localhost</code>를 통해 접속해 주세요.
          </p>
        </div>
      </I18nProvider>
    );
  }

  return (
    <MsalProvider instance={instance}>
      <I18nProvider>{children}</I18nProvider>
    </MsalProvider>
  );
}
