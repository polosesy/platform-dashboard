// 사례·런북 — "have we seen this before?" (docs/architecture/ops-knowledge.md §4). Pure: no I/O, no model.
//
// Three things make two incidents alike, and every match says which:
//   signals — the same fact (OOMKilled, exit code 137, UNSUPPORTED_L3_PROTOCOL, AADSTS700016, an alert rule …), the
//             strongest evidence; pulled out of free text by extractSignals so pasted errors and stored cases meet
//   text    — TF-IDF cosine; Latin words, Hangul as two-letter pieces (Korean particles need no stemming then)
//   scope   — same workload / namespace / resource type / cluster
// score = 0.5 text + 0.35 (matched / asked signals) + 0.15 scope (+0.05 a resolved case that says how). Nothing
// that shares no signal, no scope and little text (< 0.15) is listed — a list of weak guesses hides the real one.

import type { OpsCase, OpsMatch, OpsMatchStrength, OpsRunbook, OpsScope, OpsSignal, OpsSignalKind, OpsSimilarRequest, OpsSimilarResponse } from "@aud/types";

const K8S_REASONS = [
  "OOMKilled", "CrashLoopBackOff", "ImagePullBackOff", "ErrImagePull", "FailedScheduling", "Evicted", "FailedMount", "FailedAttachVolume",
  "FailedCreatePodSandBox", "Unhealthy", "NodeNotReady", "BackOff", "FailedKillPod", "NetworkNotReady", "ContainerCannotRun", "DeadlineExceeded",
  "FailedPreStopHook", "ProbeError", "FailedSync", "InvalidImageName", "CreateContainerConfigError", "Preempting", "NodeHasDiskPressure",
  "NodeHasMemoryPressure", "Rebooted", "OOMKilling",
];
const K8S_SET = new Map(K8S_REASONS.map((r) => [r.toLowerCase(), r]));
/** Cilium / Hubble drop reasons are UPPER_SNAKE — the ones operators meet; any other UPPER_SNAKE word is an error code */
const DROP_REASONS = new Set([
  "POLICY_DENIED", "POLICY_DENY", "AUTH_REQUIRED", "UNSUPPORTED_L3_PROTOCOL", "CT_MAP_INSERTION_FAILED", "STALE_OR_UNROUTABLE_IP",
  "SERVICE_BACKEND_NOT_FOUND", "INVALID_SOURCE_IP", "FIB_LOOKUP_FAILED", "UNKNOWN_L3_TARGET_ADDRESS", "DROP_EP_NOT_READY", "DROP_HOST_NOT_READY",
  "NO_TUNNEL_OR_ENCAPSULATION_ENDPOINT", "TTL_EXCEEDED", "DROP_RATE_LIMITED", "CT_TRUNCATED_OR_INVALID_HEADER", "INVALID_IDENTITY",
]);

const norm = (s: string) => s.trim().toLowerCase();
export const signalKey = (s: OpsSignal) => `${s.kind}:${norm(s.value)}`;

/** Pure: the facts in a free text (an error, a log line, an alert) — deduplicated, in order of appearance */
export function extractSignals(text: string): OpsSignal[] {
  const out: OpsSignal[] = [];
  const seen = new Set<string>();
  const add = (kind: OpsSignalKind, value: string) => {
    const s = { kind, value: value.trim() };
    const k = signalKey(s);
    if (s.value && !seen.has(k) && out.length < 20) { seen.add(k); out.push(s); }
  };
  if (!text) return out;
  const t = text.slice(0, 20_000);
  for (const m of t.matchAll(/\b[A-Za-z][A-Za-z]{4,30}\b/g)) { const r = K8S_SET.get(m[0].toLowerCase()); if (r) add("k8sReason", r); }
  for (const m of t.matchAll(/\bexit(?:ed)?\s*(?:code|status)?\s*[:=]?\s*(\d{1,3})\b/gi)) add("exitCode", m[1]!);
  for (const m of t.matchAll(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){1,}\b/g)) add(DROP_REASONS.has(m[0]) ? "dropReason" : "errorCode", m[0]);
  for (const m of t.matchAll(/\bAADSTS\d{5,7}\b/g)) add("errorCode", m[0]);
  for (const m of t.matchAll(/\b(?:HTTP|status(?:\s*code)?)\s*[:=]?\s*([45]\d\d)\b/gi)) add("httpStatus", m[1]!);
  for (const m of t.matchAll(/\b([45]\d\d)\s+(?:Bad Gateway|Service Unavailable|Gateway Timeout|Internal Server Error|Too Many Requests|Forbidden|Unauthorized|Not Found)\b/gi)) add("httpStatus", m[1]!);
  // Exceptions: the class name only (java.lang.OutOfMemoryError → OutOfMemoryError, System.TimeoutException → TimeoutException)
  for (const m of t.matchAll(/\b(?:[a-z][\w$]*\.)*([A-Z][A-Za-z0-9]{2,60}(?:Exception|Error))\b/g)) if (!/^HTTP/i.test(m[1]!)) add("exception", m[1]!);
  // Azure / ARM error codes in PascalCase (AuthorizationFailed, ResourceNotFound, QuotaExceeded, SubscriptionNotRegistered …)
  for (const m of t.matchAll(/\b[A-Z][a-z]+(?:[A-Z][a-z]+)*(?:Failed|NotFound|Exceeded|Denied|NotRegistered|Conflict|Throttled|Unavailable)\b/g)) {
    if (!K8S_SET.has(m[0].toLowerCase())) add("errorCode", m[0]);
  }
  // This platform's own error codes: snake_case with at least one underscore (hubble_ui_unsupported, aks_rbac_forbidden)
  for (const m of t.matchAll(/\b[a-z][a-z0-9]+(?:_[a-z0-9]+){1,6}\b/g)) if (m[0].length >= 8) add("errorCode", m[0]);
  // Azure resource types (Microsoft.ContainerService/managedClusters)
  for (const m of t.matchAll(/\bMicrosoft\.[A-Za-z]+\/[A-Za-z]+(?:\/[A-Za-z]+)?\b/g)) add("resourceType", m[0]);
  return out;
}

