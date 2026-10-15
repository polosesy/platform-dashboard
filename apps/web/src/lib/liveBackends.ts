// Gateway (LB / App Gateway) and backend-member facts for the live diagram — pure; tested from
// apps/api/test/liveBackends.test.ts. Catalog rows AGW-01..06, LB-02..06, AKS-03, VMSS-03.
import type { LiveEdge } from "@aud/types";

export type GatewayFacts = {
  /** Pool members no resource could be matched to (IP / FQDN / NIC outside the graph) */
  unresolved: number;
  /** Created by AKS (tag or node resource group) */
  aksManaged: boolean;
  /** A load balancer no inbound rule uses — only its outbound rule carries traffic */
  outboundOnly: boolean;
};

export type UnresolvedBackend = { pool: string; address: string; reason: string };

const parse = <T>(v: string | undefined): T[] => {
  if (!v) return [];
  try { const x = JSON.parse(v); return Array.isArray(x) ? (x as T[]) : []; } catch { return []; }
};

export const unresolvedBackends = (metadata?: Record<string, string>) => parse<UnresolvedBackend>(metadata?.unresolvedBackends);
export type GatewayFrontend = { name: string; kind: "public" | "private"; ip?: string; listeners: string[]; ruleBound: boolean };
export const gatewayFrontends = (metadata?: Record<string, string>) => parse<GatewayFrontend>(metadata?.frontends);

export function gatewayFacts(metadata?: Record<string, string>): GatewayFacts | undefined {
  if (!metadata) return undefined;
  const unresolved = unresolvedBackends(metadata).length;
  const aksManaged = metadata.managedBy === "aks";
  // LB only (App Gateways carry privateListeners): no inbound rule but an outbound one
  const outboundOnly = metadata.inboundRules === "0" && metadata.privateListeners == null && Number(metadata.outboundRules ?? 0) > 0;
  return unresolved || aksManaged || outboundOnly ? { unresolved, aksManaged, outboundOnly } : undefined;
}

/** A backend line's label gets its measured quality: "App GW · 54/분", "LB · 프로브 100%" */
export function withBackendValue(label: string, metrics: LiveEdge["metrics"] | undefined, t: (k: string, v?: Record<string, string | number>) => string): string {
  if (metrics?.responsesPerMin != null) return `${label} · ${t("ld.edge.perMin", { n: Math.round(metrics.responsesPerMin) })}`;
  if (metrics?.probePct != null) return `${label} · ${t("ld.edge.probeShort", { n: Math.round(metrics.probePct) })}`;
  return label;
}
