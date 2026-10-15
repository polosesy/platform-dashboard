"use client";

import { type EdgeProps, getBezierPath, getSmoothStepPath, BaseEdge, EdgeLabelRenderer } from "reactflow";
import type { Route } from "@/lib/liveRoute";
import type { EdgeStatus, EdgeTrafficLevel } from "@aud/types";
import { edgeColor, edgeWidth, defaultTokens } from "../utils/designTokens";
import {
  LIVE_EDGE_LOOK, PARTICLE_TONE_VAR, cometTailPath, estimatePathLength, liveStroke, particlePlan, particleTone,
  type LiveEdgeStyleKey,
} from "@/lib/liveStyle";
import { rgba } from "@/lib/palette";
import styles from "../styles.module.css";

export type AnimatedEdgeData = {
  styleKey: LiveEdgeStyleKey;
  status: EdgeStatus;
  trafficLevel: EdgeTrafficLevel;
  /** Relationship text (already translated and clipped) — shown on hover / selection only */
  label?: string;
  isHighlighted: boolean;
  isDimmed: boolean;
  /** Traffic layer on — particles move only on edges with measured traffic */
  showParticles: boolean;
  /** Metrics come from a real source; otherwise width and motion stay neutral */
  measured: boolean;
  /** Fault impact view: this edge joins a failing resource to a neighbour / or the view dims it */
  impact?: "path" | "dim";
  /** Path from lib/liveRoute: right angles with the vertical part in a corridor, or a curve */
  route?: Route;
  /** OS "reduce motion": comets stand still along the line instead of moving */
  reduceMotion?: boolean;
  /** Private Endpoint connection not approved: neutral grey, label always on, no comets */
  disconnected?: boolean;
};

/** Kinds that carry traffic worth animating when it is measured */
const FLOWING = new Set<LiveEdgeStyleKey>(["config", "configWeak", "ingress", "ingressUnknown", "privateLink", "egress", "egressDeprecated"]);

export function AnimatedEdge(props: EdgeProps<AnimatedEdgeData>) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, markerEnd, markerStart, selected } = props;
  const route = data?.route;
  const [edgePath, labelX, labelY] = route?.kind === "step"
    ? getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 8, offset: route.offset ?? 16, centerX: route.centerX, centerY: route.centerY })
    : getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });

  const styleKey = data?.styleKey ?? "config";
  const look = LIVE_EDGE_LOOK[styleKey];
  const status = data?.status ?? "normal";
  const trafficLevel = data?.trafficLevel ?? "none";
  const isHighlighted = data?.isHighlighted ?? false;
  const impact = data?.impact;
  const isDimmed = (data?.isDimmed ?? false) || (!isHighlighted && impact === "dim");
  const measured = data?.measured ?? false;

  // Measured problems override the relationship colour; the fault-impact path is red
  const statusColors = edgeColor(status);
  const broken = measured && (status === "degraded" || status === "down");
  const disconnected = data?.disconnected ?? false;
  const stroke = impact === "path" ? rgba("danger", 0.85) : disconnected ? rgba("ink", 0.3) : broken ? statusColors.stroke : liveStroke(styleKey);
  // Width encodes measured traffic only
  const width = impact === "path" ? Math.max(look.width, 2.5) : measured ? Math.max(look.width, edgeWidth(trafficLevel)) : look.width;
  const transition = `${defaultTokens.animation.transitionDuration}ms ease`;

  // Comets only for measured traffic with the traffic layer on — never on a down line or the fault-impact path
  const tone = particleTone(styleKey, status, measured);
  const moving = (data?.showParticles ?? false) && measured && !isDimmed && !disconnected && impact !== "path" && FLOWING.has(styleKey)
    && trafficLevel !== "none" && tone !== null;
  const plan = moving
    ? particlePlan(trafficLevel, estimatePathLength(route?.kind ?? "bezier", targetX - sourceX, targetY - sourceY, route?.offset ?? 16), width)
    : null;
  // A tail only says "this way" on one-way lines; two-way (merged) and undirected lines get round dots
  const hasMarker = (m: string | undefined) => !!m && m !== "url('#')";
  const directed = hasMarker(markerEnd) && !hasMarker(markerStart);
  const reduceMotion = data?.reduceMotion ?? false;

  const showLabel = !!data?.label && (selected || isHighlighted || disconnected || (measured && status === "down"));
  const clean = (m: string | undefined) => (m && m !== "url('#')" ? m : undefined);

  return (
    <g style={{ opacity: isDimmed ? 0.1 : 1, transition: "opacity 400ms ease" }}>
      {/* Selection / hover halo — a wider copy of the line, no blur */}
      {(selected || isHighlighted) && !isDimmed && (
        <BaseEdge path={edgePath} style={{ stroke, strokeWidth: width + 6, opacity: 0.18 }} />
      )}

      <BaseEdge
        path={edgePath}
        markerEnd={clean(markerEnd)}
        markerStart={clean(markerStart)}
        style={{
          stroke,
          strokeWidth: width,
          strokeDasharray: look.dash,
          transition: `stroke ${transition}, stroke-width ${transition}`,
        }}
      />

      {plan && tone && Array.from({ length: plan.count }, (_, i) => {
        const dur = `${plan.dur}s`;
        const begin = `-${Math.round((i * plan.dur / plan.count) * 100) / 100}s`;
        const still = Math.round(((i + 0.5) / plan.count) * 1000) / 1000;
        const rgb = `rgb(var(${PARTICLE_TONE_VAR[tone]}))`;
        return (
          <g key={`${id}-p-${i}`} className={styles.particle} pointerEvents="none">
            {reduceMotion
              ? <animateMotion path={edgePath} dur="1s" fill="freeze" calcMode="linear" keyPoints={`${still};${still}`} keyTimes="0;1" rotate={directed ? "auto" : undefined} />
              : (
                <>
                  <animateMotion path={edgePath} dur={dur} begin={begin} repeatCount="indefinite" calcMode="linear" rotate={directed ? "auto" : undefined} />
                  <animate attributeName="opacity" values="0;1;1;0" keyTimes={`0;${plan.fadeIn};${plan.fadeOut};1`} dur={dur} begin={begin} repeatCount="indefinite" />
                </>
              )}
            {directed && (
              <g className={styles.pTail}>
                <path d={cometTailPath(plan.r, plan.tail)} style={{ fill: `url(#ld-ptail-${tone})` }} />
              </g>
            )}
            <g className={styles.pHead}>
              <circle r={plan.r} style={{ fill: rgb, stroke: "rgba(var(--paper-rgb), 0.92)", strokeWidth: 1.25 }} />
            </g>
          </g>
        );
      })}

      {showLabel && (
        <EdgeLabelRenderer>
          <div
            className={styles.edgePill}
            data-status={measured ? status : undefined}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`, borderColor: stroke }}
          >
            {data!.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </g>
  );
}
