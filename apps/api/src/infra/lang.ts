// Response language for API-generated text (policy findings, risk issues). Korean is the default.
//
// The text builders are synchronous pure functions, so the language is set around one synchronous call
// with withLang() and read by L(ko, en) inside it. Never wrap an async function: another request could
// run in between and read the wrong language.

import type { Request } from "express";

export type Lang = "ko" | "en";

let current: Lang = "ko";

/** Run a synchronous builder with `lang` as the text language. */
export function withLang<T>(lang: Lang, fn: () => T): T {
  if (fn.constructor.name === "AsyncFunction") throw new Error("withLang: builders must be synchronous");
  const prev = current;
  current = lang;
  try {
    return fn();
  } finally {
    current = prev;
  }
}

/** Pick the text for the current language. */
export const L = (ko: string, en: string): string => (current === "en" ? en : ko);

/** Current language (for code that formats numbers/units around L()). */
export const lang = (): Lang => current;

/** `?lang=en` → "en", anything else → "ko" */
export function queryLang(req: Request): Lang {
  return req.query.lang === "en" ? "en" : "ko";
}
