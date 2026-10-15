// Private Link usage on the live diagram — pure (no React), unit-tested from apps/api/test/plUsage.test.ts.
//
// The API (/api/live/private-link-usage) says which workload used which Private Endpoint, from access / flow
// logs. Here that becomes lines (workload → PE, added after layout so the picture never moves when logs
// arrive), card chips and the PE → PaaS state. Nothing is drawn without observed evidence.
import type { DiagramEdgeSpec, DiagramNodeSpec, PrivateLinkUsageResponse } from "@aud/types";
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
    const unresolved = resp.unresolved.filter((x) => x.peNodeId === ep.peNodeId || (!x.peNodeId && x.targetNodeId === ep.targetNodeId && resp.endpoints.filter((e) => e.targetNodeId === ep.targetNodeId).length === 1)).length;
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
