// Live diagram line grammar — pure (tested in apps/api/test/liveLayout.test.ts). One table drives the canvas,
// the toolbar swatches and the legend, so every line kind looks the same everywhere.
//
// Rules: colour = relationship; dashes only mark weaker evidence (a guess, a path Azure is retiring);
// arrowheads only where direction means something; red is reserved for fault impact.
import type { DiagramEdgeSpec, DiagramNodeSpec, EdgeStatus } from "@aud/types";
import { rgba, type UiColor, type VizColor } from "./palette";
import { edgeLayer, isInferredEdge, type EdgeLayer } from "./liveScope";

export type LiveEdgeStyleKey = EdgeLayer | "egressDeprecated";

export type LiveEdgeLook = { color: UiColor | VizColor; alpha: number; dash?: string; width: number };

export const LIVE_EDGE_LOOK: Record<LiveEdgeStyleKey, LiveEdgeLook> = {
  config: { color: "ink", alpha: 0.42, width: 1.5 },
  ingress: { color: "accent", alpha: 0.9, width: 2 },
  privateLink: { color: "privateLink", alpha: 0.85, width: 1.6 },
  /** Workload → Private Endpoint seen in logs: same family as Private Link, solid, never dashed (it is observed) */
  privateLinkUsage: { color: "privateLink", alpha: 0.95, width: 1.4 },
  egress: { color: "egress", alpha: 0.85, width: 1.6 },
  egressDeprecated: { color: "egress", alpha: 0.85, dash: "6 4", width: 1.6 },
  peering: { color: "peering", alpha: 0.85, width: 2 },
  publicIp: { color: "warning", alpha: 0.75, width: 1.4 },
  inferred: { color: "neutral", alpha: 0.5, dash: "2 4", width: 1 },
};

/** Order of the legend and of the toolbar menu */
export const LIVE_STYLE_ORDER: readonly LiveEdgeStyleKey[] = ["ingress", "config", "privateLinkUsage", "privateLink", "egress", "egressDeprecated", "peering", "publicIp", "inferred"];

export function liveStroke(key: LiveEdgeStyleKey): string {
  const l = LIVE_EDGE_LOOK[key];
  return rgba(l.color, l.alpha);
}

/** Default outbound (implicit, being retired by Azure) — the generator marks that edge with a dashed animation */
export function isDeprecatedPath(e: Pick<DiagramEdgeSpec, "edgeKind" | "animation">): boolean {
  return e.edgeKind === "outbound-internet" && e.animation === "dash";
}

export function liveEdgeStyleKey(e: DiagramEdgeSpec, byId: ReadonlyMap<string, DiagramNodeSpec>): LiveEdgeStyleKey {
  if (isDeprecatedPath(e)) return "egressDeprecated";
  return edgeLayer(e, byId);
}

/** Legend entries for the lines on screen: exactly the styles in use, in a fixed order */
export function legendKeys(edges: readonly DiagramEdgeSpec[], byId: ReadonlyMap<string, DiagramNodeSpec>): LiveEdgeStyleKey[] {
  const used = new Set(edges.map((e) => liveEdgeStyleKey(e, byId)));
  return LIVE_STYLE_ORDER.filter((k) => used.has(k));
}

// ── Relationship labels (shown on hover / selection only; IPs stay in the side panel) ──

export type RelLabel = { key: string; vars?: Record<string, string> };

/** Short service names for "Private Link · …" — product names, not translated */
const SERVICE_SHORT: Record<string, string> = {
  keyVault: "Key Vault", storage: "Storage", redis: "Redis", appService: "App Service", functionApp: "Functions",
  sql: "SQL", postgres: "PostgreSQL", cosmosDb: "Cosmos DB", serviceBus: "Service Bus", eventHub: "Event Hubs",
  containerApp: "Container Apps", aks: "AKS", appInsights: "App Insights", logAnalytics: "Log Analytics",
};

const kindOf = (n: DiagramNodeSpec | undefined) => n?.resourceKind ?? n?.icon ?? "";

/** "Key Vault", "Storage" … for a PaaS kind (product names, not translated) */
export const serviceShort = (kind: string) => SERVICE_SHORT[kind] ?? kind;

/** What the line means, as an i18n key — null when the line needs no words (an association, a guess) */
export function relationLabel(e: DiagramEdgeSpec, byId: ReadonlyMap<string, DiagramNodeSpec>): RelLabel | null {
  if (isInferredEdge(e)) return null;
  const sk = kindOf(byId.get(e.source));
  const tk = kindOf(byId.get(e.target));
  switch (e.edgeKind) {
    case "privateLink": return { key: "ld.rel.privateLink", vars: { target: SERVICE_SHORT[tk] ?? tk } };
    // observed use: the service name rides on the line (label), the grade on `protocol` (lib/plUsage.ts)
    case "privateLinkUsage": return { key: e.protocol === "flow" ? "ld.rel.privateLinkUsage.flow" : "ld.rel.privateLinkUsage.access", vars: { target: e.label ?? "" } };
    case "peering": return { key: "ld.rel.peering" };
    case "natgw-association": return { key: "ld.rel.natAssoc" };
    case "outbound-internet":
      return { key: sk === "natGateway" ? "ld.rel.outNat" : sk === "lb" ? "ld.rel.outSnat" : sk === "subnet" ? "ld.rel.outDefault" : "ld.rel.outPip" };
    case "routes": {
      const via = sk === "appGateway" ? "App GW" : sk === "lb" ? "LB" : tk === "lb" ? "LB" : sk;
      return e.protocol ? { key: "ld.rel.routesProto", vars: { via, proto: e.protocol } } : { key: "ld.rel.routes", vars: { via } };
    }
  }
  if (e.flowType === "ingress" && sk === "internet") return { key: "ld.rel.ingress" };
  if (e.flowType === "control") return { key: "ld.rel.control" };
  return null;
}

