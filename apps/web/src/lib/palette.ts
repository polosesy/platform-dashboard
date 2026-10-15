// ──────────────────────────────────────────────────────────────
// Colour palette for graphics drawn from JavaScript (pure — tested in apps/api/test/palette.test.ts).
//
// CSS uses the tokens in app/globals.css directly (var(--accent), rgba(var(--accent-rgb), a)).
// Some renderers cannot read CSS variables: canvas 2D (ctx.fillStyle), three.js materials,
// D3 colour interpolation, SVG presentation attributes (stroke="…") and React Flow's
// Background / MiniMap colour props. They take concrete colours from here instead.
// UI channels must equal the --*-rgb tokens in globals.css (the test enforces it).
// ──────────────────────────────────────────────────────────────

type Rgb = readonly [number, number, number];

/** Mirrors --<name>-rgb in globals.css */
export const UI = {
  ink: [20, 21, 23],
  paper: [255, 255, 255],
  accent: [0, 120, 212],
  "accent-2": [0, 163, 163],
  danger: [216, 59, 1],
  warning: [209, 132, 0],
  success: [16, 124, 16],
  ok: [16, 124, 16], // healthy / running — same green as success
} as const satisfies Record<string, Rgb>;

/**
 * Visualization-only colours with no UI token: categorical edge kinds and effects in the
 * diagrams. Named here so every diagram draws the same relationship in the same colour.
 */
export const VIZ = {
  egress: [251, 146, 60], // outbound internet / NAT (orange)
  privateLink: [139, 92, 246], // Private Link (violet)
  peering: [16, 185, 129], // VNet peering (emerald)
  neutral: [107, 113, 122], // logging / inferred / control (slate)
  subnet: [95, 75, 139], // subnet boundary (plum)
  fault: [239, 68, 68], // fault impact (red)
  canvas: [247, 248, 250], // diagram canvas background
  integration: [14, 116, 144], // VNet integration (teal)
  violet: [112, 48, 160], // security advisories, user-defined routes
} as const satisfies Record<string, Rgb>;

export type UiColor = keyof typeof UI;
export type VizColor = keyof typeof VIZ;

const channels = (k: UiColor | VizColor): Rgb => (k in UI ? UI[k as UiColor] : VIZ[k as VizColor]);
/** "rgba(r,g,b,a)" for a palette colour (alpha passed through unchanged — animated alphas stay exact) */
export function rgba(k: UiColor | VizColor, a = 1): string {
  return `rgba(${channels(k).join(",")},${a})`;
}

/** "#rrggbb" for a palette colour (three.js materials, fully opaque strokes) */
export function hex(k: UiColor | VizColor): string {
  return `#${channels(k).map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}
