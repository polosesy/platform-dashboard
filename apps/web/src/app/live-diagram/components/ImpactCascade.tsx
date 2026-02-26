"use client";

import { useEffect, useRef, useCallback } from "react";
import { timer as d3Timer, type Timer } from "d3-timer";
import { easeCubicOut } from "d3-ease";
import { interpolateNumber } from "d3-interpolate";
import type { FaultImpact } from "@aud/types";
import styles from "../styles.module.css";

type CascadeEdge = {
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
};

type ImpactCascadeProps = {
  impacts: FaultImpact[];
  nodePositions: Map<string, { x: number; y: number }>;
  edgePaths: Map<string, CascadeEdge>;
  transform: { x: number; y: number; zoom: number };
  width: number;
  height: number;
  enabled: boolean;
};

const CASCADE_DELAY_MS = 300;
const CASCADE_DURATION_MS = 800;
const TOTAL_CYCLE_MS = 3600;

export function ImpactCascade({
  impacts,
  nodePositions,
  edgePaths,
  transform,
  width,
  height,
  enabled,
}: ImpactCascadeProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const timerRef = useRef<Timer | null>(null);

  const draw = useCallback(
    (elapsed: number) => {
      const canvas = canvasRef.current;
      if (!canvas || !enabled) return;

      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const dpr = window.devicePixelRatio || 1;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.translate(transform.x, transform.y);
      ctx.scale(transform.zoom, transform.zoom);

      for (const impact of impacts) {
        const cycleT = elapsed % TOTAL_CYCLE_MS;

        // Phase 1: Source node pulse (0 - CASCADE_DELAY_MS)
        const sourcePos = nodePositions.get(impact.sourceNodeId);
        if (sourcePos) {
          const pulseT = Math.min(1, cycleT / CASCADE_DELAY_MS);
          const scale = 1 + 0.08 * Math.sin(pulseT * Math.PI);
          const alpha = 0.6 + 0.3 * Math.sin(pulseT * Math.PI);

          ctx.save();
          ctx.translate(sourcePos.x + 90, sourcePos.y + 36);
          ctx.scale(scale, scale);
          ctx.beginPath();
          ctx.arc(0, 0, 24, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(216,59,1,${alpha * 0.3})`;
          ctx.fill();
          ctx.restore();
        }

        // Phase 2: Edge flash cascade
        for (let i = 0; i < impact.affectedEdgeIds.length; i++) {
          const edgeId = impact.affectedEdgeIds[i]!;
          const edgePath = edgePaths.get(edgeId);
          if (!edgePath) continue;

          const edgeStartMs = CASCADE_DELAY_MS + i * CASCADE_DELAY_MS;
          const edgeElapsed = cycleT - edgeStartMs;
          if (edgeElapsed < 0 || edgeElapsed > CASCADE_DURATION_MS) continue;

          const t = easeCubicOut(Math.min(1, edgeElapsed / CASCADE_DURATION_MS));
          const flashAlpha = interpolateNumber(0.8, 0)(t);

          // Animated line segment traveling along edge
          const segLen = t;
          const midX = edgePath.sourceX + (edgePath.targetX - edgePath.sourceX) * segLen;
          const midY = edgePath.sourceY + (edgePath.targetY - edgePath.sourceY) * segLen;

          ctx.beginPath();
          ctx.moveTo(edgePath.sourceX, edgePath.sourceY);
          ctx.lineTo(midX, midY);
          ctx.strokeStyle = `rgba(216,59,1,${flashAlpha})`;
          ctx.lineWidth = 4;
          ctx.lineCap = "round";
          ctx.stroke();

          // Leading point glow
          ctx.beginPath();
          ctx.arc(midX, midY, 6, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(216,59,1,${flashAlpha * 0.6})`;
          ctx.fill();
        }

        // Phase 3: Affected node highlight
        for (let i = 0; i < impact.affectedNodeIds.length; i++) {
          const nodeId = impact.affectedNodeIds[i]!;
          const pos = nodePositions.get(nodeId);
          if (!pos) continue;

          const nodeStartMs = CASCADE_DELAY_MS * 2 + i * CASCADE_DELAY_MS;
          const nodeElapsed = cycleT - nodeStartMs;
          if (nodeElapsed < 0 || nodeElapsed > CASCADE_DURATION_MS) continue;

          const t = easeCubicOut(Math.min(1, nodeElapsed / CASCADE_DURATION_MS));
          const highlightAlpha = interpolateNumber(0.5, 0)(t);
          const ringRadius = interpolateNumber(10, 30)(t);

          ctx.beginPath();
          ctx.arc(pos.x + 90, pos.y + 36, ringRadius, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(216,59,1,${highlightAlpha})`;
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      }

      ctx.restore();
    },
    [impacts, nodePositions, edgePaths, transform, enabled],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
  }, [width, height]);

  useEffect(() => {
    if (!enabled || impacts.length === 0) {
      timerRef.current?.stop();
      timerRef.current = null;
      return;
    }

    timerRef.current = d3Timer((elapsed) => {
      draw(elapsed);
    });

    return () => {
      timerRef.current?.stop();
      timerRef.current = null;
    };
  }, [enabled, impacts, draw]);

  return (
    <canvas
      ref={canvasRef}
      className={styles.cascadeCanvas}
      width={width}
      height={height}
    />
  );
}
