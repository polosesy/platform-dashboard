"use client";

import React, { useRef, useEffect, useCallback } from "react";
import { timer, type Timer } from "d3-timer";
import { color as d3Color } from "d3-color";
import type { LiveEdge, EdgeStatus, EdgeTrafficLevel } from "@aud/types";
import { edgeColor, particleCount, particleDuration, particleRadius } from "../utils/designTokens";
import styles from "../styles.module.css";

type ParticleCanvasProps = {
  edges: Array<{
    id: string;
    sourceX: number; sourceY: number;
    targetX: number; targetY: number;
    pathD?: string;
    status: EdgeStatus;
    trafficLevel: EdgeTrafficLevel;
    metrics?: LiveEdge["metrics"];
  }>;
  width: number;
  height: number;
  /** Ref to viewport transform — read every animation frame for zero-lag sync with ReactFlow */
  transformRef: React.RefObject<{ x: number; y: number; zoom: number }>;
  enabled: boolean;
};

type Particle = { t: number; offset: number; isError: boolean };

type EdgeParticleGroup = {
  edgeId: string;
  pathEl: SVGPathElement;
  pathLen: number;
  status: EdgeStatus;
  trafficLevel: EdgeTrafficLevel;
  errorRate: number;
  particles: Particle[];
};

function parseAlpha(rgba: string): number {
  const parsed = d3Color(rgba);
  return parsed ? parsed.opacity : 0.9;
}

const ERROR_COLOR = "rgba(216,59,1,0.95)";
const TRAIL_STEPS = [0.03, 0.06] as const;

/** Create an offscreen SVG path element for getPointAtLength. */
function makeSvgPath(d: string): SVGPathElement {
  const el = document.createElementNS("http://www.w3.org/2000/svg", "path");
  el.setAttribute("d", d);
  return el;
}

/** Get point on path at parameter t (0..1). */
function pathPoint(el: SVGPathElement, len: number, t: number): [number, number] {
  const pt = el.getPointAtLength(Math.max(0, Math.min(1, t)) * len);
  return [pt.x, pt.y];
}

export function D3ParticleCanvas({ edges, width, height, transformRef, enabled }: ParticleCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const groupsRef = useRef<EdgeParticleGroup[]>([]);
  const timerRef = useRef<Timer | null>(null);

  // Build / rebuild particle groups when edges change
  const buildGroups = useCallback(() => {
    const existing = new Map(groupsRef.current.map((g) => [g.edgeId, g]));
    const next: EdgeParticleGroup[] = [];

    for (const edge of edges) {
      const count = particleCount(edge.trafficLevel);
      if (count <= 0 || !edge.pathD) continue;
      const errorRate = edge.metrics?.errorRate ?? 0;
      const prev = existing.get(edge.id);

      // Create/update SVG path element for exact curve sampling
      const pathEl = makeSvgPath(edge.pathD);
      const pathLen = pathEl.getTotalLength();

      if (prev && prev.particles.length === count) {
        prev.pathEl = pathEl;
        prev.pathLen = pathLen;
        prev.status = edge.status;
        prev.trafficLevel = edge.trafficLevel;
        prev.errorRate = errorRate;
        next.push(prev);
      } else {
        next.push({
          edgeId: edge.id,
          pathEl,
          pathLen,
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

      // Read latest viewport transform from ref — zero-lag sync with ReactFlow
      const vp = transformRef.current;
      if (!vp) return;
      ctx.save();
      ctx.translate(vp.x, vp.y);
      ctx.scale(vp.zoom, vp.zoom);

      // Batch render all particles in a single canvas pass
      for (const group of groupsRef.current) {
        const dur = particleDuration(group.trafficLevel);
        if (dur <= 0 || group.pathLen <= 0) continue;

        const speed = 1 / (dur * 60);
        const r = particleRadius(group.trafficLevel);
        const pColor = edgeColor(group.status).particle;

        for (const p of group.particles) {
          p.t += speed;
          if (p.t >= 1) {
            p.t %= 1;
            p.isError = Math.random() < group.errorRate;
          }

          const fill = p.isError ? ERROR_COLOR : pColor;
          const [px, py] = pathPoint(group.pathEl, group.pathLen, p.t);

          // Trail: 3 trailing circles with decreasing opacity
          for (let ti = TRAIL_STEPS.length - 1; ti >= 0; ti--) {
            const trailT = p.t - TRAIL_STEPS[ti];
            if (trailT < 0) continue;
            const [ttx, tty] = pathPoint(group.pathEl, group.pathLen, trailT);
            ctx.globalAlpha = 0.15 - ti * 0.04;
            ctx.beginPath();
            ctx.arc(ttx, tty, r * (0.7 - ti * 0.1), 0, Math.PI * 2);
            ctx.fillStyle = fill;
            ctx.fill();
          }

          // Glow: larger semi-transparent circle — sized to match edge width
          ctx.globalAlpha = 0.20;
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
  // transformRef is a stable ref — no need to include in deps; read on each frame
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, width, height]);

  return (
    <canvas
      ref={canvasRef}
      className={styles.particleCanvas}
      width={width}
      height={height}
    />
  );
}