const STOP = new Set([
  "the", "and", "for", "with", "from", "this", "that", "was", "were", "are", "not", "but", "have", "has", "had", "you", "our", "its", "into", "then",
  "when", "what", "which", "will", "can", "all", "any", "out", "via", "per", "http", "https", "www", "com",
  "있습니다", "없습니다", "합니다", "했습니다", "됩니다", "되었습니다",
]);

/** Pure: words for the text similarity — Latin words (≥ 2 letters, numbers ≥ 3 digits), Hangul as two-letter pieces */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const m of (text || "").slice(0, 20_000).toLowerCase().matchAll(/[a-z][a-z0-9_.-]*[a-z0-9]|[0-9]{3,}|[가-힣]+/g)) {
    const w = m[0];
    if (/^[가-힣]/.test(w)) {
      if (w.length === 1) continue;
      if (STOP.has(w)) continue;
      for (let i = 0; i + 1 < w.length; i++) out.push(w.slice(i, i + 2));
    } else if (w.length >= 2 && !STOP.has(w)) out.push(w);
  }
  return out;
}

export const caseText = (c: Pick<OpsCase, "title" | "symptoms" | "cause" | "resolution" | "tags">) =>
  [c.title, c.title, c.symptoms, c.cause ?? "", c.resolution ?? "", c.tags.join(" ")].join("\n");
export const runbookText = (r: Pick<OpsRunbook, "title" | "when" | "tags" | "steps">) =>
  [r.title, r.title, r.when, r.tags.join(" "), ...r.steps.map((s) => `${s.title} ${s.detail ?? ""}`)].join("\n");

type Vec = Map<string, number>;
const tf = (words: string[]): Map<string, number> => { const m = new Map<string, number>(); for (const w of words) m.set(w, (m.get(w) ?? 0) + 1); return m; };

/** Pure: TF-IDF vectors over a set of documents (the query counts as one) */
function vectors(docs: string[][]): Vec[] {
  const df = new Map<string, number>();
  for (const d of docs) for (const w of new Set(d)) df.set(w, (df.get(w) ?? 0) + 1);
  const n = docs.length;
  return docs.map((d) => {
    const v: Vec = new Map();
    for (const [w, c] of tf(d)) v.set(w, (1 + Math.log(c)) * Math.log(1 + n / (df.get(w) ?? 1)));
    return v;
  });
}
function cosine(a: Vec, b: Vec): { score: number; terms: string[] } {
  let dot = 0, na = 0, nb = 0;
  const parts: Array<[string, number]> = [];
  for (const [w, x] of a) { na += x * x; const y = b.get(w); if (y) { dot += x * y; parts.push([w, x * y]); } }
  for (const y of b.values()) nb += y * y;
  if (!dot) return { score: 0, terms: [] };
  return { score: dot / Math.sqrt(na * nb), terms: parts.sort((p, q) => q[1] - p[1]).slice(0, 5).map(([w]) => w) };
}

