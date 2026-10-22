// Line styles of the infrastructure diagram (pure — no "@/" imports, so API tests can load it).
// Shared by the canvas (toFlow), the legend and the draw.io export: one table, one look.

import { hex, rgba, type UiColor, type VizColor } from "./palette";
import type { ArchEdgeKind } from "./archModel";

export type EdgeLook = { color: UiColor | VizColor; alpha: number; dash?: string; width: number; arrow: boolean };

export const EDGE_LOOK: Record<ArchEdgeKind | "traffic", EdgeLook> = {
  ingress: { color: "danger", alpha: 1, dash: "7 4", width: 2, arrow: true },
  exposure: { color: "danger", alpha: 0.55, dash: "2 4", width: 1.5, arrow: true },
  routes: { color: "accent", alpha: 1, width: 1.8, arrow: true },
  privateLink: { color: "privateLink", alpha: 1, dash: "6 3", width: 1.8, arrow: true },
  // A pipe (two rails, drawn by ArchEdge) with a chain-link badge: the two VNets are joined, not one calling the other
  peering: { color: "peering", alpha: 1, width: 5, arrow: false },
  // S2S VPN tunnel to an on-premises site (both directions — no arrow)
  hybrid: { color: "accent-2", alpha: 1, width: 2.2, arrow: false },
  outbound: { color: "ink", alpha: 0.55, width: 1.5, arrow: true },
  // the subnet's 0.0.0.0/0 UDR to a firewall / NVA (SEC-04) — the exit, an address match, so dashed
  udr: { color: "egress", alpha: 1, dash: "6 3", width: 1.8, arrow: true },
  egress: { color: "egress", alpha: 1, dash: "7 4", width: 1.8, arrow: true },
  vnetIntegration: { color: "integration", alpha: 1, dash: "3 3", width: 1.5, arrow: true },
  logging: { color: "ink", alpha: 0.4, dash: "1 4", width: 1.4, arrow: true },
  traffic: { color: "accent", alpha: 0.55, width: 3, arrow: true },
};

/**
 * One drawn line's look: its kind, changed by its state — a peering or VPN connection that is not Connected is amber
 * and dashed (Unknown = grey), an entry whose configuration could not be read is a grey dotted line
 */
export function lookOf(k: ArchEdgeKind | "traffic", state?: string): EdgeLook {
  const base = EDGE_LOOK[k];
  if (!state) return base;
  const s = state.toLowerCase();
  if ((k === "peering" || k === "hybrid") && s !== "connected") return { ...base, color: s === "unknown" ? "neutral" : "warning", dash: "6 4", width: k === "peering" ? 2.4 : base.width };
  if (k === "ingress" && s === "unknown") return { ...base, color: "neutral", dash: "2 4" };
  return base;
}
export const strokeOfLook = (l: EdgeLook) => (l.alpha === 1 ? hex(l.color) : rgba(l.color, l.alpha));

/** CSS/SVG stroke for a line kind */
export function strokeOf(k: ArchEdgeKind | "traffic"): string {
  const l = EDGE_LOOK[k];
  return l.alpha === 1 ? hex(l.color) : rgba(l.color, l.alpha);
}