/** Edge label text is capped so a pill never spans the canvas */
export function clipLabel(s: string, max = 24): string {
  return [...s].length > max ? [...s].slice(0, max - 1).join("") + "…" : s;
}

/**
 * The same relationship drawn both ways (LB → VMSS backend and VMSS → LB outbound rule) becomes one line
 * with arrowheads at both ends. Returns the ids to drop and the ids that get a start arrow.
 */
export function mergeReversePairs(edges: readonly DiagramEdgeSpec[]): { drop: Set<string>; both: Set<string> } {
  const seen = new Map<string, string>();
  const drop = new Set<string>();
  const both = new Set<string>();
  for (const e of edges) {
    if (e.source === e.target) continue;
    const key = `${e.edgeKind ?? ""}|${e.target}|${e.source}`;
    const reverse = seen.get(key);
    if (reverse && !isInferredEdge(e)) {
      drop.add(e.id);
      both.add(reverse);
      continue;
    }
    seen.set(`${e.edgeKind ?? ""}|${e.source}|${e.target}`, e.id);
  }
  return { drop, both };
}

// ── Measured-traffic particles ("comets": round head + tapered gradient tail) ──

export type ParticleLevel = "low" | "medium" | "high" | "burst";
export type ParticleTone = "accent" | "privateLink" | "egress" | "warning";

/**
 * Sizes and pace by traffic level (relative to the busiest line in view). Speed is in px/s so a long line and a
 * short one move at the same pace; gap is the distance between comets on one line.
 */
export const PARTICLE = {
  tail: { low: 14, medium: 18, high: 22, burst: 26 },
  speed: { low: 60, medium: 90, high: 130, burst: 180 },
  gap: { low: 240, medium: 170, high: 120, burst: 90 },
} as const;

/** Channel token per tone — SVG fills read it as rgb(var(--x-rgb)) */
export const PARTICLE_TONE_VAR: Record<ParticleTone, string> = {
  accent: "--accent-rgb",
  privateLink: "--private-link-rgb",
  egress: "--egress-rgb",
  warning: "--warning-rgb",
};

const round2 = (v: number) => Math.round(v * 100) / 100;
const round3 = (v: number) => Math.round(v * 1000) / 1000;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Path length without measuring the DOM: right-angle step = |dx| + |dy| + the two stubs, curve ≈ 1.15 × chord */
export function estimatePathLength(kind: "step" | "bezier", dx: number, dy: number, offset = 16): number {
  return kind === "step" ? Math.abs(dx) + Math.abs(dy) + 2 * offset : 1.15 * Math.hypot(dx, dy);
}

/**
 * Comet plan for one line. Values are rounded so a re-render with the same inputs gives the same attribute
 * strings (SMIL would restart otherwise). The comet fades in after its tail has left the source and fades out
 * before the 14 px arrowhead, so it never sits on top of it.
 */
export function particlePlan(level: ParticleLevel, len: number, lineWidth: number) {
  const r = round2(Math.max(2.6, lineWidth / 2 + 1.5));
  const tail = PARTICLE.tail[level];
  const L = Math.max(1, len);
  return {
    r,
    tail,
    dur: round2(clamp(L / PARTICLE.speed[level], 0.8, 14)),
    count: clamp(Math.round(L / PARTICLE.gap[level]), 1, 6),
    fadeIn: round3(clamp((tail + 6) / L, 0.03, 0.25)),
    fadeOut: round3(1 - clamp((r + 16) / L, 0.03, 0.25)),
  };
}

/** Particle colour; null = none. A measured-down line must not look like it is flowing. */
export function particleTone(styleKey: LiveEdgeStyleKey, status: EdgeStatus, measured: boolean): ParticleTone | null {
  if (measured && status === "down") return null;
  if (measured && status === "degraded") return "warning";
  if (styleKey === "config" || styleKey === "ingress") return "accent";
  if (styleKey === "privateLink") return "privateLink";
  if (styleKey === "egress" || styleKey === "egressDeprecated") return "egress";
  return null;
}

/** Tail shape behind a head of radius r at the origin, pointing along +x: tapers to a point T px back */
export function cometTailPath(r: number, T: number): string {
  const f = (v: number) => round2(v);
  return `M ${f(-T)} 0 C ${f(-0.45 * T)} ${f(-0.35 * r)}, ${f(-1.6 * r)} ${f(-r)}, 0 ${f(-r)} A ${f(r)} ${f(r)} 0 0 1 0 ${f(r)} C ${f(-1.6 * r)} ${f(r)}, ${f(-0.45 * T)} ${f(0.35 * r)}, ${f(-T)} 0 Z`;
}
