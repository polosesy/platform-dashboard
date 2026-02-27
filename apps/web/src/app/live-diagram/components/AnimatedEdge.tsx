"use client";

import { type EdgeProps, getBezierPath, BaseEdge } from "reactflow";
import type { EdgeStatus, EdgeTrafficLevel } from "@aud/types";
import { edgeColor, edgeWidth, particleCount, particleDuration, defaultTokens } from "../utils/designTokens";

export type AnimatedEdgeData = {
  status: EdgeStatus;
  trafficLevel: EdgeTrafficLevel;
  label?: string;
  isHighlighted: boolean;
  isDimmed: boolean;
  showParticles: boolean;
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

  const status = data?.status ?? "normal";
  const trafficLevel = data?.trafficLevel ?? "none";
  const isHighlighted = data?.isHighlighted ?? false;
  const isDimmed = data?.isDimmed ?? false;
  const showParticles = data?.showParticles ?? false;
  const label = data?.label;
  const colors = edgeColor(status);
  const width = edgeWidth(trafficLevel);
  const transition = `${defaultTokens.animation.transitionDuration}ms ease`;

  // Particle config
  const count = particleCount(trafficLevel);
  const duration = particleDuration(trafficLevel);
  const hasFlow = count > 0 && duration > 0;
  const shouldShowParticles = showParticles && hasFlow && !isDimmed;

  // Particle dimensions proportional to edge width → unified "flowing pipe" look
  const pRy = Math.max(width * 0.45, 0.8);
  const pRx = Math.max(width * 2, 3);
  // Highlighted: brighter particle color; default: same as edge stroke for unity
  const pFill = isHighlighted ? colors.particle : colors.stroke;
  const pOpacity = isHighlighted ? 0.92 : 0.7;

  const groupOpacity = isDimmed ? 0.10 : 1;
  const showGlow = colors.glow || (isHighlighted && !isDimmed);

  return (
    <g style={{ opacity: groupOpacity, transition: "opacity 400ms ease" }}>
      {/* Glow layer — degraded/down status OR hover-highlighted */}
      {showGlow && (
        <BaseEdge
          path={edgePath}
          style={{
            stroke: isHighlighted ? colors.stroke : colors.glow!,
            strokeWidth: width + (isHighlighted ? 8 : 4),
            filter: `blur(${isHighlighted ? 6 : 4}px)`,
            opacity: isHighlighted ? 0.35 : 1,
            transition: `stroke ${transition}, stroke-width ${transition}, opacity ${transition}`,
          }}
        />
      )}

      {/* Main edge line */}
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

      {/* Inline SVG flow particles — ellipses moving along the edge via <animateMotion> */}
      {shouldShowParticles && Array.from({ length: count }, (_, i) => (
        <ellipse
          key={`${id}-p-${i}`}
          rx={pRx}
          ry={pRy}
          fill={pFill}
          opacity={pOpacity}
        >
          <animateMotion
            dur={`${duration}s`}
            repeatCount="indefinite"
            rotate="auto"
            path={edgePath}
            begin={`-${i * (duration / count)}s`}
          />
        </ellipse>
      ))}

      {/* Edge label */}
      {label && (
        <text
          x={labelX}
          y={labelY - 10}
          textAnchor="middle"
          style={{
            fontSize: defaultTokens.typography.edgeLabel.fontSize,
            fontWeight: defaultTokens.typography.edgeLabel.fontWeight,
            fill: isDimmed ? "rgba(20,21,23,0.15)" : "rgba(20,21,23,0.55)",
            transition: "fill 400ms ease",
          }}
        >
          {label}
        </text>
      )}
    </g>
  );
}
