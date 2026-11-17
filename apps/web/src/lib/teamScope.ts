// 보안 개요 팀 범위 (security-roadmap 5.7 ⑤) — pure. Splits the API's per-resource-group counts by the connection's owner
// rules with the issue list's own `teamOf` (lib/issueQueue.ts): a resource group belongs to the same team on 통합 위험
// and here. Only resource-group rules apply — the overview counts Azure resources; namespace rules own things inside
// clusters (the issue list). Every group lands in exactly one bucket: teams (rule order) · 소유 미지정 · 그룹 없음 —
// so the buckets add up to the subscription (`total`). An alert naming resources of two teams counts for both.

import type { OwnerRule, PostureDomain, PostureRecommendation, PostureSeverity, SecurityTeamScopeResponse } from "@aud/types";
import { teamOf } from "./issueQueue";

export const NO_TEAM = "__none";
export const NO_GROUP = "__nogroup";
export const ALL = "all";

type Sev3 = { High: number; Medium: number; Low: number };
export type ScopeDomain = { d: PostureDomain; kinds: number; total: number; high: number; medium: number; low: number };
export type ScopeBucket = {
  /** team name · NO_TEAM · NO_GROUP · ALL */
  id: string;
  kind: "team" | "unowned" | "noGroup" | "all";
  /** resource groups in this bucket */
  groups: string[];
  /** the team has resource-group rules (a namespace-only team has no Azure resources here — "—", not 0) */
  rgRules: boolean;
  /** null = not read (a gap) */
  resources: number | null;
  affected: Sev3 | null;
  findings: (Sev3 & { total: number }) | null;
  byDomain: ScopeDomain[];
  /** recommendations by unhealthy count in this bucket, High first */
  top: Array<{ key: string; title: string; severity: PostureSeverity; n: number }>;
  alerts: { total: number; bySeverity: Record<string, number> } | null;
};
export type TeamScopeView = {
  buckets: ScopeBucket[];
  total: ScopeBucket;
  /** owner rules naming resource groups */
  rgRuleCount: number;
  /** alerts counted in more than one bucket */
  alertsShared: number;
};

const SEV_RANK: Record<PostureSeverity, number> = { High: 0, Medium: 1, Low: 2 };
const SEP = "\u0000";
/** A recommendation row's identity: key + severity */
export const recId = (key: string, severity: PostureSeverity) => `${key}${SEP}${severity}`;
const zero = (): Sev3 => ({ High: 0, Medium: 0, Low: 0 });

/** The bucket of a resource group: its team (resource-group rules, issue-list order), else unowned; "" = no group */
export function bucketOf(rg: string, rules: OwnerRule[]): string {
  if (!rg) return NO_GROUP;
  return teamOf([], [rg], rules) ?? NO_TEAM;
}

