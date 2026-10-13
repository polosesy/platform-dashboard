// ──────────────────────────────────────────────────────────────
// draw.io (diagrams.net) export of the infrastructure diagram (pure — tested in apps/api/test/archDrawio.test.ts)
//
// Input is the laid-out diagram (absolute coordinates), so the file is exactly the current view:
// region, category filter, collapsed VNets, stacks and line layers. Containers become draw.io
// containers (children use parent-relative coordinates, so moving a VNet moves its subnets).
// Labels come from the caller (already localized) and are GUID-masked here. html=0 everywhere,
// so resource names can never be interpreted as markup. No ARM IDs are written.
// ──────────────────────────────────────────────────────────────

import type { ArchLayout, ArchPlaced } from "./archModel";
import { EDGE_LOOK } from "./archStyle";
import { UI, VIZ, hex, type UiColor, type VizColor } from "./palette";
import { maskGuids } from "./mask";

export type DrawioOptions = {
  /** Display text of a shape (newline-separated lines), e.g. "VM · web-01\n10.0.1.4" */
  label: (shape: ArchPlaced) => string;
  /** Diagram tab name */
  title: string;
  /** Lines written in a caption above the diagram (view settings, data source, caveats) */
  caption: string[];
  /** Resources shown only as connection context (drawn dashed and faded) */
  context?: ReadonlySet<string>;
  /** Shapes dimmed in the current view (resource-group highlight) */
  dimmed?: ReadonlySet<string>;
};

/** Strip characters XML 1.0 cannot carry (control chars, lone surrogates), then escape. */
export function xmlText(s: string): string {
  const clean = s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
  return clean
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/\r?\n/g, "&#10;");
}

/** A colour blended over white (draw.io fills take opaque hex) */
function tint(c: UiColor | VizColor, alpha: number): string {
  const rgb = (c in UI ? UI[c as UiColor] : VIZ[c as VizColor]) as readonly number[];
  return `#${rgb.map((v) => Math.round(255 - (255 - v) * alpha).toString(16).padStart(2, "0")).join("")}`;
}

const BASE = "whiteSpace=wrap;html=0;fontFamily=Helvetica;";
const BOX_STYLE: Record<string, string> = {
  region: `rounded=1;arcSize=4;container=1;collapsible=0;verticalAlign=top;align=left;spacingLeft=10;spacingTop=6;fontStyle=1;fontSize=14;dashed=1;strokeColor=${tint("ink", 0.4)};fillColor=none;`,
  vnet: `rounded=1;arcSize=4;container=1;collapsible=0;verticalAlign=top;align=left;spacingLeft=10;spacingTop=6;fontStyle=1;fontSize=12;strokeWidth=2;strokeColor=${hex("accent")};fillColor=${tint("accent", 0.04)};`,
  subnet: `rounded=1;arcSize=4;container=1;collapsible=0;verticalAlign=top;align=left;spacingLeft=10;spacingTop=6;fontStyle=1;fontSize=11;dashed=1;strokeColor=${tint("subnet", 0.6)};fillColor=${tint("subnet", 0.04)};`,
  lane: `rounded=1;arcSize=4;container=1;collapsible=0;verticalAlign=top;align=left;spacingLeft=10;spacingTop=6;fontSize=11;strokeColor=${tint("ink", 0.15)};fillColor=${tint("ink", 0.03)};`,
  global: `rounded=1;arcSize=4;container=1;collapsible=0;verticalAlign=top;align=left;spacingLeft=10;spacingTop=6;fontSize=11;strokeColor=${tint("ink", 0.15)};fillColor=${tint("ink", 0.03)};`,
  group: `rounded=1;arcSize=4;container=1;collapsible=0;verticalAlign=top;align=left;spacingLeft=8;spacingTop=4;fontSize=10;dashed=1;strokeColor=${tint("ink", 0.15)};fillColor=none;`,
  root: "container=1;collapsible=0;strokeColor=none;fillColor=none;",
};
const TILE_STYLE: Record<string, string> = {
  tile: `rounded=1;arcSize=10;align=left;verticalAlign=middle;spacingLeft=8;fontSize=11;fillColor=#FFFFFF;strokeColor=${tint("ink", 0.2)};`,
  stack: `rounded=1;arcSize=10;align=left;verticalAlign=middle;spacingLeft=8;fontSize=11;fillColor=#FFFFFF;strokeColor=${tint("ink", 0.35)};strokeWidth=2;shadow=1;`,
  pill: `rounded=1;arcSize=16;align=left;verticalAlign=middle;spacingLeft=8;fontSize=11;strokeWidth=2;strokeColor=${hex("accent")};fillColor=${tint("accent", 0.08)};`,
  ghost: `rounded=1;arcSize=10;align=left;verticalAlign=middle;spacingLeft=8;fontSize=10;dashed=1;fillColor=#FFFFFF;strokeColor=${tint("ink", 0.3)};opacity=80;`,
  internet: `ellipse;align=center;verticalAlign=middle;fontSize=11;fontStyle=1;strokeColor=${hex("danger")};fillColor=${tint("danger", 0.06)};`,
};

