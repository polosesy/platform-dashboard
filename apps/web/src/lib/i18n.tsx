"use client";

import { createContext, useContext, useCallback, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";

export type { Locale } from "./i18nMessages";
export { dateLocale } from "./i18nMessages";
import type { Locale } from "./i18nMessages";

import { T } from "./i18nMessages";

type I18nContextValue = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  /** Translate `key`; `{name}` placeholders are filled from `vars`. */
  t: (key: string, vars?: Record<string, string | number>) => string;
};

const I18nContext = createContext<I18nContextValue>({
  locale: "ko",
  setLocale: () => {},
  t: (key) => key,
});

const LOCALE_STORAGE_KEY = "aud-locale";
const LOCALE_EVENT = "aud-locale-change";

function readStoredLocale(): Locale {
  try {
    const saved = localStorage.getItem(LOCALE_STORAGE_KEY);
    return saved === "en" ? "en" : "ko";
  } catch {
    return "ko";
  }
}

function subscribeLocale(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  window.addEventListener(LOCALE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(LOCALE_EVENT, onChange);
  };
}

export function I18nProvider({ children }: { children: ReactNode }) {
  // Server snapshot is always "ko" so SSR and the first client render match;
  // the stored locale is applied right after hydration.
  const locale = useSyncExternalStore(subscribeLocale, readStoredLocale, () => "ko" as Locale);

  const setLocale = useCallback((l: Locale) => {
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, l);
    } catch {
      /* storage unavailable — locale resets on reload */
    }
    window.dispatchEvent(new Event(LOCALE_EVENT));
  }, []);

  const t = useCallback(
    (key: string, vars?: Record<string, string | number>): string => {
      const s = T[key]?.[locale] ?? key;
      return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s;
    },
    [locale],
  );

  // Screen readers pronounce by <html lang>; keep it in step with the chosen locale
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  return useContext(I18nContext);
}
