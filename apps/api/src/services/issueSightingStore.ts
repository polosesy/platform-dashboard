// 노출 관리 (CTEM) › 조치 SLA — when the dashboard first and last saw each issue. The issue list is recomputed from its
// sources on every load and nothing stored when an issue appeared, so an SLA ("critical fixed within 15 days") had no
// start. The page reports the keys it computed; the server stamps its own clock: `first` is the first report and can
// never move back (a report can only make an issue look older-or-equal, never younger — so it cannot hide an overdue
// issue), `last` the latest. Ages are a lower bound: "seen by this dashboard since", not "exists since".
// Signed-in callers who may use the subscription (any role — it is the same computation the page already shows);
// SLA figures use only the issues in the current list, so a key that no source produces changes no number.
// Same file discipline as the issue states (temp file → rename, one write at a time per subscription; no directory =
// memory, `durable: false`). Entries not seen for 180 days are dropped; at most 20,000 per subscription.
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { IssueSighting } from "@aud/types";
import { ISSUE_KEY } from "./issueStateStore.js";

const MAX_KEYS = 20_000;
const KEEP_DAYS = 180;
const DAY = 86_400_000;

export const SightingsBody = z.object({
  items: z.array(z.object({ key: z.string().regex(ISSUE_KEY), sev: z.enum(["critical", "high", "medium", "low"]) }).strict()).max(5000),
}).strict();

type Doc = { v: 1; seen: Record<string, IssueSighting> };
const memory = new Map<string, Doc>();
const locks = new Map<string, Promise<unknown>>();
const fileOf = (dir: string, sub: string) => path.join(dir, `${sub}.seen.json`);

export async function readSightings(dir: string | undefined, subscriptionId: string): Promise<Record<string, IssueSighting>> {
  const sub = subscriptionId.toLowerCase();
  if (!dir) return memory.get(sub)?.seen ?? {};
  try {
    const raw = JSON.parse(await fs.readFile(fileOf(dir, sub), "utf8")) as Doc;
    return raw && raw.v === 1 && raw.seen && typeof raw.seen === "object" ? raw.seen : {};
  } catch {
    return {};
  }
}

/** Pure: merge a report into the ledger — first never moves, last = now, old entries dropped, the newest kept under the cap */
export function mergeSightings(seen: Record<string, IssueSighting>, items: Array<{ key: string; sev: IssueSighting["sev"] }>, now: Date): Record<string, IssueSighting> {
  const at = now.toISOString();
  const out: Record<string, IssueSighting> = {};
  const cutoff = now.getTime() - KEEP_DAYS * DAY;
  for (const [k, v] of Object.entries(seen)) if (Date.parse(v.last) >= cutoff) out[k] = v;
  for (const it of items) {
    const cur = out[it.key];
    out[it.key] = { first: cur?.first ?? at, last: at, sev: it.sev };
  }
  const keys = Object.keys(out);
  if (keys.length <= MAX_KEYS) return out;
  const keep = keys.sort((a, b) => Date.parse(out[b]!.last) - Date.parse(out[a]!.last)).slice(0, MAX_KEYS);
  return Object.fromEntries(keep.map((k) => [k, out[k]!]));
}

export async function recordSightings(dir: string | undefined, subscriptionId: string, items: Array<{ key: string; sev: IssueSighting["sev"] }>, now = new Date()): Promise<Record<string, IssueSighting>> {
  const sub = subscriptionId.toLowerCase();
  const prev = locks.get(sub) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(async () => {
    const seen = mergeSightings(await readSightings(dir, sub), items, now);
    const doc: Doc = { v: 1, seen };
    if (!dir) { memory.set(sub, doc); return seen; }
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${fileOf(dir, sub)}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(doc), { mode: 0o640 });
    await fs.rename(tmp, fileOf(dir, sub));
    return seen;
  });
  locks.set(sub, run);
  try { return await run; } finally { if (locks.get(sub) === run) locks.delete(sub); }
}

/** Test hook */
export function clearSightingMemory(): void {
  memory.clear();
}
