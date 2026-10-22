// Team layout of the infrastructure diagram (web lib/archArrange: slot order + manual lines) — one document per
// subscription, shared by everyone who opens that subscription. Layout only: no Azure call, nothing about Azure
// changes. Stored as a JSON file per subscription in AUD_ARRANGEMENT_DIR (a mounted volume — written to a temp file,
// then renamed); without it, in memory (lost on restart — the response says `durable: false`).
// Concurrency: every write names the version it was based on; a stale write gets 409 with the current document,
// and the caller decides (load theirs / overwrite with `force`).
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";

const STYLE = z.enum(["straight", "curve", "elbow"]);
/** A grid (web lib/archArrange v2): a tile container (1..6 columns) or a VNet's subnet columns (up to 16); cells [id, column, row] */
const GRID = z.object({
  cols: z.number().int().min(1).max(16).optional(),
  cells: z.array(z.tuple([z.string().max(600), z.number().int().min(0).max(15), z.number().int().min(0).max(99)])).max(400).optional(),
}).strict();
export const ArrangementBody = z.object({
  order: z.array(z.tuple([z.string().max(600), z.array(z.string().max(600)).max(400)])).max(500),
  /** Optional: documents published before grids have none */
  grid: z.array(z.tuple([z.string().max(600), GRID])).max(500).optional(),
  lines: z.array(z.object({
    source: z.string().max(600), target: z.string().max(600), style: STYLE,
    bend: z.number().min(0.1).max(0.9).optional(), bulge: z.number().min(-1).max(1).optional(),
  }).strict()).max(500),
}).strict();
export type ArrangementBody = z.infer<typeof ArrangementBody>;

export type ArrangementDoc = ArrangementBody & {
  /** 1 = order + lines only; 2 = with grids (both read) */
  v: 1 | 2;
  version: number;
  updatedAt: string;
  /** Display name from the token (never an object id) */
  updatedBy?: string;
};

const memory = new Map<string, ArrangementDoc>();
/** One write at a time per subscription (version check + write must not interleave) */
const locks = new Map<string, Promise<unknown>>();

const fileOf = (dir: string, subscriptionId: string) => path.join(dir, `${subscriptionId.toLowerCase()}.json`);

export async function readArrangement(dir: string | undefined, subscriptionId: string): Promise<ArrangementDoc | null> {
  if (!dir) return memory.get(subscriptionId.toLowerCase()) ?? null;
  try {
    const raw = JSON.parse(await fs.readFile(fileOf(dir, subscriptionId), "utf8")) as ArrangementDoc;
    const body = ArrangementBody.safeParse({ order: raw.order, lines: raw.lines, ...(raw.grid ? { grid: raw.grid } : {}) });
    return body.success && (raw.v === 1 || raw.v === 2) && Number.isInteger(raw.version) ? { ...body.data, v: body.data.grid?.length ? 2 : 1, version: raw.version, updatedAt: String(raw.updatedAt), ...(raw.updatedBy ? { updatedBy: String(raw.updatedBy) } : {}) } : null;
  } catch {
    return null; // none yet (or unreadable — treated as none, the next write replaces it)
  }
}

export type WriteResult = { ok: true; doc: ArrangementDoc } | { ok: false; conflict: ArrangementDoc };

export async function writeArrangement(
  dir: string | undefined, subscriptionId: string, body: ArrangementBody,
  opts: { baseVersion: number | null; force: boolean; by?: string; now?: Date },
): Promise<WriteResult> {
  const key = subscriptionId.toLowerCase();
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(async (): Promise<WriteResult> => {
    const current = await readArrangement(dir, key);
    if (current && !opts.force && opts.baseVersion !== current.version) return { ok: false, conflict: current };
    const doc: ArrangementDoc = { v: body.grid?.length ? 2 : 1, version: (current?.version ?? 0) + 1, updatedAt: (opts.now ?? new Date()).toISOString(), ...(opts.by ? { updatedBy: opts.by } : {}), ...body };
    if (!dir) { memory.set(key, doc); return { ok: true, doc }; }
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${fileOf(dir, key)}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(doc), { mode: 0o640 });
    await fs.rename(tmp, fileOf(dir, key));
    return { ok: true, doc };
  });
  locks.set(key, run);
  try { return await run; } finally { if (locks.get(key) === run) locks.delete(key); }
}

/** Test hook: forget the in-memory documents */
export function clearArrangementMemory(): void {
  memory.clear();
}
