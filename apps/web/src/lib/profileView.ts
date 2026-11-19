// 모니터링 › 프로필 — pure view model of a Pyroscope profile (API services/grafanaProfiles.ts) for Datadog's profile
// visualizations (docs.datadoghq.com/profiler/profile_visualizations): the flame graph, the top functions ("CPU time by
// Method"), the call graph (each function once; an edge's weight = time spent calling the callee — shown around one
// function: its callers and callees), one collection interval ("single profile") and a comparison of two windows.
// A profile is Pyroscope's nested set: depth-first rows, each a level, a total (value), a self value and a name.
// Every number here is the tree's own — measured on stg 2026-11-19: self values add up to the root, value = self +
// children for every node (0 of 6,503 off).
import type { ProfileKind, ProfileTree, ProfileTypeInfo } from "@aud/types";

// ── profile types (= API services/grafanaProfiles.ts profileTypeOf — the test keeps them equal) ──

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

// ── layout ──

export type FlameRect = { i: number; level: number; x: number; w: number; name: string; value: number; self: number };

/**
 * Pure: the flame graph's rectangles (x and w as fractions of the focused node, root = 0..1) — a node starts where its
 * previous sibling ended inside its parent. `focus` = a node index (zoomed in: it fills the width, its ancestors are
 * listed above, everything outside it is left out). Nodes narrower than `minW` are dropped (they would be < 1 px).
 */
export function flameRects(t: ProfileTree, focus = 0, minW = 0): { rects: FlameRect[]; ancestors: number[]; depth: number } {
  const n = t.level.length;
  if (!n) return { rects: [], ancestors: [], depth: 0 };
  // start offsets in the root's units: cursor[level] = where the next child of the current parent begins
  const x = new Array<number>(n);
  const cursor: number[] = [0];
  const parent = new Array<number>(n).fill(-1);
  const stack: number[] = [];
  for (let i = 0; i < n; i++) {
    const L = t.level[i]!;
    while (stack.length > L) stack.pop();
    parent[i] = stack.length ? stack[stack.length - 1]! : -1;
    x[i] = cursor[L] ?? 0;
    cursor[L] = x[i]! + t.value[i]!;
    cursor[L + 1] = x[i]!;
    stack.push(i);
  }
  const f = Math.min(Math.max(focus, 0), n - 1);
  const ancestors: number[] = [];
  for (let p = parent[f]!; p >= 0; p = parent[p]!) ancestors.unshift(p);
  const fx = x[f]!, fv = t.value[f]! || 1, fl = t.level[f]!;
  const rects: FlameRect[] = [];
  let depth = 0;
  // the focused node's subtree: the rows after it with a deeper level
  for (let i = f; i < n && (i === f || t.level[i]! > fl); i++) {
    const w = t.value[i]! / fv;
    if (w < minW) continue;
    const level = t.level[i]! - fl;
    depth = Math.max(depth, level + 1);
    rects.push({ i, level, x: (x[i]! - fx) / fv, w, name: t.names[t.label[i]!] ?? "", value: t.value[i]!, self: t.self[i]! });
  }
  return { rects, ancestors, depth };
}

// ── functions ──

export type FunctionRow = { name: string; self: number; total: number };

/**
 * Pure: per function — self = the sum of its nodes' self values; total = the sum of its nodes' values counted once
 * per call path (a node under an ancestor of the same name is already inside that ancestor's value — recursion is not
 * counted twice). Sorted by self, then total.
 */
export function topFunctions(t: ProfileTree): FunctionRow[] {
  const by = new Map<string, FunctionRow>();
  const stack: string[] = [];
  for (let i = 0; i < t.level.length; i++) {
    const L = t.level[i]!;
    stack.length = L;
    const name = t.names[t.label[i]!] ?? "";
    const r = by.get(name) ?? by.set(name, { name, self: 0, total: 0 }).get(name)!;
    r.self += t.self[i]!;
    if (!stack.includes(name)) r.total += t.value[i]!;
    stack.push(name);
  }
  // the synthetic root ("total") is not a function
  by.delete(t.names[t.label[0]!] ?? "total");
  return [...by.values()].sort((a, b) => b.self - a.self || b.total - a.total || (a.name < b.name ? -1 : 1));
}