export function teamScopeView(data: SecurityTeamScopeResponse, recs: PostureRecommendation[]): TeamScopeView {
  const rules = data.owners ?? [];
  const gap = (s: SecurityTeamScopeResponse["gaps"][number]["section"]) => data.gaps.some((g) => g.section === s);
  // Defender answers one recommendation key per severity on some resources (the overview groups by key, title and
  // severity — stg: 280 rows for 259 keys): match on key + severity, never key alone (it counted a team twice)
  const byKey = new Map(recs.map((r) => [recId(r.key, r.severity), r]));
  const teams = [...new Set(rules.map((r) => r.team))];
  const ids: Array<[string, ScopeBucket["kind"]]> = [...teams.map((t) => [t, "team"] as [string, ScopeBucket["kind"]]), [NO_TEAM, "unowned"], [NO_GROUP, "noGroup"], [ALL, "all"]];
  const make = (id: string, kind: ScopeBucket["kind"]): ScopeBucket => ({
    id, kind, groups: [], rgRules: kind !== "team" || rules.some((r) => r.team === id && (r.resourceGroups?.length ?? 0) > 0),
    resources: gap("inventory") ? null : 0, affected: gap("affected") ? null : zero(), findings: gap("findings") ? null : { ...zero(), total: 0 },
    byDomain: [], top: [], alerts: gap("alerts") ? null : { total: 0, bySeverity: {} },
  });
  const b = new Map(ids.map(([id, kind]) => [id, make(id, kind)]));
  const all = b.get(ALL)!;
  const into = (id: string) => [b.get(id)!, all];

  const groupBucket = new Map<string, string>();
  for (const g of data.groups) {
    const id = bucketOf(g.rg, rules);
    groupBucket.set(g.rg, id);
    for (const x of into(id)) {
      if (g.rg && !x.groups.includes(g.rg)) x.groups.push(g.rg);
      if (x.resources !== null) x.resources = g.resources === null ? null : x.resources + g.resources;
      if (x.affected) for (const s of ["High", "Medium", "Low"] as const) x.affected[s] += g.affected[s];
    }
  }
  // findings → severity totals, domains (the recommendation's Defender categories), top recommendations
  const perKey = new Map<string, Map<string, number>>();
  for (const f of data.findings) {
    const id = groupBucket.get(f.rg) ?? bucketOf(f.rg, rules);
    for (const x of into(id)) {
      if (x.findings) { x.findings[f.severity] += f.n; x.findings.total += f.n; }
      const m = perKey.get(x.id) ?? perKey.set(x.id, new Map()).get(x.id)!;
      const k = recId(f.key, f.severity);
      m.set(k, (m.get(k) ?? 0) + f.n);
    }
  }
  for (const x of b.values()) {
    if (!x.findings) continue;
    const m = perKey.get(x.id) ?? new Map<string, number>();
    const rows = [...m].map(([id, n]) => {
      const [key, sev] = id.split(SEP) as [string, PostureSeverity];
      const r = byKey.get(id);
      return { key, n, title: r?.title ?? key, severity: sev, domain: (r?.domain ?? "other") as PostureDomain };
    });
    const domains = new Map<PostureDomain, ScopeDomain>();
    for (const r of rows) {
      const d = domains.get(r.domain) ?? domains.set(r.domain, { d: r.domain, kinds: 0, total: 0, high: 0, medium: 0, low: 0 }).get(r.domain)!;
      d.kinds++; d.total += r.n;
      if (r.severity === "High") d.high += r.n; else if (r.severity === "Medium") d.medium += r.n; else d.low += r.n;
    }
    x.byDomain = [...domains.values()];
    x.top = rows.sort((p, q) => SEV_RANK[p.severity] - SEV_RANK[q.severity] || q.n - p.n || p.title.localeCompare(q.title))
      .map(({ key, title, severity, n }) => ({ key, title, severity, n }));
  }
  // alerts: every bucket whose groups it names (once each); none named = no group
  let alertsShared = 0;
  for (const a of data.alerts) {
    const hit = a.rgs.length ? [...new Set(a.rgs.map((rg) => groupBucket.get(rg) ?? bucketOf(rg, rules)))] : [NO_GROUP];
    if (hit.length > 1) alertsShared++;
    for (const id of [...hit, ALL]) {
      const x = b.get(id)!;
      if (x.alerts) { x.alerts.total++; x.alerts.bySeverity[a.severity] = (x.alerts.bySeverity[a.severity] ?? 0) + 1; }
    }
  }
  for (const x of b.values()) x.groups.sort();
  return {
    buckets: ids.filter(([id]) => id !== ALL).map(([id]) => b.get(id)!),
    total: all,
    rgRuleCount: rules.reduce((n, r) => n + (r.resourceGroups?.length ?? 0), 0),
    alertsShared,
  };
}

// ── The same scope on 보안 권고 · ID·권한 · 위협 탐지 ──

/** A recommendation's unhealthy count inside a bucket (0 = none of its findings are in the bucket's groups) */
export function teamCounts(bucket: ScopeBucket): Map<string, number> {
  return new Map(bucket.top.map((x) => [recId(x.key, x.severity), x.n]));
}

/** The recommendations with findings in the bucket, each with its unhealthy count there (samples: the bucket's only) */
export function recsInBucket(recs: PostureRecommendation[], bucket: ScopeBucket, rules: OwnerRule[]): PostureRecommendation[] {
  const n = teamCounts(bucket);
  return recs.filter((r) => (n.get(recId(r.key, r.severity)) ?? 0) > 0).map((r) => ({
    ...r,
    unhealthy: n.get(recId(r.key, r.severity))!,
    samples: r.samples.filter((x) => bucketOf((x.resourceGroup ?? "").toLowerCase(), rules) === bucket.id),
  }));
}

/** The buckets an alert counts in — the groups of the resources it names (none = no group): the API's own rule */
export function alertBuckets(alert: { resources: Array<{ resourceGroup: string }> }, rules: OwnerRule[]): string[] {
  const rgs = [...new Set(alert.resources.map((r) => (r.resourceGroup ?? "").toLowerCase()).filter(Boolean))];
  return rgs.length ? [...new Set(rgs.map((rg) => bucketOf(rg, rules)))] : [NO_GROUP];
}
