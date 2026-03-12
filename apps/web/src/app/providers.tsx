"use client";

import { PublicClientApplication } from "@azure/msal-browser";
import { MsalProvider } from "@azure/msal-react";
import { useMemo } from "react";
import { msalConfig } from "@/lib/msal";
import { I18nProvider } from "@/lib/i18n";

export function Providers({ children }: { children: React.ReactNode }) {
  // PublicClientApplication requires Web Crypto API (only in secure contexts — HTTPS or localhost).
  // When accessed via plain HTTP (e.g. IP address), initialization fails with crypto_nonexistent.
  const instance = useMemo(() => {
    try {
      return new PublicClientApplication(msalConfig);
    } catch {
      return null;
    }
  }, []);

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
