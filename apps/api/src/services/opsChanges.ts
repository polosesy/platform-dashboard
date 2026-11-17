// 사례·런북 › 변경 상관 (docs/architecture/ops-knowledge.md §10 B — PagerDuty Change Correlation, without its
// probability): the changes near an incident's time in its cluster, each with why it is listed. Three sources this
// platform already reads, read again here for the incident's moment:
//   rollout          a Deployment's new ReplicaSet (services/rollouts.ts — kube-state-metrics in the workspace)
//   nodeMaintenance  an AKS node upgrade / update episode (services/nodeMaintenance.ts — Activity Log + node facts)
//   warningEvent     a Kubernetes Warning event (services/kubeEvents.ts — AKS keeps about an hour: an older incident
//                    says "expired", never "none")
// Ranked by scope (same workload → same namespace → the cluster's nodes), then by time — a list of facts, not a cause.

import type { KubeEvent, NodeMaintEpisode, OpsChange, OpsChangesResponse, Rollout } from "@aud/types";
import type { Env } from "../env.js";
import { safeMessage } from "../infra/requestParams.js";
import { getRollouts } from "./rollouts.js";
import { getNodeMaintenance } from "./nodeMaintenance.js";
import { listWarningEvents } from "./kubeEvents.js";

/** Before the incident; a change a little after it (the incident's own start is rounded) still counts */
export const WINDOW_MIN = 120;
export const AFTER_MIN = 10;
/** AKS keeps events about an hour — older incidents can't be checked for them */
export const EVENT_TTL_MIN = 60;
const MAX_CHANGES = 30;

const MATCH_RANK = { workload: 0, namespace: 1, cluster: 2 } as const;
/**
 * Pure: a Kubernetes object named for the workload — itself, its ReplicaSet (`<wl>-<hash>`), a Deployment pod
 * (`<wl>-<hash>-<5>`), a StatefulSet pod (`<wl>-<n>`), a DaemonSet / Job pod (`<wl>-<5>`). A bare prefix is not enough:
 * `orders-db-0` is the orders-db StatefulSet, not orders
 */
export function ownedBy(name: string, workload: string): boolean {
  if (name === workload) return true;
  if (!name.startsWith(`${workload}-`)) return false;
  const rest = name.slice(workload.length + 1);
  // Kubernetes' generated suffixes use "bcdfghjklmnpqrstvwxz2456789" (no vowels, no 0 1 3) — a word like "db" or
  // "worker" is another workload's name
  return /^[bcdfghjklmnpqrstvwxz2456789]{5,10}(-[bcdfghjklmnpqrstvwxz2456789]{5})?$/.test(rest) || /^\d+$/.test(rest);
}
const belongs = ownedBy;

