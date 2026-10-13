import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
// Pure web module (no React) — the web package is CommonJS-typed, so read the namespace
import * as msgNs from "../../web/src/lib/i18nMessages.ts";

const msg = ((msgNs as unknown as { default?: typeof msgNs }).default ?? msgNs) as typeof msgNs;
const webSrc = join(import.meta.dirname, "..", "..", "web", "src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /\.(tsx?|ts)$/.test(n) ? [p] : [];
  });
}
const files = walk(webSrc).filter((f) => !/i18nMessages\.ts$|i18nPolicies\.ts$|i18n[A-Z]\w*\.ts$/.test(f));
const rel = (f: string) => relative(webSrc, f).replace(/\\/g, "/");

test("translation modules: no key defined twice, every value filled in both languages", () => {
  const seen = new Map<string, string>();
  const dup: string[] = [];
  for (const [mod, table] of Object.entries(msg.MODULES)) {
    for (const k of Object.keys(table)) {
      if (seen.has(k)) dup.push(`${k} (${seen.get(k)} + ${mod})`);
      seen.set(k, mod);
    }
  }
  assert.deepEqual(dup, []);
  const empty = Object.entries(msg.T).filter(([, v]) => !v.ko.trim() || !v.en.trim()).map(([k]) => k);
  assert.deepEqual(empty, []);
});

test("translations: ko and en use the same {placeholders}", () => {
  const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
  const bad = Object.entries(msg.T).filter(([, v]) => vars(v.ko) !== vars(v.en)).map(([k, v]) => `${k}: ko{${vars(v.ko)}} en{${vars(v.en)}}`);
  assert.deepEqual(bad, []);
});

test("translations: English text has no Korean", () => {
  const bad = Object.entries(msg.T).filter(([, v]) => /[가-힣]/.test(v.en)).map(([k]) => k);
  assert.deepEqual(bad, []);
});

test("every literal t(\"key\") used in the web app exists", () => {
  const missing: string[] = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/\bt\(\s*"([a-zA-Z0-9_.]+)"/g)) if (!(m[1]! in msg.T)) missing.push(`${rel(f)}: ${m[1]}`);
  }
  assert.deepEqual([...new Set(missing)], []);
});

// The whole web app is translated: no Korean string literals or JSX text outside comments.
// (Korean in data from the API is translated by the API itself — see apps/api/src/infra/lang.ts.)
const TRANSLATED = ["app/", "components/", "lib/"];
// Deliberate Korean literals: API values matched in code (a risk label, the "인터넷" token of live-diagram
// specs saved before the "Internet" token), and the "한" (Korean) button of the event translation toggle —
// a language name, shown as is in both locales like "KO"
const ALLOWED = [/r === "익명 접근"/, /const INTERNET = \/\^\(Internet\|인터넷\)\$\//, /^\s*한\s*$/];

test("translated areas have no hard-coded Korean text", () => {
  const found: string[] = [];
  for (const f of files) {
    const r = rel(f);
    if (!TRANSLATED.some((d) => r.startsWith(d))) continue;
    const lines = readFileSync(f, "utf8").split(/\r?\n/);
    let block = false;
    lines.forEach((line, i) => {
      let code = line;
      if (block) { const end = code.indexOf("*/"); if (end < 0) return; code = code.slice(end + 2); block = false; }
      code = code.replace(/\/\*.*?\*\//g, "");
      const open = code.indexOf("/*");
      if (open >= 0) { code = code.slice(0, open); block = true; }
      code = code.replace(/(^|[^:"'`])\/\/.*$/, "$1");
      if (/[가-힣]/.test(code) && !ALLOWED.some((a) => a.test(code))) found.push(`${r}:${i + 1}: ${code.trim().slice(0, 90)}`);
    });
  }
  assert.deepEqual(found, []);
});
