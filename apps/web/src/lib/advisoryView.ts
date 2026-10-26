// 보안 › 긴급 취약점 view model (pure): the CVE watch list the user types, card ordering and counts.
// Verdicts come from the API (services/advisories.ts) — nothing here upgrades "unknown" to "clear".

import type { AdvisoryItem, DependencyFinding, ExposureStatus } from "@aud/types";

export const MAX_WATCH = 20;
const CVE = /CVE-\d{4}-\d{4,7}/gi;

/** CVE IDs in free text ("CVE-2026-109618, cve-2026-109619 …"), normalized, unique, in order */
export function parseWatch(text: string): string[] {
  return [...new Set((text.match(CVE) ?? []).map((c) => c.toUpperCase()))].slice(0, MAX_WATCH);
}

export function mergeWatch(list: string[], add: string[]): string[] {
  return [...new Set([...list, ...add])].slice(0, MAX_WATCH);
}

/** Highest CVSS of the item's CVEs (null = none scored yet) */
export function maxCvss(item: Pick<AdvisoryItem, "cves">): number | null {
  const s = item.cves.map((c) => c.cvss?.score).filter((x): x is number => typeof x === "number");
  return s.length ? Math.max(...s) : null;
}

export const cvssTone = (score: number | null): "high" | "medium" | "low" | "neutral" =>
  score === null ? "neutral" : score >= 9 ? "high" : score >= 7 ? "high" : score >= 4 ? "medium" : "low";

export function targetCounts(item: Pick<AdvisoryItem, "targets">): Record<ExposureStatus, number> {
  const out: Record<ExposureStatus, number> = { affected: 0, eol: 0, unknown: 0, fixed: 0 };
  for (const t of item.targets) out[t.status]++;
  return out;
}

/** Main list (vendor advisories + watched CVEs) and the recent-KEV list, as the API ordered them */
export function splitItems(items: AdvisoryItem[]): { main: AdvisoryItem[]; kev: AdvisoryItem[] } {
  return { main: items.filter((i) => i.kind !== "kev"), kev: items.filter((i) => i.kind === "kev") };
}

/** A KEV entry matters to us when Defender found it in an image here */
export const kevHitsUs = (item: AdvisoryItem) => item.targets.some((t) => t.status === "affected");

export type FindingFilter = { severe: boolean; where: "all" | "platform" | "cluster" };

/** Severe = critical / high, or exploited (KEV, SSVC active / poc) — the default view; order stays the API's */
export function filterFindings(findings: DependencyFinding[], f: FindingFilter): DependencyFinding[] {
  return findings.filter((x) =>
    (!f.severe || x.exploited !== null || x.severity === "critical" || x.severity === "high") &&
    (f.where === "all" || x.where === f.where));
}

/** Counts for the filter chips */
export function findingCounts(findings: DependencyFinding[]): { all: number; severe: number; platform: number; cluster: number; noFix: number } {
  return {
    all: findings.length,
    severe: filterFindings(findings, { severe: true, where: "all" }).length,
    platform: findings.filter((x) => x.where === "platform").length,
    cluster: findings.filter((x) => x.where === "cluster").length,
    noFix: findings.filter((x) => !x.fixed).length,
  };
}

export const cveOrgUrl = (id: string) => `https://www.cve.org/CVERecord?id=${encodeURIComponent(id)}`;
