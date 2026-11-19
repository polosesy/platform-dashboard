// 모니터링 › 프로필 — continuous profiles read from Pyroscope THROUGH the customer's Azure Managed Grafana (like traces:
// Pyroscope in the cluster has no authentication of its own, so the dashboard never reads it directly; Grafana's
// datasource is the gate — the connection's identity needs Grafana Viewer and the connection opts in with
// `aks.observability.grafana.profiles` + a pyroscope datasource UID).
//
// Measured shapes (Grafana 12 · grafana-pyroscope-datasource, stg 2026-11-19, my Grafana Viewer token):
//   GET  <grafana>/api/datasources/uid/<uid>/resources/profileTypes?start&end → [{ id, label }]  (3: Java CPU itimer,
//        alloc_in_new_tlab bytes / objects)
//   GET  …/resources/labelNames?query={}&start&end → ["app_name","cluster","collector","jfr_event","namespace",
//        "pyroscope_spy","service_name"]  — no thread label: Datadog's thread timeline cannot be built from these
//   GET  …/resources/labelValues?label=<l>&query={}&start&end → ["javaspy"] · 16 service names
//   POST <grafana>/api/ds/query { from, to, queries: [{ queryType: "metrics", profileTypeId, labelSelector, groupBy }] }
//        → frames with fields [time, <type>] and the group labels on the value field (241 points / hour)
//   POST …                        { queryType: "profile", profileTypeId, labelSelector, maxNodes }
//        → one frame "response" (meta flamegraph): level · value · self · label (enum: config.type.enum.text) — 5,917 rows
// Function names are code, not data — no masking; the routes are operator-only like traces.

import type { Env } from "../env.js";
import type { ProfileCatalogResponse, ProfileKind, ProfileResponse, ProfileServiceRow, ProfileState, ProfileTree, ProfileTypeInfo } from "@aud/types";
import { CacheManager, cachePrefix } from "../infra/cacheManager.js";
import { clusterConnection, connectionToken, signinRequired } from "../infra/azureClientFactory.js";
import { credentialGroup } from "../infra/connectionRegistry.js";
import { HttpError, safeMessage } from "../infra/requestParams.js";
import { MANAGED_GRAFANA_SCOPE } from "./grafanaAlertPull.js";

export const PROFILE_MAX_NODES = 8192;
const TIMEOUT_MS = 25_000;
const DS_TYPE = "grafana-pyroscope-datasource";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

// ── pure ──

const SERVICE_RE = /^[\w.\-:/]{1,128}$/;
const NAMESPACE_RE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
const TYPE_RE = /^[\w.-]+(:[\w.-]+){4}$/;

/** Pure: a Pyroscope profile type ID → its parts and what it measures */
export function profileTypeOf(id: string): ProfileTypeInfo {
  const [name = "", sampleType = "", unit = ""] = id.split(":");
  const s = `${name}:${sampleType}`.toLowerCase();
  const kind: ProfileKind =
    /^process_cpu:|^cpu:/.test(s) ? "cpu"
    : /^wall:/.test(s) ? "wall"
    : /^memory:(alloc_in_new_tlab_bytes|alloc_space|alloc_outside_tlab_bytes|alloc_bytes)/.test(s) ? "allocBytes"
    : /^memory:(alloc_in_new_tlab_objects|alloc_objects|alloc_outside_tlab_objects|alloc_samples)/.test(s) ? "allocCount"
    : /^memory:(inuse_space|live_bytes|heap_bytes)/.test(s) ? "heapBytes"
    : /^memory:(inuse_objects|live_objects|heap_objects)/.test(s) ? "heapCount"
    : /^(mutex|lock):(delay|lock_time)/.test(s) ? "lockTime"
    : /^(mutex|lock):(contentions|lock_count)/.test(s) ? "lockCount"
    : /^block:delay/.test(s) ? "blockTime"
    : /^block:contentions/.test(s) ? "blockCount"
    : /^goroutines?:/.test(s) ? "goroutines"
    : /^exceptions?:/.test(s) ? "exceptions"
    : "other";
  return { id, name, sampleType, unit, kind };
}

/** pyroscope_spy → the language it profiles (the Pyroscope SDKs' and Alloy's spy names) */
const SPY_LANGUAGE: Record<string, string> = {
  javaspy: "java", gospy: "go", pyspy: "python", pyroscope_python: "python", rbspy: "ruby", nodespy: "nodejs",
  dotnetspy: "dotnet", phpspy: "php", ebpfspy: "ebpf", "grafana-agent.java": "java", rustspy: "rust",
};
export const languageOfSpy = (spy: string | null | undefined): string | null => (spy ? SPY_LANGUAGE[spy.toLowerCase()] ?? null : null);

