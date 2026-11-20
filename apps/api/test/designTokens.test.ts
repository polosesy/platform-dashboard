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
/**
 * Since 2026-11-10 the canvases follow the 12px minimum too (the canvas tokens are 12px, the inline SVG/React Flow
 * label sizes are on the scale). The one exception is the draw.io export — a file opened in draw.io, not this screen.
 */
const CANVAS_TS = new Set([
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
  assert.match(globals, /--canvas-text-xs:\s*12px/, "canvases too: 12px at 100 % zoom");
  assert.match(globals, /--canvas-text-sm:\s*12px/);
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
  for (const t of ["--shadow-raise", "--shadow-pop", "--shadow-hairline", "--ring-accent", "--motion-fast", "--motion-base", "--motion-slow"]) assert.match(globals, new RegExp(`${t}:`), t);
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
  assert.match(rule(".panelHead"), /min-height: var\(--panel-head\)/);
  assert.match(rule(".panelFoot"), /min-height: var\(--panel-foot\)/);
  // 편안함 56 · 44 · 16 · 56 (default) — 조밀 48 · 36 · 12 · 40 (data-density="compact")
  assert.match(globals, /--panel-head: 56px;[\s\S]*--panel-foot: 44px;[\s\S]*--panel-pad: 16px;[\s\S]*--row: 56px;/);
  assert.match(globals, /\[data-density="compact"\] \{\s*--panel-head: 48px;\s*--panel-foot: 36px;\s*--panel-pad: 12px;\s*--row: 40px;/);
  // Dark is opt-in (data-theme="dark", or "system" under a dark OS) — never the default
  assert.match(globals, /:root\[data-theme="dark"\] \{/);
  assert.match(globals, /@media \(prefers-color-scheme: dark\) \{\s*:root\[data-theme="system"\]/);
  assert.match(rule(".panel"), /height: 100%/);
  // 2026-11-20 renewal: a resting surface may carry only the hairline token (paper on the ground) — never a float shadow
  assert.doesNotMatch(rule(".panel"), /backdrop-filter/, "panels are opaque");
  assert.match(rule(".panel"), /box-shadow: var\(--shadow-hairline\);/);
  assert.doesNotMatch(rule(".panel"), /shadow-raise|shadow-pop/, "a resting panel does not float");
  assert.match(rule(".panelTitle"), /font-size: var\(--text-heading\)/);
  assert.match(rule(".grid"), /grid-template-columns: repeat\(12, minmax\(0, 1fr\)\)/);
  for (const n of [3, 4, 6, 8, 9, 12]) assert.ok(kitCss.includes(`.span${n} { grid-column: span ${n}; }`), `span ${n}`);
  assert.match(rule(".chip"), /height: 24px/);
  assert.match(rule(".badge"), /height: 24px/);
  assert.match(rule(".button"), /height: 32px/);
  assert.match(rule(".lg"), /height: 44px/);
  assert.match(kitCss, /@media \(pointer: coarse\) \{[\s\S]*?min-height: 44px/, "touch screens get 44px controls");
  assert.doesNotMatch(rule(".notice"), /border-left-width/, "no thick left edge on notices");
  for (const name of ["Panel", "Grid", "Cell", "Chip", "CopyButton", "CodeBlock", "FilterChip", "LinkButton"]) assert.ok(kitTsx.includes(`export function ${name}(`) || kitTsx.includes(`export function ${name}<`), name);
});

// 2026-11-11: chips ON the zoomable canvas keep their own height (a card row is 16–18px — the kit's 24px chip would
// change the card size the layout math and its tests are built on), but share one grammar: pill corners, weight 600
test("canvas chips (live diagram cards, subnet heads, edge labels) share one grammar: pill corners, weight 600", () => {
  const live = readFileSync(join(webSrc, "app", "live-diagram", "styles.module.css"), "utf8").replace(/\r\n/g, "\n");
  for (const sel of [".cardChip", ".cardPill", ".egressChip", ".nsgBadge", ".edgePill", ".internetNodeDeprecatedBadge"]) {
    const m = live.match(new RegExp(`(^|\\n)\\${sel} \\{([^}]*)\\}`));
    assert.ok(m, sel);
    assert.match(m![2]!, /border-radius: var\(--radius-pill\)/, `${sel} corners`);
    assert.match(m![2]!, /font-weight: 600/, `${sel} weight`);
  }
});

// 2026-11-10: the two hand-made controls most screens drew (a pill you press — 18 copies; a word you press — 34) are kit parts
test("UI kit: FilterChip = 28px pill, chosen = tint + ✓ (not colour alone), touch 44 · LinkButton = accent text, no box", () => {
  assert.match(rule(".filterChip"), /height: 28px/);
  assert.match(rule(".filterChip"), /border-radius: var\(--radius-pill\)/);
  assert.match(kitTsx, /pressed \? <span className=\{s\.filterCheck\} aria-hidden="true">✓<\/span>/, "chosen chips carry a ✓");
  assert.match(kitCss, /@media \(pointer: coarse\) \{\s*\.filterChip,/, "filter chips are 44 tall on touch screens");
  assert.match(rule(".linkButton"), /border: 0/);
  assert.match(rule(".linkButton"), /color: var\(--accent-strong\)/);
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
  "app/architecture/components/ArchNodes.tsx": 3, "app/architecture/components/DiagramCanvas.tsx": 1, "app/architecture/components/Legend.tsx": 1,
  "app/architecture/page.tsx": 2, "app/health/HealthHeatmap.tsx": 2, "app/health/page.tsx": 4,
  "app/hubble/components/ServiceMapTab.tsx": 1, "app/live-diagram/components/AlertSidebar.tsx": 3, "app/live-diagram/components/EmptySubnetsNode.tsx": 1,
  "app/live-diagram/components/FaultTimeline.tsx": 1, "app/live-diagram/components/GroupNode.tsx": 5, "app/live-diagram/components/Legend.tsx": 1,
  "app/live-diagram/components/LiveCanvas.tsx": 1, "app/live-diagram/components/LiveNode.tsx": 3, "app/live-diagram/components/detail/PeeringSection.tsx": 1,
  "app/live-diagram/components/detail/PrivateLinkUsage.tsx": 1, "app/live-diagram/components/detail/primitives.tsx": 4, "app/live-diagram/page.tsx": 4,
  "app/network/components/TrafficMapSection.tsx": 1, "app/notifications/page.tsx": 1, "app/observability/components/PodLogList.tsx": 1, "app/observability/components/ServiceMapView.tsx": 1,
  "app/observability/components/WorkloadHeatmap.tsx": 11, "app/observability/components/WorkloadLogStream.tsx": 1, "app/policies/components/ManagedComponentsPanel.tsx": 1,
  "app/policies/components/NetpolSimPanel.tsx": 1, "app/policies/insights/ExplorePanel.tsx": 1, "app/policies/insights/KbomPanel.tsx": 1,
  "app/policies/insights/RiskCombos.tsx": 2, "app/policies/insights/RiskHeatmap.tsx": 2, "app/policies/page.tsx": 2,
  "app/security/advisories/page.tsx": 2, "app/security/components.tsx": 1, "app/security/risk/IssueQueue.tsx": 1,
  "app/security/risk/page.tsx": 1, "app/security/threats/page.tsx": 1, "app/settings/PermissionTable.tsx": 1,
  // Sidebar 2 (2026-11-11): a group heading is a disclosure that folds its links — a row that expands, not an action
  "components/Sidebar.tsx": 2, "components/TopNav.tsx": 3,
};
/** Page CSS classes that draw their own badge / chip / pill (the kit has Chip and Badge) — names per file, frozen */
const OWN_CHIP_CLASSES: Record<string, number> = {
  "app/architecture/styles.module.css": 7, "app/hubble/styles.module.css": 7, "app/kubernetes/styles.module.css": 2, "app/live-diagram/styles.module.css": 14,
  "app/notifications/notifications.module.css": 1, "app/observability/styles.module.css": 11, "app/policies/insights/insights.module.css": 10, "app/policies/styles.module.css": 4,
  "app/security/security.module.css": 2,
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

test("no blur: surfaces are opaque (a blurred, see-through panel made small numbers hard to read — and dark mode wrong)", () => {
  const bad = decls("backdrop-filter").filter(({ value }) => value !== "none").map((d) => `${d.file}:${d.line} ${d.value}`);
  assert.deepEqual(bad, []);
});

// 2026-11-20 renewal — the look that reads as generated: a fade between two colours as decoration (the cost bars, the
// budget fills, the brand tile were blue → lighter blue / blue → teal). A gradient may only draw a pattern or a flat
// overlay: hatching (repeating-*), dots (radial), a layer whose stops are all the same colour, or a loading shimmer.
const GRADIENT_OK = new Set([
  "app/health/styles.module.css", // loading shimmer bar (moves; not a fill)
]);
function gradientStops(args: string): string[] {
  const parts: string[] = []; let depth = 0, cur = "";
  for (const ch of args) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { parts.push(cur.trim()); cur = ""; } else cur += ch;
  }
  parts.push(cur.trim());
  return parts
    .filter((p) => !/^(to |-?[\d.]+(deg|turn|rad))/.test(p))
    .map((p) => p.replace(/\s+-?[\d.]+(%|px)(\s+-?[\d.]+(%|px))?$/, "").trim());
}
test("no decorative gradients: a linear-gradient between two different colours only where it is a pattern", () => {
  const bad: string[] = [];
  for (const f of cssModules) {
    if (GRADIENT_OK.has(rel(f))) continue;
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(/(?<!repeating-)linear-gradient\(/g)) {
      let i = m.index! + m[0].length, depth = 1;
      const start = i;
      while (i < text.length && depth > 0) { if (text[i] === "(") depth++; if (text[i] === ")") depth--; i++; }
      const stops = gradientStops(text.slice(start, i - 1));
      if (new Set(stops).size > 1) bad.push(`${rel(f)}:${text.slice(0, m.index).split("\n").length} ${stops.join(" → ")}`);
    }
  }
  assert.deepEqual(bad, []);
});

test("text colours come from the text tokens (see-through ink failed contrast), and labels are not all-caps", () => {
  const bad = decls("color").filter(({ value }) => /^rgba\(var\(--ink-rgb\)/.test(value)).map((d) => `${d.file}:${d.line} color: ${d.value}`);
  assert.deepEqual(bad, [], "use var(--ink) · var(--muted) (7.6:1) · var(--subtle) (4.8:1)");
  const caps = decls("text-transform").filter(({ value }) => value === "uppercase").map((d) => `${d.file}:${d.line}`);
  assert.deepEqual(caps, []);
});

// 2026-11-20 renewal — measured on every menu route with Playwright + axe (design-system.md 9절)
test("renewal: state changes ease by default, quiet scrollbars, contrast-safe selected tab, focusable code blocks", () => {
  // zero-specificity baseline: colour-like properties only (nothing moves unless a module says so)
  assert.match(globals, /:where\(a, button, \[role="button"\][^)]*\) \{\s*transition-property: color, background-color, border-color, box-shadow, opacity/);
  assert.match(globals, /scrollbar-width: thin;/);
  assert.match(globals, /--chrome-h: 56px;/);
  // --accent on the page ground was 4.22:1 (axe) — the selected tab's words use the strong shade
  assert.match(rule('.tab[aria-selected="true"]'), /color: var\(--accent-strong\);/);
  // a command longer than the box scrolls sideways — the keyboard must reach it (axe scrollable-region-focusable)
  assert.match(kitTsx, /<pre className=\{s\.codePre\}[^>]*tabIndex=\{0\}>/);
  // loading = skeleton lines, not a dashed "empty" box
  assert.match(kitTsx, /className=\{s\.loading\} role="status"/);
  assert.match(rule(".stat"), /box-shadow: var\(--shadow-hairline\);/);
});

// Renewal step 2 (2026-11-20): one table grammar under 20+ page-made table classes — column headers 600 (they were
// 600 × 17 and 700 × 11), digits line up, the hovered row is tinted (2 of 6 measured tables did it)
test("tables: header weight 600 everywhere, tabular digits and a row hover from the global baseline", () => {
  const bad: string[] = [];
  for (const f of cssModules) {
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
      const toks = m[1]!.split(/[\s,>.:[\]()]+/);
      if (toks.includes("th") && /font-weight:\s*700/.test(m[2]!)) bad.push(`${rel(f)} ${m[1]!.trim()}`);
    }
  }
  assert.deepEqual(bad, []);
  assert.match(globals, /:where\(table\) \{\s*font-variant-numeric: tabular-nums;/);
  assert.match(globals, /:where\(tbody > tr:hover\) > :where\(td, th\) \{\s*background-color:/);
});

test("renewal step 2: page rhythm 16 on the screens that had 0 / 12 / 14, placeholder words in the text face", () => {
  const read = (p: string) => readFileSync(join(webSrc, p), "utf8");
  for (const p of ["app/runbooks/runbooks.module.css", "app/notifications/notifications.module.css"]) {
    assert.match(read(p), /\.page \{ display: grid; grid-template-columns: minmax\(0, 1fr\); gap: 16px; \}/, p);
  }
  for (const p of ["app/health/styles.module.css", "app/settings/settings.module.css", "app/security/security.module.css"]) {
    assert.match(read(p), /^\.page \{\s*display: grid;\s*grid-template-columns: minmax\(0, 1fr\);\s*gap: 16px;/m, p);
  }
  for (const p of ["app/runbooks/page.tsx", "app/notifications/page.tsx", "app/security/explore/page.tsx"]) assert.match(read(p), /<div className=\{s\.page\}>/, p);
  assert.match(kitCss, /\.textarea::placeholder \{\s*font-family: var\(--font-sans\);/);
});

// Renewal step 3 (2026-11-20): one canvas card grammar — the cards keep their sizes (layout + tests depend on them);
// rest = token border + hairline, hover = raise, chosen = the accent ring, changes ease over --motion-base
test("canvas card grammar: live card · AKS node card · diagram tile · service map card", () => {
  const css = (p: string) => readFileSync(join(webSrc, p), "utf8");
  const block = (text: string, sel: string) => {
    const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = text.match(new RegExp(`(^|\\n)${esc} \\{([^}]*)\\}`));
    assert.ok(m, sel); return m![2]!;
  };
  const live = css("app/live-diagram/styles.module.css"), arch = css("app/architecture/styles.module.css"), net = css("app/hubble/styles.module.css");
  for (const [text, sel] of [[live, ".card"], [arch, ".tile"], [net, ".nmCard"]] as const) {
    const b = block(text, sel);
    assert.match(b, /border: 1px solid var\(--border-strong\)/, `${sel} border`);
    assert.match(b, /box-shadow: var\(--shadow-hairline\)/, `${sel} hairline`);
    assert.match(b, /var\(--motion-base\) var\(--ease-out\)/, `${sel} eases`);
  }
  assert.match(block(live, ".card"), /width: 220px;\s*height: 100px;/, "the live card keeps 220 × 100");
  assert.match(live, /\.card\[data-focused\] \{ box-shadow: var\(--ring-accent\), var\(--shadow-raise\); \}/);
  assert.match(arch, /\.selected \.tile \{\s*border-color: var\(--accent\);\s*box-shadow: var\(--ring-accent\), var\(--shadow-raise\);/);
  assert.match(net, /\.nmCard\[data-selected\] \{ box-shadow: var\(--ring-accent\), var\(--shadow-raise\); \}/);
  for (const text of [live, arch, net]) assert.match(text, /:hover \{?[^}]*box-shadow: var\(--shadow-raise\)/);
  assert.match(block(live, ".cardName"), /font-weight: 600/);
});
