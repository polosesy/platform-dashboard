// 사례·런북 › 증거 스냅샷 (docs/architecture/ops-knowledge.md §10 C — Rundeck / PagerDuty automated diagnostics, read
// only): when a case starts, what the platform can read about its scope is fixed into the case — the changes near its
// time, the workload's pods (phase, restarts, the last termination reason), its Warning events with messages, and the
// log ERROR / WARN counts. Nothing is run or written in the cluster; every section says ok · failed · notAllowed ·
// empty · notApplicable (a section not read is never "nothing"). Lines are masked like every case text.

import * as k8s from "@kubernetes/client-node";
import type { OpsChangesResponse, OpsEvidence, OpsEvidenceSection, OpsScope } from "@aud/types";
import type { Env } from "../env.js";
import { safeMessage } from "../infra/requestParams.js";
import { withK8sRetry } from "../infra/k8sRetry.js";
import { podLogNamespaceAllowed } from "./aksAccess.js";
import { loadKubeConfig } from "./kubernetes.js";
import { listWarningEvents } from "./kubeEvents.js";
import { getLogInsights } from "./lokiLogs.js";
import { redactLogText } from "./logRedaction.js";
import { getChanges, ownedBy } from "./opsChanges.js";

const MAX_LINES = 40;
const belongs = ownedBy;
const mask = (lines: string[]) => lines.slice(0, MAX_LINES).map((l) => redactLogText(l.slice(0, 400)).text);

/** Pure: the changes section from a correlation */
export function changeLines(c: OpsChangesResponse): OpsEvidenceSection {
  const unread = Object.entries(c.sources).filter(([, s]) => s !== "ok").map(([k, s]) => `${k}: ${s}`);
  const lines = c.changes.map((x) => `${x.minutesBefore >= 0 ? `-${x.minutesBefore}` : `+${-x.minutesBefore}`}m [${x.kind}] ${x.title}${x.detail ? ` — ${x.detail}` : ""} (${x.match})`);
  return {
    kind: "changes",
    state: Object.values(c.sources).every((s) => s === "failed") ? "failed" : lines.length ? "ok" : unread.length ? "failed" : "empty",
    lines: mask(lines),
    note: `${c.windowMinutes}m before → 10m after${unread.length ? ` · not read: ${unread.join(", ")}` : ""}`,
  };
}

type PodLike = { metadata?: { name?: string }; status?: { phase?: string; containerStatuses?: Array<{ name?: string; ready?: boolean; restartCount?: number; lastState?: { terminated?: { reason?: string; exitCode?: number; finishedAt?: Date | string } }; state?: { waiting?: { reason?: string } } }> } };

/** Pure: one line per pod of the workload — phase, ready containers, restarts, waiting / last termination reasons */
export function podLines(pods: PodLike[], workload: string): string[] {
  return pods.filter((p) => belongs(p.metadata?.name ?? "", workload)).map((p) => {
    const cs = p.status?.containerStatuses ?? [];
    const ready = cs.filter((c) => c.ready).length;
    const restarts = cs.reduce((n, c) => n + (c.restartCount ?? 0), 0);
    const waiting = cs.map((c) => c.state?.waiting?.reason).filter(Boolean);
    const last = cs.map((c) => c.lastState?.terminated).filter((t): t is NonNullable<typeof t> => !!t)
      .map((t) => `${t.reason ?? "?"}(exit ${t.exitCode ?? "?"})${t.finishedAt ? ` at ${new Date(t.finishedAt).toISOString()}` : ""}`);
    return `${p.metadata?.name} ${p.status?.phase ?? "?"} ready ${ready}/${cs.length} restarts ${restarts}${waiting.length ? ` waiting ${waiting.join(",")}` : ""}${last.length ? ` last ${last.join("; ")}` : ""}`;
  });
}

export type EvidenceDeps = {
  changes?: typeof getChanges;
  pods?: (env: Env, bearer: string, clusterId: string, namespace: string) => Promise<PodLike[]>;
  events?: typeof listWarningEvents;
  logs?: typeof getLogInsights;
};