export type CallEdge = { caller: string; callee: string; value: number };

/** Pure: the call graph's edges — caller → callee, weight = the callee nodes' values under that caller */
export function callEdges(t: ProfileTree): CallEdge[] {
  const by = new Map<string, CallEdge>();
  const stack: number[] = [];
  const root = t.names[t.label[0]!] ?? "total";
  for (let i = 0; i < t.level.length; i++) {
    const L = t.level[i]!;
    stack.length = L;
    const p = stack.length ? stack[stack.length - 1]! : -1;
    if (p >= 0) {
      const caller = t.names[t.label[p]!] ?? "", callee = t.names[t.label[i]!] ?? "";
      if (caller !== root) {
        const k = `${caller}\u0000${callee}`;
        const e = by.get(k) ?? by.set(k, { caller, callee, value: 0 }).get(k)!;
        e.value += t.value[i]!;
      }
    }
    stack.push(i);
  }
  return [...by.values()];
}

/** Pure: one function's neighbourhood — who calls it (and how much) and what it calls, heaviest first */
export function butterfly(edges: CallEdge[], fn: string, limit = 12): { callers: CallEdge[]; callees: CallEdge[]; moreCallers: number; moreCallees: number } {
  const callers = edges.filter((e) => e.callee === fn && e.caller !== fn).sort((a, b) => b.value - a.value);
  const callees = edges.filter((e) => e.caller === fn && e.callee !== fn).sort((a, b) => b.value - a.value);
  return { callers: callers.slice(0, limit), callees: callees.slice(0, limit), moreCallers: Math.max(0, callers.length - limit), moreCallees: Math.max(0, callees.length - limit) };
}

// ── comparison ──

/** Pure: each node's call path ("total;a;b") — the key that matches a node across two windows */
export function pathKeys(t: ProfileTree): string[] {
  const out: string[] = [];
  const stack: string[] = [];
  for (let i = 0; i < t.level.length; i++) {
    stack.length = t.level[i]!;
    stack.push(t.names[t.label[i]!] ?? "");
    out.push(stack.join(";"));
  }
  return out;
}

/**
 * Pure: per node of `a`, its share of `a`'s total minus the same path's share of `b`'s total (percentage points) —
 * shares, not raw values, so windows of different lengths compare; a path only in `a` is its whole share.
 */
export function shareDiff(a: ProfileTree, b: ProfileTree): number[] {
  const ta = a.value[0] || 1, tb = b.value[0] || 1;
  const bShare = new Map<string, number>();
  pathKeys(b).forEach((k, i) => bShare.set(k, (bShare.get(k) ?? 0) + b.value[i]! / tb));
  return pathKeys(a).map((k, i) => Math.round(((a.value[i]! / ta) - (bShare.get(k) ?? 0)) * 10000) / 100);
}

export type FunctionDiff = { name: string; selfA: number; selfB: number; deltaPp: number };
/** Pure: functions by the change of their self share (percentage points), largest change first */
export function functionDiff(a: ProfileTree, b: ProfileTree, limit = 30): FunctionDiff[] {
  const ta = a.value[0] || 1, tb = b.value[0] || 1;
  const fb = new Map(topFunctions(b).map((r) => [r.name, r.self]));
  const names = new Set([...topFunctions(a).map((r) => r.name), ...fb.keys()]);
  const fa = new Map(topFunctions(a).map((r) => [r.name, r.self]));
  return [...names].map((name) => {
    const selfA = fa.get(name) ?? 0, selfB = fb.get(name) ?? 0;
    return { name, selfA, selfB, deltaPp: Math.round((selfA / ta - selfB / tb) * 10000) / 100 };
  }).filter((d) => d.deltaPp !== 0).sort((x, y) => Math.abs(y.deltaPp) - Math.abs(x.deltaPp) || (x.name < y.name ? -1 : 1)).slice(0, limit);
}

