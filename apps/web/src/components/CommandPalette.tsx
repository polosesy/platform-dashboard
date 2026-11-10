"use client";

// Ctrl+K (⌘K) quick open — find a screen by typing (design draft ⑦). Screens come from navConfig; actions: language.
// A dialog with one input and one list: ↑ ↓ move, Enter opens, Esc closes, a click outside closes. Pure parts in
// lib/commandPalette.ts.

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n";
import { filterPalette, moveIndex, paletteScreens, type PaletteItem } from "@/lib/commandPalette";
import { NAV_GROUPS } from "@/lib/navConfig";
import { NavIcon } from "./navIcons";
import { useDisplayPrefs } from "@/lib/displayPrefs";
import s from "./CommandPalette.module.css";

const ICON = new Map(NAV_GROUPS.flatMap((g) => g.items.map((it) => [it.href, it.icon] as const)));

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, locale, setLocale } = useI18n();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const prefs = useDisplayPrefs();

  const items = useMemo<PaletteItem[]>(() => [
    ...paletteScreens(t),
    { id: "lang", kind: "action", label: t(locale === "ko" ? "cmd.toEnglish" : "cmd.toKorean"), desc: t("cmd.languageDesc"), group: t("cmd.actions") },
    { id: "theme", kind: "action", label: t(prefs.theme === "dark" ? "cmd.toLight" : "cmd.toDark"), desc: t("cmd.themeDesc"), group: t("cmd.actions") },
    { id: "density", kind: "action", label: t(prefs.density === "compact" ? "cmd.toComfortable" : "cmd.toCompact"), desc: t("cmd.densityDesc"), group: t("cmd.actions") },
  ], [t, locale, prefs.theme, prefs.density]);
  const shown = useMemo(() => filterPalette(items, query), [items, query]);
  const active = Math.min(index, Math.max(0, shown.length - 1));

  // Fresh each time it opens
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setIndex(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open) return null;

  const run = (it: PaletteItem | undefined) => {
    if (!it) return;
    onClose();
    if (it.href) router.push(it.href);
    else if (it.id === "lang") setLocale(locale === "ko" ? "en" : "ko");
    else if (it.id === "theme") prefs.setTheme(prefs.theme === "dark" ? "light" : "dark");
    else if (it.id === "density") prefs.setDensity(prefs.density === "compact" ? "comfortable" : "compact");
  };

  return (
    <div className={s.overlay} onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={s.dialog} role="dialog" aria-modal="true" aria-label={t("cmd.title")}
        onKeyDown={(e) => {
          if (e.key === "Escape") { e.preventDefault(); onClose(); }
          else if (e.key === "ArrowDown") { e.preventDefault(); setIndex(moveIndex(active, 1, shown.length)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setIndex(moveIndex(active, -1, shown.length)); }
          else if (e.key === "Enter") { e.preventDefault(); run(shown[active]); }
        }}>
        <div className={s.inputRow}>
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" fill="none" /><path d="M10.5 10.5 L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          <input ref={inputRef} className={s.input} value={query} placeholder={t("cmd.placeholder")} aria-label={t("cmd.title")}
            role="combobox" aria-expanded="true" aria-controls="cmd-list" aria-activedescendant={shown[active] ? `cmd-${active}` : undefined}
            onChange={(e) => { setQuery(e.target.value); setIndex(0); }} />
          <kbd className={s.kbd}>Esc</kbd>
        </div>
        <ul id="cmd-list" ref={listRef} className={s.list} role="listbox">
          {shown.length === 0 ? <li className={s.empty}>{t("cmd.none")}</li> : shown.map((it, i) => (
            <li key={it.id} id={`cmd-${i}`} data-i={i} role="option" aria-selected={i === active}
              className={s.item} onPointerMove={() => setIndex(i)} onClick={() => run(it)}>
              <span className={s.icon} aria-hidden="true">{it.href && ICON.get(it.href) ? <NavIcon name={ICON.get(it.href)!} /> : "⌘"}</span>
              <span className={s.text}>
                <span className={s.label}>{it.label}</span>
                <span className={s.desc}>{it.desc}</span>
              </span>
              <span className={s.group}>{it.group}</span>
            </li>
          ))}
        </ul>
        <div className={s.foot}>{t("cmd.keys")}</div>
      </div>
    </div>
  );
}
