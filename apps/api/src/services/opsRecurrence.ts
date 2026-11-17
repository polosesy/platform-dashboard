// 사례·런북 › 재발 (docs/architecture/ops-knowledge.md §10) — the same alert rule on the same target, firing again.
// PagerDuty "Past Incidents" / incident.io "Related incidents", from facts only: every firing in the window, how long it
// took to resolve, what still fires, and which cases / runbooks the team wrote for it. No similarity score here — a
// group is an exact rule × target; text similarity stays in 찾기 (opsMatch).
//
// Sources (measured on stg 2026-11-17: 108 Azure Monitor alerts in 30 days → 30 groups, 15 fired 2+ times, one 30 times,
// 57 still "Fired"):
//   Azure Monitor  Alerts Management `alerts?timeRange=30d` (both Fired and Resolved — the live diagram reads Resolved for
//                  one day only), every page, per subscription the caller's role can use
//   alert centre   the dashboard's own inbox — Grafana / Alertmanager items only (Azure items arrive through the action
//                  group too: counting them again would double every Azure firing)

import { createHash } from "node:crypto";
import type { Env } from "../env.js";
import type { NotifyAlert, OpsCase, OpsRecurrenceGroup, OpsRecurrenceResponse, OpsRunbook, OpsSeverity } from "@aud/types";
import { CacheManager, cachePrefix } from "../infra/cacheManager.js";
import { defaultSubscriptions, getArmFetcher } from "../infra/azureClientFactory.js";
import { safeMessage } from "../infra/requestParams.js";
import { ALERTS_API_VERSION, type AzureAlert } from "./alertsCollector.js";

export const RECURRENCE_DAYS = [1, 7, 30] as const;
export type RecurrenceDays = (typeof RECURRENCE_DAYS)[number];
const MAX_PAGES = 20; // 250 per page — 5,000 alerts per subscription
const RECENT = 10;

/** One firing, whatever the source */
export type Firing = {
  source: OpsRecurrenceGroup["source"];
  rule: string;
  target: OpsRecurrenceGroup["target"];
  /** what identifies the target exactly (ARM id · namespace/workload) — hashed into the key, never sent */
  targetId: string;
  severity: OpsSeverity;
  at: string;
  resolvedAt?: string;
  firing: boolean;
};

const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
/** Pure: the group key — source + rule + exact target, hashed (no subscription or resource id leaves the API) */
export const recurrenceKey = (f: Pick<Firing, "source" | "rule" | "targetId">) =>
  `${f.source === "azureMonitor" ? "az" : "ac"}:${hash(`${f.rule.toLowerCase()}|${f.targetId.toLowerCase()}`)}`;

/** Azure Sev0 → sev1 … Sev4 → sev4 (the alert centre's mapping) */
const azureSev = (s: string): OpsSeverity => (["sev1", "sev1", "sev2", "sev3", "sev4"] as const)[Math.min(4, Number(/\d/.exec(s ?? "")?.[0] ?? 4))]!;

/** Pure: Azure Monitor alerts → firings */
export function azureFirings(alerts: AzureAlert[]): Firing[] {
  return alerts.map((a) => {
    const e = a.properties.essentials;
    const targetId = e.targetResource ?? "";
    const name = targetId.split("/").filter(Boolean).pop() ?? "";
    return {
      source: "azureMonitor" as const,
      rule: (e.alertRule ?? a.name).split("/").filter(Boolean).pop() ?? a.name,
      target: { name: name || "—", ...(e.targetResourceType ? { type: e.targetResourceType } : {}), ...(e.targetResourceGroup ? { resourceGroup: e.targetResourceGroup } : {}) },
      targetId,
      severity: azureSev(e.severity),
      at: e.startDateTime,
      ...(e.monitorConditionResolvedDateTime ? { resolvedAt: e.monitorConditionResolvedDateTime } : {}),
      // "Closed" by a person while the condition still holds is not firing on screen either — the Fired condition is
      firing: e.monitorCondition === "Fired" && e.alertState !== "Closed",
    };
  });
}

