"use client";

import { useEffect, useRef, useCallback } from "react";
import { timer as d3Timer, type Timer } from "d3-timer";
import { interpolateNumber } from "d3-interpolate";
import type { FaultImpact, AlertSeverity } from "@aud/types";
import styles from "../styles.module.css";

type FaultRippleProps = {
  impacts: FaultImpact[];
  nodePositions: Map<string, { x: number; y: number }>;
  transform: { x: number; y: number; zoom: number };
  width: number;
  height: number;
  enabled: boolean;
};

const SEVERITY_COLORS: Record<AlertSeverity, string> = {
  critical: "rgba(216,59,1,0.65)",
  warning: "rgba(209,132,0,0.55)",
  info: "rgba(0,120,212,0.45)",
};

const RIPPLE_DURATION_MS = 2400;
const MAX_RIPPLE_PX = 180;
const RING_COUNT = 3;

export function FaultRipple({
  impacts,
  nodePositions,
  transform,
  width,
  height,
  enabled,
}: FaultRippleProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const timerRef = useRef<Timer | null>(null);
  const startRef = useRef(0);

  const draw = useCallback(
    (elapsed: number) => {
      const canvas = canvasRef.current;
      if (!canvas || !enabled || impacts.length === 0) return;

      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const dpr = window.devicePixelRatio || 1;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.translate(transform.x, transform.y);
      ctx.scale(transform.zoom, transform.zoom);

      for (const impact of impacts) {
        const pos = nodePositions.get(impact.sourceNodeId);
        if (!pos) continue;

        const baseColor = SEVERITY_COLORS[impact.severity] ?? SEVERITY_COLORS.critical;
        const maxRadius = Math.min(
          MAX_RIPPLE_PX,
          impact.rippleRadius * 60,
        );

        for (let ring = 0; ring < RING_COUNT; ring++) {
          const phase = (elapsed + ring * (RIPPLE_DURATION_MS / RING_COUNT)) % RIPPLE_DURATION_MS;
          const t = phase / RIPPLE_DURATION_MS;
          const radius = interpolateNumber(8, maxRadius)(t);
          const opacity = interpolateNumber(0.7, 0)(t);

          ctx.beginPath();
          ctx.arc(pos.x + 90, pos.y + 36, radius, 0, Math.PI * 2);
          ctx.strokeStyle = baseColor;
          ctx.lineWidth = 2.5 - t * 1.5;
          ctx.globalAlpha = opacity;
          ctx.stroke();
          ctx.globalAlpha = 1;
        }

        // Impact highlight on affected nodes
        for (const nodeId of impact.affectedNodeIds) {
          const affectedPos = nodePositions.get(nodeId);
          if (!affectedPos) continue;

          const pulseT = (elapsed % 1200) / 1200;
          const pulseAlpha = 0.15 + 0.15 * Math.sin(pulseT * Math.PI * 2);

          ctx.beginPath();
          ctx.roundRect(
            affectedPos.x - 4,
            affectedPos.y - 4,
            188,
            80,
            18,
          );
          ctx.strokeStyle = SEVERITY_COLORS[impact.severity] ?? SEVERITY_COLORS.critical;
          ctx.lineWidth = 2;
          ctx.globalAlpha = pulseAlpha;
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }

      ctx.restore();
    },
    [impacts, nodePositions, transform, enabled],
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
      const ctx = canvasRef.current?.getContext("2d");
      if (ctx && canvasRef.current) ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
      return;
    }

    startRef.current = performance.now();
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
      className={styles.faultRippleCanvas}
      width={width}
      height={height}
    />
  );
}
