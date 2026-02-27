import type {
  DesignTokenSet,
  HealthStatus,
  EdgeStatus,
  EdgeTrafficLevel,
  NodeColorToken,
  EdgeColorToken,
  FaultDesignTokens,
  HeatmapDesignTokens,
  CanvasParticleTokens,
} from "@aud/types";

// ────────────────────────────────────────────
// Default design tokens (matches figma-tokens.json)
// In production, this would be loaded from Figma API
// or a synced JSON file at build time.
// ────────────────────────────────────────────

export const defaultTokens: DesignTokenSet = {
  version: "1.0.0",
  generatedAt: "2026-02-23T00:00:00Z",
  source: "manual",
  colors: {
    node: {
      ok:       { fill: "rgba(255,255,255,0.88)", border: "rgba(16,137,62,0.30)",  shadow: "rgba(16,137,62,0.12)",  ringStroke: "rgba(16,137,62,0.70)",  text: "rgba(20,21,23,0.90)" },
      warning:  { fill: "rgba(255,255,255,0.88)", border: "rgba(209,132,0,0.35)",  shadow: "rgba(209,132,0,0.14)",  ringStroke: "rgba(209,132,0,0.75)",  text: "rgba(20,21,23,0.90)" },
      critical: { fill: "rgba(255,255,255,0.88)", border: "rgba(216,59,1,0.35)",   shadow: "rgba(216,59,1,0.14)",   ringStroke: "rgba(216,59,1,0.80)",   text: "rgba(20,21,23,0.90)" },
      unknown:  { fill: "rgba(255,255,255,0.88)", border: "rgba(20,21,23,0.12)",   shadow: "rgba(20,21,23,0.06)",   ringStroke: "rgba(20,21,23,0.20)",   text: "rgba(20,21,23,0.60)" },
    },
    edge: {
      normal:   { stroke: "rgba(0,120,212,0.55)",   particle: "rgba(0,120,212,0.90)" },
      degraded: { stroke: "rgba(209,132,0,0.60)",   particle: "rgba(209,132,0,0.90)", glow: "rgba(209,132,0,0.20)" },
      down:     { stroke: "rgba(216,59,1,0.70)",     particle: "rgba(216,59,1,0.95)", glow: "rgba(216,59,1,0.25)" },
      idle:     { stroke: "rgba(20,21,23,0.12)",     particle: "rgba(20,21,23,0.30)" },
    },
    alert: {
      info: "rgba(0,120,212,0.90)",
      warning: "rgba(209,132,0,0.90)",
      critical: "rgba(216,59,1,0.95)",
    },
    background: "rgba(247,248,250,1)",
    border: "rgba(20,21,23,0.10)",
  },
  animation: {
    particleDuration: { none: 0, low: 8, medium: 5, high: 3.5, burst: 2.0 },
    particleCount: { none: 0, low: 1, medium: 1, high: 2, burst: 3 },
    pulseFrequency: { ok: 0, warning: 2.0, critical: 1.0, unknown: 0 },
    transitionDuration: 600,
  },
  dimensions: {
    nodeWidth: 180,
    nodeHeight: 72,
    edgeWidthRange: [1.5, 6],
    particleRadius: { none: 0, low: 1, medium: 1.2, high: 1.5, burst: 2 },
    healthRingRadius: 17,
    healthRingStroke: 3,
  },
  typography: {
    nodeLabel: { fontSize: 13, fontWeight: 800 },
    nodeMetric: { fontSize: 11, fontWeight: 700 },
    edgeLabel: { fontSize: 11, fontWeight: 600 },
  },
};

// ── Token access helpers ──

export function nodeColor(health: HealthStatus, tokens = defaultTokens): NodeColorToken {
  return tokens.colors.node[health];
}

export function edgeColor(status: EdgeStatus, tokens = defaultTokens): EdgeColorToken {
  return tokens.colors.edge[status];
}

export function edgeWidth(trafficLevel: EdgeTrafficLevel, tokens = defaultTokens): number {
  const [min, max] = tokens.dimensions.edgeWidthRange;
  const levels: Record<EdgeTrafficLevel, number> = { none: 0, low: 0.20, medium: 0.45, high: 0.70, burst: 1.0 };
  return min + (max - min) * levels[trafficLevel];
}

export function particleDuration(trafficLevel: EdgeTrafficLevel, tokens = defaultTokens): number {
  return tokens.animation.particleDuration[trafficLevel];
}

export function particleCount(trafficLevel: EdgeTrafficLevel, tokens = defaultTokens): number {
  return tokens.animation.particleCount[trafficLevel];
}

export function particleRadius(trafficLevel: EdgeTrafficLevel, tokens = defaultTokens): number {
  return tokens.dimensions.particleRadius[trafficLevel];
}

// ── Extended tokens for fault / heatmap / canvas particles ──

export const faultTokens: FaultDesignTokens = {
  rippleColor: {
    critical: "rgba(216,59,1,0.65)",
    warning: "rgba(209,132,0,0.55)",
    info: "rgba(0,120,212,0.45)",
  },
  cascadeDelayMs: 300,
  impactHighlight: "rgba(216,59,1,0.20)",
  rippleDurationMs: 2400,
  maxRippleRadius: 180,
};

export const heatmapTokens: HeatmapDesignTokens = {
  colorScaleStart: "rgba(255,255,178,0.6)",
  colorScaleEnd: "rgba(189,0,38,0.85)",
  minOpacity: 0.25,
  maxOpacity: 0.80,
};

export const canvasParticleTokens: CanvasParticleTokens = {
  sizeRange: [2, 4.5],
  glowRadius: 8,
  trailLength: 3,
  trailOpacity: 0.15,
};
