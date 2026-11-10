import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
// Pure web module (no React) — the web package is CommonJS-typed, so read the namespace
import * as ns from "../../web/src/lib/palette.ts";

const p = ((ns as unknown as { default?: typeof ns }).default ?? ns) as typeof ns;
const css = readFileSync(resolve(fileURLToPath(new URL(".", import.meta.url)), "../../web/src/app/globals.css"), "utf8");

test("JS palette channels equal the --*-rgb tokens in globals.css", () => {
  // The light :root block — lib/palette.ts mirrors the light values (JS-drawn canvases stay on light paper in dark mode)
  const root = css.slice(css.indexOf(":root {"), css.indexOf("}", css.indexOf(":root {")));
  const tokens = Object.fromEntries([...root.matchAll(/--([\w-]+)-rgb:\s*([\d\s,]+);/g)].map((m) => [m[1]!, m[2]!.split(",").map((x) => Number(x.trim()))]));
  // CSS names are kebab-case; palette VIZ keys are camelCase
  const kebab = (k: string) => k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  for (const [k, v] of Object.entries(p.UI)) assert.deepEqual(tokens[k], [...v], `UI ${k}`);
  const vizInCss = Object.keys(tokens).filter((k) => !(k in p.UI));
  assert.deepEqual(vizInCss.sort(), ["canvas", "egress", "fault", "integration", "peering", "private-link", "secret", "slate", "subnet", "violet", "workload"], "CSS visualization channels");
  for (const k of vizInCss) {
    const key = Object.keys(p.VIZ).find((x) => kebab(x) === k) as keyof typeof p.VIZ;
    assert.ok(key, `palette VIZ has ${k}`);
    assert.deepEqual(tokens[k], [...p.VIZ[key]], `VIZ ${k}`);
  }
  assert.deepEqual([...p.UI.ok], [...p.UI.success], "one green: OK status = success");
});

test("named CSS tokens are built from the channels (one source of truth)", () => {
  for (const name of ["ink", "accent", "danger", "warning", "success", "ok"]) {
    assert.match(css, new RegExp(`--${name}: rgb\\(var\\(--${name}-rgb\\)\\);`), name);
  }
});

test("rgba / hex helpers", () => {
  assert.equal(p.rgba("accent", 0.55), "rgba(0,120,212,0.55)");
  assert.equal(p.rgba("danger"), "rgba(196,43,28,1)");
  assert.equal(p.rgba("danger", 0.1 * 3), `rgba(196,43,28,${0.1 * 3})`, "alpha passes through unchanged");
  assert.equal(p.hex("accent"), "#0078d4");
  assert.equal(p.hex("ok"), "#107c10");
  assert.equal(p.hex("privateLink"), "#8b5cf6");
});

test("TSX and CSS modules have no numeric rgb()/rgba() colours — CSS rgba(var(--x-rgb), a), TSX lib/palette rgba(key, a) (Hubble / AKS 모니터링 used other reds and greens)", () => {
  const root = new URL("../../web/src/", import.meta.url);
  const hits: string[] = [];
  const walk = (dir: URL) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(new URL(`${e.name}/`, dir));
      else if (e.name.endsWith(".tsx") || e.name.endsWith(".module.css")) {
        const src = readFileSync(new URL(e.name, dir), "utf8");
        for (const m of src.matchAll(/rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}/g)) hits.push(`${e.name}: ${m[0]}`);
      }
    }
  };
  walk(root);
  assert.deepEqual(hits, []);
});

test("no hex colours outside globals.css — tokens only (white text is the one kept literal, its reason beside it)", () => {
  const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../web/src");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const f = resolve(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (/\.(tsx|module\.css)$/.test(e.name)) files.push(f);
    }
  };
  walk(root);
  const bad: string[] = [];
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
      if (/^#(fff|ffffff)$/i.test(m[0])) continue;
      // `#` in a URL fragment / id selector is not a colour: only colour-shaped lengths, after ':', ',', '(', quote or space
      const before = text.slice(Math.max(0, m.index! - 1), m.index!);
      if (![3, 4, 6, 8].includes(m[0].length - 1) || !/[\s:,("'`]/.test(before)) continue;
      bad.push(`${f.slice(root.length + 1)}: ${m[0]}`);
    }
  }
  assert.deepEqual(bad, [], "use a token from app/globals.css (or lib/palette for canvas / SVG attributes)");
});
