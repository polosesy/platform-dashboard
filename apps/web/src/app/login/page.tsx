"use client";

// Sign-in page (design draft ①, docs/architecture/design-system.md) — one card: what signing in does, one entry button
// (redirect to Microsoft and back — no popup), "browse sample data" as the other way in, and the states a person can
// land here in: expired session, consent needed, wrong redirect address, signed in without a platform role, already
// signed in. Outside the menu and the app shell (navConfig NAV_EXEMPT_ROUTES · AppShell).

import { useEffect, useState } from "react";
import Link from "next/link";
import { InteractionStatus } from "@azure/msal-browser";
import { useMsal } from "@azure/msal-react";
import { Button, Notice, Segmented } from "@/components/ui";
import { useI18n } from "@/lib/i18n";
import { LOGIN_KEYS, loginReason, safeNext, type LoginReason } from "@/lib/loginFlow";
import { loginErrorMessage, loginRequestFor } from "@/lib/msal";
import { signInConfigured } from "@/lib/runtimeConfig";
import { useMe } from "@/lib/useMe";
import { useWebConfig } from "@/lib/webConfig";
import s from "./login.module.css";

export default function LoginPage() {
  const { t, locale, setLocale } = useI18n();
  const { instance, accounts, inProgress } = useMsal();
  const config = useWebConfig();
  const configured = signInConfigured(config);
  const user = instance.getActiveAccount() ?? accounts[0];
  const me = useMe().data;
  // Read the query on the client (no Suspense boundary needed): where to return, and why we are here
  const [next, setNext] = useState("/");
  const [reason, setReason] = useState<LoginReason | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [going, setGoing] = useState(false);
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    setNext(safeNext(q.get("next")));
    let stored: string | null = null;
    try {
      stored = window.sessionStorage.getItem(LOGIN_KEYS.error);
      window.sessionStorage.removeItem(LOGIN_KEYS.error);
    } catch { /* storage blocked */ }
    setReason(loginReason(stored) ?? loginReason(q.get("reason")));
    fetch("/healthz").then((r) => r.json()).then((j: { version?: string }) => setVersion(j.version ?? null)).catch(() => undefined);
  }, []);

  const busy = going || inProgress === InteractionStatus.HandleRedirect;
  const noRole = !!user && !!me && !me.anonymous && !me.role;
  const signedIn = !!user && !noRole;

  const signIn = async () => {
    setError(null);
    setGoing(true);
    try {
      window.sessionStorage.setItem(LOGIN_KEYS.redirecting, "1");
    } catch { /* storage blocked — the bridge check then cannot tell; the redirect still works without popups in use */ }
    try {
      await instance.loginRedirect({ ...loginRequestFor(config), redirectStartPage: new URL(next, window.location.origin).href });
    } catch (e) {
      try { window.sessionStorage.removeItem(LOGIN_KEYS.redirecting); } catch { /* ignore */ }
      setGoing(false);
      setError(loginErrorMessage(e, t));
    }
  };
  const signOut = () => instance.logoutRedirect({ account: user }).catch((e: unknown) => setError(loginErrorMessage(e, t)));

  // One notice at most: the state this person is in
  const notice = !configured ? <Notice tone="warning" title={t("login.notConfigured.t")}>{t("auth.notConfigured")}</Notice>
    : error ? <Notice tone="danger" title={t("login.failed")}>{error}</Notice>
    : noRole ? <Notice tone="warning" title={t("login.norole.t")}>{t("login.norole.d")}</Notice>
    : signedIn ? <Notice tone="success" title={t("login.signedIn.t")}>{t("login.signedIn.d", { name: user?.name ?? user?.username ?? "" })}</Notice>
    : reason ? <Notice tone={reason === "expired" ? "info" : "danger"} title={t(`login.reason.${reason}.t`)}>{t(`login.reason.${reason}.d`)}</Notice>
    : null;

  return (
    <div className={s.page}>
      <header className={s.top}>
        <span className={s.brand}>
          <span className={s.mark} aria-hidden="true" />
          <span>Azure Unified Dashboard</span>
        </span>
        <Segmented label={t("login.language")} value={locale} onChange={setLocale}
          items={[{ id: "ko", label: t("login.lang.ko") }, { id: "en", label: t("login.lang.en") }]} />
      </header>

      <main className={s.main}>
        <div className={s.column}>
          <section className={s.card} aria-labelledby="login-title">
            <div className={s.intro}>
              <h1 id="login-title" className={s.title}>{t("login.title")}</h1>
              <p className={s.lead}>{t("login.lead")}</p>
            </div>

            {notice}

            <div className={s.actions}>
              {signedIn ? (
                <>
                  <Link href={next} className={s.primaryLink}>{t("login.continue")}</Link>
                  <Button variant="ghost" onClick={signOut}>{t("login.otherAccount")}</Button>
                </>
              ) : noRole ? (
                <Button size="lg" onClick={signOut}>{t("login.otherAccount")}</Button>
              ) : (
                <>
                  <Button size="lg" variant="primary" onClick={signIn} disabled={!configured || busy}>
                    <span className={s.msMark} aria-hidden="true"><i /><i /><i /><i /></span>
                    {busy ? t("login.going") : t("login.button")}
                  </Button>
                  <p className={s.hint}>{t("login.hint")}</p>
                </>
              )}
            </div>

            {!signedIn ? (
              <>
                <div className={s.or}><span>{t("login.or")}</span></div>
                <div className={s.actions}>
                  {config.sampleData ? (<>
                    <Link href="/" className={s.secondaryLink}>{t("login.sample")}</Link>
                    <p className={s.hint}>{t("login.sampleHint")}</p>
                  </>) : null}
                </div>
              </>
            ) : null}
          </section>

          <ul className={s.facts}>
            <li><span aria-hidden="true">●</span>{t("login.fact.readOnly")}</li>
            <li><span aria-hidden="true">●</span>{t("login.fact.identity")}</li>
            <li><span aria-hidden="true">●</span>{t("login.fact.roles")}</li>
          </ul>
        </div>
      </main>

      <footer className={s.foot}>
        <span>{version ? t("login.version", { v: version }) : ""}</span>
      </footer>
    </div>
  );
}
