// 사례·런북 (/runbooks) — pure view helpers: the forms ↔ the API bodies, filters, the link an alert opens.
// Design: docs/architecture/ops-knowledge.md. Tested in apps/api/test/opsKnowledge.test.ts.

import type { NotifyAlert, OpsCase, OpsCaseStatus, OpsRunbook, OpsRunbookStep, OpsSeverity, OpsSignal } from "@aud/types";

export type CaseForm = {
  title: string; status: OpsCaseStatus; severity: OpsSeverity; occurredAt: string; symptoms: string; cause: string; resolution: string;
  lessons: string; tags: string; keywords: string; clusterId: string; clusterName: string; namespace: string; workload: string; resourceType: string;
  runbookIds: string[]; team: string; alertRule: string; sourceRef: string;
};
export type RunbookForm = { title: string; when: string; tags: string; keywords: string; steps: OpsRunbookStep[]; rollback: string; team: string; verifiedAt: string };

/** datetime-local value (local time, minutes) ↔ ISO */
export const toLocalInput = (iso: string) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const fromLocalInput = (v: string) => { const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString(); };

export const listOf = (s: string) => s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
const opt = (s: string) => (s.trim() ? s.trim() : undefined);

export function emptyCase(now: Date, prefill: Partial<CaseForm> = {}): CaseForm {
  return {
    title: "", status: "open", severity: "sev3", occurredAt: toLocalInput(now.toISOString()), symptoms: "", cause: "", resolution: "", lessons: "",
    tags: "", keywords: "", clusterId: "", clusterName: "", namespace: "", workload: "", resourceType: "", runbookIds: [], team: "", alertRule: "", sourceRef: "",
    ...prefill,
  };
}

export function caseForm(c: OpsCase): CaseForm {
  return {
    title: c.title, status: c.status, severity: c.severity, occurredAt: toLocalInput(c.occurredAt), symptoms: c.symptoms, cause: c.cause ?? "",
    resolution: c.resolution ?? "", lessons: c.lessons ?? "", tags: c.tags.join(", "),
    keywords: c.signals.filter((s) => s.kind === "keyword").map((s) => s.value).join(", "),
    clusterId: c.scope.clusterId ?? "", clusterName: c.scope.clusterName ?? "", namespace: c.scope.namespace ?? "", workload: c.scope.workload ?? "",
    resourceType: c.scope.resourceType ?? "", runbookIds: c.runbookIds, team: c.team ?? "",
    alertRule: c.signals.find((s) => s.kind === "alertRule")?.value ?? "", sourceRef: c.source?.kind === "alert" ? c.source.ref ?? "" : "",
  };
}

/** What a form is missing before it can be saved (i18n keys) — the API checks the same */
export function caseProblems(f: CaseForm): string[] {
  const out: string[] = [];
  if (!f.title.trim()) out.push("ops.kb.need.title");
  if (!f.symptoms.trim()) out.push("ops.kb.need.symptoms");
  if (!fromLocalInput(f.occurredAt)) out.push("ops.kb.need.occurredAt");
  if (f.status === "resolved" && !f.resolution.trim()) out.push("ops.kb.need.resolution");
  return out;
}

export function caseBody(f: CaseForm, baseRev: number | null) {
  const signals: OpsSignal[] = [
    ...(f.alertRule.trim() ? [{ kind: "alertRule" as const, value: f.alertRule.trim().slice(0, 120) }] : []),
    ...listOf(f.keywords).slice(0, 15).map((v) => ({ kind: "keyword" as const, value: v.slice(0, 120) })),
  ];
  const scope = Object.fromEntries(Object.entries({ clusterId: f.clusterId, clusterName: f.clusterName, namespace: f.namespace, workload: f.workload, resourceType: f.resourceType })
    .filter(([, v]) => v.trim()).map(([k, v]) => [k, v.trim()]));
  return {
    title: f.title.trim(), status: f.status, severity: f.severity, occurredAt: fromLocalInput(f.occurredAt) ?? new Date().toISOString(),
    symptoms: f.symptoms, ...(opt(f.cause) ? { cause: f.cause } : {}), ...(opt(f.resolution) ? { resolution: f.resolution } : {}),
    ...(opt(f.lessons) ? { lessons: f.lessons } : {}), tags: listOf(f.tags).slice(0, 12).map((t) => t.slice(0, 40)), signals, scope,
    runbookIds: f.runbookIds.slice(0, 10), ...(f.sourceRef ? { source: { kind: "alert" as const, ref: f.sourceRef.slice(0, 200) } } : { source: { kind: "manual" as const } }),
    ...(opt(f.team) ? { team: f.team.trim() } : {}), baseRev,
  };
}