/** Pure: Grafana's flamegraph frame (level · value · self · label enum) → a profile tree; null without one */
export function treeOfFrame(body: unknown, refId = "A"): ProfileTree | null {
  const frames = arr(obj(obj(obj(body)?.results)?.[refId])?.frames);
  for (const f of frames) {
    const schema = obj(obj(f)?.schema);
    const fields = arr(schema?.fields).map((x) => obj(x));
    const at = (n: string) => fields.findIndex((x) => x?.name === n);
    const [li, vi, si, ni] = [at("level"), at("value"), at("self"), at("label")];
    if ([li, vi, si, ni].some((i) => i < 0)) continue;
    const values = arr(obj(obj(f)?.data)?.values);
    const names = arr(obj(obj(obj(fields[ni]?.config)?.type)?.enum)?.text).map((x) => String(x));
    const num = (i: number) => arr(values[i]).map((x) => Number(x));
    const tree: ProfileTree = { level: num(li), value: num(vi), self: num(si), label: num(ni), names };
    const n = tree.level.length;
    if (!n || [tree.value, tree.self, tree.label].some((a) => a.length !== n)) return null;
    return tree;
  }
  return null;
}

/** Pure: Grafana's metric frames → one series per group (labels of the value field), points [ms, value] */
export function seriesOfFrames(body: unknown, refId = "A"): Array<{ labels: Record<string, string>; points: Array<{ t: number; v: number }> }> {
  const out: Array<{ labels: Record<string, string>; points: Array<{ t: number; v: number }> }> = [];
  for (const f of arr(obj(obj(obj(body)?.results)?.[refId])?.frames)) {
    const fields = arr(obj(obj(f)?.schema)?.fields).map((x) => obj(x));
    const ti = fields.findIndex((x) => x?.type === "time" || x?.name === "time");
    const vi = fields.findIndex((x, i) => i !== ti && x?.type === "number");
    if (ti < 0 || vi < 0) continue;
    const values = arr(obj(obj(f)?.data)?.values);
    const ts = arr(values[ti]).map(Number), vs = arr(values[vi]).map(Number);
    const labels = Object.fromEntries(Object.entries(obj(fields[vi]?.labels) ?? {}).map(([k, v]) => [k, String(v)]));
    out.push({ labels, points: ts.map((t, i) => ({ t, v: Number.isFinite(vs[i]!) ? vs[i]! : 0 })) });
  }
  return out;
}

/** Pure: the label selector of one service (validated names only — never escaped into the query) */
export function selectorOf(service: string, namespace?: string | null): string {
  if (!SERVICE_RE.test(service)) throw new HttpError(400, "invalid_service", "A service name: letters, digits, . - _ : /");
  if (namespace && !NAMESPACE_RE.test(namespace)) throw new HttpError(400, "invalid_namespace", "A Kubernetes namespace name");
  return namespace ? `{service_name="${service}", namespace="${namespace}"}` : `{service_name="${service}"}`;
}

// ── reading ──

type Setup = { endpoint: string; uid: string; token: () => Promise<string> };
type NotReady = { state: ProfileState; message: string };

function setup(env: Env, bearerToken: string | undefined, clusterId: string): Setup | NotReady {
  if (!bearerToken) throw signinRequired();
  const { connection } = clusterConnection(env, clusterId);
  const g = connection.aks?.observability?.grafana;
  if (!g || !g.profiles || !g.datasources.pyroscope) {
    return { state: "notConfigured", message: !g ? "no Grafana on this connection" : !g.datasources.pyroscope ? "no pyroscope datasource UID" : "profiles are not enabled (aks.observability.grafana.profiles)" };
  }
  if (credentialGroup(env, connection) === "delegated" || connection.mode === "lighthouse") {
    return { state: "unsupportedMode", message: "this connection mode has no app token for the customer's Grafana" };
  }
  return { endpoint: g.endpoint.replace(/\/+$/, ""), uid: g.datasources.pyroscope, token: () => connectionToken(env, bearerToken, connection, MANAGED_GRAFANA_SCOPE) };
}

async function grafana(s: Setup, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${s.endpoint}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${await s.token()}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: controller.signal,
    });
    const text = await res.text();
    let parsed: unknown = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    return { status: res.status, body: parsed };
  } finally {
    clearTimeout(timer);
  }
}

