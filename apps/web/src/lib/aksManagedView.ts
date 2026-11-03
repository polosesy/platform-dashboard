// AKS 보안 점검 › 인벤토리 › AKS 관리 부품 — view model (pure; tested in apps/api/test/aksManaged.test.ts).
// Families worst first (exploited, then Microsoft-unfixed), components inside the same way; counts per status.

import type { AksCveStatus, AksManagedComponent, AksManagedFamily } from "@aud/types";

export type MgCounts = Record<AksCveStatus, number> & { kev: number; notScanned: number; components: number };

export const STATUS_GLYPH: Record<AksCveStatus, string> = { fixedInLatest: "↑", pendingMs: "▲", unknown: "?" };
export const STATUS_LEVEL: Record<AksCveStatus, "info" | "warn" | "unknown"> = { fixedInLatest: "info", pendingMs: "warn", unknown: "unknown" };

export function countsOf(cs: AksManagedComponent[]): MgCounts {
  const n: MgCounts = { fixedInLatest: 0, pendingMs: 0, unknown: 0, kev: 0, notScanned: 0, components: cs.length };
  for (const c of cs) {
    if (c.scan !== "scanned") n.notScanned++;
    for (const v of c.cves) { n[v.status]++; if (v.kev) n.kev++; }
  }
  return n;
}

const rank = (n: MgCounts) => [n.kev, n.pendingMs, n.fixedInLatest, n.unknown];
const worse = (a: MgCounts, b: MgCounts) => {
  const ra = rank(a), rb = rank(b);
  for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return rb[i]! - ra[i]!;
  return 0;
};

export type MgFamily = { family: AksManagedFamily; notes: string; components: AksManagedComponent[]; counts: MgCounts };

export function groupByFamily(cs: AksManagedComponent[]): MgFamily[] {
  const by = new Map<AksManagedFamily, AksManagedComponent[]>();
  for (const c of cs) by.set(c.family, [...(by.get(c.family) ?? []), c]);
  return [...by].map(([family, list]) => ({
    family, notes: list[0]!.notes, counts: countsOf(list),
    components: [...list].sort((a, b) => worse(countsOf([a]), countsOf([b])) || (a.image < b.image ? -1 : a.image > b.image ? 1 : 0)),
  })).sort((a, b) => worse(a.counts, b.counts) || Number(a.family === "other") - Number(b.family === "other") || (a.family < b.family ? -1 : 1));
}

/** "mcr.microsoft.com/oss/v2/kubernetes/coredns" → "kubernetes/coredns" (the last two segments; registry dropped) */
export function shortImage(image: string): string {
  return image.split("/").slice(-2).join("/");
}

/** The comparison line's kind: newer tag scanned · ours is the newest · newer tag not scanned yet · not in the reports */
export function compareKind(c: AksManagedComponent): "newer" | "same" | "newerUnscanned" | "none" {
  if (!c.latest) return "none";
  if (c.latest.same) return "same";
  return c.latest.scan === "scanned" ? "newer" : "newerUnscanned";
}
