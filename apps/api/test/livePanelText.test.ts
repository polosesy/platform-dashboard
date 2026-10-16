import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Detail panel rows: the KV label column is 84 px and holds fixed words (i18n). Data — host names, origin, pool or
// listener names — goes in a two-line row (TwoLine / styles.dpTwoLine); in the label column it ran under the value.
const DIR = join(import.meta.dirname, "../../web/src/app/live-diagram/components");
const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? files(p) : p.endsWith(".tsx") ? [p] : [];
});

test("no data expression as a KV label in the live-diagram panels", () => {
  const bad: string[] = [];
  for (const f of files(DIR)) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/<KV\b[^>]*\blabel=\{([a-z]\w*\.\w+)\}/g)) bad.push(`${f.split(/[\/]/).slice(-2).join("/")}: label={${m[1]}}`);
  }
  assert.deepEqual(bad, []);
});
