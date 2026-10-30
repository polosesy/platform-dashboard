// 그래프 탐색 › 팀 저장 질문 (보안 고도화 P5) — the explorer's questions kept for the team, one JSON document per
// subscription next to the issue states (`<sub>.queries.json`). Only the question is stored (condition keys, not
// results): the matches are recomputed from the sources on every load, so a stored question can neither hide nor invent
// a finding. A watched question turns each match into an issue (the web builds them — source `query`). Written like
// the issue states: temp file → rename, one write at a time per subscription, a write names the revision it saw.
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { SavedQuery } from "@aud/types";

export const QUERY_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_QUERIES = 50;

/** Condition keys are the web's (camelCase words joined by "."); the API checks the shape, not the vocabulary */
export const SavedQueryBody = z.object({
  name: z.string().trim().min(1).max(40),
  q: z.string().regex(/^[a-zA-Z]{1,40}(\.[a-zA-Z]{1,40}){0,7}$/),
  includeManaged: z.boolean(),
  watch: z.boolean(),
  sev: z.enum(["critical", "high", "medium"]),
  baseRev: z.number().int().min(0).nullable(),
}).strict();
export type SavedQueryBody = z.infer<typeof SavedQueryBody>;

type Doc = { v: 1; queries: Record<string, SavedQuery> };
const memory = new Map<string, Doc>();
const locks = new Map<string, Promise<unknown>>();
const fileOf = (dir: string, sub: string) => path.join(dir, `${sub}.queries.json`);

export async function readSavedQueries(dir: string | undefined, subscriptionId: string): Promise<SavedQuery[]> {
  const sub = subscriptionId.toLowerCase();
  let doc: Doc | undefined;
  if (!dir) doc = memory.get(sub);
  else {
    try {
      const raw = JSON.parse(await fs.readFile(fileOf(dir, sub), "utf8")) as Doc;
      doc = raw && raw.v === 1 && raw.queries && typeof raw.queries === "object" ? raw : undefined;
    } catch { doc = undefined; } // none yet (or unreadable — the next write replaces it)
  }
  return Object.values(doc?.queries ?? {}).sort((a, b) => a.name.localeCompare(b.name));
}

/** Pure: a new question's id from its name — ASCII slug, numbered on collision ("q" when the name has no ASCII) */
export function newQueryId(name: string, taken: Set<string>): string {
  const base = (name.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "q");
  for (let i = 1; ; i++) {
    const id = i === 1 ? base : `${base}-${i}`;
    if (!taken.has(id)) return id;
  }
}

export type SavedQueryWriteResult =
  | { ok: true; query: SavedQuery | null }
  | { ok: false; error: "conflict"; current: SavedQuery | null }
  | { ok: false; error: string };

/** Create (`id` null), replace (`body`) or delete (`body` null) one question */
export async function writeSavedQuery(
  dir: string | undefined, subscriptionId: string, id: string | null, body: SavedQueryBody | { baseRev: number }, opts: { by?: string; now?: Date; remove?: boolean } = {},
): Promise<SavedQueryWriteResult> {
  if (id !== null && !QUERY_ID.test(id)) return { ok: false, error: "query_id_invalid" };
  const sub = subscriptionId.toLowerCase();
  const prev = locks.get(sub) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(async (): Promise<SavedQueryWriteResult> => {
    const queries: Record<string, SavedQuery> = Object.fromEntries((await readSavedQueries(dir, sub)).map((q) => [q.id, q]));
    const current = id ? queries[id] ?? null : null;
    if ((current?.rev ?? null) !== body.baseRev) return { ok: false, error: "conflict", current };
    let query: SavedQuery | null = null;
    if (opts.remove) {
      if (!id || !current) return { ok: false, error: "conflict", current: null };
      delete queries[id];
    } else {
      const b = body as SavedQueryBody;
      if (!current && Object.keys(queries).length >= MAX_QUERIES) return { ok: false, error: "query_store_full" };
      const qid = id ?? newQueryId(b.name, new Set(Object.keys(queries)));
      query = {
        id: qid, name: b.name, q: b.q, includeManaged: b.includeManaged, watch: b.watch, sev: b.sev,
        rev: (current?.rev ?? 0) + 1, updatedAt: (opts.now ?? new Date()).toISOString(), ...(opts.by ? { updatedBy: opts.by } : {}),
      };
      queries[qid] = query;
    }
    const doc: Doc = { v: 1, queries };
    if (!dir) { memory.set(sub, doc); return { ok: true, query }; }
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${fileOf(dir, sub)}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(doc), { mode: 0o640 });
    await fs.rename(tmp, fileOf(dir, sub));
    return { ok: true, query };
  });
  locks.set(sub, run);
  try { return await run; } finally { if (locks.get(sub) === run) locks.delete(sub); }
}

/** Test hook */
export function clearSavedQueryMemory(): void {
  memory.clear();
}
