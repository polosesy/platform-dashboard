// 통합 위험 › 이슈 목록 (pure) — one queue over sources that each find risk on their own, with the team's status.
// Issues are recomputed from the sources on every load; the stored state is only what the team said. When the two
// disagree the source wins: "resolved" that is still detected after the claim is open again (reopened), an expired
// exception is open again (expired). Keys are printable ASCII without spaces (the API validates `source:scope:id`).

import type {
  AdvisoriesResponse, EvidenceKind, IssueState, IssueStatus, PolicyInsightsResponse, PostureAlert, WorkloadIdentityResponse,
} from "@aud/types";
import { groupAlerts } from "./alertGroups";

export type IssueSource = "combo" | "wi" | "alert" | "vuln";
export type IssueSev = "critical" | "high" | "medium" | "low";

export type QueueItem = {
  key: string;
  source: IssueSource;
  sev: IssueSev;
  title: string;
  /** Where — workloads, owner, resources (short) */
  target: string;
  evidence: EvidenceKind;
  /** Source screen of this issue */
  href: string;
  /** When the source last produced it */
  seenAt: string | null;
  stored: IssueState | null;
  /** Effective status (the source wins over a stale claim) */
  status: IssueStatus;
  /** resolved, but detected again after the claim · exception past its end date · resolved, not re-checked yet */
  flag: "reopened" | "expired" | "verifying" | null;
};

export type QueueInput = {
  /** The selected cluster's ARM id (null = no cluster) */
  clusterId: string | null;
  insights?: PolicyInsightsResponse | null;
  wi?: WorkloadIdentityResponse | null;
  alerts?: PostureAlert[] | null;
  /** When the alerts were read (posture.generatedAt) */
  alertsAt?: string | null;
  advisories?: AdvisoriesResponse | null;
  states: Record<string, IssueState>;
  now: Date;
};

export type IssueQueue = {
  items: QueueItem[];
  counts: { open: number; openCritical: number; inProgress: number; accepted: number; resolved: number };
  /** Stored states of this scope whose issue is no longer detected (kept as history, not listed) */
  notDetected: number;
};

const SEV_RANK: Record<IssueSev, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const STATUS_RANK: Record<IssueStatus, number> = { open: 0, inProgress: 1, accepted: 2, resolved: 3 };
const SOURCE_RANK: Record<IssueSource, number> = { combo: 0, wi: 1, vuln: 2, alert: 3 };

/** "/subscriptions/x/resourceGroups/RG/providers/…/managedClusters/AKS1" → "rg/aks1" (the state file is per subscription) */
export function clusterScope(clusterId: string): string {
  const m = /\/resourcegroups\/([^/]+)\/.*\/managedclusters\/([^/]+)/i.exec(clusterId);
  return (m ? `${m[1]}/${m[2]}` : clusterId).toLowerCase();
}
const ascii = (s: string, max = 300) => s.normalize("NFKD").replace(/[^\x21-\x7e]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, max);
export const slug = (s: string) => ascii(s.toLowerCase(), 120);

/** Effective status: an exception ends, a "resolved" claim older than the source's last reading is reopened */
export function effectiveStatus(stored: IssueState | null, seenAt: string | null, now: Date): Pick<QueueItem, "status" | "flag"> {
  if (!stored) return { status: "open", flag: null };
  if (stored.status === "accepted" && stored.until && Date.parse(`${stored.until}T23:59:59Z`) < now.getTime()) return { status: "open", flag: "expired" };
  if (stored.status === "resolved") {
    // Still in the source: detected again after the claim → open; read before the claim → not re-checked yet
    if (seenAt && Date.parse(seenAt) > Date.parse(stored.updatedAt)) return { status: "open", flag: "reopened" };
    return { status: "resolved", flag: "verifying" };
  }
  return { status: stored.status, flag: null };
}

