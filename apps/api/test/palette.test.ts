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
  const tokens = Object.fromEntries([...css.matchAll(/--([\w-]+)-rgb:\s*([\d\s,]+);/g)].map((m) => [m[1]!, m[2]!.split(",").map((x) => Number(x.trim()))]));
  // CSS names are kebab-case; palette VIZ keys are camelCase
  const kebab = (k: string) => k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  for (const [k, v] of Object.entries(p.UI)) assert.deepEqual(tokens[k], [...v], `UI ${k}`);
  const vizInCss = Object.keys(tokens).filter((k) => !(k in p.UI));
  assert.deepEqual(vizInCss.sort(), ["canvas", "egress", "fault", "peering", "private-link", "subnet", "violet"], "CSS visualization channels");
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
  assert.equal(p.rgba("danger"), "rgba(216,59,1,1)");
  assert.equal(p.rgba("danger", 0.1 * 3), `rgba(216,59,1,${0.1 * 3})`, "alpha passes through unchanged");
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
