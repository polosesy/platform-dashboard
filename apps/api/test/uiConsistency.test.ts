import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Static checks over the web sources — they catch regressions that tsc and next build do not:
// a page without the shared header, a CSS variable nobody defines (renders as transparent),
// and a CSS-module class that no longer exists (renders unstyled).

const webSrc = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../web/src");
const appDir = join(webSrc, "app");

function walk(dir: string, pred: (f: string) => boolean): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, pred));
    else if (pred(p)) out.push(p);
  }
  return out;
}
const rel = (p: string) => relative(webSrc, p).split(sep).join("/");
const read = (p: string) => readFileSync(p, "utf8");

test("every page renders the shared PageHeader (title = menu label)", () => {
  const pages = walk(appDir, (f) => f.endsWith(`${sep}page.tsx`));
  assert.ok(pages.length >= 15);
  const missing = pages.filter((p) => {
    const s = read(p);
    // /security/* pages use SecurityHeader, which wraps PageHeader
    return !/<PageHeader\b/.test(s) && !/<SecurityHeader\b/.test(s);
  });
  assert.deepEqual(missing.map(rel), []);
  assert.match(read(join(appDir, "security", "components.tsx")), /<PageHeader\b/);
});

test("every CSS variable used without a fallback is declared somewhere", () => {
  const css = walk(webSrc, (f) => f.endsWith(".css"));
  const tsx = walk(webSrc, (f) => /\.(tsx|ts)$/.test(f));
  const declared = new Set<string>();
  for (const f of css) for (const m of read(f).matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)) declared.add(m[1]!);
  for (const f of tsx) for (const m of read(f).matchAll(/["'](--[a-zA-Z0-9-]+)["']\s*:/g)) declared.add(m[1]!);
  const external = (v: string) => /^--(font-geist-|xy-|rf-)/.test(v);
  const undefinedVars = new Map<string, string>();
  for (const f of css) {
    for (const m of read(f).matchAll(/var\((--[a-zA-Z0-9-]+)\s*\)/g)) {
      const v = m[1]!;
      if (!declared.has(v) && !external(v)) undefinedVars.set(v, rel(f));
    }
  }
  assert.deepEqual([...undefinedVars].map(([v, f]) => `${v} (${f})`), []);
});

test("every CSS-module class referenced from TSX exists in that module", () => {
  const tsx = walk(webSrc, (f) => f.endsWith(".tsx"));
  const problems: string[] = [];
  for (const f of tsx) {
    const src = read(f);
    for (const m of src.matchAll(/import\s+(\w+)\s+from\s+["']([^"']+\.module\.css)["']/g)) {
      const [, alias, spec] = m;
      const cssPath = spec!.startsWith("@/") ? join(webSrc, spec!.slice(2)) : resolve(dirname(f), spec!);
      if (!existsSync(cssPath)) { problems.push(`${rel(f)}: missing ${spec}`); continue; }
      const css = read(cssPath);
      const classes = new Set([...css.matchAll(/\.([a-zA-Z_][a-zA-Z0-9_-]*)/g)].map((x) => x[1]!));
      const code = src.replace(/^import[^\n]*$/gm, ""); // ignore the import path itself
      for (const u of code.matchAll(new RegExp(`\\b${alias}\\.([a-zA-Z_][a-zA-Z0-9_]*)`, "g"))) {
        if (!classes.has(u[1]!)) problems.push(`${rel(f)}: ${alias}.${u[1]} not in ${relative(webSrc, cssPath).split(sep).join("/")}`);
      }
    }
  }
  assert.deepEqual([...new Set(problems)], []);
});

test("design tokens: fonts aliased on body, no duplicate :root declarations, one UI kit entry", () => {
  const g = read(join(appDir, "globals.css"));
  const rootBlock = g.slice(g.indexOf(":root {"), g.indexOf("}", g.indexOf(":root {")));
  assert.ok(!/--font-geist-/.test(rootBlock), "next/font variables live on <body>, so aliases must be declared there");
  const names = [...rootBlock.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)].map((m) => m[1]!);
  assert.deepEqual(names.filter((n, i) => names.indexOf(n) !== i), [], "no token declared twice");
  for (const t of ["--success", "--danger", "--warning", "--accent-soft", "--radius-xs", "--surface", "--fg", "--line"]) assert.ok(names.includes(t), t);
  assert.ok(!existsSync(join(webSrc, "components", "ui", "index.ts")), "index.ts would shadow index.tsx");
});

test("modules touched by the redesign use the danger token, not a second red", () => {
  const files = ["app/hubble/styles.module.css", "app/observability/styles.module.css", "app/architecture/styles.module.css", "app/security/security.module.css", "components/ui/ui.module.css"];
  const offenders = files.filter((f) => /rgba\(\s*196,\s*43,\s*28/.test(read(join(webSrc, f))));
  assert.deepEqual(offenders, []);
});

test("API URLs are built with apiUrl(path, params) — no hand-joined apiBaseUrl() + query strings outside lib/api.ts", () => {
  const offenders = walk(webSrc, (f) => /\.tsx?$/.test(f) && rel(f) !== "lib/api.ts")
    .filter((f) => /apiBaseUrl\(\)/.test(read(f)))
    .map(rel);
  assert.deepEqual(offenders, []);
});
