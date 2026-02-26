"use client";

import { useEffect, useRef, useCallback } from "react";
import { interpolateRgb } from "d3-interpolate";
import type { TrafficHeatmapData } from "@aud/types";
import styles from "../styles.module.css";

type HeatmapEdge = {
  id: string;
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
};

type TrafficHeatmapProps = {
  heatmap: TrafficHeatmapData | null;
  edgePositions: Map<string, HeatmapEdge>;
  transform: { x: number; y: number; zoom: number };
  width: number;
  height: number;
  enabled: boolean;
};

export function TrafficHeatmap({
  heatmap,
  edgePositions,
  transform,
  width,
  height,
  enabled,
}: TrafficHeatmapProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const colorInterp = interpolateRgb("rgba(255,255,178,0.8)", "rgba(189,0,38,0.9)");

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !enabled || !heatmap) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.translate(transform.x, transform.y);
    ctx.scale(transform.zoom, transform.zoom);

    for (const cell of heatmap.cells) {
      const edgeKey = `${cell.source}->${cell.target}`;
      const edge = edgePositions.get(edgeKey);
      if (!edge) continue;

      const intensity = cell.normalizedValue;
      const heatColor = colorInterp(intensity);

      // Draw thick heatmap edge
      ctx.beginPath();
      ctx.moveTo(edge.sourceX, edge.sourceY);

      // Bezier curve for smooth edge
      const midX = (edge.sourceX + edge.targetX) / 2;
      const midY = (edge.sourceY + edge.targetY) / 2 - 20;
      ctx.quadraticCurveTo(midX, midY, edge.targetX, edge.targetY);

      ctx.strokeStyle = heatColor;
      ctx.lineWidth = 3 + intensity * 12;
      ctx.lineCap = "round";
      ctx.globalAlpha = 0.25 + intensity * 0.55;
      ctx.stroke();

      // Glow effect for high-intensity edges
      if (intensity > 0.6) {
        ctx.beginPath();
        ctx.moveTo(edge.sourceX, edge.sourceY);
        ctx.quadraticCurveTo(midX, midY, edge.targetX, edge.targetY);
        ctx.strokeStyle = heatColor;
        ctx.lineWidth = 8 + intensity * 16;
        ctx.globalAlpha = 0.08 + intensity * 0.12;
        ctx.filter = "blur(4px)";
        ctx.stroke();
        ctx.filter = "none";
      }

      ctx.globalAlpha = 1;
    }

    ctx.restore();
  }, [heatmap, edgePositions, transform, enabled, colorInterp]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    draw();
  }, [width, height, draw]);

  useEffect(() => {
    draw();
  }, [draw]);

  if (!enabled || !heatmap) return null;

  return (
    <canvas
      ref={canvasRef}
      className={styles.heatmapCanvas}
      width={width}
      height={height}
    />
  );
}
