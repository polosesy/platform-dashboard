// 통합 위험 › 이슈 목록 — the team's status per issue (open · in progress · resolved · accepted exception), one JSON
// document per subscription. Only the team's words are stored; the issues themselves are recomputed from their
// sources on every load, so nothing here can hide or invent a finding. Written like the diagram's team layout
// (arrangementStore): temp file → rename, one write at a time per subscription; without a directory, in memory
// (`durable: false`). Concurrency is per issue: a write names the revision it saw, a stale one gets the current state.
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { IssueState, IssueStatus } from "@aud/types";

/** source:scope:id — printable ASCII without spaces (the web builds keys that way) */
export const ISSUE_KEY = /^(combo|wi|alert|vuln|query):[\x21-\x7e]{1,700}$/;
const MAX_KEYS = 3000;
const HISTORY = 20;
const DAY = 86_400_000;

export const IssueStateBody = z.object({
  status: z.enum(["open", "inProgress", "resolved", "accepted"]),
  note: z.string().trim().max(500).optional(),
  assignee: z.string().trim().max(100).optional(),
  until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  baseRev: z.number().int().min(0).nullable(),
}).strict();
export type IssueStateBody = z.infer<typeof IssueStateBody>;

type Doc = { v: 1; states: Record<string, IssueState> };
const memory = new Map<string, Doc>();
const locks = new Map<string, Promise<unknown>>();
const fileOf = (dir: string, subscriptionId: string) => path.join(dir, `${subscriptionId.toLowerCase()}.json`);

/** Where the states live: AUD_ISSUE_STATE_DIR, else an `issues` folder in the team-layout directory (same volume) */
export function issueStateDir(env: { AUD_ISSUE_STATE_DIR?: string; AUD_ARRANGEMENT_DIR?: string }): string | undefined {
  return env.AUD_ISSUE_STATE_DIR ?? (env.AUD_ARRANGEMENT_DIR ? path.join(env.AUD_ARRANGEMENT_DIR, "issues") : undefined);
}

export async function readIssueStates(dir: string | undefined, subscriptionId: string): Promise<Record<string, IssueState>> {
  const key = subscriptionId.toLowerCase();
  if (!dir) return memory.get(key)?.states ?? {};
  try {
    const raw = JSON.parse(await fs.readFile(fileOf(dir, key), "utf8")) as Doc;
    return raw && raw.v === 1 && raw.states && typeof raw.states === "object" ? raw.states : {};
  } catch {
    return {}; // none yet (or unreadable — the next write replaces it)
  }
}

/**
 * Pure: the rules of a status change. An exception (accepted) needs a reason and an end date between tomorrow and a
 * year ahead; other statuses carry no end date. Returns an error code, or null when the change is allowed.
 */
export function validateChange(body: IssueStateBody, now: Date): string | null {
  if (body.status === "accepted") {
    if (!body.note || body.note.length < 3) return "issue_exception_reason";
    if (!body.until) return "issue_exception_until";
    const until = Date.parse(`${body.until}T23:59:59Z`);
    if (!Number.isFinite(until) || until <= now.getTime() || until > now.getTime() + 366 * DAY) return "issue_exception_until";
  } else if (body.until) return "issue_until_only_exception";
  return null;
}

export type IssueWriteResult = { ok: true; state: IssueState } | { ok: false; error: "conflict"; current: IssueState | null } | { ok: false; error: string };

export async function writeIssueState(
  dir: string | undefined, subscriptionId: string, issueKey: string, body: IssueStateBody, opts: { by?: string; now?: Date } = {},
): Promise<IssueWriteResult> {
  const now = opts.now ?? new Date();
  if (!ISSUE_KEY.test(issueKey)) return { ok: false, error: "issue_key_invalid" };
  const invalid = validateChange(body, now);
  if (invalid) return { ok: false, error: invalid };
  const sub = subscriptionId.toLowerCase();
  const prev = locks.get(sub) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(async (): Promise<IssueWriteResult> => {
    const states = { ...(await readIssueStates(dir, sub)) };
    const current = states[issueKey] ?? null;
    if ((current?.rev ?? null) !== body.baseRev) return { ok: false, error: "conflict", current };
    if (!current && Object.keys(states).length >= MAX_KEYS) return { ok: false, error: "issue_state_full" };
    const at = now.toISOString();
    const change = { status: body.status as IssueStatus, at, ...(opts.by ? { by: opts.by } : {}), ...(body.note ? { note: body.note } : {}), ...(body.until ? { until: body.until } : {}) };
    const state: IssueState = {
      status: body.status,
      ...(body.note ? { note: body.note } : {}),
      ...(body.assignee ? { assignee: body.assignee } : {}),
      ...(body.until ? { until: body.until } : {}),
      rev: (current?.rev ?? 0) + 1,
      updatedAt: at,
      ...(opts.by ? { updatedBy: opts.by } : {}),
      history: [change, ...(current?.history ?? [])].slice(0, HISTORY),
    };
    states[issueKey] = state;
    const doc: Doc = { v: 1, states };
    if (!dir) { memory.set(sub, doc); return { ok: true, state }; }
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${fileOf(dir, sub)}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(doc), { mode: 0o640 });
    await fs.rename(tmp, fileOf(dir, sub));
    return { ok: true, state };
  });
  locks.set(sub, run);
  try { return await run; } finally { if (locks.get(sub) === run) locks.delete(sub); }
}

/** Test hook */
export function clearIssueStateMemory(): void {
  memory.clear();
}
