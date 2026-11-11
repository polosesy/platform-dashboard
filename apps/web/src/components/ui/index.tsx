"use client";

// Shared UI kit. Page chrome comes from here so every page looks and reads the same:
// PageHeader takes its title and description from the menu (navConfig), so a page
// title always equals its menu label.

import { useId, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { activeNavItem } from "@/lib/navConfig";
import { dateLocale, useI18n } from "@/lib/i18n";
import { authStateOfCode } from "@/lib/api";
import {
  PRESET_MINUTES, RANGE_PRESETS, REFRESH_INTERVALS, canShiftBack, canZoomOut, customRange, fromLocalInput, presetOf, shiftRange, spanMs, toLocalInput,
  zoomOut, type CustomRangeError, type RangePreset, type RefreshInterval,
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

/* ── Panel ──
   One anatomy for every panel and card (design-system.md · ⑤): head 56 (title 16/600 + meta · controls ≤ 32 on the
   right) · body · optional foot 44 (counts, source, a link). Panels in one row of a Grid share a height — the foot
   sits at the bottom and the spare room stays under the body. */
export function Panel({
  title, sub, actions, children, footer, flush, className, id, labelledBy, as = "section", level,
}: {
  title?: ReactNode; sub?: ReactNode; actions?: ReactNode; children: ReactNode; footer?: ReactNode; flush?: boolean; className?: string; id?: string;
  labelledBy?: string; as?: "section" | "article" | "aside";
  /** A status the panel stands for — only a quiet top line (the chip in `actions` says it in words) */
  level?: ChipLevel;
}) {
  const autoId = useId();
  const headId = title ? `${autoId}-h` : undefined;
  const Tag = as;
  return (
    <Tag className={cx(s.panel, className)} id={id} aria-labelledby={labelledBy ?? headId} data-level={level}>
      {title || actions ? (
        <div className={s.panelHead}>
          {title ? (
            <h2 className={s.panelTitle} id={headId}>
              <span className={s.panelTitleText}>{title}</span>
              {sub ? <span className={s.panelSub}>{sub}</span> : null}
            </h2>
          ) : <span />}
          {actions ? <div className={s.panelActions}>{actions}</div> : null}
        </div>
      ) : null}
      <div className={flush ? s.panelFlush : s.panelBody}>{children}</div>
      {footer ? <div className={s.panelFoot}>{footer}</div> : null}
    </Tag>
  );
}

/** A tab's top line: view switch / filters on the left, the basis (as of …, window chip) on the right — not a notice */
export function Toolbar({ start, end }: { start?: ReactNode; end?: ReactNode }) {
  return (
    <div className={s.toolbar}>
      <div className={s.toolbarStart}>{start}</div>
      {end ? <div className={s.toolbarEnd}>{end}</div> : null}
    </div>
  );
}

/* ── 12-column grid ── one per page body: cards 3 (×4) or 4 (×3), panels 9 + 3 · 8 + 4 · 6 + 6 · 12, so the edges of a
   lower row sit on the edges of the cards above. Under 1100 px: 3·4 → 6, 6·8·9 → 12; under 640 px: all 12. */
export type GridSpan = 3 | 4 | 6 | 8 | 9 | 12;
export function Grid({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx(s.grid, className)}>{children}</div>;
}
export function Cell({ span, children, className }: { span: GridSpan; children: ReactNode; className?: string }) {
  return <div className={cx(s.cell, s[`span${span}`], className)}>{children}</div>;
}

/* ── Status chip ── the platform's state grammar: colour + glyph (● ok · ▲ warn · ■ danger · ○ not judged · ? unknown),
   one size (24 px, 1 px border always — the colour changes, not the size) */
/** `plain` = a fact with no verdict (a value, a tag, an alert that is not firing) — solid border, muted text */
export type ChipLevel = "ok" | "warn" | "danger" | "info" | "neutral" | "unknown" | "plain";
export const CHIP_GLYPH: Record<ChipLevel, string> = { ok: "●", warn: "▲", danger: "■", info: "●", neutral: "○", unknown: "?", plain: "●" };
export function Chip({ level = "neutral", children, title, glyph }: { level?: ChipLevel; children: ReactNode; title?: string; glyph?: string | false }) {
  const g = glyph === false ? null : glyph ?? CHIP_GLYPH[level];
  return (
    <span className={cx(s.chip, s[`chip_${level}`])} title={title}>
      {g ? <span className={s.chipGlyph} aria-hidden="true">{g}</span> : null}
      {children}
    </span>
  );
}

/* ── Filter chip ── a pill you press: a filter, a preset, a saved query (28 px like a small button; touch 44).
   `pressed` given = an on/off filter (aria-pressed, chosen = tinted + ✓ so it is not colour alone); left out = a one-shot action. */
export function FilterChip({
  children, onClick, pressed, title, ariaLabel, disabled,
}: { children: ReactNode; onClick: () => void; pressed?: boolean; title?: string; ariaLabel?: string; disabled?: boolean }) {
  return (
    <button type="button" className={s.filterChip} aria-pressed={pressed} title={title} aria-label={ariaLabel} disabled={disabled} onClick={onClick}>
      {pressed ? <span className={s.filterCheck} aria-hidden="true">✓</span> : null}
      {children}
    </button>
  );
}

/* ── Link button ── an action that reads as text: a name in a table that opens its row, "show all", "clear" —
   accent text, no box (the row or sentence around it is the target's frame) */
export function LinkButton({
  children, onClick, title, ariaLabel, ariaExpanded, tone = "accent", disabled,
}: { children: ReactNode; onClick: () => void; title?: string; ariaLabel?: string; ariaExpanded?: boolean; tone?: "accent" | "muted"; disabled?: boolean }) {
  return (
    <button type="button" className={cx(s.linkButton, tone === "muted" && s.linkMuted)} title={title} aria-label={ariaLabel} aria-expanded={ariaExpanded} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

/** Copy a text (a config snippet, a command) — says "copied" for a moment */
export function CopyButton({ text, label, copiedLabel }: { text: string; label: string; copiedLabel: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button size="sm" onClick={() => {
      void navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => undefined);
    }}>
      {copied ? copiedLabel : label}
    </Button>
  );
}

/** A code block with a copy button above it (config snippets, commands) */
export function CodeBlock({ code, label, copyLabel, copiedLabel, maxHeight }: { code: string; label?: ReactNode; copyLabel: string; copiedLabel: string; maxHeight?: number }) {
  return (
    <div className={s.code}>
      <div className={s.codeHead}>
        <span>{label}</span>
        <CopyButton text={code} label={copyLabel} copiedLabel={copiedLabel} />
      </div>
      {/* A long snippet scrolls inside its box — the copy button always takes all of it */}
      <pre className={s.codePre} style={maxHeight ? { maxHeight, overflowY: "auto" } : undefined} tabIndex={maxHeight ? 0 : undefined}>{code}</pre>
    </div>
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

/** One-line text / number / date-time field — or `rows` lines (a textarea); the same box as SearchInput */
export function TextInput({
  label, value, onChange, placeholder, type = "text", disabled, hideLabel, rows, maxLength, hint, width,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: "text" | "number" | "datetime-local";
  disabled?: boolean;
  hideLabel?: boolean;
  rows?: number;
  maxLength?: number;
  /** One line under the box (what an empty field means) */
  hint?: ReactNode;
  /** px — the box's width (default: the field's) */
  width?: number;
}) {
  const style = width ? { width, maxWidth: "100%" } : undefined;
  return (
    <label className={s.field}>
      <span className={s.fieldLabel} hidden={hideLabel}>{label}</span>
      {rows
        ? <textarea className={`${s.input} ${s.textarea}`} rows={rows} value={value} placeholder={placeholder} disabled={disabled} maxLength={maxLength}
            aria-label={hideLabel ? label : undefined} style={style} onChange={(e) => onChange(e.target.value)} />
        : <input className={s.input} type={type} value={value} placeholder={placeholder} disabled={disabled} maxLength={maxLength}
            aria-label={hideLabel ? label : undefined} style={style} onChange={(e) => onChange(e.target.value)} />}
      {hint ? <span className={s.fieldHint}>{hint}</span> : null}
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
  /** 32 by default · sm 28 inside dense rows · lg 44 for the one entry action of a screen (sign-in) */
  size?: "sm" | "lg";
  disabled?: boolean;
  type?: "button" | "submit";
  title?: string;
  ariaLabel?: string;
  ariaPressed?: boolean;
}) {
  return (
    <button
      type={type}
      className={cx(s.button, variant === "primary" && s.primary, variant === "ghost" && s.ghost, size === "sm" && s.sm, size === "lg" && s.lg)}
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

/** A span in words: 90분 · 36시간 · 3일 (the locale's units) */
export function spanText(t: (k: string, v?: Record<string, string | number>) => string, minutes: number): string {
  return minutes % 1440 === 0 ? t("tr.unit.d", { n: minutes / 1440 }) : minutes % 60 === 0 ? t("tr.unit.h", { n: minutes / 60 }) : t("tr.unit.m", { n: minutes });
}

/**
 * One bar for a page's time range and refresh: « (back half a range) · the range (quick ranges = ending now; after a
 * shift or a typed from–to it reads from ~ to; 직접 입력… opens the two times) · » (forward, up to now) · ⊖ (the next
 * quick range) | ↻ 새로 고침 (spins while any panel loads) · the auto-refresh interval (waits while the range is in the
 * past). Keys t ← · t → · t z (lib/useTimeRange). State: lib/useTimeRange; math: lib/timeRange.
 */
export function TimeRangeBar({ state }: { state: TimeRangeState }) {
  const { t, locale } = useI18n();
  const { range, setRange, interval, setInterval, paused, refresh, busy, mountedAt } = state;
  const [form, setForm] = useState<{ from: string; to: string; error: CustomRangeError | null } | null>(null);
  const fmt = (ms: number) => new Date(ms).toLocaleString(dateLocale(locale), { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const preset = presetOf(range);
  const label = preset ? null : range.to !== null
    ? t("tr.custom", { from: fmt(range.to - spanMs(range)), to: fmt(range.to) })
    : t("tr.lastCustom", { d: spanText(t, range.span) });
  const openForm = () => {
    const end = range.to ?? Date.now();
    setForm({ from: toLocalInput(end - spanMs(range)), to: toLocalInput(end), error: null });
  };
  const apply = () => {
    if (!form) return;
    const r = customRange(fromLocalInput(form.from), fromLocalInput(form.to), Date.now());
    if ("error" in r) setForm({ ...form, error: r.error });
    else { setRange(r); setForm(null); }
  };
  return (
    <div className={s.timeBar} role="group" aria-label={t("tr.label")}>
      <div className={s.timeGroup}>
        <button type="button" className={s.timeBtn} title={t("tr.back")} aria-label={t("tr.back")}
          disabled={!canShiftBack(range, mountedAt)} onClick={() => setRange(shiftRange(range, -1, Date.now()))}>«</button>
        <label className={s.timeRange} title={label && range.to !== null ? t("tr.customHint") : t("tr.label")}>
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
          <select className={s.timeSelect} aria-label={t("tr.label")} value={preset ?? ""}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "__custom") openForm();
              else if (v) setRange({ span: PRESET_MINUTES[v as RangePreset], to: null });
            }}>
            {label ? <option value="">{label}</option> : null}
            {RANGE_PRESETS.map((p) => <option key={p} value={p}>{t(`tr.preset.${p}`)}</option>)}
            <option value="__custom">{t("tr.customOpen")}</option>
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
      {form ? (
        // Two local times → a span ending at `to` (customRange: 5 min – 30 days, not the future, not past 30 days back)
        <div className={s.timeForm} role="dialog" aria-label={t("tr.customTitle")}
          onKeyDown={(e) => { if (e.key === "Escape") setForm(null); if (e.key === "Enter" && e.target instanceof HTMLInputElement) apply(); }}>
          <strong className={s.timeFormTitle}>{t("tr.customTitle")}</strong>
          <label className={s.field}>
            <span className={s.fieldLabel}>{t("tr.from")}</span>
            <input className={s.input} type="datetime-local" value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value, error: null })} autoFocus />
          </label>
          <label className={s.field}>
            <span className={s.fieldLabel}>{t("tr.to")}</span>
            <input className={s.input} type="datetime-local" value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value, error: null })} />
          </label>
          {form.error ? <span className={s.timeFormError} role="alert">{t(`tr.err.${form.error}`)}</span> : <span className={s.timeFormHint}>{t("tr.customLimits")}</span>}
          <span className={s.timeFormActions}>
            <Button size="sm" onClick={() => setForm(null)}>{t("tr.cancel")}</Button>
            <Button size="sm" variant="primary" onClick={apply}>{t("tr.apply")}</Button>
          </span>
        </div>
      ) : null}
    </div>
  );
}

/* ── Notice / states ── */
const NOTICE_GLYPH = { info: "●", warning: "▲", danger: "■", success: "●" } as const;
/** One notice per screen at most (design principle 2 — the rest goes inside the panel it is about). `action` = a button on the right. */
export function Notice({ tone = "info", title, children, action }: { tone?: "info" | "warning" | "danger" | "success"; title?: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className={cx(s.notice, s[`notice_${tone}`])} role={tone === "danger" ? "alert" : "status"}>
      <span className={s.noticeGlyph} aria-hidden="true">{NOTICE_GLYPH[tone]}</span>
      <div className={s.noticeText}>
        {title ? <span className={s.noticeTitle}>{title} </span> : null}
        {children}
      </div>
      {action ? <div className={s.noticeAction}>{action}</div> : null}
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
