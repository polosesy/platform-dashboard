// 통합 위험 › 이슈 목록 (pure) — one queue over sources that each find risk on their own, with the team's status.
// A watched question of the graph explorer is a source too: each workload it matches (all conditions yes) is an issue.
// Issues are recomputed from the sources on every load; the stored state is only what the team said. When the two
// disagree the source wins: "resolved" that is still detected after the claim is open again (reopened), an expired
// exception is open again (expired). Keys are printable ASCII without spaces (the API validates `source:scope:id`).

import type {
  AdvisoriesResponse, EvidenceKind, IssueState, IssueStatus, OwnerRule, PolicyInsightsResponse, PostureAlert, SavedQuery, WorkloadIdentityResponse, AzureAttackPath, AzureRiskCombo, AzureRiskResponse,
} from "@aud/types";
import { groupAlerts } from "./alertGroups";
import { buildGraph, decodeQuery, runQuery } from "./securityGraph";

export type IssueSource = "combo" | "wi" | "alert" | "vuln" | "query" | "azure";
export type IssueSev = "critical" | "high" | "medium" | "low";

/**
 * The kind of attack path an issue is (노출 관리 › 우선순위 — Wiz groups its prioritized issues the same way):
 * exposure = reachable from outside (a cluster's exposed workloads without ingress isolation · an Azure resource
 * exposed with a High finding or a privileged identity · an Internet path to data or control) · privilege = an
 * identity that can do too much (cluster takeover, standing privilege, AKS local accounts, workload identity findings,
 * a privileged identity on a vulnerable Azure resource) · exfiltration = a compromised workload can send data out ·
 * vulnerability = urgent vulnerabilities in what runs · threat = an active Defender alert · custom = a team question
 */
export type PathType = "exposure" | "privilege" | "exfiltration" | "vulnerability" | "threat" | "custom";

/**
 * Pure: an urgent vulnerability's issue severity — exploited (CISA KEV or SSVC active) = critical, else the highest
 * CVSS: ≥ 9 critical · ≥ 7 high · ≥ 4 medium · else low; no score anywhere = medium (stated as unscored on the page,
 * never "high" by default — every affected advisory used to be "high", a CVSS 4 too).
 */
export function vulnSeverity(cves: Array<{ kev?: unknown; exploitation?: string | null; cvss?: { score?: number | null } | null }>): IssueSev {
  if (cves.some((c) => c.kev || c.exploitation === "active")) return "critical";
  const scores = cves.map((c) => c.cvss?.score).filter((x): x is number => typeof x === "number");
  if (!scores.length) return "medium";
  const top = Math.max(...scores);
  return top >= 9 ? "critical" : top >= 7 ? "high" : top >= 4 ? "medium" : "low";
}

