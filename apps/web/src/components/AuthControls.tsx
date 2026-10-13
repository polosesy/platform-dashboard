"use client";

import { useState } from "react";
import { InteractionStatus } from "@azure/msal-browser";
import { AuthenticatedTemplate, UnauthenticatedTemplate, useMsal } from "@azure/msal-react";
import { loginErrorMessage, loginRequest, msalConfigured } from "@/lib/msal";
import { useI18n } from "@/lib/i18n";
import styles from "./TopNav.module.css";

/** Sign-in / signed-in user / sign-out, with visible errors instead of console-only failures. */
export function AuthControls() {
  const { instance, accounts, inProgress } = useMsal();
  const { t } = useI18n();
  const [error, setError] = useState<string | null>(null);
  const user = instance.getActiveAccount() ?? accounts[0];
  const busy = inProgress !== InteractionStatus.None;

  const login = async () => {
    setError(null);
    try {
      const result = await instance.loginPopup(loginRequest);
      if (result.account) instance.setActiveAccount(result.account);
    } catch (e) {
      setError(loginErrorMessage(e, t));
    }
  };
  // Redirect sign-out: no popup to relay, works even when popups are blocked
  const logout = () => instance.logoutRedirect({ account: user }).catch((e: unknown) => setError(loginErrorMessage(e, t)));

  return (
    <div className={styles.right}>
      <AuthenticatedTemplate>
        <div className={styles.user} title={user?.username}>
          <span className={styles.userDot} aria-hidden="true" />
          <span className={styles.userName}>{user?.name ?? user?.username ?? t("auth.signedIn")}</span>
        </div>
        <button className={styles.btnSecondary} onClick={logout} type="button" disabled={busy}>
          {t("auth.logout")}
        </button>
      </AuthenticatedTemplate>

      <UnauthenticatedTemplate>
        {error && (
          <span className={styles.authError} role="alert">
            {error}
          </span>
        )}
        <button
          className={styles.btnPrimary}
          onClick={login}
          type="button"
          disabled={!msalConfigured || busy}
          title={msalConfigured ? undefined : t("auth.notConfigured")}
        >
          {busy ? t("auth.signingIn") : t("auth.login")}
        </button>
      </UnauthenticatedTemplate>
    </div>
  );
}