/** Pure: alert-centre items (Grafana / Alertmanager — not Azure, see the header) → firings, one per firing event */
export function centerFirings(items: NotifyAlert[]): Firing[] {
  const out: Firing[] = [];
  for (const a of items) {
    // Azure (counted from Azure Monitor itself) and the receiver's test alert are not firings of a rule here
    if (a.source === "azure-monitor" || a.source === "test") continue;
    const ns = a.target.namespace ?? "";
    const wl = a.target.workload ?? a.target.pod?.replace(/-[a-z0-9]{8,10}-[a-z0-9]{5}$/, "").replace(/-[a-z0-9]{5}$/, "") ?? a.target.resourceName ?? a.target.node ?? "";
    const base = {
      source: "alertCenter" as const, rule: a.rule,
      target: { name: wl || a.title.slice(0, 80) || "—", ...(ns ? { namespace: ns } : {}), ...(a.target.resourceType ? { type: a.target.resourceType } : {}) },
      targetId: `${a.target.cluster ?? ""}/${ns}/${wl}`, severity: a.severity,
    };
    // Each firing → the next resolved; no history (an old item) = the item's own start and end
    const events = [...(a.history ?? [])].sort((x, y) => (x.at < y.at ? -1 : 1));
    const starts = events.filter((e) => e.status === "firing");
    if (!starts.length) {
      out.push({ ...base, at: a.startsAt, ...(a.endsAt ? { resolvedAt: a.endsAt } : {}), firing: a.status === "firing" });
      continue;
    }
    starts.forEach((s, i) => {
      const end = events.find((e) => e.status === "resolved" && e.at >= s.at && (i + 1 >= starts.length || e.at <= starts[i + 1]!.at));
      out.push({ ...base, at: s.at, ...(end ? { resolvedAt: end.at } : {}), firing: !end && i === starts.length - 1 && a.status === "firing" });
    });
  }
  return out;
}

const SEV_RANK: Record<OpsSeverity, number> = { sev1: 1, sev2: 2, sev3: 3, sev4: 4 };
const median = (xs: number[]) => { const s = [...xs].sort((a, z) => a - z); return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2; };

/**
 * Pure: firings in the window → groups (most firings first), each with the cases written for it (recurrenceKey) and
 * the cases / runbooks that name its alert rule. `now` and `days` bound the window (a firing that started before it
 * is left out — the sources already filter, this keeps a test honest).
 */
export function recurrenceGroups(firings: Firing[], cases: OpsCase[], runbooks: OpsRunbook[], now: Date, days: number): { groups: OpsRecurrenceGroup[]; totals: OpsRecurrenceResponse["totals"] } {
  const since = now.getTime() - days * 86_400_000;
  const byKey = new Map<string, Firing[]>();
  for (const f of firings) {
    const t = Date.parse(f.at);
    if (!Number.isFinite(t) || t < since) continue;
    const k = recurrenceKey(f);
    const list = byKey.get(k) ?? [];
    list.push(f);
    byKey.set(k, list);
  }
  const ruleOf = (signals: Array<{ kind: string; value: string }>) => signals.filter((s) => s.kind === "alertRule").map((s) => s.value.toLowerCase());
  const groups: OpsRecurrenceGroup[] = [];
  for (const [key, list] of byKey) {
    list.sort((a, z) => (a.at < z.at ? 1 : -1));
    const first = list[list.length - 1]!, last = list[0]!;
    const firing = list.filter((f) => f.firing);
    const mins = list.filter((f) => f.resolvedAt).map((f) => (Date.parse(f.resolvedAt!) - Date.parse(f.at)) / 60_000).filter((m) => m >= 0);
    const rule = last.rule.toLowerCase();
    const linked = cases.filter((c) => c.recurrenceKey === key).map((c) => c.id);
    groups.push({
      key, source: last.source, rule: last.rule, target: last.target,
      severity: list.reduce<OpsSeverity>((w, f) => (SEV_RANK[f.severity] < SEV_RANK[w] ? f.severity : w), "sev4"),
      occurrences: list.length,
      firingNow: firing.length,
      ...(firing.length ? { firingSince: firing[firing.length - 1]!.at } : {}),
      firstAt: first.at, lastAt: last.at,
      resolveMinutes: mins.length ? { p50: Math.round(median(mins) * 10) / 10, max: Math.round(Math.max(...mins) * 10) / 10, n: mins.length } : null,
      recent: list.slice(0, RECENT).map((f) => ({ at: f.at, ...(f.resolvedAt ? { resolvedAt: f.resolvedAt } : {}) })),
      cases: { linked, rule: cases.filter((c) => !linked.includes(c.id) && ruleOf(c.signals).includes(rule)).map((c) => c.id) },
      runbooks: runbooks.filter((r) => ruleOf(r.signals).includes(rule)).map((r) => r.id),
    });
  }
  groups.sort((a, z) => z.occurrences - a.occurrences || z.firingNow - a.firingNow || (a.lastAt < z.lastAt ? 1 : -1) || (a.key < z.key ? -1 : 1));
  const recurring = groups.filter((g) => g.occurrences >= 2);
  return {
    groups,
    totals: {
      alerts: groups.reduce((n, g) => n + g.occurrences, 0),
      groups: groups.length,
      recurring: recurring.length,
      firingNow: groups.reduce((n, g) => n + g.firingNow, 0),
      recurringNoCase: recurring.filter((g) => !g.cases.linked.length && !g.cases.rule.length).length,
      recurringNoRunbook: recurring.filter((g) => !g.runbooks.length).length,
    },
  };
}