export const emptyStep = (): OpsRunbookStep => ({ title: "", detail: "", command: "", check: "" });
export function emptyRunbook(prefill: Partial<RunbookForm> = {}): RunbookForm {
  return { title: "", when: "", tags: "", keywords: "", steps: [emptyStep()], rollback: "", team: "", verifiedAt: "", ...prefill };
}
export function runbookForm(r: OpsRunbook): RunbookForm {
  return {
    title: r.title, when: r.when, tags: r.tags.join(", "), keywords: r.signals.map((s) => s.value).join(", "),
    steps: r.steps.map((s) => ({ title: s.title, detail: s.detail ?? "", command: s.command ?? "", check: s.check ?? "" })),
    rollback: r.rollback ?? "", team: r.team ?? "", verifiedAt: r.verifiedAt ? toLocalInput(r.verifiedAt) : "",
  };
}
export function runbookProblems(f: RunbookForm): string[] {
  const out: string[] = [];
  if (!f.title.trim()) out.push("ops.kb.need.title");
  if (!f.when.trim()) out.push("ops.kb.need.when");
  if (!f.steps.some((s) => s.title.trim())) out.push("ops.kb.need.step");
  return out;
}
export function runbookBody(f: RunbookForm, baseRev: number | null) {
  const verified = f.verifiedAt ? fromLocalInput(f.verifiedAt) : null;
  return {
    title: f.title.trim(), when: f.when, signals: listOf(f.keywords).slice(0, 20).map((v) => ({ kind: "keyword" as const, value: v.slice(0, 120) })),
    tags: listOf(f.tags).slice(0, 12).map((t) => t.slice(0, 40)),
    steps: f.steps.filter((s) => s.title.trim()).slice(0, 30).map((s) => ({
      title: s.title.trim(), ...(opt(s.detail ?? "") ? { detail: s.detail } : {}), ...(opt(s.command ?? "") ? { command: s.command } : {}), ...(opt(s.check ?? "") ? { check: s.check } : {}),
    })),
    ...(opt(f.rollback) ? { rollback: f.rollback } : {}), ...(opt(f.team) ? { team: f.team.trim() } : {}), ...(verified ? { verifiedAt: verified } : {}), baseRev,
  };
}

/** Pure: cases matching a search (title · symptoms · cause · resolution · tags · scope) and a status, newest first */
export function filterCases(cases: OpsCase[], q: string, status: OpsCaseStatus | ""): OpsCase[] {
  const needle = q.trim().toLowerCase();
  return cases.filter((c) => (!status || c.status === status) && (!needle || [c.title, c.symptoms, c.cause, c.resolution, c.tags.join(" "),
    c.scope.namespace, c.scope.workload, c.scope.clusterName, ...c.signals.map((s) => s.value)].some((x) => x?.toLowerCase().includes(needle))));
}
export function filterRunbooks(runbooks: OpsRunbook[], q: string): OpsRunbook[] {
  const needle = q.trim().toLowerCase();
  return runbooks.filter((r) => !needle || [r.title, r.when, r.tags.join(" "), ...r.signals.map((s) => s.value), ...r.steps.map((s) => s.title)]
    .some((x) => x.toLowerCase().includes(needle)));
}

/** The first `n` characters of a text on one line (for lists) */
export const excerpt = (s: string | undefined, n = 160) => {
  const one = (s ?? "").replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

/** Pure: what an alert of the notification centre says, as the text to look for and the case to prefill */
export function alertSearch(a: Pick<NotifyAlert, "id" | "rule" | "title" | "summary" | "description" | "target">): { text: string; prefill: Record<string, string> } {
  const target = [a.target.namespace && `namespace ${a.target.namespace}`, a.target.workload && `workload ${a.target.workload}`, a.target.pod && `pod ${a.target.pod}`,
    a.target.resourceType, a.target.resourceName].filter(Boolean).join(" · ");
  const text = [a.title, a.rule, a.summary, a.description?.slice(0, 600), target].filter(Boolean).join("\n").slice(0, 1500);
  const prefill: Record<string, string> = { rule: a.rule.slice(0, 120), alert: a.id.slice(0, 200) };
  if (a.target.namespace) prefill.ns = a.target.namespace;
  if (a.target.workload) prefill.wl = a.target.workload;
  if (a.target.resourceType) prefill.rt = a.target.resourceType;
  return { text, prefill };
}

/** The /runbooks link for an alert: the find tab with the alert's text and scope */
export function alertFindHref(a: Parameters<typeof alertSearch>[0]): string {
  const { text, prefill } = alertSearch(a);
  return `/runbooks?${new URLSearchParams({ tab: "find", q: text, ...prefill }).toString()}`;
}
