// Ctrl+K quick open (pure — tested in apps/api/test/commandPalette.test.ts). Every screen comes from navConfig (the
// one menu source), labelled and described in the current language; a few actions sit beside them. Matching is plain
// and predictable: every word typed must appear (label, description, group, or path); label hits rank first.

import { NAV_GROUPS } from "./navConfig";

export type PaletteItem = {
  id: string;
  kind: "screen" | "action";
  label: string;
  desc: string;
  group: string;
  /** a screen's path */
  href?: string;
};

type T = (key: string, vars?: Record<string, string | number>) => string;

/** Pure: the screens in menu order, in the given language */
export function paletteScreens(t: T): PaletteItem[] {
  return NAV_GROUPS.flatMap((g) => g.items.map((it) => ({
    id: it.href, kind: "screen" as const, label: t(it.labelKey), desc: t(it.descKey), group: t(g.labelKey), href: it.href,
  })));
}

const norm = (s: string) => s.toLowerCase().normalize("NFC").replace(/\s+/g, " ").trim();

/**
 * Pure: the items matching the query, best first. Each word must appear somewhere; the score = for each word, 3 if the
 * label starts with it, 2 if the label contains it, 1 if only the description / group / path does. Ties keep the
 * menu order. An empty query returns everything in order.
 */
export function filterPalette(items: PaletteItem[], query: string): PaletteItem[] {
  const words = norm(query).split(" ").filter(Boolean);
  if (!words.length) return items;
  const scored: Array<{ it: PaletteItem; score: number; i: number }> = [];
  items.forEach((it, i) => {
    const label = norm(it.label);
    const rest = norm(`${it.desc} ${it.group} ${it.href ?? ""}`);
    let score = 0;
    for (const w of words) {
      if (label.startsWith(w)) score += 3;
      else if (label.includes(w)) score += 2;
      else if (rest.includes(w)) score += 1;
      else return;
    }
    scored.push({ it, score, i });
  });
  return scored.sort((a, b) => b.score - a.score || a.i - b.i).map((x) => x.it);
}

/** Pure: the next highlighted row for ↑ / ↓ (wraps), clamped when the list shrinks */
export function moveIndex(current: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return (((current + delta) % length) + length) % length;
}