// ── Reading ──

/** Azure Monitor's window values (Alerts Management `timeRange`) */
const TIME_RANGE: Record<RecurrenceDays, string> = { 1: "1d", 7: "7d", 30: "30d" };
export const recurrenceUrl = (subscriptionId: string, days: RecurrenceDays) =>
  `https://management.azure.com/subscriptions/${subscriptionId}/providers/Microsoft.AlertsManagement/alerts` +
  `?api-version=${ALERTS_API_VERSION}&timeRange=${TIME_RANGE[days]}&pageCount=250&includeContext=false`;

/** Pure: whether permissions granted at subscription scope (inherited included) read alerts there */
export function readsAlertsWide(actions: string[], notActions: string[] = []): boolean {
  const hit = (list: string[]) => list.some((a) => /^\*$|^\*\/read$|^microsoft\.alertsmanagement\/(\*|alerts\/(\*|read))$/i.test(a));
  return hit(actions) && !notActions.some((a) => /^microsoft\.alertsmanagement\/(\*|alerts\/(\*|read))$/i.test(a));
}

async function subscriptionWideRead(arm: { fetchJson: <T>(url: string) => Promise<T> }, sub: string): Promise<boolean> {
  try {
    const p = await arm.fetchJson<{ value?: Array<{ actions?: string[]; notActions?: string[] }> }>(
      `https://management.azure.com/subscriptions/${sub}/providers/Microsoft.Authorization/permissions?api-version=2022-04-01`);
    return (p.value ?? []).some((x) => readsAlertsWide(x.actions ?? [], x.notActions ?? []));
  } catch {
    return true; // could not tell — the alerts themselves were read; do not claim a limit we did not see
  }
}

type RawRead = { firings: Firing[]; gaps: OpsRecurrenceResponse["gaps"]; read: number };
const rawCache = new CacheManager<RawRead>(50, 5 * 60_000);

/** Azure Monitor firings of the caller's subscriptions (5-minute cache; a failed subscription is a gap, not "none") */
export async function azureRecurrenceFirings(env: Env, bearerToken: string, days: RecurrenceDays): Promise<RawRead> {
  const key = `${cachePrefix(bearerToken)}:recurrence:${days}`;
  const hit = rawCache.get(key);
  if (hit) return hit;
  const subs = defaultSubscriptions(env, bearerToken);
  const arm = await getArmFetcher(env, bearerToken);
  const gaps: OpsRecurrenceResponse["gaps"] = [];
  let read = 0;
  const lists = await Promise.all(subs.map(async (sub, i) => {
    try {
      const out: AzureAlert[] = [];
      let url: string | undefined = recurrenceUrl(sub, days);
      for (let p = 0; url && p < MAX_PAGES; p++) {
        const page: { value?: AzureAlert[]; nextLink?: string } = await arm.fetchJson(url);
        out.push(...(page.value ?? []));
        url = page.nextLink;
      }
      if (url) gaps.push({ source: "azureMonitor", scope: `subscription ${i + 1}`, code: "truncated", reason: `more than ${MAX_PAGES * 250} alerts — the oldest were not read` });
      // Azure returns only the alerts on resources the caller can read: an identity with resource-group roles only sees
      // those groups' alerts — say so (never shown as the subscription's whole history)
      if (!(await subscriptionWideRead(arm, sub))) gaps.push({ source: "azureMonitor", scope: `subscription ${i + 1}`, code: "rgOnly", reason: "no subscription-wide read — only the resource groups this identity can read" });
      read++;
      return azureFirings(out);
    } catch (e: unknown) {
      gaps.push({ source: "azureMonitor", scope: `subscription ${i + 1}`, code: "failed", reason: safeMessage(e) });
      return [];
    }
  }));
  const r: RawRead = { firings: lists.flat(), gaps, read };
  if (!gaps.length) rawCache.set(key, r);
  return r;
}
