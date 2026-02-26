"use client";

import { type EdgeProps, getBezierPath, BaseEdge } from "reactflow";
import type { EdgeStatus, EdgeTrafficLevel } from "@aud/types";
import { edgeColor, edgeWidth, particleDuration, particleCount, particleRadius, defaultTokens } from "../utils/designTokens";

export type AnimatedEdgeData = {
  status: EdgeStatus;
  trafficLevel: EdgeTrafficLevel;
  label?: string;
};

export function AnimatedEdge(props: EdgeProps<AnimatedEdgeData>) {
  const {
    sourceX, sourceY, targetX, targetY,
    sourcePosition, targetPosition,
    data, markerEnd,
  } = props;

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX, sourceY, targetX, targetY,
    sourcePosition, targetPosition,
  });

  const status = data?.status ?? "normal";
  const trafficLevel = data?.trafficLevel ?? "none";
  const label = data?.label;
  const colors = edgeColor(status);
  const width = edgeWidth(trafficLevel);
  const dur = particleDuration(trafficLevel);
  const count = particleCount(trafficLevel);
  const radius = particleRadius(trafficLevel);
  const transition = `${defaultTokens.animation.transitionDuration}ms ease`;

  return (
    <>
      {/* Glow layer for degraded/down */}
      {colors.glow && (
        <BaseEdge
          path={edgePath}
          style={{
            stroke: colors.glow,
            strokeWidth: width + 6,
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

      {/* Animated particles along path */}
      {dur > 0 && count > 0 && Array.from({ length: count }, (_, i) => (
        <circle
          key={i}
          r={radius}
          fill={colors.particle}
          opacity={status === "idle" ? 0.4 : 0.85}
        >
          <animateMotion
            dur={`${dur}s`}
            repeatCount="indefinite"
            begin={`${(i / count) * dur}s`}
            path={edgePath}
          />
        </circle>
      ))}

      {/* Pulse ring for "down" status */}
      {status === "down" && dur > 0 && (
        <circle r={4} fill="none" stroke={colors.particle} strokeWidth={1.5} opacity={0.6}>
          <animateMotion dur={`${dur * 1.2}s`} repeatCount="indefinite" path={edgePath} />
          <animate attributeName="r" values="3;8;3" dur="1.2s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.8;0.15;0.8" dur="1.2s" repeatCount="indefinite" />
        </circle>
      )}

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
