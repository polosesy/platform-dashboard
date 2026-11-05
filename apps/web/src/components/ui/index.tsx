"use client";

// Shared UI kit. Page chrome comes from here so every page looks and reads the same:
// PageHeader takes its title and description from the menu (navConfig), so a page
// title always equals its menu label.

import { useId, useRef, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { activeNavItem } from "@/lib/navConfig";
import { dateLocale, useI18n } from "@/lib/i18n";
import { authStateOfCode } from "@/lib/api";
import {
  RANGE_PRESETS, REFRESH_INTERVALS, canShiftBack, canZoomOut, shiftRange, spanMs, zoomOut, type RangePreset, type RefreshInterval,
} from "@/lib/timeRange";
import type { TimeRangeState } from "@/lib/useTimeRange";
import s from "./ui.module.css";

const cx = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(" ");

/* ── PageHeader ── */
export function PageHeader({ actions, meta, title, desc }: { actions?: ReactNode; meta?: ReactNode; title?: string; desc?: ReactNode }) {
  const pathname = usePathname();
  const { t } = useI18n();
  const item = activeNavItem(pathname);
  return (
    <header className={s.header}>
      <div className={s.headerText}>
        <h1 className={s.title}>{title ?? (item ? t(item.labelKey) : "")}</h1>
        {(desc ?? item) ? <p className={s.desc}>{desc ?? t(item!.descKey)}</p> : null}
        {meta ? <div className={s.meta}>{meta}</div> : null}
      </div>
      {actions ? <div className={s.actions}>{actions}</div> : null}
    </header>
  );
}

/* ── Panel ── */
export function Panel({
  title, sub, actions, children, flush, className, id, labelledBy,
}: { title?: ReactNode; sub?: ReactNode; actions?: ReactNode; children: ReactNode; flush?: boolean; className?: string; id?: string; labelledBy?: string }) {
  const autoId = useId();
  const headId = title ? `${autoId}-h` : undefined;
  return (
    <section className={cx(s.panel, className)} id={id} aria-labelledby={labelledBy ?? headId}>
      {title || actions ? (
        <div className={s.panelHead}>
          {title ? (
            <h2 className={s.panelTitle} id={headId}>
              {title}
              {sub ? <span className={s.panelSub}>{sub}</span> : null}
            </h2>
          ) : <span />}
          {actions}
        </div>
      ) : null}
      <div className={flush ? s.panelFlush : s.panelBody}>{children}</div>
    </section>
  );
}

/* ── Tabs (page-level, underline) — roving focus with ←/→/Home/End ── */
export type TabItem<K extends string> = { id: K; label: ReactNode; count?: number };
export function Tabs<K extends string>({ items, value, onChange, label, idPrefix }: { items: TabItem<K>[]; value: K; onChange: (id: K) => void; label: string; idPrefix?: string }) {
  const listRef = useRef<HTMLDivElement>(null);
  const prefix = idPrefix ?? "tab";
  const move = (idx: number) => {
    const next = items[(idx + items.length) % items.length]!;
    onChange(next.id);
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLButtonElement>(`[data-tab="${next.id}"]`)?.focus());
  };
  return (
    <div className={s.tabs} role="tablist" aria-label={label} ref={listRef}>
      {items.map((it, i) => {
        const selected = it.id === value;
        return (
          <button
            key={it.id}
            type="button"
            role="tab"
            id={`${prefix}-${it.id}`}
            data-tab={it.id}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            className={s.tab}
            onClick={() => onChange(it.id)}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight") { e.preventDefault(); move(i + 1); }
              else if (e.key === "ArrowLeft") { e.preventDefault(); move(i - 1); }
              else if (e.key === "Home") { e.preventDefault(); move(0); }
              else if (e.key === "End") { e.preventDefault(); move(items.length - 1); }
            }}
          >
            {it.label}
            {it.count != null ? <span className={s.tabCount}>{it.count.toLocaleString()}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

/* ── Segmented control (view switches) ── */
export function Segmented<K extends string | number>({ items, value, onChange, label }: { items: { id: K; label: ReactNode; title?: string }[]; value: K; onChange: (id: K) => void; label: string }) {
  return (
    <div className={s.segmented} role="group" aria-label={label}>
      {items.map((it) => (
        <button key={String(it.id)} type="button" className={s.segment} aria-pressed={it.id === value} title={it.title} onClick={() => onChange(it.id)}>
          {it.label}
        </button>
      ))}
    </div>
  );
}

/* ── Field + Select ── */
export function Select({
  label, value, onChange, options, disabled, placeholder, hideLabel,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  /** `group`: options with a group are shown under it (<optgroup>), in first-seen group order */
  options: { value: string; label: string; group?: string }[];
  disabled?: boolean;
  placeholder?: string;
  hideLabel?: boolean;
}) {
  const groups = [...new Set(options.map((o) => o.group).filter((g): g is string => !!g))];
  const opt = (o: { value: string; label: string }) => <option key={o.value} value={o.value}>{o.label}</option>;
  return (
    <label className={s.field}>
      <span className={s.fieldLabel} hidden={hideLabel}>{label}</span>
      <select className={s.select} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled || options.length === 0} aria-label={hideLabel ? label : undefined}>
        {options.length === 0 ? <option value="">{placeholder ?? "-"}</option> : null}
        {groups.length
          ? <>
              {options.filter((o) => !o.group).map(opt)}
              {groups.map((g) => <optgroup key={g} label={g}>{options.filter((o) => o.group === g).map(opt)}</optgroup>)}
            </>
          : options.map(opt)}
      </select>
    </label>
  );
}

export function SearchInput({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <label className={s.field}>
      <span className={s.fieldLabel}>{label}</span>
      <input className={s.input} type="search" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

/* ── Button / Toggle ── */
export function Button({
  children, onClick, variant = "secondary", size, disabled, type = "button", title, ariaLabel, ariaPressed,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "secondary" | "ghost";
  size?: "sm";
  disabled?: boolean;
  type?: "button" | "submit";
  title?: string;
  ariaLabel?: string;
  ariaPressed?: boolean;
}) {
  return (
    <button
      type={type}
      className={cx(s.button, variant === "primary" && s.primary, variant === "ghost" && s.ghost, size === "sm" && s.sm)}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      aria-pressed={ariaPressed}
    >
      {children}
    </button>
  );
}

/** On/off switch. When `disabled`, `title` should say why (e.g. no measured data). */
export function Toggle({ checked, onChange, children, title, disabled }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode; title?: string; disabled?: boolean }) {
  return (
    <label className={s.toggle} title={title} data-disabled={disabled || undefined}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {children}
    </label>
  );
}

/* ── Time range + refresh (Grafana's time picker and refresh picker) ── */

/**
 * One bar for a page's time range and refresh: ‹‹ (back half a range) · the range (quick ranges = ending now; after a
 * shift it reads from ~ to) · ›› (forward, up to now) · ⊖ (twice as wide) | ↻ 새로 고침 (spins while any panel loads) ·
 * the auto-refresh interval (waits while the range is in the past). State: lib/useTimeRange; math: lib/timeRange.
 */
export function TimeRangeBar({ state }: { state: TimeRangeState }) {
  const { t, locale } = useI18n();
  const { range, setRange, interval, setInterval, paused, refresh, busy, mountedAt } = state;
  const fmt = (ms: number) => new Date(ms).toLocaleString(dateLocale(locale), { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const custom = range.to !== null ? t("tr.custom", { from: fmt(range.to - spanMs(range)), to: fmt(range.to) }) : null;
  return (
    <div className={s.timeBar} role="group" aria-label={t("tr.label")}>
      <div className={s.timeGroup}>
        <button type="button" className={s.timeBtn} title={t("tr.back")} aria-label={t("tr.back")}
          disabled={!canShiftBack(range, mountedAt)} onClick={() => setRange(shiftRange(range, -1, Date.now()))}>«</button>
        <label className={s.timeRange} title={custom ? t("tr.customHint") : t("tr.label")}>
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
          <select className={s.timeSelect} aria-label={t("tr.label")} value={custom ? "" : range.preset}
            onChange={(e) => e.target.value && setRange({ preset: e.target.value as RangePreset, to: null })}>
            {custom ? <option value="">{custom}</option> : null}
            {RANGE_PRESETS.map((p) => <option key={p} value={p}>{t(`tr.preset.${p}`)}</option>)}
          </select>
        </label>
        <button type="button" className={s.timeBtn} title={range.to === null ? t("tr.forwardNow") : t("tr.forward")} aria-label={t("tr.forward")}
          disabled={range.to === null} onClick={() => setRange(shiftRange(range, 1, Date.now()))}>»</button>
        <button type="button" className={s.timeBtn} title={t("tr.zoomOut")} aria-label={t("tr.zoomOut")}
          disabled={!canZoomOut(range)} onClick={() => setRange(zoomOut(range, Date.now()))}>
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M8 11h6M16.5 16.5 21 21" /></svg>
        </button>
      </div>
      <div className={s.timeGroup} data-paused={paused || undefined}>
        <button type="button" className={s.timeBtn} data-busy={busy || undefined} onClick={refresh} aria-label={t("tr.refresh")}
          title={busy ? t("tr.refreshing") : t("tr.refresh")}>
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" /></svg>
          {t("tr.refresh")}
        </button>
        <select className={s.timeSelect} aria-label={t("tr.interval")} value={interval} onChange={(e) => setInterval(e.target.value as RefreshInterval)}
          title={paused ? t("tr.paused") : t("tr.intervalHint")}>
          {REFRESH_INTERVALS.map((v) => <option key={v} value={v}>{t(`tr.interval.${v}`)}</option>)}
        </select>
        {paused ? <span className={s.timePaused} title={t("tr.paused")}>{t("tr.pausedShort")}</span> : null}
      </div>
    </div>
  );
}

/* ── Notice / states ── */
export function Notice({ tone = "info", title, children }: { tone?: "info" | "warning" | "danger" | "success"; title?: ReactNode; children?: ReactNode }) {
  return (
    <div className={cx(s.notice, s[`notice_${tone}`])} role={tone === "danger" ? "alert" : "status"}>
      <div>
        {title ? <span className={s.noticeTitle}>{title} </span> : null}
        {children}
      </div>
    </div>
  );
}

/**
 * Signed out on a page that has no sample data (cluster pages — the sample cluster cannot be read): a sign-in hint
 * in the info tone, not a red failure
 */
export function SignInNotice() {
  const { t } = useI18n();
  return <Notice tone="info" title={t("auth.state.signin")}>{t("auth.signinNoSample")}</Notice>;
}

/**
 * Error banner with the localized "failed to load" prefix (or `title`). The sign-in sentence (lib/api fetchJson turns
 * 401 signin_required into it) becomes SignInNotice — being signed out is not a failure.
 */
export function ErrorNotice({ error, title }: { error: string | null | undefined; title?: string }) {
  const { t } = useI18n();
  if (!error) return null;
  if (error === t("auth.state.signin")) return <SignInNotice />;
  return <Notice tone="danger" title={title ?? t("common.loadFailed")}>{error}</Notice>;
}

/** Shown whenever a response is sample (mock) data, so it is never mistaken for live data. */
/** A response note for people: "signin_required" (anonymous → sample data) becomes the sign-in hint */
export function useNoteText() {
  const { t } = useI18n();
  return (note: string | null | undefined) => {
    if (note === "signin_required") return t("auth.signinForReal");
    const state = authStateOfCode(note);
    return state ? t(`auth.state.${state}`) : note ?? undefined;
  };
}

export function SampleDataNotice({ note }: { note?: string | null }) {
  const { t } = useI18n();
  if (!note) return null;
  if (note === "signin_required") {
    return <Notice tone="info" title={t("common.sampleData")}>{t("auth.signinForReal")}</Notice>;
  }
  // An auth / connection code (consent_required, connection_failed …) reads as a sentence in the app's language
  const state = authStateOfCode(note);
  if (state) return <Notice tone="warning" title={t("common.partialData")}>{t(`auth.state.${state}`)}</Notice>;
  const mock = /mock/i.test(note);
  return (
    <Notice tone="warning" title={mock ? t("common.sampleData") : t("common.partialData")}>
      {mock ? t("common.sampleDataHint") : note}
    </Notice>
  );
}

export function LoadingState({ label }: { label?: string }) {
  const { t } = useI18n();
  return (
    <div className={s.state} role="status" aria-live="polite">
      <span className={s.spinner} aria-hidden="true" />
      <span>{label ?? t("common.loading")}</span>
    </div>
  );
}

export function EmptyState({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className={s.state}>
      <div className={s.stateTitle}>{title}</div>
      {children ? <div>{children}</div> : null}
    </div>
  );
}

/* ── Badge / Stat ── */
export type BadgeTone = "neutral" | "high" | "medium" | "low" | "info" | "success";
export function Badge({ tone = "neutral", children, title }: { tone?: BadgeTone; children: ReactNode; title?: string }) {
  return <span className={cx(s.badge, tone !== "neutral" && s[`badge_${tone}`])} title={title}>{children}</span>;
}

export function Stat({ label, value, hint, tone }: { label: ReactNode; value: ReactNode; hint?: ReactNode; tone?: "high" | "medium" | "success" }) {
  return (
    <div className={cx(s.stat, tone && s[`statTone_${tone}`])}>
      <div className={s.statLabel}>{label}</div>
      <div className={s.statValue}>{value}</div>
      {/* The hint row is always there (empty = a blank line) so cards in one row line up */}
      <div className={s.statHint} aria-hidden={hint ? undefined : true}>{hint ?? "\u00a0"}</div>
    </div>
  );
}
