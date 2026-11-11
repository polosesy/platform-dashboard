// AKS 모니터링 › SLO › 설정 — the team's SLO targets and error-budget resets, kept on the platform per cluster.
//
// The connection file (`aks.observability.slo`) stays the GitOps source; what is set here overrides it field by
// field, the most specific winning (workloadSlo `targetsFor`): a service's platform value › the service's file value ›
// the cluster's platform value › the file's top level › SLO_DEFAULTS. Excluded URIs add up.
//
// Error-budget reset: the budget of a service (or of every service, "*") is counted from the reset time instead of
// the window's start — after an incident is fixed and reviewed, its spent budget stops holding the service at
// "exhausted" for the rest of the window. Only the SLO window's numbers move: the burn-rate alerts measure now and are
// never reset (an ongoing burn keeps paging). A reset older than the window has no effect and is pruned on the next
// write. Every reset needs a reason; both kinds of change go to a short history (who · when · what).
//
// Written like the issue states (issueStateStore): one JSON per cluster (file name = a hash of the cluster's ARM ID,
// the ID itself inside), temp file → rename, one write at a time per cluster; without a directory, in memory
// (`durable: false`). The settings carry a revision — a save names the one it edited (409 otherwise); resets do not
// conflict (they only add or remove one entry). `version` changes with every write: the SLO result's cache key.
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { SloBudgetReset, SloSettings, SloSettingsChange } from "@aud/types";
import { SLO_SERVICE_KEY, SloSchema } from "../infra/connectionRegistry.js";

const DAY = 86_400_000;
/** The longest SLO window — a reset older than this can never apply */
export const SLO_RESET_MAX_AGE_MS = 30 * DAY;
/** Resets kept per cluster (each active one adds a few small queries to the SLO read) */
export const SLO_MAX_RESETS = 20;
const HISTORY = 30;

export const SloSettingsBody = z.object({ baseRev: z.number().int().min(0), settings: SloSchema }).strict();
export type SloSettingsBody = z.infer<typeof SloSettingsBody>;
export const SloResetBody = z.object({
  service: z.union([z.literal("*"), z.string().regex(SLO_SERVICE_KEY)]),
  at: z.string().datetime({ offset: true }).optional(),
  reason: z.string().trim().min(3).max(200),
}).strict();
export type SloResetBody = z.infer<typeof SloResetBody>;

export type SloSettingsDoc = {
  v: 1;
  clusterId: string;
  settings: SloSettings;
  rev: number;
  version: number;
  updatedAt?: string;
  updatedBy?: string;
  resets: SloBudgetReset[];
  history: SloSettingsChange[];
};

const empty = (clusterId: string): SloSettingsDoc => ({ v: 1, clusterId, settings: {}, rev: 0, version: 0, resets: [], history: [] });
const memory = new Map<string, SloSettingsDoc>();
const locks = new Map<string, Promise<unknown>>();
const keyOf = (clusterId: string) => clusterId.toLowerCase();
const fileOf = (dir: string, clusterId: string) => path.join(dir, `${createHash("sha256").update(keyOf(clusterId)).digest("hex").slice(0, 32)}.json`);

/** Where the settings live: an `slo` folder in the team-layout directory (the one writable volume) — else memory */
export function sloSettingsDir(env: { AUD_ARRANGEMENT_DIR?: string }): string | undefined {
  return env.AUD_ARRANGEMENT_DIR ? path.join(env.AUD_ARRANGEMENT_DIR, "slo") : undefined;
}

export async function readSloSettings(dir: string | undefined, clusterId: string): Promise<SloSettingsDoc> {
  const key = keyOf(clusterId);
  if (!dir) return memory.get(key) ?? empty(key);
  try {
    const raw = JSON.parse(await fs.readFile(fileOf(dir, key), "utf8")) as SloSettingsDoc;
    if (raw?.v !== 1 || raw.clusterId !== key) return empty(key);
    const settings = SloSchema.safeParse(raw.settings ?? {});
    return {
      ...empty(key), ...raw,
      settings: settings.success ? (settings.data as SloSettings) : {},
      resets: Array.isArray(raw.resets) ? raw.resets : [],
      history: Array.isArray(raw.history) ? raw.history : [],
    };
  } catch {
    return empty(key); // none yet (or unreadable — the next write replaces it)
  }
}

