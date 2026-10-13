import type {
  DesignTokenSet,
  HealthStatus,
  EdgeStatus,
  EdgeTrafficLevel,
  DiagramEdgeKind,
  NodeColorToken,
  EdgeColorToken,
} from "@aud/types";
import { rgba } from "@/lib/palette";

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
      ok:       { fill: rgba("paper", 0.88), border: rgba("ok", 0.3),  shadow: rgba("ok", 0.12),  ringStroke: rgba("ok", 0.7),  text: rgba("ink", 0.9) },
      warning:  { fill: rgba("paper", 0.88), border: rgba("warning", 0.35),  shadow: rgba("warning", 0.14),  ringStroke: rgba("warning", 0.75),  text: rgba("ink", 0.9) },
      critical: { fill: rgba("paper", 0.88), border: rgba("danger", 0.35),   shadow: rgba("danger", 0.14),   ringStroke: rgba("danger", 0.8),   text: rgba("ink", 0.9) },
      unknown:  { fill: rgba("paper", 0.88), border: rgba("ink", 0.12),   shadow: rgba("ink", 0.06),   ringStroke: rgba("ink", 0.2),   text: rgba("ink", 0.6) },
    },
    edge: {
      normal:   { stroke: rgba("accent", 0.55),   particle: rgba("accent", 0.9) },
      degraded: { stroke: rgba("warning", 0.6),   particle: rgba("warning", 0.9), glow: rgba("warning", 0.2) },
      down:     { stroke: rgba("danger", 0.7),     particle: rgba("danger", 0.95), glow: rgba("danger", 0.25) },
      idle:     { stroke: rgba("ink", 0.12),     particle: rgba("ink", 0.3) },
    },
    alert: {
      info: rgba("accent", 0.9),
      warning: rgba("warning", 0.9),
      critical: rgba("danger", 0.95),
    },
    background: rgba("canvas"),
    border: rgba("ink", 0.1),
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

// ── EdgeKind visual tokens ──

export type EdgeKindStyle = {
  stroke: string;
  particle: string;
  dashArray: string;       // SVG stroke-dasharray ("none" = solid)
  showParticles: boolean;
};

const EDGE_KIND_STYLES: Record<DiagramEdgeKind, EdgeKindStyle> = {
  network:       { stroke: rgba("accent", 0.6),   particle: rgba("accent", 0.9),   dashArray: "none",      showParticles: true },
  peering:       { stroke: rgba("peering", 0.6),  particle: rgba("peering", 0.9),  dashArray: "8 4",       showParticles: false },
  privateLink:   { stroke: rgba("privateLink", 0.6),  particle: rgba("privateLink", 0.9),  dashArray: "none",      showParticles: true },
  routes:        { stroke: rgba("accent", 0.6),   particle: rgba("accent", 0.9),   dashArray: "none",      showParticles: true },
  logging:       { stroke: rgba("neutral", 0.3), particle: rgba("neutral", 0.5), dashArray: "4 6",       showParticles: false },
  inferred:      { stroke: rgba("neutral", 0.25), particle: rgba("neutral", 0.4), dashArray: "2 4 6 4",   showParticles: false },
  "attached-to":        { stroke: rgba("subnet", 0.5),   particle: rgba("subnet", 0.7),   dashArray: "none",    showParticles: false },
  "bound-to":           { stroke: rgba("accent", 0.45),   particle: rgba("accent", 0.7),   dashArray: "4 4",     showParticles: false },
  // Outbound internet: orange-amber for explicit, dashed handled via animation override for deprecated
  "outbound-internet":  { stroke: rgba("egress", 0.75),  particle: rgba("egress", 0.95),  dashArray: "none",    showParticles: false },
  // NAT GW association: subnet → NAT GW card, same orange family, dashed
  "natgw-association":  { stroke: rgba("egress", 0.6),  particle: rgba("egress", 0.8),  dashArray: "6 4",     showParticles: false },
};

export function edgeKindStyle(kind: DiagramEdgeKind | undefined): EdgeKindStyle {
  if (!kind) return EDGE_KIND_STYLES.network; // default for legacy edges
  return EDGE_KIND_STYLES[kind] ?? EDGE_KIND_STYLES.network;
}

// ── Flow type tints (subtle color overlay for architecture flow semantics) ──

export type FlowTypeTint = { tint: string; glowWidth: number };

export const FLOW_TYPE_TINTS: Record<string, FlowTypeTint> = {
  ingress:    { tint: rgba("peering", 0.12),  glowWidth: 4 },
  egress:     { tint: rgba("fault", 0.1),   glowWidth: 4 },
  dependency: { tint: rgba("privateLink", 0.1),  glowWidth: 4 },
  control:    { tint: rgba("neutral", 0.08), glowWidth: 3 },
  // east-west: no tint (uses default edgeKind styling)
};

// ── GroupNode scope visual tokens ──

export type ScopeStyle = {
  borderColor: string;
  background: string;
  borderStyle: string;     // "solid" | "dashed"
  borderWidth: string;
};

export const SCOPE_STYLES: Record<string, ScopeStyle> = {
  subscription:  { borderColor: rgba("accent", 0.15),  background: rgba("accent", 0.02),  borderStyle: "solid",  borderWidth: "1px" },
  resourceGroup: { borderColor: rgba("neutral", 0.2), background: rgba("neutral", 0.02), borderStyle: "dashed", borderWidth: "1px" },
  vnet:          { borderColor: rgba("accent", 0.25),   background: rgba("accent", 0.03),   borderStyle: "dashed", borderWidth: "1.5px" },
  subnet:        { borderColor: rgba("subnet", 0.22),   background: rgba("subnet", 0.03),   borderStyle: "dashed", borderWidth: "1.5px" },
};

export function scopeStyle(icon: string): ScopeStyle {
  return SCOPE_STYLES[icon] ?? SCOPE_STYLES.vnet;
}