/** Pure: how much two scopes overlap (0–1) and on what */
export function scopeOverlap(q: OpsScope | undefined, s: OpsScope | undefined): { score: number; on: string[] } {
  if (!q || !s) return { score: 0, on: [] };
  const eq = (a?: string, b?: string) => !!a && !!b && norm(a) === norm(b);
  const on: string[] = [];
  let score = 0;
  const sameNs = eq(q.namespace, s.namespace);
  if (sameNs && eq(q.workload, s.workload)) { score += 1; on.push("workload"); }
  else if (!q.namespace && eq(q.workload, s.workload)) { score += 0.8; on.push("workload"); }
  if (sameNs) { score += 0.5; on.push("namespace"); }
  if (eq(q.resourceType, s.resourceType)) { score += 0.4; on.push("resourceType"); }
  if ((q.clusterId && eq(q.clusterId, s.clusterId)) || (!q.clusterId && eq(q.clusterName, s.clusterName))) { score += 0.3; on.push("cluster"); }
  return { score: Math.min(1, score), on };
}

export const strengthOf = (score: number): OpsMatchStrength => (score >= 0.45 ? "strong" : score >= 0.25 ? "medium" : "weak");

type Item = { id: string; signals: OpsSignal[]; scope?: OpsScope; text: string; resolvedWithFix?: boolean };

/** Pure: the items like the query, best first (top `limit`), each with why */
export function rankSimilar(query: { text: string; signals: OpsSignal[]; scope?: OpsScope }, items: Item[], limit = 5): OpsMatch[] {
  if (!items.length) return [];
  const qWords = tokenize(query.text);
  const vecs = vectors([qWords, ...items.map((i) => tokenize(i.text))]);
  const qv = vecs[0]!;
  const qKeys = new Map(query.signals.map((s) => [signalKey(s), s]));
  const out: OpsMatch[] = [];
  items.forEach((it, i) => {
    const text = qWords.length ? cosine(qv, vecs[i + 1]!) : { score: 0, terms: [] };
    const own = new Set([...it.signals, ...extractSignals(it.text)].map(signalKey));
    const shared = [...qKeys].filter(([k]) => own.has(k)).map(([, s]) => s);
    const sig = qKeys.size ? shared.length / qKeys.size : 0;
    const sc = scopeOverlap(query.scope, it.scope);
    if (!shared.length && !sc.on.length && text.score < 0.15) return;
    const score = Math.round((0.5 * text.score + 0.35 * sig + 0.15 * sc.score + (it.resolvedWithFix ? 0.05 : 0)) * 1000) / 1000;
    out.push({ id: it.id, score, strength: strengthOf(score), why: { signals: shared, terms: text.terms, scope: sc.on } });
  });
  return out.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1)).slice(0, limit);
}

/** Pure: similar cases and runbooks + the experience helper (runbooks those cases used, and direct matches) */
export function findSimilar(req: OpsSimilarRequest, cases: OpsCase[], runbooks: OpsRunbook[]): OpsSimilarResponse {
  const text = (req.text ?? "").slice(0, 20_000);
  const extracted = [...(req.signals ?? []), ...extractSignals(text)].filter((s, i, a) => a.findIndex((x) => signalKey(x) === signalKey(s)) === i).slice(0, 20);
  const query = { text, signals: extracted, ...(req.scope ? { scope: req.scope } : {}) };
  const caseMatches = rankSimilar(query, cases.filter((c) => c.id !== req.exclude).map((c) => ({
    id: c.id, signals: c.signals, scope: c.scope, text: caseText(c), resolvedWithFix: c.status === "resolved" && !!c.resolution?.trim(),
  })));
  const rbMatches = rankSimilar(query, runbooks.map((r) => ({ id: r.id, signals: r.signals, text: runbookText(r) })));
  const known = new Set(runbooks.map((r) => r.id));
  const byId = new Map(cases.map((c) => [c.id, c]));
  const suggest = new Map<string, { runbookId: string; fromCases: string[]; direct: boolean; weight: number }>();
  for (const m of caseMatches) {
    for (const rid of byId.get(m.id)?.runbookIds ?? []) {
      if (!known.has(rid)) continue;
      const s = suggest.get(rid) ?? { runbookId: rid, fromCases: [], direct: false, weight: 0 };
      s.fromCases.push(m.id); s.weight += m.score;
      suggest.set(rid, s);
    }
  }
  for (const m of rbMatches) {
    const s = suggest.get(m.id) ?? { runbookId: m.id, fromCases: [], direct: false, weight: 0 };
    s.direct = true; s.weight += m.score;
    suggest.set(m.id, s);
  }
  const suggested = [...suggest.values()].sort((a, b) => b.weight - a.weight || (a.runbookId < b.runbookId ? -1 : 1)).slice(0, 3)
    .map(({ runbookId, fromCases, direct }) => ({ runbookId, fromCases, direct }));
  return { extracted, cases: caseMatches, runbooks: rbMatches, suggested };
}
