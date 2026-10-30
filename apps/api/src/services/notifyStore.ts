// 알림 센터 — the received alerts, one document (`alerts.json`) next to the issue states. Repeated deliveries of the
// same alert update one item (received count, history); a resolved alert that fires again is re-opened (refired) and
// its acknowledgement cleared — a new occurrence needs a new look. Written like the issue states: temp file → rename,
// one write at a time; without a directory, in memory (`durable: false`). Kept: firing alerts always, resolved ones
// for the retention days, at most MAX items (oldest resolved dropped first).
import { promises as fs } from "node:fs";
import path from "node:path";
import type { NotifyAlert, OwnerRule } from "@aud/types";
import type { ParsedAlert } from "./alertPayloads.js";

const MAX = 3000;
const HISTORY = 20;
const DAY = 86_400_000;

type Doc = { v: 1; alerts: Record<string, NotifyAlert> };
let memory: Doc | null = null;
let lock: Promise<unknown> = Promise.resolve();

/** AUD_NOTIFY_DIR, else a `notifications` folder in the team-layout directory (same volume) */
export function notifyDir(env: { AUD_NOTIFY_DIR?: string; AUD_ARRANGEMENT_DIR?: string }): string | undefined {
  return env.AUD_NOTIFY_DIR ?? (env.AUD_ARRANGEMENT_DIR ? path.join(env.AUD_ARRANGEMENT_DIR, "notifications") : undefined);
}

async function load(dir: string | undefined): Promise<Doc> {
  if (memory) return memory;
  if (dir) {
    try {
      const raw = JSON.parse(await fs.readFile(path.join(dir, "alerts.json"), "utf8")) as Doc;
      if (raw && raw.v === 1 && raw.alerts && typeof raw.alerts === "object") return (memory = raw);
    } catch { /* none yet — the first write creates it */ }
  }
  return (memory = { v: 1, alerts: {} });
}

async function save(dir: string | undefined, doc: Doc): Promise<void> {
  memory = doc;
  if (!dir) return;
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, "alerts.json");
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(doc), { mode: 0o640 });
  await fs.rename(tmp, file);
}

const serial = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = lock.catch(() => undefined).then(fn);
  lock = run;
  return run;
};

/** Pure: "team-*" or an exact name; namespace rules before resource-group rules (same as the issue list) */
export function ownerTeam(alert: Pick<NotifyAlert, "target">, rules: OwnerRule[]): string | undefined {
  const m = (p: string, v: string | undefined) => !!v && (p.endsWith("*") ? v.toLowerCase().startsWith(p.slice(0, -1).toLowerCase()) : p.toLowerCase() === v.toLowerCase());
  for (const r of rules) if ((r.namespaces ?? []).some((p) => m(p, alert.target.namespace))) return r.team;
  for (const r of rules) if ((r.resourceGroups ?? []).some((p) => m(p, alert.target.resourceGroup))) return r.team;
  return undefined;
}

