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
  peering: { color: "accent-2", alpha: 1, dash: "8 4", width: 2.4, arrow: false },
  outbound: { color: "ink", alpha: 0.55, width: 1.5, arrow: true },
  egress: { color: "egress", alpha: 1, dash: "7 4", width: 1.8, arrow: true },
  vnetIntegration: { color: "integration", alpha: 1, dash: "3 3", width: 1.5, arrow: true },
  logging: { color: "ink", alpha: 0.4, dash: "1 4", width: 1.4, arrow: true },
  traffic: { color: "accent", alpha: 0.55, width: 3, arrow: true },
};

/** CSS/SVG stroke for a line kind */
export function strokeOf(k: ArchEdgeKind | "traffic"): string {
  const l = EDGE_LOOK[k];
  return l.alpha === 1 ? hex(l.color) : rgba(l.color, l.alpha);
}
