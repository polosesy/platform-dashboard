"use client";

import { memo } from "react";
import { BaseEdge, type EdgeProps } from "reactflow";
import { labelPoint, roundedPath } from "@/lib/archRoute";

export type ArchEdgeData = {
  /** Absolute route from lib/archRoute (source side → target side) */
  points: Array<[number, number]>;
  /** A user's curved line (lib/archArrange manualPath): points = start, control 1, control 2, end */
  curve?: boolean;
  /** Peering: a pipe — the line drawn as two rails (a white core inside the stroke) */
  rail?: boolean;
  /** A badge on the longest run: a chain link (peering), with its words and tooltip */
  glyph?: "chain";
  glyphText?: string;
  glyphTitle?: string;
};

/** The longest run of a polyline: its middle and whether it is vertical (a badge on it turns with it) */
function longestRun(pts: Array<[number, number]>): { at: [number, number]; vertical: boolean } {
  let best = 0, len = -1;
  for (let i = 0; i + 1 < pts.length; i++) {
    const l = Math.abs(pts[i + 1]![0] - pts[i]![0]) + Math.abs(pts[i + 1]![1] - pts[i]![1]);
    if (l > len) { len = l; best = i; }
  }
  const a = pts[best]!, b = pts[best + 1]!;
  return { at: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], vertical: a[0] === b[0] && a[1] !== b[1] };
}

/**
 * Chain-link badge (two interlocked links, the "link" glyph of Fluent / Azure icons) in the line's colour — SVG in
 * diagram coordinates, so it zooms with the line and is in the PNG
 */
function ChainBadge({ at, vertical, color, text, title }: { at: [number, number]; vertical: boolean; color: string; text?: string; title?: string }) {
  return (
    <g transform={`translate(${at[0]} ${at[1]})`} pointerEvents="none">
      {title ? <title>{title}</title> : null}
      <g transform={vertical ? "rotate(90)" : undefined}>
        {/* white badge behind the links — the canvas is light in both themes (PNG too) */}
        <rect x={-14} y={-8} width={28} height={16} rx={8} fill="#ffffff" stroke={color} strokeWidth={1.2} />
        <rect x={-9.5} y={-3.6} width={11} height={7.2} rx={3.6} fill="none" stroke={color} strokeWidth={1.8} />
        <rect x={-1.5} y={-3.6} width={11} height={7.2} rx={3.6} fill="none" stroke={color} strokeWidth={1.8} />
      </g>
      {text ? (
        <text x={0} y={vertical ? 0 : 20} dx={vertical ? 14 : 0} textAnchor={vertical ? "start" : "middle"} dominantBaseline="middle" fontSize={10} fontWeight={700} fill={color} paintOrder="stroke" stroke="#ffffff" strokeWidth={3}>{text}</text>
      ) : null}
    </g>
  );
}

/**
 * One configuration line along its orthogonal route (lib/archRoute): rounded corners, the arrowhead on the
 * straight stub into the target side, the count label in the middle of the longest run (never on a tile border).
 * React Flow's own sourceX / targetX are ignored — the route already starts and ends on the tiles' sides. All SVG,
 * so the PNG export captures it.
 */
export const ArchPathEdge = memo(function ArchPathEdge({ id, data, style, markerEnd, label, labelStyle, labelBgStyle }: EdgeProps<ArchEdgeData>) {
  const pts = data?.points ?? [];
  if (pts.length < 2) return null;
  const curve = !!data?.curve && pts.length === 4;
  // A bezier's middle (t = 0.5) carries the label; a polyline's longest run does
  const [lx, ly] = curve
    ? [(pts[0]![0] + 3 * pts[1]![0] + 3 * pts[2]![0] + pts[3]![0]) / 8, (pts[0]![1] + 3 * pts[1]![1] + 3 * pts[2]![1] + pts[3]![1]) / 8]
    : labelPoint(pts);
  const path = curve ? `M${pts[0]![0]},${pts[0]![1]} C${pts[1]![0]},${pts[1]![1]} ${pts[2]![0]},${pts[2]![1]} ${pts[3]![0]},${pts[3]![1]}` : roundedPath(pts, 6);
  const color = (style?.stroke as string | undefined) ?? "currentColor";
  if (data?.glyph) {
    const run = longestRun(pts);
    return (
      <>
        <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} />
        {/* the pipe's white core: two rails */}
        {data.rail ? <path d={path} fill="none" stroke="#ffffff" strokeWidth={1.6} pointerEvents="none" /> : null}
        <ChainBadge at={run.at} vertical={run.vertical} color={color} text={data.glyphText} title={data.glyphTitle} />
      </>
    );
  }
  return (
    <BaseEdge
      id={id}
      path={path}
      style={style}
      markerEnd={markerEnd}
      label={label}
      labelX={lx}
      labelY={ly}
      labelStyle={labelStyle}
      labelShowBg={!!label}
      labelBgStyle={labelBgStyle}
      labelBgPadding={[3, 1]}
      labelBgBorderRadius={3}
    />
  );
});

/** Module constant (React Flow warns when edgeTypes change identity) */
export const EDGE_TYPES = { archPath: ArchPathEdge } as const;