export type QueueItem = {
  key: string;
  source: IssueSource;
  pathType: PathType;
  sev: IssueSev;
  title: string;
  /** Where — workloads, owner, resources (short) */
  target: string;
  evidence: EvidenceKind;
  /** Source screen of this issue */
  href: string;
  /** When the source last produced it */
  seenAt: string | null;
  /** Kubernetes namespaces and Azure resource groups it is about — what the team rules match */
  namespaces: string[];
  resourceGroups: string[];
  /** Owning team (connection file `owners`), null = no rule matched */
  team: string | null;
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
  /** Team questions of the graph explorer — only `watch` ones raise issues */
  queries?: SavedQuery[] | null;
  /** Team rules of the subscription's connection */
  owners?: OwnerRule[];
  /** Azure resource combinations of the subscription (exposure × High recommendation × privileged identity) */
  azureRisk?: AzureRiskResponse | null;
  /** The issue title of a combination (the page's language — this module has no translations) */
  azureTitle?: (c: AzureRiskCombo) => string;
  /** The issue title of an attack path that reaches data or control */
  azurePathTitle?: (p: AzureAttackPath) => string;
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
const SOURCE_RANK: Record<IssueSource, number> = { combo: 0, azure: 1, wi: 2, query: 3, vuln: 4, alert: 5 };
const EV_RANK: Record<EvidenceKind, number> = { unk: 0, cfg: 1, perm: 2, obs: 3 };

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

/** "team-*" or an exact name, case-insensitive */
const matches = (pattern: string, value: string) => {
  const p = pattern.toLowerCase(), v = value.toLowerCase();
  return p.endsWith("*") ? v.startsWith(p.slice(0, -1)) : p === v;
};

/** The first rule naming one of the namespaces, else the first naming one of the resource groups (file order) */
export function teamOf(namespaces: string[], resourceGroups: string[], rules: OwnerRule[] = []): string | null {
  for (const r of rules) if ((r.namespaces ?? []).some((p) => namespaces.some((n) => matches(p, n)))) return r.team;
  for (const r of rules) if ((r.resourceGroups ?? []).some((p) => resourceGroups.some((g) => matches(p, g)))) return r.team;
  return null;
}

/** "ns/name" ids, "w:ns/Kind/name" and "sa:ns/name" graph ids → the namespace */
const nsOf = (id: string): string | null => {
  const m = /^(?:w:|sa:)?([a-z0-9][-a-z0-9]{0,62})\/[^/]/.exec(id);
  return m ? m[1]! : null;
};
const uniq = (xs: Array<string | null | undefined>) => [...new Set(xs.filter((x): x is string => !!x))];

export function buildIssueQueue(input: QueueInput): IssueQueue {
  const raw: Array<Omit<QueueItem, "stored" | "status" | "flag" | "team">> = [];
  const clusterRg = input.clusterId ? /\/resourcegroups\/([^/]+)\//i.exec(input.clusterId)?.[1] ?? null : null;
  const scope = input.clusterId ? clusterScope(input.clusterId) : null;
  const cluster = input.clusterId ? encodeURIComponent(input.clusterId) : "";

  // ① Cluster risk combinations (AKS 보안 점검)
  if (scope && input.insights) {
    for (const i of input.insights.issues) {
      const ev: EvidenceKind = i.edges.some((e) => e.ev === "obs") ? "obs" : i.edges.some((e) => e.ev === "perm") ? "perm" : "cfg";
      raw.push({
        key: `combo:${scope}:${ascii(i.id, 400)}`, source: "combo", pathType: i.kind === "vnet" ? "exposure" : i.kind === "exfil" ? "exfiltration" : "privilege", sev: i.sev === "crit" ? "critical" : "high",
        title: i.title, target: i.owner, evidence: ev, href: `/policies?tab=overview&cluster=${cluster}&issue=${encodeURIComponent(i.id)}`,
        seenAt: input.insights.generatedAt,
        namespaces: uniq([...(i.members ?? []).map((m) => m.namespace), ...i.nodes.flatMap((n) => n.refs).map(nsOf), i.id.startsWith("vnet:") ? i.id.slice(5) : null]),
        resourceGroups: uniq([clusterRg]),
      });
    }
  }
  // ② Workload identity (critical / warning findings — WI-17 IMDS path included)
  if (scope && input.wi) {
    for (const f of input.wi.findings) {
      if (f.sev !== "crit" && f.sev !== "warn") continue;
      raw.push({
        key: `wi:${scope}:${ascii(f.id, 400)}`, source: "wi", pathType: "privilege", sev: f.sev === "crit" ? "critical" : "high",
        title: f.title, target: f.rule, evidence: f.ev, href: `/policies?tab=workloadIdentity&cluster=${cluster}`, seenAt: input.wi.generatedAt,
        namespaces: uniq(f.refs.map(nsOf)), resourceGroups: uniq([clusterRg]),
      });
    }
  }
  // ③ Urgent vulnerabilities that affect something we run (exploited in the wild or critical = critical)
  if (scope && input.advisories) {
    for (const a of input.advisories.items) {
      if (a.status !== "affected") continue;
      // Only what runs in this cluster: an image of its workloads. The dashboard's own runtime (evidence "runtime") and a
      // Defender finding on an image no workload here runs are not this cluster's (they were queued under it and its team)
      const inCluster = a.targets.filter((x) => x.status === "affected" && x.evidence !== "runtime" && (x.evidence === "imageTag" || x.workloads.length > 0));
      if (!inCluster.length) continue;
      const where = [...new Set(inCluster.map((x) => x.where))];
      raw.push({
        key: `vuln:${scope}:${ascii(a.key, 400)}`, source: "vuln", pathType: "vulnerability", sev: vulnSeverity(a.cves),
        title: a.title, target: where.slice(0, 2).join(", ") + (where.length > 2 ? ` +${where.length - 2}` : ""), evidence: "cfg",
        href: "/security/advisories", seenAt: input.advisories.generatedAt,
        namespaces: uniq(inCluster.flatMap((x) => x.workloads).map(nsOf)), resourceGroups: uniq([clusterRg]),
      });
    }
  }
  // ④ Watched graph questions: one issue per (question, matched workload). Only all-yes matches — "can't tell" raises
  // nothing; the evidence is the weakest of the facts it rests on. Workload identity conditions need that view.
  const watched = (input.queries ?? []).filter((q) => q.watch);
  if (scope && input.insights && watched.length) {
    const graph = buildGraph(input.insights, input.wi ?? null);
    for (const q of watched) {
      const keys = decodeQuery(q.q);
      if (!keys.length) continue;
      for (const w of runQuery(graph, keys, { includeManaged: q.includeManaged }).matches) {
        const ev = keys.map((k) => w.facts[k].ev).sort((a, b) => EV_RANK[a] - EV_RANK[b])[0] ?? "cfg";
        raw.push({
          key: `query:${scope}:${q.id}/${ascii(w.id, 300)}`, source: "query", pathType: "custom", sev: q.sev,
          title: `${q.name} · ${w.name}`, target: `${w.namespace}/${w.name}`, evidence: ev,
          href: `/security/explore?cluster=${cluster}&q=${encodeURIComponent(q.q)}`, seenAt: input.insights.generatedAt,
          namespaces: [w.namespace], resourceGroups: uniq([clusterRg]),
        });
      }
    }
  }
  // ⑥ Azure resource combinations (the subscription — one issue per resource, the key fixed by rg / type / name)
  if (input.azureRisk) {
    for (const c of input.azureRisk.combos) {
      raw.push({
        key: c.key, source: "azure", pathType: c.kind === "highIdentity" ? "privilege" : "exposure", sev: c.sev, title: input.azureTitle ? input.azureTitle(c) : c.kind,
        target: `${c.name} (${c.resourceGroup})`, evidence: c.exposure.state === "yes" || c.high.state === "yes" ? "cfg" : "perm",
        href: `/security/risk#azure-${c.key.slice(6).replace(/[^a-z0-9-]/g, "-")}`, seenAt: input.azureRisk.generatedAt,
        namespaces: [], resourceGroups: [c.resourceGroup],
      });
    }
    // Attack paths that reach data or control: an issue of their own (a data role is not a combination's identity
    // factor — a path Internet → entry → Storage data role → storage is found here only)
    for (const p of input.azureRisk.paths ?? []) {
      if (p.ends === "entry") continue;
      raw.push({
        key: p.key, source: "azure", pathType: "exposure", sev: p.sev, title: input.azurePathTitle ? input.azurePathTitle(p) : `path ${p.entry.name}`,
        target: `${p.entry.name} (${p.entry.resourceGroup})`, evidence: "perm",
        href: `/security/risk#azure-${p.key.slice(5).replace(/[^a-z0-9-]/g, "-")}-path`, seenAt: input.azureRisk.generatedAt,
        namespaces: [], resourceGroups: [p.entry.resourceGroup],
      });
    }
  }
  // ⑤ Defender active alerts (the subscription — one issue per detection, instances inside)
  if (input.alerts) {
    for (const g of groupAlerts(input.alerts)) {
      if (g.severity === "Informational") continue;
      raw.push({
        key: `alert:${g.severity.toLowerCase()}:${slug(g.title)}`, source: "alert", pathType: "threat", sev: g.severity === "High" ? "high" : g.severity === "Medium" ? "medium" : "low",
        title: g.items.length > 1 ? `${g.title} ×${g.items.length}` : g.title, target: g.resources.slice(0, 2).join(", ") + (g.resources.length > 2 ? ` +${g.resources.length - 2}` : ""),
        evidence: "obs", href: "/security/threats", seenAt: input.alertsAt ?? g.lastAt,
        namespaces: uniq(g.items.map((a) => a.k8s?.namespace)), resourceGroups: uniq(g.items.flatMap((a) => a.resources.map((r) => r.resourceGroup))),
      });
    }
  }

  const seen = new Set<string>();
  const items: QueueItem[] = [];
  for (const r of raw) {
    if (seen.has(r.key)) continue; // the same id twice in a source is one issue
    seen.add(r.key);
    const stored = input.states[r.key] ?? null;
    items.push({ ...r, team: teamOf(r.namespaces, r.resourceGroups, input.owners), stored, ...effectiveStatus(stored, r.seenAt, input.now) });
  }
  items.sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || SEV_RANK[a.sev] - SEV_RANK[b.sev] || SOURCE_RANK[a.source] - SOURCE_RANK[b.source] || a.title.localeCompare(b.title));

  // Stored states of this scope that no source produced now — only for sources that were actually read
  const read = (k: string) => (k.startsWith("query:") ? !!input.insights && !!input.queries && watched.some((q) => k.startsWith(`query:${scope}:${q.id}/`))
    : k.startsWith("combo:") ? !!input.insights : k.startsWith("wi:") ? !!input.wi : k.startsWith("vuln:") ? !!input.advisories : k.startsWith("alert:") ? !!input.alerts
      // a combination's factor that could not be read does not make its issue "not detected"
      : k.startsWith("azure:") || k.startsWith("path:") ? !!input.azureRisk && !input.azureRisk.gaps.length : false);
  const inScope = (k: string) => k.startsWith("alert:") || k.startsWith("azure:") || k.startsWith("path:") || (!!scope && k.split(":")[1] === scope);
  const notDetected = Object.keys(input.states).filter((k) => inScope(k) && read(k) && !seen.has(k)).length;

  const counts = { open: 0, openCritical: 0, inProgress: 0, accepted: 0, resolved: 0 };
  for (const i of items) {
    if (i.status === "open") { counts.open++; if (i.sev === "critical") counts.openCritical++; }
    else counts[i.status]++;
  }
  return { items, counts, notDetected };
}
