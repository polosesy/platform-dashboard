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

// Step 2 — the UI kit carries the panel rules (design canvas ⑤): every screen gets them by using the kit
const kitCss = readFileSync(join(webSrc, "components", "ui", "ui.module.css"), "utf8");
const kitTsx = readFileSync(join(webSrc, "components", "ui", "index.tsx"), "utf8");
const rule = (sel: string) => {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = kitCss.match(new RegExp(`(^|\\n)${esc} \\{([^}]*)\\}`));
  assert.ok(m, `ui.module.css has ${sel}`);
  return m![2]!;
};

test("UI kit: panel head 56 · foot 44 · flat · stretches in a row; 12-column grid; chips and badges 24; buttons 32 (touch 44)", () => {
  assert.match(rule(".panelHead"), /min-height: 56px/);
  assert.match(rule(".panelFoot"), /min-height: 44px/);
  assert.match(rule(".panel"), /height: 100%/);
  assert.doesNotMatch(rule(".panel"), /backdrop-filter|box-shadow/, "panels are flat and opaque");
  assert.match(rule(".panelTitle"), /font-size: var\(--text-heading\)/);
  assert.match(rule(".grid"), /grid-template-columns: repeat\(12, minmax\(0, 1fr\)\)/);
  for (const n of [3, 4, 6, 8, 9, 12]) assert.ok(kitCss.includes(`.span${n} { grid-column: span ${n}; }`), `span ${n}`);
  assert.match(rule(".chip"), /height: 24px/);
  assert.match(rule(".badge"), /height: 24px/);
  assert.match(rule(".button"), /height: 32px/);
  assert.match(rule(".lg"), /height: 44px/);
  assert.match(kitCss, /@media \(pointer: coarse\) \{[\s\S]*?min-height: 44px/, "touch screens get 44px controls");
  assert.doesNotMatch(rule(".notice"), /border-left-width/, "no thick left edge on notices");
  for (const name of ["Panel", "Grid", "Cell", "Chip", "CopyButton", "CodeBlock"]) assert.ok(kitTsx.includes(`export function ${name}(`) || kitTsx.includes(`export function ${name}<`), name);
});

test("SLO tab is built from the kit: grid cells, panels, chips — no hand-made card edges", () => {
  const tab = readFileSync(join(webSrc, "app", "observability", "components", "SloTab.tsx"), "utf8");
  for (const c of ["<Grid>", "<Cell span={3}>", "<Cell span={6}", "<Panel", "<Chip", "<CodeBlock"]) assert.ok(tab.includes(c), c);
  const css = readFileSync(join(webSrc, "app", "observability", "styles.module.css"), "utf8");
  assert.doesNotMatch(css, /\.sloCard\b|border-left: 4px/, "the old left-striped SLO card is gone");
  // One notice per screen: the tab renders at most one (gaps outrank the default-target note)
  assert.equal((tab.match(/<Notice /g) ?? []).length, 3, "metrics state · gaps · default target — and the page shows only one of them");
});

/**
 * Ratchet (2026-11-10): hand-made controls outside the kit may only go down. A raw <button> is sometimes right (a
 * heatmap tile, a row that expands, a canvas node) — so the count per file is frozen, not banned: a new screen uses
 * <Button>/<Chip>/<Badge>, and an existing file that needs another raw one raises its number here on purpose.
 */
const RAW_BUTTONS: Record<string, number> = {
  "app/architecture/components/ArchNodes.tsx": 3, "app/architecture/components/CategoryFilter.tsx": 1, "app/architecture/components/DiagramCanvas.tsx": 1,
  "app/architecture/components/Inspector.tsx": 6, "app/architecture/components/Legend.tsx": 1, "app/architecture/page.tsx": 4,
  "app/health/HealthHeatmap.tsx": 3, "app/health/InstanceHealthPanel.tsx": 3, "app/health/page.tsx": 4,
  "app/hubble/components/ServiceMapTab.tsx": 1, "app/live-diagram/components/AlertSidebar.tsx": 3, "app/live-diagram/components/EdgeDetailPanel.tsx": 1,
  "app/live-diagram/components/EmptySubnetsNode.tsx": 1, "app/live-diagram/components/FaultTimeline.tsx": 1, "app/live-diagram/components/GroupNode.tsx": 5,
  "app/live-diagram/components/Legend.tsx": 1, "app/live-diagram/components/LiveCanvas.tsx": 1, "app/live-diagram/components/LiveNode.tsx": 3,
  "app/live-diagram/components/ResourceDetailPanel.tsx": 12, "app/live-diagram/components/detail/HybridSection.tsx": 2, "app/live-diagram/components/detail/PeeringSection.tsx": 1,
  "app/live-diagram/components/detail/PrivateLinkUsage.tsx": 4, "app/live-diagram/components/detail/WafPanel.tsx": 4, "app/live-diagram/components/detail/primitives.tsx": 3,
  "app/live-diagram/page.tsx": 4, "app/network/components/TrafficMapSection.tsx": 1, "app/notifications/page.tsx": 1,
  "app/observability/components/LogsTab.tsx": 1, "app/observability/components/WorkloadHeatmap.tsx": 11, "app/observability/components/WorkloadLogStream.tsx": 2,
  "app/policies/components/ManagedComponentsPanel.tsx": 1, "app/policies/components/NetpolSimPanel.tsx": 6, "app/policies/insights/AttackGraph.tsx": 2,
  "app/policies/insights/ExplorePanel.tsx": 12, "app/policies/insights/Inspector.tsx": 2, "app/policies/insights/KbomPanel.tsx": 2,
  "app/policies/insights/NetworkMap.tsx": 7, "app/policies/insights/PermissionMatrix.tsx": 1, "app/policies/insights/RiskCombos.tsx": 12,
  "app/policies/insights/RiskHeatmap.tsx": 5, "app/policies/insights/WorkloadIdentityPanel.tsx": 8, "app/policies/page.tsx": 2,
  "app/security/advisories/page.tsx": 2, "app/security/components.tsx": 1, "app/security/risk/IssueQueue.tsx": 1,
  "app/security/risk/page.tsx": 1, "app/security/threats/page.tsx": 1, "app/settings/PermissionTable.tsx": 1,
  "components/AuthControls.tsx": 2, "components/Sidebar.tsx": 3, "components/TopNav.tsx": 2,
};
/** Page CSS classes that draw their own badge / chip / pill (the kit has Chip and Badge) — names per file, frozen */
const OWN_CHIP_CLASSES: Record<string, number> = {
  "app/architecture/styles.module.css": 7, "app/health/styles.module.css": 14, "app/hubble/styles.module.css": 7, "app/kubernetes/styles.module.css": 2,
  "app/live-diagram/styles.module.css": 22, "app/notifications/notifications.module.css": 1, "app/observability/styles.module.css": 12,
  "app/policies/insights/insights.module.css": 12, "app/policies/styles.module.css": 5, "app/security/security.module.css": 2,
};

test("ratchet: raw <button>s and page-made chip classes outside the kit only go down", () => {
  const over: string[] = [];
  for (const f of sources) {
    const r = rel(f);
    if (!r.endsWith(".tsx") || r.startsWith("components/ui/")) continue;
    const n = (readFileSync(f, "utf8").match(/<button[\s>]/g) ?? []).length; // a tag split over lines counts too
    if (n > (RAW_BUTTONS[r] ?? 0)) over.push(`${r}: ${n} raw <button> (frozen at ${RAW_BUTTONS[r] ?? 0}) — use <Button> from @/components/ui`);
  }
  for (const f of cssModules) {
    const r = rel(f);
    if (r.startsWith("components/ui/")) continue;
    const names = new Set([...readFileSync(f, "utf8").matchAll(/^\s*\.([a-zA-Z0-9_]*(?:Badge|Chip|Pill|badge|chip|pill)[a-zA-Z0-9_]*)[ ,{:[]/gm)].map((m) => m[1]));
    if (names.size > (OWN_CHIP_CLASSES[r] ?? 0)) over.push(`${r}: ${names.size} own chip/badge classes (frozen at ${OWN_CHIP_CLASSES[r] ?? 0}) — use <Chip>/<Badge>`);
  }
  assert.deepEqual(over, []);
});
