"use client";

import { useRef, useEffect, useCallback } from "react";
import { timer, type Timer } from "d3-timer";
import { interpolate } from "d3-interpolate";
import { color as d3Color } from "d3-color";
import type { LiveEdge, EdgeStatus, EdgeTrafficLevel } from "@aud/types";
import { edgeColor, particleCount, particleDuration, particleRadius } from "../utils/designTokens";
import styles from "../styles.module.css";

type ParticleCanvasProps = {
  edges: Array<{
    id: string;
    sourceX: number; sourceY: number;
    targetX: number; targetY: number;
    status: EdgeStatus;
    trafficLevel: EdgeTrafficLevel;
    metrics?: LiveEdge["metrics"];
  }>;
  width: number;
  height: number;
  transform: { x: number; y: number; zoom: number };
  enabled: boolean;
};

type Particle = { t: number; offset: number; isError: boolean };

type EdgeParticleGroup = {
  edgeId: string;
  sourceX: number; sourceY: number;
  targetX: number; targetY: number;
  status: EdgeStatus;
  trafficLevel: EdgeTrafficLevel;
  errorRate: number;
  particles: Particle[];
};

/** Cubic bezier interpolation between source and target. */
function bezierPt(sx: number, sy: number, tx: number, ty: number, t: number): [number, number] {
  const mx = (sx + tx) / 2;
  const u = 1 - t;
  return [
    u * u * u * sx + 3 * u * u * t * mx + 3 * u * t * t * mx + t * t * t * tx,
    u * u * u * sy + 3 * u * u * t * sy + 3 * u * t * t * ty + t * t * t * ty,
  ];
}

function parseAlpha(rgba: string): number {
  const parsed = d3Color(rgba);
  return parsed ? parsed.opacity : 0.9;
}

const ERROR_COLOR = "rgba(216,59,1,0.95)";
const TRAIL_STEPS = [0.02, 0.04, 0.06] as const;

export function D3ParticleCanvas({ edges, width, height, transform, enabled }: ParticleCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const groupsRef = useRef<EdgeParticleGroup[]>([]);
  const timerRef = useRef<Timer | null>(null);

  // Build / rebuild particle groups when edges change
  const buildGroups = useCallback(() => {
    const existing = new Map(groupsRef.current.map((g) => [g.edgeId, g]));
    const next: EdgeParticleGroup[] = [];

    for (const edge of edges) {
      const count = particleCount(edge.trafficLevel);
      if (count <= 0) continue;
      const errorRate = edge.metrics?.errorRate ?? 0;
      const prev = existing.get(edge.id);

      if (prev && prev.particles.length === count) {
        prev.sourceX = edge.sourceX; prev.sourceY = edge.sourceY;
        prev.targetX = edge.targetX; prev.targetY = edge.targetY;
        prev.status = edge.status;
        prev.trafficLevel = edge.trafficLevel;
        prev.errorRate = errorRate;
        next.push(prev);
      } else {
        next.push({
          edgeId: edge.id,
          sourceX: edge.sourceX, sourceY: edge.sourceY,
          targetX: edge.targetX, targetY: edge.targetY,
          status: edge.status, trafficLevel: edge.trafficLevel, errorRate,
          particles: Array.from({ length: count }, (_, i) => ({
            t: i / count, offset: i / count, isError: Math.random() < errorRate,
          })),
        });
      }
    }
    groupsRef.current = next;
  }, [edges]);

  useEffect(() => { buildGroups(); }, [buildGroups]);

  // Animation loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !enabled) {
      timerRef.current?.stop();
      timerRef.current = null;
      const ctx = canvas?.getContext("2d");
      if (ctx && canvas) ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;

    timerRef.current = timer(() => {
      // Resize with devicePixelRatio for crisp rendering
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      // Apply viewport transform (pan + zoom)
      ctx.save();
      ctx.translate(transform.x, transform.y);
      ctx.scale(transform.zoom, transform.zoom);

      // Batch render all particles in a single canvas pass
      for (const group of groupsRef.current) {
        const dur = particleDuration(group.trafficLevel);
        if (dur <= 0) continue;

        const speed = 1 / (dur * 60);
        const r = particleRadius(group.trafficLevel);
        const pColor = edgeColor(group.status).particle;
        const { sourceX: sx, sourceY: sy, targetX: tx, targetY: ty } = group;

        for (const p of group.particles) {
          p.t += speed;
          if (p.t >= 1) {
            p.t %= 1;
            p.isError = Math.random() < group.errorRate;
          }

          const fill = p.isError ? ERROR_COLOR : pColor;
          const [px, py] = bezierPt(sx, sy, tx, ty, p.t);

          // Trail: 3 trailing circles with decreasing opacity
          for (let ti = TRAIL_STEPS.length - 1; ti >= 0; ti--) {
            const trailT = p.t - TRAIL_STEPS[ti];
            if (trailT < 0) continue;
            const [ttx, tty] = bezierPt(sx, sy, tx, ty, trailT);
            ctx.globalAlpha = 0.15 - ti * 0.04;
            ctx.beginPath();
            ctx.arc(ttx, tty, r * (0.7 - ti * 0.1), 0, Math.PI * 2);
            ctx.fillStyle = fill;
            ctx.fill();
          }

          // Glow: larger semi-transparent circle
          ctx.globalAlpha = 0.3;
          ctx.beginPath();
          ctx.arc(px, py, r * 2, 0, Math.PI * 2);
          ctx.fillStyle = fill;
          ctx.fill();

          // Main particle
          ctx.globalAlpha = p.isError ? 0.95 : parseAlpha(fill);
          ctx.beginPath();
          ctx.arc(px, py, r, 0, Math.PI * 2);
          ctx.fillStyle = fill;
          ctx.fill();
        }
      }

      ctx.restore();
      ctx.globalAlpha = 1;
    });

    return () => {
      timerRef.current?.stop();
      timerRef.current = null;
    };
  }, [enabled, width, height, transform]);

  return (
    <canvas
      ref={canvasRef}
      className={styles.particleCanvas}
      width={width}
      height={height}
    />
  );
}