const stateOf = (status: number): ProfileState => (status === 401 || status === 403 ? "forbidden" : status === 404 ? "notFound" : "failed");
const failMessage = (status: number, body: unknown) =>
  status === 401 || status === 403 ? `Grafana ${status}: the connection's identity needs a Grafana role (Grafana Viewer) on this Grafana`
  : `Grafana ${status}${obj(body)?.message ? `: ${safeMessage(String(obj(body)!.message))}` : ""}`;
/** A query's own error (the datasource answered 200 / 400 with results.A.error) */
const queryError = (body: unknown, refId = "A"): string | null => {
  const e = obj(obj(obj(body)?.results)?.[refId])?.error;
  return typeof e === "string" && e ? safeMessage(e).replace(/https?:\/\/\S+/g, "<url>").replace(/\b\d{1,3}(\.\d{1,3}){3}(:\d+)?\b/g, "<address>") : null;
};

const spanOf = (minutes: number, at?: number) => {
  const end = (at ?? Math.floor(Date.now() / 1000)) * 1000;
  return { from: end - minutes * 60_000, to: end };
};

const catalogCache = new CacheManager<ProfileCatalogResponse>(30, 60_000);
const profileCache = new CacheManager<ProfileResponse>(60, 60_000);

/** The profile types, the services that sent each (with the window's totals) and the label names */
export async function getProfileCatalog(env: Env, bearerToken: string | undefined, clusterId: string, minutes: number, at?: number): Promise<ProfileCatalogResponse> {
  const s = setup(env, bearerToken, clusterId);
  const { from, to } = spanOf(minutes, at);
  const base: ProfileCatalogResponse = {
    clusterId, generatedAt: new Date().toISOString(), ...(at !== undefined ? { at: new Date(at * 1000).toISOString() } : {}),
    windowMinutes: minutes, state: "ok", types: [], services: [], labels: [],
  };
  if ("state" in s) return { ...base, state: s.state, message: s.message };
  const key = `${cachePrefix(bearerToken)}:profiles:${clusterId.toLowerCase()}:${minutes}:${at ?? Math.floor(to / 60_000)}`;
  const hit = catalogCache.get(key);
  if (hit) return hit;
  try {
    const res = (p: string) => grafana(s, `/api/datasources/uid/${encodeURIComponent(s.uid)}/resources/${p}`);
    const [types, labels] = await Promise.all([res(`profileTypes?start=${from}&end=${to}`), res(`labelNames?query=${encodeURIComponent("{}")}&start=${from}&end=${to}`)]);
    if (types.status !== 200) return { ...base, state: stateOf(types.status), message: failMessage(types.status, types.body) };
    const ids = arr(types.body).map((x) => String(obj(x)?.id ?? "")).filter((x) => TYPE_RE.test(x));
    const infos = ids.map(profileTypeOf);
    // per type: which services sent it, their totals — one metrics query per type, grouped by service · namespace · spy
    const queries = ids.map((id, i) => ({ refId: `T${i}`, datasource: { uid: s.uid, type: DS_TYPE }, queryType: "metrics", profileTypeId: id, labelSelector: "{}", groupBy: ["service_name", "namespace", "pyroscope_spy"] }));
    const m = queries.length ? await grafana(s, "/api/ds/query", { from: String(from), to: String(to), queries }) : { status: 200, body: {} };
    if (m.status !== 200) return { ...base, state: stateOf(m.status), message: failMessage(m.status, m.body) };
    const rows = new Map<string, ProfileServiceRow>();
    ids.forEach((id, i) => {
      for (const sr of seriesOfFrames(m.body, `T${i}`)) {
        const service = sr.labels.service_name;
        if (!service) continue;
        const ns = sr.labels.namespace ?? null;
        const k = `${ns ?? ""}/${service}`;
        const row = rows.get(k) ?? rows.set(k, { service, namespace: ns, spy: sr.labels.pyroscope_spy ?? null, language: languageOfSpy(sr.labels.pyroscope_spy), types: [] }).get(k)!;
        const total = sr.points.reduce((a, p) => a + p.v, 0);
        const t = row.types.find((x) => x.id === id);
        if (t) t.total += total; else row.types.push({ id, total });
      }
    });
    const out: ProfileCatalogResponse = {
      ...base, types: infos, labels: arr(labels.status === 200 ? labels.body : []).map(String),
      services: [...rows.values()].sort((a, b) => (a.service < b.service ? -1 : a.service > b.service ? 1 : 0)),
    };
    catalogCache.set(key, out);
    return out;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    return { ...base, state: "failed", message: e instanceof Error && e.name === "AbortError" ? "Grafana did not answer in time" : safeMessage(e instanceof Error ? e.message : String(e)) };
  }
}

