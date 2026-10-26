// Log stream view model (pure) — AKS 모니터링 › 히트맵 패널's Loki lines read like a log explorer, not a wall of text:
// one row per distinct message (same level + message with numbers / ids blurred → "×n", newest first), the row is
// the message itself (the leading timestamp the logger repeats is dropped — the row already shows the time; a
// logback "… LEVEL … - message" prefix is cut to the message), and a Java stack keeps the application's frames
// with the framework frames folded. Nothing is invented: the raw (already redacted) text stays for copy.

import type { LogLine } from "@aud/types";

const LEADING_TS = /^\s*\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})?\s+/;
/** logback / log4j "[thread] LEVEL [mdc] 1 logger [mdc] - message" — the message after the first " - " past the level */
const LEVEL_PREFIX = /^.*?\b(?:ERROR|WARN(?:ING)?|INFO|DEBUG|TRACE|FATAL)\b.*?\s-\s+/;
const FRAME = /^\s*at\s+(\S+?)\(/;
const OMITTED = /^\s*\.\.\.\s*\d+\s+(?:more|common frames omitted)/;
const CAUSE = /^\s*(?:Caused by|Suppressed):/;
/** Library / runtime packages — folded in a stack; everything else is the application's own code */
const FRAMEWORK = /^(?:java|javax|jdk|sun|com\.sun|jakarta|org\.springframework|org\.apache|org\.hibernate|io\.netty|reactor|kotlin|kotlinx|com\.fasterxml|io\.micrometer|org\.eclipse|com\.zaxxer|io\.opentelemetry|net\.bytebuddy|org\.aspectj|io\.undertow|com\.google|okhttp3|feign|io\.github\.resilience4j)\./;

export type StackFrame = { text: string; app: boolean };
export type ParsedLog = {
  /** The first line without the repeated timestamp */
  head: string;
  /** What the row shows: the message part of the head */
  summary: string;
  /** Message continuation lines (not frames) */
  body: string[];
  frames: StackFrame[];
  /** "Caused by:" / "Suppressed:" lines, in order */
  causes: string[];
};

export function parseLogText(text: string): ParsedLog {
  const lines = text.replace(/\r/g, "").split("\n");
  const head = (lines[0] ?? "").replace(LEADING_TS, "").trimEnd();
  const summary = head.replace(LEVEL_PREFIX, "").trim() || head.trim();
  const body: string[] = [];
  const frames: StackFrame[] = [];
  const causes: string[] = [];
  for (const raw of lines.slice(1)) {
    if (!raw.trim()) continue;
    const f = FRAME.exec(raw);
    if (f) {
      const qualified = f[1]!.replace(/^[\w.]+\//, ""); // "java.base/jdk.internal…" module prefix
      frames.push({ text: raw.trim(), app: !FRAMEWORK.test(qualified) });
    } else if (OMITTED.test(raw)) frames.push({ text: raw.trim(), app: false });
    else if (CAUSE.test(raw)) causes.push(raw.trim());
    else if (frames.length === 0) body.push(raw.trimEnd());
  }
  return { head, summary, body, frames, causes };
}

/** Numbers, hex ids and UUIDs blurred so "same error, other request" lands in one row */
export function logSignature(level: LogLine["level"], summary: string): string {
  return `${level}|${summary
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "#")
    .replace(/\b[0-9a-f]{12,}\b/gi, "#")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400)}`;
}

export type LogGroup = {
  key: string;
  level: LogLine["level"];
  /** The newest line of the group (what the row and the expanded view show) */
  latest: LogLine;
  parsed: ParsedLog;
  count: number;
  pods: string[];
  first: string;
  last: string;
};

/** Distinct messages, newest first; the input order does not matter */
export function groupLogLines(lines: LogLine[]): LogGroup[] {
  const map = new Map<string, LogGroup>();
  for (const l of lines) {
    const parsed = parseLogText(l.text);
    const key = logSignature(l.level, parsed.summary);
    const g = map.get(key);
    if (!g) {
      map.set(key, { key, level: l.level, latest: l, parsed, count: 1, pods: l.pod ? [l.pod] : [], first: l.time, last: l.time });
      continue;
    }
    g.count++;
    if (l.pod && !g.pods.includes(l.pod)) g.pods.push(l.pod);
    if (l.time < g.first) g.first = l.time;
    if (l.time > g.last) { g.last = l.time; g.latest = l; g.parsed = parsed; }
  }
  return [...map.values()].sort((a, b) => (a.last < b.last ? 1 : a.last > b.last ? -1 : 0));
}

/** Rows whose text names the exception class (the chips above the list filter with it) */
export function filterByException(groups: LogGroup[], cls: string | null): LogGroup[] {
  return cls ? groups.filter((g) => g.latest.text.includes(cls)) : groups;
}

/** The pod's own suffix — the workload name is in the panel header ("api-7d9f8c6b5-bcdfg" → "7d9f8c6b5-bcdfg") */
export function shortPod(pod: string, workload: string): string {
  return pod.startsWith(`${workload}-`) && pod.length > workload.length + 1 ? pod.slice(workload.length + 1) : pod;
}

/** A frame as an IDE shows it: "Class.method" + "(File.java:75)", the package aside (tooltip) */
export function frameLabel(text: string): { call: string; where: string; pkg: string } {
  const m = /^at\s+(?:[\w.]+\/)?(\S+?)\((.*)\)$/.exec(text.trim());
  if (!m) return { call: text.trim(), where: "", pkg: "" };
  const parts = m[1]!.split(".");
  const call = parts.slice(-2).join(".");
  return { call, where: `(${m[2]})`, pkg: parts.slice(0, -2).join(".") };
}

/** Stack shown folded: the application's frames (at most `max`), plus how many framework frames were folded */
export function visibleFrames(frames: StackFrame[], max = 6): { shown: StackFrame[]; folded: number } {
  const app = frames.filter((f) => f.app);
  const shown = (app.length ? app : frames.slice(0, 1)).slice(0, max);
  return { shown, folded: frames.length - shown.length };
}
