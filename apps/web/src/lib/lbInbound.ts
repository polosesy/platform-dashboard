// The inbound side of an internal load balancer on the live diagram — pure (no React), unit-tested from
// apps/api/test/lbInbound.test.ts. A line "LB → backend" alone does not say anyone calls the LB; the card says what
// is known, strictly from facts, in this order:
//   1. configured callers — lines already in the spec (Application Gateway backend pool = the frontend IP, AGW-04)
//   2. observed callers — VNet flow logs to a private frontend IP (API joinLbInbound: one resource or unresolved)
//   3. measured inbound — ByteCount / SYNCount per private frontend over the last hour (specGenerator
//      privateFrontendBindings `feIn<i>` / `feSyn<i>`): traffic arrived, the source is not known
//   4. nothing measured / 0 measured — said as such ("not measured" ≠ "nothing came")
// Never a risk colour, never the card status. Peered VNets and on-premises sites are reachable, not callers.
import type { DiagramEdgeSpec, DiagramNodeSpec, LbInboundCaller, PlUnresolved, PrivateLinkUsageResponse } from "@aud/types";
import type { UsageChip } from "./plUsage";
import { unresolvedCount } from "./plUsage";

/** Metric keys of the per-frontend inbound hour — shown in the LB's inbound section, not the general metric list */
export const isFrontendInboundKey = (k: string) => /^fe(In|Syn)\d+$/.test(k);

/** 1536 → "1.5 KB" (bytes over a window, not a rate) */
export function formatBytes(v: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let x = Math.max(0, v);
  let i = 0;
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i++; }
  return `${x < 10 && i ? x.toFixed(1) : Math.round(x)} ${units[i]}`;
}

/** Same cap as the API (specGenerator MAX_PRIVATE_FRONTENDS) */
export const MAX_PRIVATE_FRONTENDS = 3;
const PRIVATE_V4 = /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/;
const kindOf = (n: DiagramNodeSpec | undefined) => n?.resourceKind ?? n?.icon ?? "";
/** Kinds whose configured line into an LB is a caller (a backend pool that names the frontend) */
const CALLER_KINDS = new Set(["appGateway", "frontDoor", "agc", "apim"]);

/** Private frontend IPs of an LB card, in metadata order (the binding keys follow it) */
export function privateFrontends(meta: Record<string, string> | undefined): string[] {
  let fes: Array<{ kind?: string; ip?: string }> = [];
  try { fes = JSON.parse(meta?.frontends ?? "[]") as typeof fes; } catch { return []; }
  return [...new Set(fes.filter((f) => f.kind === "private" && f.ip && PRIVATE_V4.test(f.ip)).map((f) => f.ip!))].slice(0, MAX_PRIVATE_FRONTENDS);
}

export type LbInboundFacts = {
  lbNodeId: string;
  frontends: Array<{ ip: string; bytes: number | null; syn: number | null }>;
  /** Bytes received over the hour on all private frontends; null = none of them measured */
  bytes: number | null;
  configured: Array<{ nodeId: string; edgeId: string }>;
  observed: LbInboundCaller[];
  unresolved: PlUnresolved[];
  /** The flow-log source of the response (null = no response yet) */
  flowState: "ok" | "empty" | "disabled" | "signin" | "failed" | null;
  flowReason?: string;
};

/** Everything known about who sends traffic into one internal LB (null for a public-only LB) */
export function lbInboundFacts(
  lb: DiagramNodeSpec,
  edges: readonly DiagramEdgeSpec[],
  byId: ReadonlyMap<string, DiagramNodeSpec>,
  metrics: Record<string, number | null> | undefined,
  resp: PrivateLinkUsageResponse | null | undefined,
): LbInboundFacts | null {
  if (kindOf(lb) !== "lb") return null;
  const ips = privateFrontends(lb.metadata);
  if (!ips.length) return null;
  const val = (k: string) => { const v = metrics?.[k]; return typeof v === "number" && Number.isFinite(v) ? v : null; };
  const frontends = ips.map((ip, i) => ({ ip, bytes: val(`feIn${i}`), syn: val(`feSyn${i}`) }));
  const measured = frontends.map((f) => f.bytes).filter((b): b is number => b != null);
  const configured = edges
    .filter((e) => e.target === lb.id && e.edgeKind === "routes" && CALLER_KINDS.has(kindOf(byId.get(e.source))))
    .map((e) => ({ nodeId: e.source, edgeId: e.id }))
    .filter((c, i, a) => a.findIndex((x) => x.nodeId === c.nodeId) === i);
  const flow = resp?.sources.find((s) => s.source === "vnetFlow");
  return {
    lbNodeId: lb.id,
    frontends,
    bytes: measured.length ? measured.reduce((s, b) => s + b, 0) : null,
    configured,
    observed: (resp?.lbInbound?.callers ?? []).filter((c) => c.lbNodeId === lb.id),
    unresolved: (resp?.lbInbound?.unresolved ?? []).filter((u) => u.targetNodeId === lb.id),
    flowState: flow ? (flow.state as LbInboundFacts["flowState"]) : null,
    ...(flow?.reason ? { flowReason: flow.reason } : {}),
  };
}

/** Distinct callers known by configuration or observation */
export const knownCallers = (f: LbInboundFacts) => new Set([...f.configured.map((c) => c.nodeId), ...f.observed.map((c) => c.callerNodeId)]).size;

/**
 * Card chip (one, plus the unresolved count): callers known · traffic measured but no caller known · 0 measured ·
 * not measured (ld.lbin.chip.*). Neutral / muted only.
 */
export function lbInboundChips(f: LbInboundFacts | null): UsageChip[] {
  if (!f) return [];
  const out: UsageChip[] = [];
  const n = knownCallers(f);
  if (n) out.push({ key: "ld.lbin.chip.callers", vars: { count: n } });
  else if (f.bytes != null && f.bytes > 0) out.push({ key: "ld.lbin.chip.sourceUnknown", tone: "muted" });
  else if (f.bytes === 0) out.push({ key: "ld.lbin.chip.none", tone: "muted" });
  else out.push({ key: "ld.lbin.chip.notMeasured", tone: "muted" });
  const u = unresolvedCount(f.unresolved);
  if (u) out.push({ key: "ld.plu.chip.unresolved", vars: { count: u }, tone: "muted" });
  return out;
}

/** Observed caller → LB lines (both ends drawn), in the observed-use layer; `protocol` "lbFlow" picks the label */
export function lbInboundEdges(resp: PrivateLinkUsageResponse | null | undefined, drawn: ReadonlySet<string>): DiagramEdgeSpec[] {
  return (resp?.lbInbound?.callers ?? [])
    .filter((c) => drawn.has(c.callerNodeId) && drawn.has(c.lbNodeId))
    .map((c) => ({
      id: c.id,
      source: c.callerNodeId,
      target: c.lbNodeId,
      edgeKind: "privateLinkUsage" as const,
      evidence: "observed" as const,
      label: c.frontendIps.join(", "),
      protocol: "lbFlow",
      bindings: {},
      animation: "flow" as const,
    }));
}
