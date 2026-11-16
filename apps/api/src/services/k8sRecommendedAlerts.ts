// AKS 모니터링 › 경고 신호 — Microsoft's recommended Kubernetes alert rules (msRecommendedAlerts.ts, verbatim)
// evaluated against this cluster's Azure Monitor workspace: which fire now, which are clear, and which CANNOT fire here
// because a metric they read does not exist in the workspace (Dynatrace "Recommendations" / Grafana alert coverage).
//
// Why (stg 2026-11-16): Resource Graph showed 0 Prometheus rule groups for the cluster, and of the 30 rules, KubeJobFailed
// reads `kube_job_failed` — absent here (the workspace has `kube_job_status_failed`): enabled as shipped it would never
// fire. Quota rules need `kube_resourcequota` (absent), KubeClientErrors needs `rest_client_requests_total`.
//
// Rules:
// - The expression is Microsoft's. Only each `job="…"` matcher is replaced by the scope of that metric family in this
//   workspace (`group by (cluster, job, collector) (<metric>)` → pickScope: the cluster, and the job / collector when two
//   write the same family — summing both would double), and a metric with no job matcher gets the same scope.
// - "for": the condition must have held for the whole duration — `E and count_over_time(E[for:step]) >= for/step`
//   (1-minute steps, 5-minute steps beyond an hour). A rule firing here = it would be firing in Azure Monitor now.
// - A required metric missing = noData with its name (never "clear"); a metric only after `unless` is optional.
// - Nothing is judged by us: the severity is the template's.

import type { Env } from "../env.js";
import type { RecommendedAlertFiring, RecommendedAlertRule, RecommendedAlertsResponse, StackQueryGap } from "@aud/types";
import { CacheManager, cachePrefix } from "../infra/cacheManager.js";
import { getPrometheusFetcherAuto } from "../infra/azureClientFactory.js";
import { HttpError } from "../infra/requestParams.js";
import { resolvePrometheusTarget } from "./prometheusCollector.js";
import { metricsStateOf } from "./hubbleMetrics.js";
import { pickScope, scopeMatchers } from "./promScope.js";
import { runAll } from "./observabilityStack.js";
import { MS_RECOMMENDED_RULES, type MsRecommendedRule } from "./msRecommendedAlerts.js";

const QUERY_TIMEOUT_MS = 20_000;
const METRIC = /(?:kube|kubelet|container|node|rest_client)_[A-Za-z0-9_:]*/y;
const IDENT_CHAR = /[A-Za-z0-9_:]/;

/** Pure: the expression with quoted strings blanked (positions kept) — metric names never come from label values */
const blankQuotes = (e: string) => e.replace(/"(?:[^"\\]|\\.)*"/g, (m) => `"${" ".repeat(m.length - 2)}"`);

/** Pure: the metric names an expression reads, in order of first use */
export function metricsOf(expr: string): string[] {
  const e = blankQuotes(expr);
  const out: string[] = [];
  for (let i = 0; i < e.length; i++) {
    if (i > 0 && IDENT_CHAR.test(e[i - 1]!)) continue;
    METRIC.lastIndex = i;
    const m = METRIC.exec(e);
    if (!m) continue;
    // a function name or a label in by()/on() is not followed by these — but every metric here has an underscore prefix
    if (!out.includes(m[0])) out.push(m[0]);
    i += m[0].length - 1;
  }
  return out;
}

/** Pure: metrics read only after `unless` (their absence removes no result — optional) */
export function optionalMetricsOf(expr: string): string[] {
  const e = blankQuotes(expr);
  const at = e.search(/\bunless\b/);
  if (at < 0) return [];
  return metricsOf(expr).filter((m) => {
    const re = new RegExp(`(?<![A-Za-z0-9_:])${m}(?![A-Za-z0-9_:])`, "g");
    let first = -1;
    for (let x = re.exec(e); x; x = re.exec(e)) { first = x.index; break; }
    return first > at;
  });
}

