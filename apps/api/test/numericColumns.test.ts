import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as ns from "../../web/src/lib/numericColumns.ts";

// Number columns align right (renewal 2026-11-20, design-system.md 9.5): one rule over 55 page-made tables.
const N = ((ns as unknown as { default?: typeof ns }).default ?? ns) as typeof ns;
const row = (...cells: Array<string | [string, number]>) => cells.map((c) => (Array.isArray(c) ? { text: c[0], span: c[1] } : { text: c, span: 1 }));

test("numbers: digits with separators, a sign, a currency, a magnitude and a unit", () => {
  for (const s of ["0", "1,234", "12.5", "-3", "+10.9%", "US$1,129", "$12", "₩120만", "1.2K", "3.4 M", "320 ms", "1.5/s", "47.5 req/s",
    "700 MiB", "1 GiB", "0.3 cores", "100m", "28개", "6건", "×3", "4 / 8", "6 / 8개", "99.9%", "≥ 90%", "2.5 s", "0.2%p", "1.4×"]) {
    assert.equal(N.isNumericText(s), true, s);
  }
});

test("not numbers: versions, addresses, dates, times, words, mixed text, placeholders", () => {
  for (const s of ["1.32.6", "10.0.0.1", "10.0.0.0/24", "2026-11-20", "오후 04:56", "11/20", "v1.2", "3 고정", "1, 2, 3", "Standard_D4ds_v5",
    "Linux · AzureLinux", "abc", "", "—", "-", "?", "n/a", "12 abc", "GET /orders/{id}", "0x1f"]) {
    assert.equal(N.isNumericText(s), false, s);
  }
});

test("a column is numeric when every filled cell is a number — empties and placeholders do not count against it", () => {
  const rows = [row("system", "3", "1.32.6", "US$1,129"), row("apps", "—", "1.32.6", "US$980"), row("tools", "12", "1.33.0", "")];
  assert.deepEqual(N.numericColumns(rows), [1, 3]);
  // one word in the column = a text column
  assert.deepEqual(N.numericColumns([row("a", "3"), row("b", "고정")]), []);
  // a column with nothing filled is not a number column
  assert.deepEqual(N.numericColumns([row("a", "—"), row("b", "")]), []);
});

test("colspan: a spanning cell (group / note row) says nothing; the columns after it keep their place", () => {
  const rows = [row(["Group A", 3]), row("x", "1", "2"), row("y", "3", "4"), row(["note", 2], "5")];
  assert.deepEqual(N.numericColumns(rows), [1, 2]);
});

test("wiring: the frame applies it to every table; globals align the marked cells right (head too); opt-out exists", () => {
  const shell = readFileSync(new URL("../../web/src/components/AppShell.tsx", import.meta.url), "utf8");
  const hook = readFileSync(new URL("../../web/src/lib/useNumericColumns.ts", import.meta.url), "utf8");
  const css = readFileSync(new URL("../../web/src/app/globals.css", import.meta.url), "utf8");
  assert.match(shell, /useNumericColumns\(contentRef, pathname\)/);
  assert.match(hook, /closest\("\[data-align='left'\]"\)/, "a table can opt out");
  assert.match(hook, /table\.tHead/, "the header of a number column aligns with it");
  assert.match(hook, /characterData: true/, "values that change in place are re-read");
  assert.doesNotMatch(hook, /attributes: true/, "its own writes never re-trigger it");
  assert.match(css, /:is\(td, th\)\[data-num\]\[data-num\] \{\s*text-align: right;/);
});
