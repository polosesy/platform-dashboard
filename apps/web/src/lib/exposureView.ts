// 노출 관리 (CTEM) — pure. The three stages counted on the page from the issue list (the same `buildIssueQueue`
// result the 통합 위험 page shows, so the numbers agree by construction):
//   prioritization  issues open or in progress, critical or high — by attack-path type (Wiz: "Critical/High Attack Paths")
//   validation      of those, the ones whose evidence was OBSERVED (traffic, a Defender alert — evidence "obs"), not only
//                   configured; Wiz validates from outside with its scanner and Red Agent — we have no external tester,
//                   so "validated" here means "seen happening", and the mitigating controls are counted beside it
//   remediation     from the team's stored states and the dashboard's sightings:
//                     resolved (window)    issues whose history has a "resolved" entry inside the window (team-marked)
//                     no longer detected   stored issues no source produces now (the queue's notDetected)
//                     assignment rate      prioritized issues with an assignee ÷ prioritized issues
//                     SLA                  prioritized issues younger than their severity's limit ÷ those with a known
//                                          first sighting — limits from CISA BOD 19-02 (critical 15 days, high 30 days);
//                                          an issue first seen before sightings existed has no age ("not known", excluded)
//                     exceptions (14 d)    "accepted" entries in the last 14 days

import type { IssueSighting, IssueState } from "@aud/types";
import type { IssueQueue, PathType, QueueItem } from "./issueQueue";

export const PATH_ORDER: PathType[] = ["exposure", "privilege", "exfiltration", "vulnerability", "threat", "custom"];
/** CISA BOD 19-02 (Vulnerability Remediation Requirements for Internet-Accessible Systems): critical 15, high 30 days */
export const SLA_DAYS: Record<"critical" | "high", number> = { critical: 15, high: 30 };
export const REMEDIATION_WINDOW_DAYS = 90;
export const EXCEPTION_WINDOW_DAYS = 14;
const DAY = 86_400_000;

/** open or in progress, critical or high */
export const isPrioritized = (i: QueueItem) => (i.status === "open" || i.status === "inProgress") && (i.sev === "critical" || i.sev === "high");

export function byPath(items: QueueItem[]): Array<{ type: PathType; n: number; critical: number }> {
  return PATH_ORDER.map((type) => {
    const of = items.filter((i) => i.pathType === type);
    return { type, n: of.length, critical: of.filter((i) => i.sev === "critical").length };
  });
}

export type ExposureStages = {
  prioritized: QueueItem[];
  validated: QueueItem[];
  remediation: {
    resolved: number;
    notDetected: number;
    inProgress: number;
    assigned: number;
    /** null = nothing prioritized (no rate to give) */
    assignmentRate: number | null;
    sla: { within: number; overdue: number; unknown: number; rate: number | null; overdueItems: Array<{ item: QueueItem; days: number; limit: number }> };
    exceptions: number;
  };
};

export function stages(queue: IssueQueue, states: Record<string, IssueState>, sightings: Record<string, IssueSighting> | null, now: Date): ExposureStages {
  const prioritized = queue.items.filter(isPrioritized);
  const validated = prioritized.filter((i) => i.evidence === "obs");
  const since = (days: number) => now.getTime() - days * DAY;
  let resolved = 0, exceptions = 0;
  for (const st of Object.values(states)) {
    if (st.history.some((h) => h.status === "resolved" && Date.parse(h.at) >= since(REMEDIATION_WINDOW_DAYS))) resolved++;
    exceptions += st.history.filter((h) => h.status === "accepted" && Date.parse(h.at) >= since(EXCEPTION_WINDOW_DAYS)).length;
  }
  const assigned = prioritized.filter((i) => !!i.stored?.assignee).length;
  let within = 0, overdue = 0, unknown = 0;
  const overdueItems: ExposureStages["remediation"]["sla"]["overdueItems"] = [];
  for (const i of prioritized) {
    const s = sightings?.[i.key];
    if (!s) { unknown++; continue; }
    const days = Math.floor((now.getTime() - Date.parse(s.first)) / DAY);
    const limit = SLA_DAYS[i.sev as "critical" | "high"];
    if (days > limit) { overdue++; overdueItems.push({ item: i, days, limit }); } else within++;
  }
  overdueItems.sort((a, b) => b.days - b.limit - (a.days - a.limit));
  return {
    prioritized, validated,
    remediation: {
      resolved, notDetected: queue.notDetected, inProgress: prioritized.filter((i) => i.status === "inProgress").length,
      assigned, assignmentRate: prioritized.length ? assigned / prioritized.length : null,
      sla: { within, overdue, unknown, rate: within + overdue ? within / (within + overdue) : null, overdueItems },
      exceptions,
    },
  };
}

/**
 * The funnel's band heights (log scale — 11,448 findings and 3 validated must both be visible): 0..1, the largest = 1,
 * 0 = a hairline. null (not known) = no band.
 */
export function funnelHeights(values: Array<number | null>): Array<number | null> {
  const known = values.filter((v): v is number => v !== null);
  const top = Math.log10(1 + Math.max(1, ...known));
  return values.map((v) => (v === null ? null : Math.log10(1 + v) / top));
}