function vertexStyle(sh: ArchPlaced, o: DrawioOptions): string {
  let st = BASE + (sh.shape === "box" ? BOX_STYLE[sh.type] ?? BOX_STYLE.lane : TILE_STYLE[sh.shape]);
  if (sh.shape === "tile" && o.context?.has(sh.ref)) st += "dashed=1;opacity=55;";
  if (o.dimmed?.has(sh.id)) st += "opacity=35;";
  return st;
}

function edgeStyle(kind: keyof typeof EDGE_LOOK): string {
  const l = EDGE_LOOK[kind];
  let st = `edgeStyle=orthogonalEdgeStyle;rounded=1;html=0;strokeColor=${hex(l.color)};strokeWidth=${l.width};`;
  if (l.alpha < 1) st += `opacity=${Math.round(l.alpha * 100)};`;
  if (l.dash) st += `dashed=1;dashPattern=${l.dash};`;
  st += l.arrow ? "endArrow=block;endFill=1;" : "endArrow=none;";
  return st;
}

export function toDrawio(layout: ArchLayout, o: DrawioOptions): string {
  // Parents before children (stable by depth), ids c1..cN
  const shapes = layout.shapes.map((s, i) => ({ s, i })).sort((a, b) => a.s.depth - b.s.depth || a.i - b.i).map((x) => x.s);
  const ids = new Map(shapes.map((s, i) => [s.id, `c${i + 1}`]));
  const byId = new Map(shapes.map((s) => [s.id, s]));
  const cells: string[] = ['<mxCell id="0"/>', '<mxCell id="1" parent="0"/>'];
  const caption = maskGuids(o.caption.join("\n"));
  cells.push(
    `<mxCell id="caption" value="${xmlText(caption)}" style="text;${BASE}align=left;verticalAlign=top;fontSize=11;fontColor=${tint("ink", 0.65)};" vertex="1" parent="1"><mxGeometry x="0" y="${-16 - 16 * o.caption.length}" width="${Math.max(400, layout.width)}" height="${16 * o.caption.length + 8}" as="geometry"/></mxCell>`,
  );
  for (const s of shapes) {
    const p = s.parent ? byId.get(s.parent) : undefined;
    const x = p ? s.x - p.x : s.x;
    const y = p ? s.y - p.y : s.y;
    const parent = p ? ids.get(p.id)! : "1";
    const value = s.shape === "box" && s.type === "root" ? "" : maskGuids(o.label(s));
    cells.push(
      `<mxCell id="${ids.get(s.id)}" value="${xmlText(value)}" style="${vertexStyle(s, o)}" vertex="1" parent="${parent}"><mxGeometry x="${x}" y="${y}" width="${s.w}" height="${s.h}" as="geometry"/></mxCell>`,
    );
  }
  layout.edges.forEach((e, i) => {
    const src = ids.get(e.source), dst = ids.get(e.target);
    if (!src || !dst) return;
    const value = e.count > 1 ? `×${e.count}` : "";
    cells.push(
      `<mxCell id="e${i + 1}" value="${xmlText(value)}" style="${edgeStyle(e.kind)}" edge="1" parent="1" source="${src}" target="${dst}"><mxGeometry relative="1" as="geometry"/></mxCell>`,
    );
  });
  const name = xmlText(maskGuids(o.title));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<mxfile host="aud" type="device"><diagram id="infra" name="${name}"><mxGraphModel dx="0" dy="0" grid="1" gridSize="10" guides="1" tooltips="1" connect="0" arrows="1" fold="1" page="0" pageScale="1" math="0" shadow="0"><root>${cells.join("")}</root></mxGraphModel></diagram></mxfile>\n`;
}

/** "infra-diagram_koreacentral_filtered_20261013-0930.drawio" (local time; no subscription info) */
export function archExportFileName(o: { region: string; filtered: boolean; sample: boolean; now: Date; ext: "png" | "drawio" }): string {
  const region = o.region.toLowerCase().replace(/[^a-z0-9-]/g, "_") || "all";
  const d = o.now;
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  return `infra-diagram_${region}${o.filtered ? "_filtered" : ""}${o.sample ? "_sample" : ""}_${stamp}.${o.ext}`;
}
