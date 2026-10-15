"use client";

import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { useI18n } from "@/lib/i18n";
import styles from "../../styles.module.css";

const OPEN_KEY = "ld.panel.open.";

function readOpen(id: string, fallback: boolean): boolean {
  try {
    const v = window.localStorage.getItem(OPEN_KEY + id);
    return v == null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}

function writeOpen(id: string, open: boolean) {
  try {
    window.localStorage.setItem(OPEN_KEY + id, open ? "1" : "0");
  } catch {
    /* storage unavailable — the section just opens with its default next time */
  }
}

/**
 * How deep a Section sits: 0 = panel body (level 1, a band), 1+ = inside another section (level 2, title + rule).
 * The level comes from the tree, not from CSS position selectors, so moving a section keeps its look right.
 */
const DepthCtx = createContext(0);

/** One chevron that turns (no ▸/▾ swap) */
function Chevron() {
  return (
    <svg className={styles.dpChevron} width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M3.5 2 L7 5 L3.5 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * Collapsible panel section; the open state is remembered per section (falls back to the default).
 * Level 1: an opaque band that sticks while its rows scroll. Level 2: small title with a rule, rows on a rail.
 */
export function Section({ id, title, count, defaultOpen = true, children }: { id: string; title: ReactNode; count?: number; defaultOpen?: boolean; children: ReactNode }) {
  const depth = useContext(DepthCtx);
  const level = depth === 0 ? 1 : 2;
  const [open, setOpen] = useState(() => readOpen(id, defaultOpen));
  const toggle = useCallback(() => setOpen((o) => { writeOpen(id, !o); return !o; }), [id]);
  return (
    <section className={styles.dpSection} data-level={level}>
      <button type="button" className={styles.dpSectionHead} aria-expanded={open} onClick={toggle}>
        <span className={styles.dpSectionTitle}>{title}</span>
        {count != null && <span className={styles.dpCount}>{count}</span>}
        {level === 2 && <span className={styles.dpRule} aria-hidden="true" />}
        <Chevron />
      </button>
      {open && (
        <DepthCtx.Provider value={depth + 1}>
          <div className={styles.dpSectionBody}>{children}</div>
        </DepthCtx.Provider>
      )}
    </section>
  );
}

/** Sub-group inside a section (connections by direction, a backend pool, a node pool): title + rule, rows on a rail */
export function Group({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <div className={styles.dpGroup}>
      <div className={styles.dpGroupTitle}>
        <span className={styles.dpGroupTitleText}>{title}</span>
        <span className={styles.dpRule} aria-hidden="true" />
      </div>
      <div className={styles.dpGroupBody}>{children}</div>
    </div>
  );
}

/** A level-1 band that does not open (e.g. "알림 — 활성 알림 없음"), so it reads as one of the sections */
export function StaticSection({ title, note, children }: { title: ReactNode; note?: ReactNode; children?: ReactNode }) {
  return (
    <section className={styles.dpSection} data-level={1}>
      <div className={styles.dpSectionHead} data-static="true">
        <span className={styles.dpSectionTitle}>{title}</span>
        {note ? <span className={styles.dpHeadNote}>{note}</span> : null}
      </div>
      {children ? <div className={styles.dpSectionBody}>{children}</div> : null}
    </section>
  );
}

/** Label | value row (84 px label column, value wraps instead of scrolling) */
export function KV({ label, children, mono, copy }: { label: ReactNode; children: ReactNode; mono?: boolean; copy?: string }) {
  return (
    <div className={styles.dpRow}>
      <span className={styles.dpLabel}>{label}</span>
      <span className={styles.dpValue} data-mono={mono || undefined}>
        <span className={styles.dpValueText}>{children}</span>
        {copy ? <CopyButton value={copy} /> : null}
      </span>
    </div>
  );
}

/** Copies the full value (the screen may show a masked or shortened form) */
export function CopyButton({ value, label }: { value: string; label?: string }) {
  const { t } = useI18n();
  const [done, setDone] = useState(false);
  const copy = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard?.writeText(value).then(() => {
      setDone(true);
      setTimeout(() => setDone(false), 1200);
    }).catch(() => undefined);
  }, [value]);
  return (
    <button type="button" className={styles.dpCopy} onClick={copy} aria-label={label ?? t("ld.copy")} title={label ?? t("ld.copy")}>
      {done ? "✓" : "⧉"}
    </button>
  );
}

/** Relative time in the app language ("5분 전") */
export function useRelativeTime() {
  const { locale } = useI18n();
  return useCallback((iso: string) => {
    const secs = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
    const fmt = new Intl.RelativeTimeFormat(locale === "en" ? "en" : "ko", { numeric: "auto" });
    const a = Math.abs(secs);
    if (a < 60) return fmt.format(secs, "second");
    if (a < 3600) return fmt.format(Math.round(secs / 60), "minute");
    if (a < 86400) return fmt.format(Math.round(secs / 3600), "hour");
    return fmt.format(Math.round(secs / 86400), "day");
  }, [locale]);
}