// ── frames: a fact about the name, not a guess about the code ──

export type FrameKind = "native" | "runtime" | "code";
/** Pure: native (a shared object / the JVM / unknown), the language's own runtime library (JDK, Go runtime, CPython …), or code */
export function frameKind(name: string): FrameKind {
  if (/\.so(\.\d+)*\b|^\[|^libjvm|^lib[\w+-]+\.so|^\.\/|^\/usr\/|^unknown$/i.test(name)) return "native";
  if (/^(java|javax|jdk|sun|com\.sun)\.|^runtime\.|^(reflect|sync|syscall|internal\/)|^<frozen |^System\.|^Microsoft\.|^node:/.test(name)) return "runtime";
  return "code";
}
/** Pure: the short name shown in a narrow frame — the last segment (Class.method, pkg.func) */
export const shortName = (name: string) => {
  const m = /([\w$<>~-]+(?:\.[\w$<>~-]+)?)(\([^)]*\))?$/.exec(name);
  return m ? m[1]! : name;
};

// ── units ──

export type UnitText = { n: string; unit: string };
/** Pure: a profile value in its unit — ns → ms / s, bytes → KB … GB (1024), count → as is */
export function valueText(v: number, unit: string): UnitText {
  const r = (x: number) => (x >= 100 ? Math.round(x).toLocaleString("en-US") : x >= 10 ? x.toFixed(1) : x.toFixed(2));
  if (unit === "nanoseconds") {
    if (v >= 1e9) return { n: r(v / 1e9), unit: "s" };
    if (v >= 1e6) return { n: r(v / 1e6), unit: "ms" };
    return { n: r(v / 1e3), unit: "µs" };
  }
  if (unit === "bytes") {
    const u = ["B", "KB", "MB", "GB", "TB"];
    let i = 0, x = v;
    while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
    return { n: i ? r(x) : String(Math.round(x)), unit: u[i]! };
  }
  return { n: Math.round(v).toLocaleString("en-US"), unit: "" };
}
/**
 * Pure: what the series' values are (measured on stg — Grafana's Pyroscope datasource answers CPU as cores, bytes per
 * second, counts per step) and how to turn a series back into the window's total (Σ v × step × factor ≈ the root:
 * CPU 6.56 s vs 6.54 s, bytes 717.6 MB vs 716.5 MB, count 1,359 vs 1,357 — the edges of the window).
 */
export function seriesUnit(unit: string): { key: "cores" | "perSec" | "perStep"; toTotal: (sum: number, stepSeconds: number) => number } {
  if (unit === "nanoseconds") return { key: "cores", toTotal: (s, step) => s * step * 1e9 };
  if (unit === "bytes") return { key: "perSec", toTotal: (s, step) => s * step };
  return { key: "perStep", toTotal: (s) => s };
}

// ── Datadog's profile types per language (docs.datadoghq.com/profiler/profile_types, 2026-11-19) ──

export type LangKey = "java" | "go" | "python" | "ruby" | "nodejs" | "dotnet" | "php" | "native";
export type DdType = { key: string; kinds: ProfileKind[] };
/**
 * Datadog's list per language, each mapped onto the kinds a Pyroscope type can be (profileTypeOf) — `kinds: []` =
 * Pyroscope has no such profile for that language (shown as "not in Pyroscope", never as missing data).
 */
