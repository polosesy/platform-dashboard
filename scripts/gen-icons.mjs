// The platform's mark → the browser icons, from one drawing (no image library — a small rasteriser, 4×4 samples per pixel).
//
//   node scripts/gen-icons.mjs
//
// Writes apps/web/src/app/icon.svg (modern browsers), favicon.ico (16/32/48, PNG inside) and apple-icon.png (180, full
// square — iOS rounds the corners itself). The on-screen mark is components/BrandMark.tsx with the same points
// (apps/api/test/brandIcons.test.ts checks they agree).
//
// The drawing: a tile in the platform's two colours (Azure blue → teal, tokens --accent / --accent-2) and one white line
// through four nodes — read as connected resources (the diagrams) and as a signal over time (the monitoring).

import { writeFileSync } from "node:fs";
import { deflateSync, crc32 } from "node:zlib";

const OUT = new URL("../apps/web/src/app/", import.meta.url);
export const MARK = {
  view: 32,
  radius: 7,
  from: [0x00, 0x78, 0xd4], // --accent
  to: [0x00, 0xa3, 0xa3],   // --accent-2
  points: [[7, 22], [13, 14], [19, 19], [25, 10]],
  stroke: 2.4,
  node: 2.6,
};
const hex = (c) => `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
const pts = MARK.points.map((p) => p.join(",")).join(" ");

// ---------- SVG ----------
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${MARK.view} ${MARK.view}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${hex(MARK.from)}"/><stop offset="1" stop-color="${hex(MARK.to)}"/></linearGradient></defs>
  <rect width="${MARK.view}" height="${MARK.view}" rx="${MARK.radius}" fill="url(#g)"/>
  <polyline points="${pts}" fill="none" stroke="#fff" stroke-width="${MARK.stroke}" stroke-linecap="round" stroke-linejoin="round"/>
  <g fill="#fff">${MARK.points.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="${MARK.node}"/>`).join("")}</g>
</svg>
`;

// ---------- raster ----------
function segDist(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
function inRounded(x, y, s, r) {
  const cx = Math.max(r, Math.min(s - r, x)), cy = Math.max(r, Math.min(s - r, y));
  return Math.hypot(x - cx, y - cy) <= r;
}
/** RGBA pixels of the mark at `size` px; `square` = no rounded corners (the platform masks them) */
function render(size, square = false) {
  const N = 4, k = MARK.view / size, px = Buffer.alloc(size * size * 4);
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sj = 0; sj < N; sj++) for (let si = 0; si < N; si++) {
      const x = (i + (si + 0.5) / N) * k, y = (j + (sj + 0.5) / N) * k;
      if (!square && !inRounded(x, y, MARK.view, MARK.radius)) continue;
      const white = MARK.points.some(([cx, cy]) => Math.hypot(x - cx, y - cy) <= MARK.node)
        || MARK.points.slice(1).some((p, n) => segDist(x, y, MARK.points[n], p) <= MARK.stroke / 2);
      const t = Math.max(0, Math.min(1, (x + y) / (2 * MARK.view)));
      const c = white ? [255, 255, 255] : MARK.from.map((v, n) => v + (MARK.to[n] - v) * t);
      r += c[0]; g += c[1]; b += c[2]; a += 1;
    }
    const o = (j * size + i) * 4;
    if (a) { px[o] = Math.round(r / a); px[o + 1] = Math.round(g / a); px[o + 2] = Math.round(b / a); }
    px[o + 3] = Math.round((a / (N * N)) * 255);
  }
  return px;
}
function png(size, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}
function ico(sizes) {
  const imgs = sizes.map((s) => png(s, render(s)));
  const head = Buffer.alloc(6 + 16 * imgs.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(imgs.length, 4);
  let offset = head.length;
  imgs.forEach((img, n) => {
    const e = 6 + 16 * n, s = sizes[n];
    head[e] = s >= 256 ? 0 : s; head[e + 1] = s >= 256 ? 0 : s; head[e + 2] = 0; head[e + 3] = 0;
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(img.length, e + 8); head.writeUInt32LE(offset, e + 12);
    offset += img.length;
  });
  return Buffer.concat([head, ...imgs]);
}

writeFileSync(new URL("icon.svg", OUT), svg);
writeFileSync(new URL("favicon.ico", OUT), ico([16, 32, 48]));
writeFileSync(new URL("apple-icon.png", OUT), png(180, render(180, true)));
if (process.argv.includes("--preview")) {
  const dir = process.argv[process.argv.indexOf("--preview") + 1];
  for (const s of [16, 32, 64]) writeFileSync(`${dir}/mark-${s}.png`, png(s, render(s)));
}
console.log("icon.svg · favicon.ico (16/32/48) · apple-icon.png (180)");
