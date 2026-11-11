// AKS 모니터링 › K8s 이벤트 — `kubectl get events --field-selector type=Warning -A` as a screen (pure).
//
// Kubernetes has two types only (Normal · Warning) and no severity — so this view does not invent one. It groups by
// the event's own reason string (kubectl's REASON), explains the reasons kubelet / the scheduler / controllers are
// documented to emit (`KNOWN_REASONS` → i18n `ob.ev.why.<reason>`), and marks what is still happening: the last
// occurrence within RECENT_MS of the read. `count` accumulates since the first occurrence (a probe failing every 10 s
// keeps one event for days), so it is shown as "×n since …", never as "n in the last hour".

import type { KubeEvent } from "@aud/types";

/** Last occurrence this close to the read = still happening (kubelet repeats a failing probe every period, ≤ 5 min) */
export const RECENT_MS = 5 * 60_000;

/** Reasons with an explanation (ob.ev.why.*) — kubelet · scheduler · controller-manager · HPA · cloud provider */
export const KNOWN_REASONS = [
  "Unhealthy", "ProbeWarning", "BackOff", "Failed", "FailedScheduling", "FailedMount", "FailedAttachVolume",
  "FailedCreatePodSandBox", "OOMKilling", "Evicted", "FailedCreate", "FailedGetResourceMetric",
  "FailedComputeMetricsReplicas", "NodeNotReady", "FailedKillPod", "DNSConfigForming", "FailedToUpdateEndpoint",
  "SyncLoadBalancerFailed", "NetworkNotReady",
] as const;

const KNOWN = new Set<string>(KNOWN_REASONS);
export function knownReason(reason: string): boolean {
  return KNOWN.has(reason);
}

/** Platform namespaces (AKS add-ons, policy, CNI) — the same set the heatmap and policies call system; "" = cluster-scoped (Node) */
export function isSystemNamespace(ns: string): boolean {
  return !ns || /^(kube-|aks-|azure-|gatekeeper|calico|tigera|app-routing)/.test(ns);
}

const at = (iso: string | undefined): number => (iso ? Date.parse(iso) : NaN);

/** Still happening: the last occurrence within RECENT_MS of `now` (the read time — not the viewer's clock drift) */
export function isRecent(e: KubeEvent, now: number): boolean {
  const t = at(e.time);
  return Number.isFinite(t) && now - t <= RECENT_MS;
}

export type EventFilter = { namespace: string; reason: string; query: string; system: boolean; recentOnly: boolean };
export const NO_FILTER: EventFilter = { namespace: "", reason: "", query: "", system: true, recentOnly: false };

/** Everything but the reason (the reason chips count within the other filters) */
function passesBase(e: KubeEvent, f: EventFilter, now: number): boolean {
  if (!f.system && isSystemNamespace(e.namespace)) return false;
  if (f.namespace && e.namespace !== f.namespace) return false;
  if (f.recentOnly && !isRecent(e, now)) return false;
  const q = f.query.trim().toLowerCase();
  if (q && ![e.namespace, e.kind, e.name, e.reason, e.message ?? "", e.component ?? ""].some((x) => x.toLowerCase().includes(q))) return false;
  return true;
}

export function filterEvents(events: KubeEvent[], f: EventFilter, now: number): KubeEvent[] {
  return events.filter((e) => passesBase(e, f, now) && (!f.reason || e.reason === f.reason));
}

export type EventSort = "recent" | "count";
export function sortEvents(events: KubeEvent[], by: EventSort): KubeEvent[] {
  const recent = (a: KubeEvent, b: KubeEvent) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0);
  return [...events].sort(by === "count" ? (a, b) => b.count - a.count || recent(a, b) : recent);
}

export type EventSummary = {
  rows: number;
  /** distinct involved objects (kind/namespace/name) */
  objects: number;
  recent: number;
  namespaces: number;
  systemRows: number;
  /** reason → rows, most first (ties by name) — within every filter but the reason itself */
  reasons: { reason: string; rows: number; recent: number }[];
  /** namespace → rows, most first */
  byNamespace: { namespace: string; rows: number }[];
};

export function summarizeEvents(events: KubeEvent[], f: EventFilter, now: number): EventSummary {
  const base = events.filter((e) => passesBase(e, f, now));
  const shown = base.filter((e) => !f.reason || e.reason === f.reason);
  const reasons = new Map<string, { rows: number; recent: number }>();
  for (const e of base) {
    const r = reasons.get(e.reason) ?? { rows: 0, recent: 0 };
    r.rows++;
    if (isRecent(e, now)) r.recent++;
    reasons.set(e.reason, r);
  }
  const ns = new Map<string, number>();
  for (const e of shown) ns.set(e.namespace, (ns.get(e.namespace) ?? 0) + 1);
  const cmp = (a: [string, number], b: [string, number]) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  return {
    rows: shown.length,
    objects: new Set(shown.map((e) => `${e.kind}/${e.namespace}/${e.name}`)).size,
    recent: shown.filter((e) => isRecent(e, now)).length,
    namespaces: ns.size,
    systemRows: shown.filter((e) => isSystemNamespace(e.namespace)).length,
    reasons: [...reasons.entries()]
      .sort((a, b) => cmp([a[0], a[1].rows], [b[0], b[1].rows]))
      .map(([reason, v]) => ({ reason, ...v })),
    byNamespace: [...ns.entries()].sort(cmp).map(([namespace, rows]) => ({ namespace, rows })),
  };
}

/** Namespaces in the data for the picker (users first, then system, each by name) */
export function eventNamespaces(events: KubeEvent[]): { namespace: string; rows: number; system: boolean }[] {
  const m = new Map<string, number>();
  for (const e of events) m.set(e.namespace, (m.get(e.namespace) ?? 0) + 1);
  return [...m.entries()]
    .map(([namespace, rows]) => ({ namespace, rows, system: isSystemNamespace(namespace) }))
    .sort((a, b) => Number(a.system) - Number(b.system) || (a.namespace < b.namespace ? -1 : a.namespace > b.namespace ? 1 : 0));
}

/** One line of `kubectl get events` for copying: NAMESPACE  KIND/NAME  [REASON]  xN  MESSAGE */
export function eventLine(e: KubeEvent): string {
  return [e.namespace || "-", `${e.kind}/${e.name}`, `[${e.reason}]`, `x${e.count}`, e.message ?? ""].join("  ").trimEnd();
}

/** "n units ago" for Intl.RelativeTimeFormat — seconds under a minute, minutes under an hour, hours under a day, days */
export function agoParts(iso: string | undefined, now: number): { value: number; unit: "second" | "minute" | "hour" | "day" } | null {
  const t = at(iso);
  if (!Number.isFinite(t)) return null;
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return { value: -s, unit: "second" };
  if (s < 3600) return { value: -Math.floor(s / 60), unit: "minute" };
  if (s < 86400) return { value: -Math.floor(s / 3600), unit: "hour" };
  return { value: -Math.floor(s / 86400), unit: "day" };
}