/** Pure: one delivery into the current items. Returns the items whose status changed or that are new (for the relay). */
export function applyDelivery(current: Record<string, NotifyAlert>, parsed: ParsedAlert[], now: Date, teamOf: (a: ParsedAlert) => string | undefined): { next: Record<string, NotifyAlert>; changed: NotifyAlert[] } {
  const next = { ...current };
  const changed: NotifyAlert[] = [];
  const at = now.toISOString();
  for (const p of parsed) {
    const prev = next[p.id];
    const team = teamOf(p);
    if (!prev) {
      const a: NotifyAlert = {
        ...p, ...(team ? { team } : {}), firstReceivedAt: at, lastReceivedAt: at, received: 1, refired: 0,
        history: [{ at, status: p.status }],
      };
      next[p.id] = a;
      changed.push(a);
      continue;
    }
    const statusChanged = prev.status !== p.status;
    const refire = statusChanged && p.status === "firing";
    const a: NotifyAlert = {
      ...prev,
      // The newest delivery describes the alert (texts, values, links may change); identity and counts stay
      status: p.status, severity: p.severity, category: p.category, categoryBasis: p.categoryBasis, rule: p.rule, title: p.title,
      summary: p.summary, description: p.description, service: p.service, target: p.target, labels: p.labels, values: p.values, links: p.links,
      ...(team ? { team } : {}),
      startsAt: refire ? p.startsAt : prev.startsAt,
      endsAt: p.status === "resolved" ? p.endsAt ?? at : undefined,
      lastReceivedAt: at, received: prev.received + 1, refired: prev.refired + (refire ? 1 : 0),
      ack: refire ? undefined : prev.ack,
      history: statusChanged ? [{ at, status: p.status }, ...prev.history].slice(0, HISTORY) : prev.history,
    };
    if (!a.endsAt) delete a.endsAt;
    if (!a.ack) delete a.ack;
    next[p.id] = a;
    if (statusChanged) changed.push(a);
  }
  return { next, changed };
}

/** Pure: retention — firing kept; resolved older than `days` dropped; above MAX the oldest resolved go first */
export function prune(alerts: Record<string, NotifyAlert>, now: Date, days: number, max = MAX): Record<string, NotifyAlert> {
  const cutoff = now.getTime() - days * DAY;
  const kept = Object.values(alerts).filter((a) => a.status === "firing" || Date.parse(a.endsAt ?? a.lastReceivedAt) >= cutoff);
  if (kept.length > max) {
    kept.sort((a, b) => Number(b.status === "firing") - Number(a.status === "firing") || Date.parse(b.lastReceivedAt) - Date.parse(a.lastReceivedAt));
    kept.length = max;
  }
  return Object.fromEntries(kept.map((a) => [a.id, a]));
}

export async function ingest(dir: string | undefined, parsed: ParsedAlert[], opts: { now?: Date; retentionDays: number; teamOf: (a: ParsedAlert) => string | undefined }): Promise<NotifyAlert[]> {
  return serial(async () => {
    const now = opts.now ?? new Date();
    const doc = await load(dir);
    const { next, changed } = applyDelivery(doc.alerts, parsed, now, opts.teamOf);
    await save(dir, { v: 1, alerts: prune(next, now, opts.retentionDays) });
    return changed;
  });
}

export async function listAlerts(dir: string | undefined): Promise<NotifyAlert[]> {
  const doc = await load(dir);
  return Object.values(doc.alerts);
}

export type AckResult = { ok: true; alert: NotifyAlert } | { ok: false; error: "not_found" };

export async function setAck(dir: string | undefined, id: string, ack: { by: string; note?: string } | null, now = new Date()): Promise<AckResult> {
  return serial(async () => {
    const doc = await load(dir);
    const a = doc.alerts[id];
    if (!a) return { ok: false, error: "not_found" } as const;
    const next: NotifyAlert = { ...a };
    if (ack) next.ack = { by: ack.by, at: now.toISOString(), ...(ack.note ? { note: ack.note } : {}) };
    else delete next.ack;
    next.history = [{ at: now.toISOString(), status: a.status, by: ack?.by ?? "", note: ack ? `ack${ack.note ? `: ${ack.note}` : ""}` : "unack" }, ...a.history].slice(0, HISTORY);
    await save(dir, { v: 1, alerts: { ...doc.alerts, [id]: next } });
    return { ok: true, alert: next } as const;
  });
}

export async function setRelayResult(dir: string | undefined, id: string, relay: NonNullable<NotifyAlert["relay"]>): Promise<void> {
  await serial(async () => {
    const doc = await load(dir);
    const a = doc.alerts[id];
    if (!a) return;
    await save(dir, { v: 1, alerts: { ...doc.alerts, [id]: { ...a, relay } } });
  });
}

/** Test hook */
export function clearNotifyMemory(): void {
  memory = null;
}
