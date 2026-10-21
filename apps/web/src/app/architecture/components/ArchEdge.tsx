"use client";

import { memo } from "react";
import { BaseEdge, type EdgeProps } from "reactflow";
import { labelPoint, roundedPath } from "@/lib/archRoute";

export type ArchEdgeData = {
  /** Absolute route from lib/archRoute (source side → target side) */
  points: Array<[number, number]>;
};

/**
 * One configuration line along its orthogonal route (lib/archRoute): rounded corners, the arrowhead on the
 * straight stub into the target side, the count label in the middle of the longest run (never on a tile border).
 * React Flow's own sourceX / targetX are ignored — the route already starts and ends on the tiles' sides. All SVG,
 * so the PNG export captures it.
 */
export const ArchPathEdge = memo(function ArchPathEdge({ id, data, style, markerEnd, label, labelStyle, labelBgStyle }: EdgeProps<ArchEdgeData>) {
  const pts = data?.points ?? [];
  if (pts.length < 2) return null;
  const [lx, ly] = labelPoint(pts);
  return (
    <BaseEdge
      id={id}
      path={roundedPath(pts, 6)}
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
