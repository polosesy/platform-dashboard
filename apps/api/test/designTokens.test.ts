import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Design principles v1 (docs/architecture/design-system.md) — step 1: one type scale, nothing under 12px on screen,
// four weights, three radii, flat surfaces. Before 2026-11-09 the web app had 25 font sizes (324 declarations
// at 8–11.5px), 12 weights, 30 radii and 54 shadows, and Korean fell back to the OS font (Geist has no Hangul).

const webSrc = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../web/src");
const rel = (p: string) => relative(webSrc, p).split(sep).join("/");
function walk(dir: string, pred: (f: string) => boolean): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, pred));
    else if (pred(p)) out.push(p);
  }
  return out;
}
const globals = readFileSync(join(webSrc, "app", "globals.css"), "utf8");
const cssModules = walk(webSrc, (f) => f.endsWith(".css") && !f.endsWith(`${sep}globals.css`));
const sources = walk(webSrc, (f) => /\.(tsx|ts)$/.test(f));

/**
 * Zoomable canvases: text is drawn in canvas units and scales with zoom (React Flow nodes, viewBox SVG, the draw.io
 * export), so the screen minimum does not apply. CSS files may use --canvas-text-* here (and only here); TS files may
 * use numeric font sizes under 12. The canvas cards are redesigned for 12px at 100% zoom in a later step.
 */
const CANVAS_CSS = new Set([
  "app/live-diagram/styles.module.css", // live diagram cards, groups, lanes
  "app/architecture/styles.module.css", // infrastructure diagram tiles and boxes
  "app/hubble/styles.module.css", // service map cards (also the VNet traffic map)
  "app/policies/insights/insights.module.css", // attack path / network map SVG text
]);
const CANVAS_TS = new Set([
  "app/architecture/components/ArchEdge.tsx",
  "app/architecture/page.tsx",
  "app/architecture/utils/toFlow.ts",
  "app/hubble/components/ServiceMapTab.tsx",
  "app/network/components/TrafficMapSection.tsx",
  "app/live-diagram/utils/designTokens.ts",
  "app/policies/insights/AttackGraph.tsx",
  "app/policies/insights/NetworkMap.tsx",
  "lib/archDrawio.ts", // draw.io export — a file, not the screen
]);

const SCALE = { display: 28, title: 20, heading: 16, body: 14, small: 13, caption: 12 };

/** declarations of one CSS property across the CSS modules: file, line, value */
function decls(prop: string): Array<{ file: string; line: number; value: string }> {
  const out: Array<{ file: string; line: number; value: string }> = [];
  for (const f of cssModules) {
    readFileSync(f, "utf8").split("\n").forEach((l, i) => {
      for (const m of l.matchAll(new RegExp(`(?<![\\w-])${prop}:\\s*([^;}]+)`, "g"))) out.push({ file: rel(f), line: i + 1, value: m[1]!.trim() });
    });
  }
  return out;
}

test("globals.css defines exactly the six-step type scale, canvas sizes and the body default", () => {
  const sizes = Object.fromEntries([...globals.matchAll(/--text-(\w+):\s*(\d+)px/g)].map((m) => [m[1]!, Number(m[2])]));
  assert.deepEqual(sizes, SCALE);
  assert.ok(Math.min(...Object.values(sizes)) >= 12, "nothing under 12px on screen");
  assert.match(globals, /--canvas-text-xs:\s*10px/);
  assert.match(globals, /--canvas-text-sm:\s*11px/);
  assert.match(globals, /font-size: var\(--text-body\);/, "body text = 14px");
  assert.match(globals, /"Pretendard Variable"/, "one family for Korean and Latin");
});

test("CSS modules: font-size only from the scale tokens (canvas tokens only in canvas files)", () => {
  const bad = decls("font-size").filter(({ file, value }) => {
    if (/^var\(--text-(display|title|heading|body|small|caption)\)$/.test(value) || value === "inherit") return false;
    if (/^var\(--canvas-text-(xs|sm)\)$/.test(value)) return !CANVAS_CSS.has(file);
    return true;
  });
  assert.deepEqual(bad.map((d) => `${d.file}:${d.line} ${d.value}`), [], "use var(--text-*) — the scale is 12·13·14·16·20·28");
});

test("TSX/TS inline font sizes: on the scale, and under 12px only on zoomable canvases", () => {
  const allowed = new Set(Object.values(SCALE));
  const bad: string[] = [];
  for (const f of sources) {
    if (CANVAS_TS.has(rel(f))) continue;
    readFileSync(f, "utf8").split("\n").forEach((l, i) => {
      for (const m of l.matchAll(/fontSize[=:]\s*\{?\s*([\d.]+)/g)) if (!allowed.has(Number(m[1]))) bad.push(`${rel(f)}:${i + 1} fontSize ${m[1]}`);
    });
  }
  assert.deepEqual(bad, []);
});

test("font weights: 400 · 500 · 600 · 700 only (CSS and inline styles)", () => {
  const ok = new Set(["400", "500", "600", "700", "inherit", "normal", "bold"]);
  const bad = decls("font-weight").filter(({ value }) => !ok.has(value.replace(/\s*!important$/, ""))).map((d) => `${d.file}:${d.line} ${d.value}`);
  for (const f of sources) {
    readFileSync(f, "utf8").split("\n").forEach((l, i) => {
      for (const m of l.matchAll(/fontWeight[=:]\s*\{?\s*["']?(\d+)/g)) if (!ok.has(m[1]!)) bad.push(`${rel(f)}:${i + 1} fontWeight ${m[1]}`);
    });
  }
  assert.deepEqual(bad, []);
});

test("font families: var(--font-sans) or var(--font-mono) only", () => {
  const bad = decls("font-family").filter(({ value }) => !/^(var\(--font-(sans|mono)\)|inherit)$/.test(value));
  assert.deepEqual(bad.map((d) => `${d.file}:${d.line} ${d.value}`), []);
});

test("border-radius: radius tokens only — controls 6, surfaces 10, pills (or 0 / 50% circles)", () => {
  assert.match(globals, /--radius-sm:\s*6px/);
  assert.match(globals, /--radius-md:\s*10px/);
  assert.match(globals, /--radius-pill:\s*999px/);
  const bad = decls("border-radius").filter(({ value }) =>
    value
      .replace(/\s*!important$/, "")
      .split(/\s+(?![^(]*\))/)
      .some((p) => !/^(var\(--radius-(sm|md|pill)\)|0|50%|inherit)$/.test(p)),
  );
  assert.deepEqual(bad.map((d) => `${d.file}:${d.line} ${d.value}`), []);
});

test("shadows: surfaces are flat — a blurred shadow only through var(--shadow-raise | --shadow-pop)", () => {
  const bad = decls("box-shadow").filter(({ value }) =>
    value
      .replace(/\s*!important$/, "")
      .split(/,(?![^(]*\))/)
      .map((p) => p.trim())
      .some((p) => {
        if (p.startsWith("inset") || p.startsWith("var(") || p === "none") return false;
        const lengths = p.replace(/rgba?\([^)]*\)|var\([^)]*\)/g, "").trim().split(/\s+/);
        return Number.parseFloat(lengths[2] ?? "0") > 0; // blur radius
      }),
  );
  assert.deepEqual(bad.map((d) => `${d.file}:${d.line} ${d.value}`), []);
  for (const t of ["--shadow-raise", "--shadow-pop", "--ring-accent", "--motion-fast", "--motion-base", "--motion-slow"]) assert.match(globals, new RegExp(`${t}:`), t);
  assert.match(globals, /prefers-reduced-motion: reduce/);
});
