// The platform's mark (2026-11-13): the browser icons (scripts/gen-icons.mjs → app/icon.svg, favicon.ico,
// apple-icon.png) and the on-screen mark (components/BrandMark.tsx) are one drawing — and no longer Next.js's default.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const app = (f: string) => new URL(`../../web/src/app/${f}`, import.meta.url);
const NEXT_DEFAULT_FAVICON = "c30c7d42707a47a3f4591831641e50dc";

test("browser icons: our own favicon (16/32/48), an SVG icon and a 180 px Apple icon", () => {
  const ico = readFileSync(app("favicon.ico"));
  assert.notEqual(createHash("md5").update(ico).digest("hex"), NEXT_DEFAULT_FAVICON, "still create-next-app's favicon");
  assert.equal(ico.readUInt16LE(2), 1, "ICO");
  assert.deepEqual(Array.from({ length: ico.readUInt16LE(4) }, (_, n) => ico[6 + 16 * n]), [16, 32, 48]);
  const apple = readFileSync(app("apple-icon.png"));
  assert.equal(apple.toString("ascii", 1, 4), "PNG");
  assert.deepEqual([apple.readUInt32BE(16), apple.readUInt32BE(20)], [180, 180]);
});

test("one drawing: icon.svg, the generator and BrandMark share the points", () => {
  const svg = readFileSync(app("icon.svg"), "utf8");
  const mark = readFileSync(new URL("../../web/src/components/BrandMark.tsx", import.meta.url), "utf8");
  const gen = readFileSync(new URL("../../../scripts/gen-icons.mjs", import.meta.url), "utf8");
  const points = /MARK_POINTS = "([^"]+)"/.exec(mark)?.[1];
  assert.ok(points);
  assert.match(svg, new RegExp(`<polyline points="${points}"`));
  const genPoints = /points: (\[\[.*\]\]),/.exec(gen)?.[1];
  assert.equal(JSON.parse(genPoints!).map((p: number[]) => p.join(",")).join(" "), points);
  // one flat colour = --accent (2026-11-20 renewal — no gradient tile)
  assert.match(svg, /<rect [^>]*fill="#0078d4"/, "--accent");
  assert.doesNotMatch(svg, /Gradient/);
  const css = readFileSync(new URL("../../web/src/app/globals.css", import.meta.url), "utf8");
  assert.match(css, /--accent-rgb: 0, 120, 212;/);
  const markCss = readFileSync(new URL("../../web/src/components/BrandMark.module.css", import.meta.url), "utf8");
  assert.match(markCss, /background: var\(--accent\);/);
});