export function buildIssueQueue(input: QueueInput): IssueQueue {
  const raw: Array<Omit<QueueItem, "stored" | "status" | "flag">> = [];
  const scope = input.clusterId ? clusterScope(input.clusterId) : null;
  const cluster = input.clusterId ? encodeURIComponent(input.clusterId) : "";

  // ① Cluster risk combinations (AKS 보안 점검)
  if (scope && input.insights) {
    for (const i of input.insights.issues) {
      const ev: EvidenceKind = i.edges.some((e) => e.ev === "obs") ? "obs" : i.edges.some((e) => e.ev === "perm") ? "perm" : "cfg";
      raw.push({
        key: `combo:${scope}:${ascii(i.id, 400)}`, source: "combo", sev: i.sev === "crit" ? "critical" : "high",
        title: i.title, target: i.owner, evidence: ev, href: `/policies?tab=overview&cluster=${cluster}&issue=${encodeURIComponent(i.id)}`,
        seenAt: input.insights.generatedAt,
      });
    }
  }
  // ② Workload identity (critical / warning findings — WI-17 IMDS path included)
  if (scope && input.wi) {
    for (const f of input.wi.findings) {
      if (f.sev !== "crit" && f.sev !== "warn") continue;
      raw.push({
        key: `wi:${scope}:${ascii(f.id, 400)}`, source: "wi", sev: f.sev === "crit" ? "critical" : "high",
        title: f.title, target: f.rule, evidence: f.ev, href: `/policies?tab=workloadIdentity&cluster=${cluster}`, seenAt: input.wi.generatedAt,
      });
    }
  }
  // ③ Urgent vulnerabilities that affect something we run (exploited in the wild or critical = critical)
  if (scope && input.advisories) {
    for (const a of input.advisories.items) {
      if (a.status !== "affected") continue;
      const exploited = a.cves.some((c) => c.kev || c.exploitation === "active");
      const critical = exploited || a.cves.some((c) => (c.cvss?.score ?? 0) >= 9);
      const where = [...new Set(a.targets.filter((x) => x.status === "affected").map((x) => x.where))];
      raw.push({
        key: `vuln:${scope}:${ascii(a.key, 400)}`, source: "vuln", sev: critical ? "critical" : "high",
        title: a.title, target: where.slice(0, 2).join(", ") + (where.length > 2 ? ` +${where.length - 2}` : ""), evidence: "cfg",
        href: "/security/advisories", seenAt: input.advisories.generatedAt,
      });
    }
  }
  // ④ Defender active alerts (the subscription — one issue per detection, instances inside)
  if (input.alerts) {
    for (const g of groupAlerts(input.alerts)) {
      if (g.severity === "Informational") continue;
      raw.push({
        key: `alert:${g.severity.toLowerCase()}:${slug(g.title)}`, source: "alert", sev: g.severity === "High" ? "high" : g.severity === "Medium" ? "medium" : "low",
        title: g.items.length > 1 ? `${g.title} ×${g.items.length}` : g.title, target: g.resources.slice(0, 2).join(", ") + (g.resources.length > 2 ? ` +${g.resources.length - 2}` : ""),
        evidence: "obs", href: "/security/threats", seenAt: input.alertsAt ?? g.lastAt,
      });
    }
  }

  const seen = new Set<string>();
  const items: QueueItem[] = [];
  for (const r of raw) {
    if (seen.has(r.key)) continue; // the same id twice in a source is one issue
    seen.add(r.key);
    const stored = input.states[r.key] ?? null;
    items.push({ ...r, stored, ...effectiveStatus(stored, r.seenAt, input.now) });
  }
  items.sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || SEV_RANK[a.sev] - SEV_RANK[b.sev] || SOURCE_RANK[a.source] - SOURCE_RANK[b.source] || a.title.localeCompare(b.title));

  // Stored states of this scope that no source produced now — only for sources that were actually read
  const read = (k: string) => (k.startsWith("combo:") ? !!input.insights : k.startsWith("wi:") ? !!input.wi : k.startsWith("vuln:") ? !!input.advisories : k.startsWith("alert:") ? !!input.alerts : false);
  const inScope = (k: string) => k.startsWith("alert:") || (!!scope && k.split(":")[1] === scope);
  const notDetected = Object.keys(input.states).filter((k) => inScope(k) && read(k) && !seen.has(k)).length;

  const counts = { open: 0, openCritical: 0, inProgress: 0, accepted: 0, resolved: 0 };
  for (const i of items) {
    if (i.status === "open") { counts.open++; if (i.sev === "critical") counts.openCritical++; }
    else counts[i.status]++;
  }
  return { items, counts, notDetected };
}
