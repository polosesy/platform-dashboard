"use client";

import { useEffect } from "react";
import { type EdgeProps, getBezierPath, BaseEdge } from "reactflow";
import type { EdgeStatus, EdgeTrafficLevel } from "@aud/types";
import { edgeColor, edgeWidth, defaultTokens } from "../utils/designTokens";
import { setEdgePath } from "../utils/edgePathStore";

export type AnimatedEdgeData = {
  status: EdgeStatus;
  trafficLevel: EdgeTrafficLevel;
  label?: string;
};

export function AnimatedEdge(props: EdgeProps<AnimatedEdgeData>) {
  const {
    id,
    sourceX, sourceY, targetX, targetY,
    sourcePosition, targetPosition,
    data, markerEnd,
  } = props;

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX, sourceY, targetX, targetY,
    sourcePosition, targetPosition,
  });

  // Report the actual SVG path to the shared store for D3ParticleCanvas alignment
  useEffect(() => {
    setEdgePath(id, edgePath);
  }, [id, edgePath]);

  const status = data?.status ?? "normal";
  const trafficLevel = data?.trafficLevel ?? "none";
  const label = data?.label;
  const colors = edgeColor(status);
  const width = edgeWidth(trafficLevel);
  const transition = `${defaultTokens.animation.transitionDuration}ms ease`;

  return (
    <>
      {/* Glow layer for degraded/down */}
      {colors.glow && (
        <BaseEdge
          path={edgePath}
          style={{
            stroke: colors.glow,
            strokeWidth: width + 4,
            filter: "blur(4px)",
            transition: `stroke ${transition}, stroke-width ${transition}`,
          }}
        />
      )}

      {/* Main edge */}
      <BaseEdge
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          stroke: colors.stroke,
          strokeWidth: width,
          strokeDasharray: status === "down" ? "6 4" : status === "idle" ? "3 6" : "none",
          transition: `stroke ${transition}, stroke-width ${transition}`,
        }}
      />

      {/* Edge label */}
      {label && (
        <text
          x={labelX}
          y={labelY - 10}
          textAnchor="middle"
          style={{
            fontSize: defaultTokens.typography.edgeLabel.fontSize,
            fontWeight: defaultTokens.typography.edgeLabel.fontWeight,
            fill: "rgba(20,21,23,0.55)",
          }}
        >
          {label}
        </text>
      )}
    </>
  );
}
