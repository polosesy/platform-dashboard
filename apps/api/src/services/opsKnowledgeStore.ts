// 사례·런북 저장 (docs/architecture/ops-knowledge.md §3) — one JSON document for the platform:
// `<AUD_ARRANGEMENT_DIR>/knowledge/knowledge.json` (else in memory, said on screen). Written like the issue states:
// temp file → rename, one write at a time, a write names the revision it saw (409 otherwise).
//
// Who sees what: a case or runbook tied to a cluster stores that cluster's connection key; reads keep only the
// entries whose connection the caller's role may use (a customer's cluster names are not shown to another's operators).
// Pasted text is masked on the way in (tokens, keys, SAS signatures, PEM — services/logRedaction.ts).

import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { OpsCase, OpsRunbook, OpsRunbookUsage } from "@aud/types";
import { redactLogText } from "./logRedaction.js";

export function opsKnowledgeDir(env: { AUD_ARRANGEMENT_DIR?: string }): string | undefined {
  return env.AUD_ARRANGEMENT_DIR ? path.join(env.AUD_ARRANGEMENT_DIR, "knowledge") : undefined;
}

export const OPS_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
export const MAX_CASES = 2000;
export const MAX_RUNBOOKS = 300;

const Text = (max: number) => z.string().max(max);
const Name = z.string().trim().max(253).regex(/^[A-Za-z0-9._:/-]*$/);
const Signal = z.object({
  kind: z.enum(["k8sReason", "exitCode", "dropReason", "alertRule", "httpStatus", "errorCode", "exception", "resourceType", "keyword"]),
  value: z.string().trim().min(1).max(120),
}).strict();
const Tags = z.array(z.string().trim().min(1).max(40)).max(12);
const Scope = z.object({
  clusterId: z.string().max(400).regex(/^\/subscriptions\/[0-9a-fA-F-]{36}\/resourceGroups\/[^/]+\/providers\/Microsoft\.ContainerService\/managedClusters\/[^/]+$/i).optional(),
  clusterName: Name.optional(), namespace: Name.optional(), workload: Name.optional(), resourceType: Name.optional(),
}).strict();
const Iso = z.string().datetime({ offset: true });

export const CaseBody = z.object({
  title: z.string().trim().min(1).max(120),
  status: z.enum(["open", "mitigated", "resolved"]),
  severity: z.enum(["sev1", "sev2", "sev3", "sev4"]),
  occurredAt: Iso,
  resolvedAt: Iso.optional(),
  symptoms: Text(8000).refine((s) => s.trim().length > 0, "symptoms required"),
  cause: Text(8000).optional(),
  resolution: Text(8000).optional(),
  lessons: Text(4000).optional(),
  tags: Tags,
  signals: z.array(Signal).max(20),
  scope: Scope,
  runbookIds: z.array(z.string().regex(OPS_ID)).max(10),
  source: z.object({ kind: z.enum(["alert", "manual"]), ref: z.string().max(200).optional() }).strict().optional(),
  team: z.string().trim().max(60).optional(),
  baseRev: z.number().int().min(0).nullable(),
}).strict()
  // "resolved" says what fixed it — a resolved case with no fix teaches nothing
  .refine((b) => b.status !== "resolved" || !!b.resolution?.trim(), { message: "resolution required", path: ["resolution"] });
export type CaseBody = z.infer<typeof CaseBody>;

const Step = z.object({
  title: z.string().trim().min(1).max(160),
  detail: Text(4000).optional(),
  command: Text(4000).optional(),
  check: Text(1000).optional(),
}).strict();
export const RunbookBody = z.object({
  title: z.string().trim().min(1).max(120),
  when: Text(2000).refine((s) => s.trim().length > 0, "when required"),
  signals: z.array(Signal).max(20),
  tags: Tags,
  steps: z.array(Step).min(1).max(30),
  rollback: Text(4000).optional(),
  team: z.string().trim().max(60).optional(),
  verifiedAt: Iso.optional(),
  scope: Scope.pick({ clusterId: true }).optional(),
  baseRev: z.number().int().min(0).nullable(),
}).strict();
export type RunbookBody = z.infer<typeof RunbookBody>;

/** Stored with the connection that may see it (null = everyone signed in) */
type Stored<T> = T & { connection?: string };
type Doc = { v: 1; cases: Record<string, Stored<OpsCase>>; runbooks: Record<string, Stored<OpsRunbook>> };
let memory: Doc = { v: 1, cases: {}, runbooks: {} };
let lock: Promise<unknown> = Promise.resolve();
const fileOf = (dir: string) => path.join(dir, "knowledge.json");

async function readDoc(dir: string | undefined): Promise<Doc> {
  if (!dir) return memory;
  try {
    const raw = JSON.parse(await fs.readFile(fileOf(dir), "utf8")) as Doc;
    if (raw && raw.v === 1 && raw.cases && raw.runbooks) return raw;
  } catch { /* none yet — the first write creates it */ }
  return { v: 1, cases: {}, runbooks: {} };
}