/** Split a selector's inside on commas outside quotes */
function splitMatchers(inner: string): string[] {
  const out: string[] = [];
  let cur = "", q = false;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!;
    if (c === '"' && inner[i - 1] !== "\\") q = !q;
    if (c === "," && !q) { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/**
 * Pure: the expression with each metric selector scoped — every `job="…"` / `job=~"…"` removed, `scope(metric)` added
 * (e.g. `cluster="c",collector="alloy"`). Anything else is untouched.
 */
export function scopeExpression(expr: string, scope: (metric: string) => string): string {
  const blank = blankQuotes(expr);
  let out = "";
  let i = 0;
  while (i < expr.length) {
    const prevIdent = i > 0 && IDENT_CHAR.test(blank[i - 1]!);
    METRIC.lastIndex = i;
    const m = !prevIdent && blank[i] !== '"' ? METRIC.exec(blank) : null;
    if (!m || m.index !== i) { out += expr[i]; i++; continue; }
    const name = m[0];
    let j = i + name.length;
    let inner: string[] = [];
    const ws = /^\s*/.exec(expr.slice(j))![0];
    if (expr[j + ws.length] === "{") {
      // find the closing brace outside quotes
      let k = j + ws.length + 1, q = false;
      for (; k < expr.length; k++) { const c = expr[k]!; if (c === '"' && expr[k - 1] !== "\\") q = !q; if (c === "}" && !q) break; }
      inner = splitMatchers(expr.slice(j + ws.length + 1, k)).filter((x) => !/^job\s*=~?\s*"/.test(x));
      j = k + 1;
    }
    const sc = scope(name);
    const all = [...(sc ? [sc] : []), ...inner];
    out += all.length ? `${name}{${all.join(",")}}` : name;
    i = j;
  }
  return out;
}

/** Pure: the "for" check — the condition now AND true at every step of the duration */
export function forQuery(expr: string, forMinutes: number): string {
  const step = forMinutes <= 60 ? 1 : 5;
  const n = Math.max(1, Math.floor(forMinutes / step));
  return `(${expr}) and (count_over_time((${expr})[${forMinutes}m:${step}m]) >= ${n})`;
}

/** Labels that name the object a firing is about (kept in this order; the rest is dropped) */
const OBJECT_LABELS = ["namespace", "controller", "deployment", "statefulset", "daemonset", "horizontalpodautoscaler", "job_name", "persistentvolumeclaim", "persistentvolume", "pod", "container", "node", "instance", "mountpoint", "reason"];
export function objectOf(metric: Record<string, string>): Record<string, string> {
  const o: Record<string, string> = {};
  for (const k of OBJECT_LABELS) if (metric[k]) o[k] = metric[k]!;
  return o;
}

/** Pure: one rule's verdict from its scope facts and (when run) its result rows */
export function ruleVerdict(rule: MsRecommendedRule, present: ReadonlySet<string>, ambiguous: ReadonlySet<string>, rows: Array<{ metric: Record<string, string>; value: number }> | "failed" | null, reason?: string): RecommendedAlertRule {
  const metrics = metricsOf(rule.expression), optional = optionalMetricsOf(rule.expression);
  const required = metrics.filter((m) => !optional.includes(m));
  const missing = required.filter((m) => !present.has(m));
  const base = { alert: rule.alert, group: rule.group, severity: rule.severity, forMinutes: rule.forMinutes, metrics: required, original: rule.expression };
  if (missing.length) return { ...base, state: "noData", missing, firing: [] };
  const amb = required.filter((m) => ambiguous.has(m));
  if (amb.length) return { ...base, state: "ambiguous", missing: amb, firing: [] };
  if (rows === "failed") return { ...base, state: "failed", ...(reason ? { reason } : {}), firing: [] };
  if (rows === null) return { ...base, state: "failed", firing: [] };
  const firing: RecommendedAlertFiring[] = rows.map((r) => ({ object: objectOf(r.metric), value: Math.round(r.value * 1000) / 1000 }));
  return { ...base, state: firing.length ? "firing" : "clear", firing };
}

const cache = new CacheManager<RecommendedAlertsResponse>(30, 60_000);
const scopeCache = new CacheManager<Record<string, string | null | "ambiguous">>(30, 10 * 60_000);
const inflight = new Map<string, Promise<RecommendedAlertsResponse>>();

export async function getRecommendedAlerts(env: Env, bearerToken: string | undefined, clusterId: string, at?: number): Promise<RecommendedAlertsResponse> {
  const key = `${cachePrefix(bearerToken)}:msalerts:${clusterId.toLowerCase()}:${at ?? "now"}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const running = inflight.get(key);
  if (running) return running;
  const job = collect(env, bearerToken, clusterId, at).then((r) => {
    if (r.metricsState === "ok") cache.set(key, r, r.gaps?.length ? 15_000 : undefined);
    return r;
  }).finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

async function collect(env: Env, bearerToken: string | undefined, clusterId: string, at?: number): Promise<RecommendedAlertsResponse> {
  const base: RecommendedAlertsResponse = {
    clusterId, generatedAt: new Date().toISOString(), ...(at !== undefined ? { at: new Date(at * 1000).toISOString() } : {}),
    metricsState: "ok", source: "Azure/prometheus-collector recommendedMetricAlerts.json (2026-11-16)", rules: [],
  };
  const target = await resolvePrometheusTarget(env, bearerToken, clusterId);
  if (target.state !== "ok") return { ...base, metricsState: target.state, ...(target.message ? { message: target.message } : {}) };
  try {
    const fetcher = await getPrometheusFetcherAuto(env, bearerToken, clusterId);
    const time = at === undefined ? undefined : String(at);
    const aks = clusterId.split("/").pop() ?? "";
    // 1. Each metric family's scope in this workspace (presence + cluster / job / collector)
    const all = [...new Set(MS_RECOMMENDED_RULES.flatMap((r) => metricsOf(r.expression)))];
    const sKey = `${cachePrefix(bearerToken)}:msalerts-scope:${clusterId.toLowerCase()}`;
    let scopes = scopeCache.get(sKey);
    if (!scopes) {
      const run = await runAll(fetcher, target.endpoint, Object.fromEntries(all.map((m) => [m, `group by (cluster, job, collector) (${m})`])), 8, undefined, QUERY_TIMEOUT_MS);
      if (run.gaps.length === all.length) throw run.firstError;
      // A family with no series NOW may exist only while something happens (waiting_reason: only while a container
      // waits) — look back a day for those few before calling them absent (stg 2026-11-16: waiting_reason had no
      // series at that instant but is in the workspace; a day-long lookback on every family would be too costly)
      const quiet = all.filter((m) => !run.gaps.some((g) => g.query === m) && !(run.rows[m] ?? []).length);
      const back = quiet.length ? await runAll(fetcher, target.endpoint, Object.fromEntries(quiet.map((m) => [m, `group by (cluster, job, collector) (last_over_time(${m}[1d]))`])), 8, undefined, QUERY_TIMEOUT_MS) : null;
      scopes = {};
      const unknown = new Set([...run.gaps, ...(back?.gaps ?? [])].map((g) => g.query));
      for (const m of all) {
        if (unknown.has(m)) continue; // not read → not cached as absent
        const rows = (run.rows[m] ?? []).length ? run.rows[m]! : back?.rows[m] ?? [];
        const s = pickScope(rows.map((r) => ({ cluster: r.metric.cluster, job: r.metric.job, collector: r.metric.collector })), aks);
        scopes[m] = s === "ambiguous" ? "ambiguous" : s === null ? null : scopeMatchers(s);
      }
      if (!unknown.size) scopeCache.set(sKey, scopes);
    }
    const present = new Set(Object.entries(scopes).filter(([, v]) => v !== null && v !== "ambiguous").map(([k]) => k));
    const ambiguous = new Set(Object.entries(scopes).filter(([, v]) => v === "ambiguous").map(([k]) => k));
    // 2. The rules that can run here
    const queries: Record<string, string> = {};
    const scoped: Record<string, string> = {};
    for (const r of MS_RECOMMENDED_RULES) {
      const v = ruleVerdict(r, present, ambiguous, []);
      if (v.state === "noData" || v.state === "ambiguous") continue;
      scoped[r.alert] = scopeExpression(r.expression, (m) => (typeof scopes![m] === "string" ? (scopes![m] as string) : ""));
      queries[r.alert] = forQuery(scoped[r.alert]!, r.forMinutes);
    }
    const run = await runAll(fetcher, target.endpoint, queries, 4, time, QUERY_TIMEOUT_MS);
    const gaps: StackQueryGap[] = run.gaps;
    const rules = MS_RECOMMENDED_RULES.map((r) => {
      const gap = gaps.find((g) => g.query === r.alert);
      const v = ruleVerdict(r, present, ambiguous, gap ? "failed" : (run.rows[r.alert] ?? []), gap?.reason);
      return scoped[r.alert] ? { ...v, expression: scoped[r.alert]! } : v;
    });
    return { ...base, rules, ...(gaps.length ? { gaps } : {}) };
  } catch (e) {
    if (e instanceof HttpError && e.code === "signin_required") throw e;
    const { state, message } = metricsStateOf(e);
    return { ...base, metricsState: state, message };
  }
}
