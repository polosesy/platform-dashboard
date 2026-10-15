// Private Link usage on the live diagram — pure (no React), unit-tested from apps/api/test/plUsage.test.ts.
//
// The API (/api/live/private-link-usage) says which workload used which Private Endpoint, from access / flow
// logs. Here that becomes lines (workload → PE, added after layout so the picture never moves when logs
// arrive), card chips and the PE → PaaS state. Nothing is drawn without observed evidence.
import type { DiagramEdgeSpec, DiagramNodeSpec, PlUnresolved, PrivateLinkUsageResponse } from "@aud/types";
import { serviceShort } from "./liveStyle";

const kindOf = (n: DiagramNodeSpec | undefined) => n?.resourceKind ?? n?.icon ?? "";

/** Workload → PE lines for the usages whose two ends are drawn. `label` = service, `protocol` = grade. */
export function usageEdges(resp: PrivateLinkUsageResponse | null | undefined, byId: ReadonlyMap<string, DiagramNodeSpec>, drawn: ReadonlySet<string>): DiagramEdgeSpec[] {
  if (!resp) return [];
  return resp.usages
    .filter((u) => drawn.has(u.callerNodeId) && drawn.has(u.peNodeId))
    .map((u) => ({
      id: u.id,
      source: u.callerNodeId,
      target: u.peNodeId,
      edgeKind: "privateLinkUsage" as const,
      evidence: "observed" as const,
      label: serviceShort(kindOf(byId.get(u.targetNodeId))),
      protocol: u.grade,
      bindings: {},
      animation: "flow" as const,
    }));
}

/** PEs whose connection is not approved — their PE → PaaS line is grey, labelled, without comets */
export function disconnectedPes(resp: PrivateLinkUsageResponse | null | undefined): Set<string> {
  return new Set((resp?.endpoints ?? []).filter((e) => e.connectionState && e.connectionState !== "Approved").map((e) => e.peNodeId));
}

/** A source looked (on or empty) — the layer has something to say */
export const anySourceOn = (resp: PrivateLinkUsageResponse | null | undefined) => (resp?.sources ?? []).some((s) => s.state === "ok" || s.state === "empty");

export type UnresolvedGroup = {
  key: string;
  reason: PlUnresolved["reason"];
  basis?: PlUnresolved["basis"];
  candidates: string[];
  place?: PlUnresolved["place"];
  nicName?: string;
  /** distinct caller IPs (rows without an IP count once) */
  ips: number;
  requests: number;
  deniedFlows: number;
  lastSeen?: string;
  /** up to 3 IPs, most requests first */
  sample: string[];
  /** every distinct IP (folded in the panel, copied as is) */
  allIps: string[];
};

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const placeKey = (p: PlUnresolved["place"]) => !p ? "" : p.kind === "otherVnet" ? `ov:${p.vnetNodeId}:${p.subnetNodeId}:${p.ownerNodeId ?? ""}` : p.kind === "overlap" ? `ol:${p.matches}` : p.kind;

/**
 * One line per reason instead of one per IP: rows grouped by (reason, basis, candidate set, place, NIC). Groups
 * are ordered by distinct IPs, then requests, then key — deterministic. The panel shows the groups; the chip
 * counts `unresolvedCount` (the same distinct callers).
 */
export function groupUnresolved(rows: readonly PlUnresolved[]): UnresolvedGroup[] {
  const groups = new Map<string, UnresolvedGroup & { byIp: Map<string, number>; noIp: number }>();
  for (const r of rows) {
    const cands = [...(r.candidates ?? [])].sort(cmp);
    const key = [r.reason, r.basis ?? "", cands.join(","), placeKey(r.place), r.nicName ?? ""].join("|");
    type G = UnresolvedGroup & { byIp: Map<string, number>; noIp: number };
    const g: G = groups.get(key) ?? { key, reason: r.reason, ...(r.basis ? { basis: r.basis } : {}), candidates: cands, ...(r.place ? { place: r.place } : {}), ...(r.nicName ? { nicName: r.nicName } : {}), ips: 0, requests: 0, deniedFlows: 0, sample: [], allIps: [], byIp: new Map(), noIp: 0 };
    if (r.ip) g.byIp.set(r.ip, (g.byIp.get(r.ip) ?? 0) + (r.requests ?? 0));
    else g.noIp = 1;
    g.requests += r.requests ?? 0;
    g.deniedFlows += r.deniedFlows ?? 0;
    if (r.lastSeen && (!g.lastSeen || r.lastSeen > g.lastSeen)) g.lastSeen = r.lastSeen;
    groups.set(key, g);
  }
  return [...groups.values()].map(({ byIp, noIp, ...g }) => {
    const ordered = [...byIp.entries()].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0])).map(([ip]) => ip);
    return { ...g, ips: byIp.size + noIp, sample: ordered.slice(0, 3), allIps: [...ordered].sort(cmp) };
  }).sort((a, b) => b.ips - a.ips || b.requests - a.requests || cmp(a.key, b.key));
}

/** Distinct unidentified callers: distinct IPs, plus one per group of rows that carry no IP */
export const unresolvedCount = (rows: readonly PlUnresolved[]) => groupUnresolved(rows).reduce((n, g) => n + g.ips, 0);

export type UsageChip = { key: string; vars?: Record<string, number>; tone?: "warn" | "muted" };

/**
 * Chips per card. PE: "사용 n" / "사용 기록 없음" / "근거 없음" (+ "미확인 n"). PaaS: "사용처 n" (+ amber "공용 접근").
 * Card status never changes because of this.
 */
export function usageChips(resp: PrivateLinkUsageResponse | null | undefined): Map<string, UsageChip[]> {
  const out = new Map<string, UsageChip[]>();
  if (!resp) return out;
  const push = (id: string, c: UsageChip) => out.set(id, [...(out.get(id) ?? []), c]);
  for (const ep of resp.endpoints) {
    const n = resp.usages.filter((u) => u.peNodeId === ep.peNodeId).length;
    if (n) push(ep.peNodeId, { key: "ld.plu.chip.used", vars: { count: n } });
    else push(ep.peNodeId, ep.activity === "noUseObserved" ? { key: "ld.plu.chip.none", tone: "muted" } : { key: "ld.plu.chip.unknown", tone: "muted" });
    // Distinct callers (an IP seen in both an access log and a flow log is one), the same count as the panel
    const unresolved = unresolvedCount(resp.unresolved.filter((x) => x.peNodeId === ep.peNodeId || (!x.peNodeId && x.targetNodeId === ep.targetNodeId && resp.endpoints.filter((e) => e.targetNodeId === ep.targetNodeId).length === 1)));
    if (unresolved) push(ep.peNodeId, { key: "ld.plu.chip.unresolved", vars: { count: unresolved }, tone: "muted" });
  }
  const targets = [...new Set(resp.endpoints.map((e) => e.targetNodeId))];
  for (const t of targets) {
    const callers = new Set(resp.usages.filter((u) => u.targetNodeId === t).map((u) => u.callerNodeId)).size;
    if (callers) push(t, { key: "ld.plu.chip.users", vars: { count: callers } });
    if (resp.publicAccess.some((p) => p.targetNodeId === t && p.requests > 0)) push(t, { key: "ld.plu.chip.public", tone: "warn" });
  }
  return out;
}