/** Pure: the changes in [at − window, at + after] that touch the scope, nearest scope first then nearest time */
export function correlateChanges(input: {
  at: string; scope: { namespace?: string; workload?: string };
  rollouts: Rollout[] | null; episodes: NodeMaintEpisode[] | null; events: KubeEvent[] | null; now?: Date;
}, windowMin = WINDOW_MIN): { changes: OpsChange[]; counts: OpsChangesResponse["counts"] } {
  const t = Date.parse(input.at);
  const from = t - windowMin * 60_000, to = t + AFTER_MIN * 60_000;
  const now = (input.now ?? new Date()).getTime();
  const minutes = (iso: string) => Math.round((t - Date.parse(iso)) / 60_000);
  const { namespace: ns, workload: wl } = input.scope;
  const out: OpsChange[] = [];
  for (const r of input.rollouts ?? []) {
    const at = Date.parse(r.at);
    if (at < from || at > to) continue;
    const match = ns && r.namespace === ns ? (wl && r.deployment === wl ? "workload" : "namespace") : !ns ? "cluster" : null;
    if (!match) continue;
    const img = r.images.map((i) => i.image.split("/").pop()).join(", ");
    out.push({ kind: "rollout", at: r.at, title: `${r.namespace}/${r.deployment}`, ...(img ? { detail: img } : {}), match, minutesBefore: minutes(r.at) });
  }
  for (const e of input.episodes ?? []) {
    const start = Date.parse(e.start), end = e.end ? Date.parse(e.end) : now;
    if (start > to || end < from) continue;
    out.push({
      kind: "nodeMaintenance", at: e.start, end: e.end, title: `${e.kind} · ${e.pools.join(", ") || "—"}`,
      detail: `${e.status} · ${e.initiator}${e.podsRestarted !== null ? ` · pods restarted ${e.podsRestarted}` : ""}`, match: "cluster", minutesBefore: minutes(e.start),
    });
  }
  // events: one line per (object, reason), its last time inside the window
  for (const e of input.events ?? []) {
    const last = Date.parse(e.time), first = Date.parse(e.firstTime ?? e.time);
    if (first > to || last < from) continue;
    const match = ns && e.namespace === ns ? (wl && belongs(e.name, wl) ? "workload" : "namespace") : !ns ? "cluster" : null;
    if (!match) continue;
    const at = new Date(Math.min(last, to)).toISOString();
    out.push({ kind: "warningEvent", at, title: `${e.reason} · ${e.kind}/${e.name}`, detail: `${e.namespace} · ×${e.count}${e.component ? ` · ${e.component}` : ""}`, match, minutesBefore: minutes(at) });
  }
  out.sort((a, b) => MATCH_RANK[a.match] - MATCH_RANK[b.match] || Math.abs(a.minutesBefore) - Math.abs(b.minutesBefore) || a.title.localeCompare(b.title));
  return {
    changes: out.slice(0, MAX_CHANGES),
    counts: { rollouts: out.filter((c) => c.kind === "rollout").length, nodeMaintenance: out.filter((c) => c.kind === "nodeMaintenance").length, warningEvents: out.filter((c) => c.kind === "warningEvent").length },
  };
}

export type ChangeDeps = {
  rollouts?: typeof getRollouts;
  maintenance?: typeof getNodeMaintenance;
  events?: typeof listWarningEvents;
};

/** Read the three sources for the incident's moment (each failure is its own state) and correlate */
export async function getChanges(env: Env, bearerToken: string, clusterId: string, at: string, scope: { namespace?: string; workload?: string }, deps: ChangeDeps = {}): Promise<OpsChangesResponse> {
  const t = Date.parse(at);
  const now = Date.now();
  const ageDays = (now - t) / 86_400_000;
  // a recent incident reads "now" (undefined — the sources' own cache); an older one ends 10 min after it, to the minute
  const end = t + AFTER_MIN * 60_000 >= now - 60_000 ? undefined : Math.floor((t + AFTER_MIN * 60_000) / 60_000) * 60_000;
  const read = async <T>(fn: () => Promise<T>): Promise<{ v: T | null; state: "ok" | "failed" }> => {
    try { return { v: await fn(), state: "ok" }; } catch { return { v: null, state: "failed" }; }
  };
  const [ro, mt, ev] = await Promise.all([
    ageDays > 7 ? Promise.resolve({ v: null, state: "notRead" as const })
      : read(() => (deps.rollouts ?? getRollouts)(env, bearerToken, clusterId, ageDays > 0.9 ? 7 : 1, end)),
    ageDays > 29 ? Promise.resolve({ v: null, state: "notRead" as const })
      : read(() => (deps.maintenance ?? getNodeMaintenance)(env, bearerToken, clusterId, Math.max(1, Math.ceil(ageDays + 0.2)), end)),
    (now - t) / 60_000 > EVENT_TTL_MIN + WINDOW_MIN ? Promise.resolve({ v: null, state: "expired" as const })
      : read(() => (deps.events ?? listWarningEvents)(env, bearerToken, clusterId, { ...(scope.namespace ? { namespace: scope.namespace } : {}), messages: false, limit: 2000 })),
  ]);
  const { changes, counts } = correlateChanges({ at, scope, rollouts: ro.v?.rollouts ?? null, episodes: mt.v?.episodes ?? null, events: ev.v?.events ?? null, now: new Date(now) });
  return {
    at, windowMinutes: WINDOW_MIN, scope,
    sources: {
      rollouts: ro.state === "ok" && ro.v && ro.v.metricsState !== "ok" ? "failed" : ro.state,
      nodeMaintenance: mt.state,
      warningEvents: ev.state,
    },
    changes, counts,
  };
}

export const changesError = (e: unknown) => safeMessage(e);