/** Pure: whether a reset applies to a service — its own or the cluster-wide one */
export function resetMatches(r: SloBudgetReset, namespace: string, application: string): boolean {
  return r.service === "*" || r.service === `${namespace}/${application}`;
}

/**
 * Pure: the reset that counts for a service at `endMs` (the window's end) — the latest one at or before the end and
 * inside the window; null = the whole window counts
 */
export function resetFor(resets: SloBudgetReset[], namespace: string, application: string, endMs: number, windowDays: number): SloBudgetReset | null {
  let best: SloBudgetReset | null = null;
  for (const r of resets) {
    const t = Date.parse(r.at);
    if (!Number.isFinite(t) || t > endMs || t <= endMs - windowDays * DAY || !resetMatches(r, namespace, application)) continue;
    if (!best || t > Date.parse(best.at)) best = r;
  }
  return best;
}

/** Pure: a reset's time — now when not given; at most a minute ahead (clock skew) and not before the longest window */
export function validateReset(body: SloResetBody, now: Date): { ok: true; at: Date } | { ok: false; error: string } {
  const at = body.at ? new Date(body.at) : now;
  if (!Number.isFinite(at.getTime())) return { ok: false, error: "slo_reset_time" };
  if (at.getTime() > now.getTime() + 60_000 || at.getTime() < now.getTime() - SLO_RESET_MAX_AGE_MS) return { ok: false, error: "slo_reset_time" };
  return { ok: true, at };
}

/** Pure: a short line of what a settings save changed (the history) — field names and service keys, no values */
export function settingsDiff(before: SloSettings, after: SloSettings): string {
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const out: string[] = [];
  for (const k of ["windowDays", "availability", "latency", "excludeUris"] as const) if (!same(before[k], after[k])) out.push(k);
  const keys = new Set([...Object.keys(before.services ?? {}), ...Object.keys(after.services ?? {})]);
  const svc = [...keys].filter((k) => !same(before.services?.[k], after.services?.[k])).sort();
  if (svc.length) out.push(`services: ${svc.slice(0, 5).join(", ")}${svc.length > 5 ? ` +${svc.length - 5}` : ""}`);
  return out.join(" · ").slice(0, 300) || "—";
}

/** Pure: drop empty service entries and empty lists (an emptied field = "inherit", not an empty override) */
export function cleanSettings(s: SloSettings): SloSettings {
  const services: NonNullable<SloSettings["services"]> = {};
  for (const [k, v] of Object.entries(s.services ?? {})) {
    const e = { ...v, ...(v.excludeUris?.length ? {} : { excludeUris: undefined }) };
    const kept = Object.fromEntries(Object.entries(e).filter(([, x]) => x !== undefined && x !== false));
    if (Object.keys(kept).length) services[k] = kept as typeof v;
  }
  const out: SloSettings = { ...s, services };
  if (!s.excludeUris?.length) delete out.excludeUris;
  if (!Object.keys(services).length) delete out.services;
  for (const k of Object.keys(out) as (keyof SloSettings)[]) if (out[k] === undefined) delete out[k];
  return out;
}

async function save(dir: string | undefined, doc: SloSettingsDoc): Promise<void> {
  if (!dir) { memory.set(doc.clusterId, doc); return; }
  await fs.mkdir(dir, { recursive: true });
  const file = fileOf(dir, doc.clusterId);
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(doc), { mode: 0o640 });
  await fs.rename(tmp, file);
}

