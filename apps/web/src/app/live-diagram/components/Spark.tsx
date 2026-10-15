"use client";

import { memo } from "react";

/**
 * Trend line — one SVG stretched to its box (CSS sets the size per zoom level), stroke width kept in screen
 * pixels. The scale comes from the caller (sparkDomain: starts at 0), so a flat series stays flat.
 */
export const Spark = memo(function Spark({ values, domain, color, className }: { values: number[]; domain: [number, number]; color: string; className?: string }) {
  if (values.length < 2) return <span className={className} aria-hidden="true" data-empty="true">—</span>;
  const [d0, d1] = domain;
  const span = d1 - d0 || 1;
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * 100).toFixed(2)},${(27 - ((Math.min(Math.max(v, d0), d1) - d0) / span) * 25).toFixed(2)}`);
  return (
    <svg className={className} viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
});