async function listPods(env: Env, bearer: string, clusterId: string, namespace: string): Promise<PodLike[]> {
  const kc = await loadKubeConfig(env, bearer, clusterId);
  const core = kc.makeApiClient(k8s.CoreV1Api);
  const r = await withK8sRetry(() => core.listNamespacedPod({ namespace, limit: 500 }));
  return (r.items ?? []) as PodLike[];
}

/** Read every section for a case's scope and time (operator — log counts only where pod logs may be read) */
export async function takeEvidence(env: Env, bearer: string, scope: OpsScope, at: string, by: string | undefined, deps: EvidenceDeps = {}): Promise<OpsEvidence> {
  const sections: OpsEvidenceSection[] = [];
  const ns = scope.namespace, wl = scope.workload;
  const clusterId = scope.clusterId!;
  const sec = async (kind: OpsEvidenceSection["kind"], applicable: boolean, fn: () => Promise<OpsEvidenceSection>) => {
    if (!applicable) { sections.push({ kind, state: "notApplicable", lines: [] }); return; }
    try { sections.push(await fn()); } catch (e) { sections.push({ kind, state: "failed", lines: [], note: safeMessage(e).slice(0, 200) }); }
  };
  await sec("changes", true, async () => changeLines(await (deps.changes ?? getChanges)(env, bearer, clusterId, at, { ...(ns ? { namespace: ns } : {}), ...(wl ? { workload: wl } : {}) })));
  await sec("pods", !!ns && !!wl, async () => {
    const lines = podLines(await (deps.pods ?? listPods)(env, bearer, clusterId, ns!), wl!);
    return { kind: "pods", state: lines.length ? "ok" : "empty", lines: mask(lines), note: "now (pods are read when the snapshot is taken)" };
  });
  await sec("events", !!ns, async () => {
    const r = await (deps.events ?? listWarningEvents)(env, bearer, clusterId, { namespace: ns!, ...(wl ? { workload: wl } : {}), messages: true, limit: 200 });
    const lines = r.events.map((e) => `${e.time} ${e.reason} ${e.kind}/${e.name} ×${e.count}${e.message ? ` — ${e.message}` : ""}`);
    return { kind: "events", state: lines.length ? "ok" : "empty", lines: mask(lines), note: "Warning events Kubernetes still keeps (about an hour)" };
  });
  await sec("logErrors", !!ns, async () => {
    if (!podLogNamespaceAllowed(env, clusterId, ns!)) return { kind: "logErrors", state: "notAllowed", lines: [], note: "aks.podLogNamespaces" };
    const t = Date.parse(at);
    const r = await (deps.logs ?? getLogInsights)(env, bearer, clusterId, { namespace: ns!, ...(wl ? { workload: wl } : {}), minutes: 60, ...(Date.now() - t > 5 * 60_000 ? { at: Math.min(Date.now(), t + 10 * 60_000) } : {}) });
    if (r.state !== "ok") return { kind: "logErrors", state: "failed", lines: [], note: `Loki ${r.state}` };
    const lines = [
      `ERROR ${r.errors ?? "?"} · WARN ${r.warns ?? "?"} (${r.windowMinutes}m)`,
      ...r.services.slice(0, 10).map((s) => `${s.workload}: ERROR ${s.errors} · WARN ${s.warns}`),
      ...(r.exceptions ?? []).slice(0, 10).map((x) => `${x.workload} ${x.cls} ×${x.count}`),
    ];
    return { kind: "logErrors", state: "ok", lines: mask(lines) };
  });
  return {
    takenAt: new Date().toISOString(), ...(by ? { takenBy: by } : {}), at,
    scope: { ...(scope.clusterName ? { clusterName: scope.clusterName } : {}), ...(ns ? { namespace: ns } : {}), ...(wl ? { workload: wl } : {}) },
    sections,
  };
}