/** One write at a time per cluster; `change` returns the new document or an error code */
async function update<R>(dir: string | undefined, clusterId: string, change: (doc: SloSettingsDoc) => { doc: SloSettingsDoc; result: R } | { error: R }): Promise<R> {
  const key = keyOf(clusterId);
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(async () => {
    const r = change(await readSloSettings(dir, key));
    if ("error" in r) return r.error;
    await save(dir, r.doc);
    return r.result;
  });
  locks.set(key, run);
  try { return await run; } finally { if (locks.get(key) === run) locks.delete(key); }
}

const pruned = (resets: SloBudgetReset[], now: Date) => resets.filter((r) => Date.parse(r.at) > now.getTime() - SLO_RESET_MAX_AGE_MS);

export type SloWriteResult = { ok: true; doc: SloSettingsDoc } | { ok: false; error: "conflict"; doc: SloSettingsDoc } | { ok: false; error: string };

export function writeSloSettings(dir: string | undefined, clusterId: string, body: SloSettingsBody, opts: { by?: string; now?: Date } = {}): Promise<SloWriteResult> {
  const now = opts.now ?? new Date();
  return update<SloWriteResult>(dir, clusterId, (cur) => {
    if (cur.rev !== body.baseRev) return { error: { ok: false, error: "conflict", doc: cur } };
    const settings = cleanSettings(body.settings as SloSettings);
    const at = now.toISOString();
    const doc: SloSettingsDoc = {
      ...cur, settings, rev: cur.rev + 1, version: cur.version + 1, updatedAt: at, ...(opts.by ? { updatedBy: opts.by } : {}),
      resets: pruned(cur.resets, now),
      history: [{ at, ...(opts.by ? { by: opts.by } : {}), action: "settings" as const, detail: settingsDiff(cur.settings, settings) }, ...cur.history].slice(0, HISTORY),
    };
    return { doc, result: { ok: true, doc } };
  });
}

/** A new reset replaces the service's previous one (the latest counts anyway) */
export function addSloReset(dir: string | undefined, clusterId: string, body: SloResetBody, opts: { by?: string; now?: Date } = {}): Promise<SloWriteResult> {
  const now = opts.now ?? new Date();
  const v = validateReset(body, now);
  if (!v.ok) return Promise.resolve({ ok: false, error: v.error });
  return update<SloWriteResult>(dir, clusterId, (cur) => {
    const kept = pruned(cur.resets, now).filter((r) => r.service !== body.service);
    if (kept.length >= SLO_MAX_RESETS) return { error: { ok: false, error: "slo_reset_full" } };
    const created = now.toISOString();
    const reset: SloBudgetReset = {
      id: randomBytes(6).toString("hex"), service: body.service, at: v.at.toISOString(), reason: body.reason,
      ...(opts.by ? { by: opts.by } : {}), createdAt: created,
    };
    const doc: SloSettingsDoc = {
      ...cur, version: cur.version + 1, resets: [reset, ...kept],
      history: [{ at: created, ...(opts.by ? { by: opts.by } : {}), action: "reset" as const, detail: `${body.service} · ${body.reason}`.slice(0, 300) }, ...cur.history].slice(0, HISTORY),
    };
    return { doc, result: { ok: true, doc } };
  });
}

export function removeSloReset(dir: string | undefined, clusterId: string, id: string, opts: { by?: string; now?: Date } = {}): Promise<SloWriteResult> {
  const now = opts.now ?? new Date();
  return update<SloWriteResult>(dir, clusterId, (cur) => {
    const gone = cur.resets.find((r) => r.id === id);
    if (!gone) return { error: { ok: false, error: "slo_reset_not_found" } };
    const at = now.toISOString();
    const doc: SloSettingsDoc = {
      ...cur, version: cur.version + 1, resets: pruned(cur.resets.filter((r) => r.id !== id), now),
      history: [{ at, ...(opts.by ? { by: opts.by } : {}), action: "undoReset" as const, detail: `${gone.service} · ${gone.reason}`.slice(0, 300) }, ...cur.history].slice(0, HISTORY),
    };
    return { doc, result: { ok: true, doc } };
  });
}

/** Test hook */
export function clearSloSettingsMemory(): void {
  memory.clear();
}