/**
 * One service's profile of one type over [from, to] (epoch seconds) + its series over the page's range (the timeline
 * to pick the window on) + optionally a comparison window's tree.
 */
export async function getProfile(env: Env, bearerToken: string | undefined, clusterId: string, q: {
  service: string; namespace?: string | null; typeId: string; from: number; to: number;
  seriesFrom: number; seriesTo: number; compareFrom?: number; compareTo?: number; maxNodes?: number;
}): Promise<ProfileResponse> {
  if (!TYPE_RE.test(q.typeId)) throw new HttpError(400, "invalid_profile_type", "A Pyroscope profile type ID");
  const sel = selectorOf(q.service, q.namespace);
  for (const [a, b] of [[q.from, q.to], [q.seriesFrom, q.seriesTo], ...(q.compareFrom !== undefined ? [[q.compareFrom, q.compareTo ?? 0]] : [])] as Array<[number, number]>) {
    if (!(Number.isInteger(a) && Number.isInteger(b) && b > a && b - a <= 31 * 86400)) throw new HttpError(400, "invalid_window", "from < to, at most 31 days, epoch seconds");
  }
  const s = setup(env, bearerToken, clusterId);
  const info = profileTypeOf(q.typeId);
  const base: ProfileResponse = {
    clusterId, generatedAt: new Date().toISOString(), state: "ok", service: q.service, typeId: q.typeId, unit: info.unit,
    from: new Date(q.from * 1000).toISOString(), to: new Date(q.to * 1000).toISOString(), tree: null, total: null, series: null, stepSeconds: null,
  };
  if ("state" in s) return { ...base, state: s.state, message: s.message };
  const maxNodes = Math.min(Math.max(q.maxNodes ?? PROFILE_MAX_NODES, 256), 16384);
  const key = `${cachePrefix(bearerToken)}:profile:${clusterId.toLowerCase()}:${sel}:${q.typeId}:${q.from}:${q.to}:${q.seriesFrom}:${q.seriesTo}:${q.compareFrom ?? ""}:${q.compareTo ?? ""}:${maxNodes}`;
  const hit = profileCache.get(key);
  if (hit) return hit;
  const ds = { uid: s.uid, type: DS_TYPE };
  const prof = (from: number, to: number) => grafana(s, "/api/ds/query", { from: String(from * 1000), to: String(to * 1000), queries: [{ refId: "A", datasource: ds, queryType: "profile", profileTypeId: q.typeId, labelSelector: sel, groupBy: [], maxNodes }] });
  try {
    const [p, m, c] = await Promise.all([
      prof(q.from, q.to),
      grafana(s, "/api/ds/query", { from: String(q.seriesFrom * 1000), to: String(q.seriesTo * 1000), queries: [{ refId: "A", datasource: ds, queryType: "metrics", profileTypeId: q.typeId, labelSelector: sel, groupBy: [] }] }),
      q.compareFrom !== undefined && q.compareTo !== undefined ? prof(q.compareFrom, q.compareTo) : Promise.resolve(null),
    ]);
    if (p.status !== 200) return { ...base, state: stateOf(p.status), message: queryError(p.body) ?? failMessage(p.status, p.body) };
    const tree = treeOfFrame(p.body);
    const series = m.status === 200 ? seriesOfFrames(m.body)[0]?.points ?? [] : null;
    const step = series && series.length > 1 ? Math.round((series[1]!.t - series[0]!.t) / 1000) : null;
    const ctree = c && c.status === 200 ? treeOfFrame(c.body) : null;
    const out: ProfileResponse = {
      ...base, tree, total: tree ? tree.value[0] ?? 0 : null, series, stepSeconds: step,
      ...(c ? { compare: { from: new Date(q.compareFrom! * 1000).toISOString(), to: new Date(q.compareTo! * 1000).toISOString(), tree: ctree, total: ctree ? ctree.value[0] ?? 0 : null } } : {}),
    };
    profileCache.set(key, out);
    return out;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    return { ...base, state: "failed", message: e instanceof Error && e.name === "AbortError" ? "Grafana did not answer in time" : safeMessage(e instanceof Error ? e.message : String(e)) };
  }
}
