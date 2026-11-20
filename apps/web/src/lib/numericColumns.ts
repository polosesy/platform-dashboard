// Number columns align right (renewal 2026-11-20, design-system.md 9.5): 55 files draw their own tables, so instead of
// marking columns by hand in each, one rule decides — a column whose every filled body cell is a number (with a unit,
// a currency or a sign) is a number column; its cells and its header align right so the digits line up by place.
// Pure (apps/api/test/numericColumns.test.ts); `lib/useNumericColumns.ts` applies it to the tables on screen.

/** Placeholders a number column may contain: no value is not text */
const EMPTY = new Set(["", "—", "-", "–", "?", "n/a", "N/A"]);

// sign · currency · digits with , or one . · optional K/M/B/천/만/억 · optional unit (no letters glued to the digits
// beyond the known units) — "1.32.6", "10.0.0.1", "2026-11-20", "v1.2", "3 고정" are not numbers; a ratio needs spaces
// ("4 / 8") because "11/20" is a date in en-US
const UNIT = String.raw`(?:%|‰|ms|μs|µs|ns|s|m|h|d|분|초|시간|일|개|건|회|명|곳|배|번|B|KB|MB|GB|TB|KiB|MiB|GiB|TiB|bps|Kbps|Mbps|Gbps|B\/s|KB\/s|MB\/s|\/s|\/분|\/min|\/h|req\/s|ops\/s|rps|cores?|m?cores|vCPU|pp|%p|x|×)`;
const NUMBER = new RegExp(
  String.raw`^(?:[+\-−±~≈<>≤≥]\s?)?(?:US\$|\$|₩|€|£|¥)?\s?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:\s?(?:K|M|B|G|T|천|만|억))?(?:\s?` + UNIT + String.raw`)?(?:\s(?:\/|·)\s(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:\s?` + UNIT + String.raw`)?)?$|^×\s?\d+(?:\.\d+)?$`,
);

/** Is this cell text a number (with its unit)? "1,234" "12.5%" "US$1,129" "320 ms" "4 / 8" "×3" — yes */
export function isNumericText(raw: string): boolean {
  const s = raw.replace(/\s+/g, " ").trim();
  if (EMPTY.has(s)) return false;
  return NUMBER.test(s);
}

export type CellText = { text: string; span: number };

/**
 * Number columns of a table body: logical column indexes (colspan counted) where every filled cell is a number and at
 * least `min` cells are filled. A cell spanning several columns says nothing about them (a group row, a note row).
 */
export function numericColumns(rows: CellText[][], min = 1): number[] {
  const seen = new Map<number, { nums: number; text: number }>();
  for (const row of rows) {
    let col = 0;
    for (const c of row) {
      if (c.span === 1) {
        const s = c.text.replace(/\s+/g, " ").trim();
        if (!EMPTY.has(s)) {
          const e = seen.get(col) ?? { nums: 0, text: 0 };
          if (isNumericText(s)) e.nums++; else e.text++;
          seen.set(col, e);
        }
      }
      col += Math.max(1, c.span);
    }
  }
  return [...seen].filter(([, e]) => e.text === 0 && e.nums >= min).map(([i]) => i).sort((a, b) => a - b);
}