/** Pure: what a caller may see — no connection = everyone signed in; else only callers whose role can use it */
export function visible<T extends { connection?: string }>(items: T[], connections: ReadonlySet<string>): T[] {
  return items.filter((x) => !x.connection || connections.has(x.connection));
}
const strip = <T extends { connection?: string }>(x: T): Omit<T, "connection"> => { const { connection: _c, ...rest } = x; return rest; };

/** Pure: per runbook, the cases that name it — counted, never stored */
export function runbookUsage(cases: OpsCase[]): Record<string, OpsRunbookUsage> {
  const out: Record<string, OpsRunbookUsage> = {};
  for (const c of cases) {
    for (const id of new Set(c.runbookIds)) {
      const u = out[id] ?? (out[id] = { cases: 0, resolved: 0, lastUsedAt: null });
      u.cases++;
      if (c.status === "resolved") u.resolved++;
      const at = c.resolvedAt ?? c.occurredAt;
      if (!u.lastUsedAt || at > u.lastUsedAt) u.lastUsedAt = at;
    }
  }
  return out;
}

export async function readKnowledge(dir: string | undefined, connections: ReadonlySet<string>): Promise<{ cases: OpsCase[]; runbooks: OpsRunbook[] }> {
  const doc = await readDoc(dir);
  return {
    cases: visible(Object.values(doc.cases), connections).map(strip).sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : a.occurredAt > b.occurredAt ? -1 : 0)) as OpsCase[],
    runbooks: visible(Object.values(doc.runbooks), connections).map(strip).sort((a, b) => a.title.localeCompare(b.title)) as OpsRunbook[],
  };
}

/** Pure: an ASCII id from a title, numbered on collision ("case" / "runbook" when the title has no ASCII) */
export function newOpsId(title: string, taken: Set<string>, fallback: string, now: Date): string {
  const slug = title.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
  const base = slug || `${fallback}-${now.toISOString().slice(0, 10).replace(/-/g, "")}`;
  for (let i = 1; ; i++) {
    const id = i === 1 ? base : `${base}-${i}`;
    if (!taken.has(id)) return id;
  }
}

/** Mask secrets in the free-text fields; returns the masked copy and how many were masked */
export function maskTexts<T extends Record<string, unknown>>(body: T, fields: Array<keyof T>): { body: T; n: number } {
  let n = 0;
  const out = { ...body };
  for (const f of fields) {
    const v = out[f];
    if (typeof v === "string") { const r = redactLogText(v); n += r.n; (out as Record<string, unknown>)[f as string] = r.text; }
  }
  return { body: out, n };
}

export type OpsWriteResult<T> =
  | { ok: true; item: T | null }
  | { ok: false; error: "conflict"; current: T | null }
  | { ok: false; error: "forbidden" | "store_full" | "id_invalid" | "not_found" };

type Kind = "cases" | "runbooks";
/**
 * Create (`id` null), replace, or delete (`remove`) one case / runbook. `connection` = the connection of the cluster
 * the body names (null = none); `mayUse` = the caller may use that connection (checked for the old and the new one).
 */
export async function writeOps<T extends OpsCase | OpsRunbook>(
  dir: string | undefined, kind: Kind, id: string | null,
  build: ((prev: T | null, id: string) => T) | null,
  opts: { baseRev: number | null; connection: string | null; mayUse: (connection: string) => boolean; title?: string; now?: Date },
): Promise<OpsWriteResult<T>> {
  if (id !== null && !OPS_ID.test(id)) return { ok: false, error: "id_invalid" };
  const run = lock.catch(() => undefined).then(async (): Promise<OpsWriteResult<T>> => {
    const doc = await readDoc(dir);
    const table = doc[kind] as unknown as Record<string, Stored<T>>;
    const stored = id ? table[id] ?? null : null;
    if (stored?.connection && !opts.mayUse(stored.connection)) return { ok: false, error: "forbidden" };
    if (opts.connection && !opts.mayUse(opts.connection)) return { ok: false, error: "forbidden" };
    const current = stored ? (strip(stored) as unknown as T) : null;
    if ((current?.rev ?? null) !== opts.baseRev) return { ok: false, error: "conflict", current };
    let item: T | null = null;
    if (!build) {
      if (!id || !stored) return { ok: false, error: "not_found" };
      delete table[id];
    } else {
      const max = kind === "cases" ? MAX_CASES : MAX_RUNBOOKS;
      if (!stored && Object.keys(table).length >= max) return { ok: false, error: "store_full" };
      const now = opts.now ?? new Date();
      const nid = id ?? newOpsId(opts.title ?? "", new Set(Object.keys(table)), kind === "cases" ? "case" : "runbook", now);
      item = build(current, nid);
      table[nid] = { ...item, ...(opts.connection ? { connection: opts.connection } : {}) };
    }
    if (!dir) { memory = doc; return { ok: true, item }; }
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${fileOf(dir)}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(doc), { mode: 0o640 });
    await fs.rename(tmp, fileOf(dir));
    return { ok: true, item };
  });
  lock = run;
  return run;
}

/** Test hook */
export function clearOpsMemory(): void {
  memory = { v: 1, cases: {}, runbooks: {} };
}