export const DD_TYPES: Record<LangKey, DdType[]> = {
  java: [
    { key: "cpu", kinds: ["cpu"] }, { key: "allocations", kinds: ["allocCount"] }, { key: "allocatedMemory", kinds: ["allocBytes"] },
    { key: "liveHeap", kinds: ["heapBytes", "heapCount"] }, { key: "wallTime", kinds: ["wall"] }, { key: "classLoad", kinds: [] },
    { key: "thrownExceptions", kinds: ["exceptions"] }, { key: "fileIo", kinds: [] }, { key: "lock", kinds: ["lockTime", "lockCount"] }, { key: "socketIo", kinds: [] },
  ],
  python: [
    { key: "wallTime", kinds: ["wall"] }, { key: "lockWait", kinds: ["lockTime"] }, { key: "lockAcquires", kinds: ["lockCount"] }, { key: "cpu", kinds: ["cpu"] },
    { key: "heapLiveSize", kinds: ["heapBytes"] }, { key: "allocatedMemory", kinds: ["allocBytes"] }, { key: "allocations", kinds: ["allocCount"] },
  ],
  go: [
    { key: "cpu", kinds: ["cpu"] }, { key: "allocations", kinds: ["allocCount"] }, { key: "allocatedMemory", kinds: ["allocBytes"] },
    { key: "heapLiveObjects", kinds: ["heapCount"] }, { key: "heapLiveSize", kinds: ["heapBytes"] }, { key: "mutex", kinds: ["lockTime", "lockCount"] },
    { key: "block", kinds: ["blockTime", "blockCount"] }, { key: "goroutines", kinds: ["goroutines"] },
  ],
  ruby: [{ key: "cpu", kinds: ["cpu"] }, { key: "wallTime", kinds: ["wall"] }, { key: "allocations", kinds: ["allocCount"] }, { key: "heapLiveObjects", kinds: ["heapCount"] }],
  nodejs: [{ key: "cpu", kinds: ["cpu"] }, { key: "wallTime", kinds: ["wall"] }, { key: "heapLiveSize", kinds: ["heapBytes"] }, { key: "allocatedMemory", kinds: ["allocBytes"] }],
  dotnet: [
    { key: "wallTime", kinds: ["wall"] }, { key: "cpu", kinds: ["cpu"] }, { key: "thrownExceptions", kinds: ["exceptions"] },
    { key: "allocations", kinds: ["allocCount", "allocBytes"] }, { key: "lock", kinds: ["lockTime", "lockCount"] }, { key: "liveHeap", kinds: ["heapBytes", "heapCount"] },
  ],
  php: [{ key: "wallTime", kinds: ["wall"] }, { key: "cpu", kinds: ["cpu"] }, { key: "allocations", kinds: ["allocCount"] }, { key: "allocatedMemory", kinds: ["allocBytes"] }, { key: "thrownExceptions", kinds: ["exceptions"] }],
  native: [{ key: "cpu", kinds: ["cpu"] }, { key: "allocations", kinds: ["allocCount"] }, { key: "allocatedMemory", kinds: ["allocBytes"] }],
};
export const LANG_OF: Record<string, LangKey> = { java: "java", go: "go", python: "python", ruby: "ruby", nodejs: "nodejs", dotnet: "dotnet", php: "php", rust: "native", ebpf: "native" };

/**
 * Pure: per Datadog type of a language — collected here (some service of that language sent a matching kind), not
 * collected, or not a Pyroscope profile for that language at all
 */
export function languageCoverage(lang: LangKey, sentKinds: Set<ProfileKind>): Array<{ key: string; state: "collected" | "notCollected" | "noPyroscope" }> {
  return DD_TYPES[lang].map((d) => ({ key: d.key, state: !d.kinds.length ? "noPyroscope" : d.kinds.some((k) => sentKinds.has(k)) ? "collected" : "notCollected" }));
}

/** The label names that would make a thread timeline (one lane per thread / goroutine) possible */
export const THREAD_LABELS = ["thread_name", "thread_id", "thread", "goroutine", "tid"];
export const hasThreadLabel = (labels: string[]) => labels.some((l) => THREAD_LABELS.includes(l.toLowerCase()));
