// What a resource is doing right now, and why — pure (no Azure calls), unit-tested from apps/api/test/lifecycle.test.ts.
//
// State: the resource's own words read on this poll (metricsCollector live read — the same ARM GET as the power
// state): PostgreSQL / MySQL Flexible `properties.state`, SQL `properties.status`, otherwise `provisioningState`;
// a scale set whose instance count differs from its target is scaling.
// Learn: PostgreSQL KnownServerState https://learn.microsoft.com/javascript/api/@azure/arm-postgresql-flexible/knownserverstate
//        Redis KnownProvisioningState https://learn.microsoft.com/javascript/api/@azure/arm-rediscache/knownprovisioningstate
//        VM states https://learn.microsoft.com/azure/virtual-machines/states-billing (Updating = a control-plane operation)
// Cause, only from a record that says it:
//   user / app / platform — Resource Graph `resourcechanges` (changedByType User / Application / System, with the
//     changed properties before → after; https://learn.microsoft.com/azure/governance/resource-graph/changes/get-resource-changes)
//   maintenance — an active Service Health planned-maintenance event that lists this resource (impactedresources)
//   unknown — in progress and nothing recorded yet (change records arrive within minutes): never guessed from the
//     state word (Updating is not "maintenance", System is not "maintenance")
// Never a health input and never a risk colour; "Updating" does not mean downtime.
import type { LiveChange, LiveLifecycle, LiveSpec } from "@aud/types";
import type { LiveRead } from "./metricsCollector.js";
import { resourceSpec } from "./resourceSpec.js";

/** One record of Resource Graph `resourcechanges` (already projected) */
export type ChangeRow = {
  rid: string;
  at: string;
  changeType?: string;
  byType?: string;
  changes?: Record<string, { previousValue?: unknown; newValue?: unknown; propertyChangeType?: string } | undefined>;
};

/** A change counts as "recent" this long after it was recorded (the card's "최근 변경") */
export const RECENT_CHANGE_MS = 2 * 60 * 60_000;
/** Changed paths worth naming first (size, capacity, tier, version, storage) — the rest are counted */
const KEY_PATHS = [/^sku\.(name|capacity|tier|family)$/i, /hardwareProfile\.vmSize$/i, /^properties\.sku\./i, /storage(SizeGB|\.storageSizeGB|\.tier|\.iops)/i,
  /version$/i, /highAvailability\.mode$/i, /agentPoolProfiles\.\d+\.(count|vmSize)$/i, /\.capacity$/i];

const lower = (s: string | undefined) => (s ?? "").toLowerCase();
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const show = (v: unknown): string | undefined =>
  v == null ? undefined : typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(v).slice(0, 60);

/** "microsoft.compute/virtualmachinescalesets" from a resource id */
export function armTypeOf(id: string): string {
  const parts = lower(id).split("/");
  const i = parts.lastIndexOf("providers");
  return i >= 0 && parts.length > i + 2 ? `${parts[i + 1]}/${parts[i + 2]}` : "";
}

/** The operation state from the read, or null when nothing is in progress */
export function operationState(kind: string, read: LiveRead | undefined, metaProvisioningState?: string): { state: LiveLifecycle["state"]; raw?: string } | null {
  const prov = read?.provisioningState ?? metaProvisioningState;
  const st = read?.state;
  const p = lower(prov), s = lower(st);
  // Service-specific words first (they say more than provisioningState)
  if (kind === "postgres" || kind === "mysql") {
    if (s === "updating") return { state: "updating", raw: st };
    if (s === "starting" || s === "restarting") return { state: "starting", raw: st };
    if (s === "stopping") return { state: "stopping", raw: st };
    if (s === "provisioning") return { state: "creating", raw: st };
    if (s === "dropping") return { state: "deleting", raw: st };
  }
  if (kind === "sql") {
    if (s === "scaling" || s === "onlinechangingdwperformancetiers") return { state: "scaling", raw: st };
    if (s === "resuming" || s === "starting") return { state: "starting", raw: st };
    if (s === "pausing" || s === "stopping") return { state: "stopping", raw: st };
    if (s === "creating" || s === "copying" || s === "restoring" || s === "recovering") return { state: "updating", raw: st };
  }
  if (kind === "vmss" && read?.instances && read.sku?.capacity != null && read.instances.actual !== read.sku.capacity) {
    return { state: "scaling", raw: prov };
  }
  if (!p || p === "succeeded" || p === "canceled") return null;
  if (p === "failed") return { state: "failed", raw: prov };
  if (p === "creating" || p === "provisioning") return { state: "creating", raw: prov };
  if (p === "deleting" || p === "unprovisioning") return { state: "deleting", raw: prov };
  if (p === "scaling" || p === "recoveringscalefailure") return { state: "scaling", raw: prov };
  // Updating, Migrating, Linking, Upgrading (AKS is a free string), … — something is running; the raw word stays
  return { state: "updating", raw: prov };
}

/** The latest change record, as shown (key paths first, at most 4 items) */
export function describeChange(rows: readonly ChangeRow[]): LiveChange | undefined {
  const r = [...rows].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))[0];
  if (!r) return undefined;
  const entries = Object.entries(r.changes ?? {}).filter(([, v]) => v);
  const isKey = (path: string) => KEY_PATHS.some((re) => re.test(path));
  const keyFirst = [...entries].sort(([a], [b]) => Number(!isKey(a)) - Number(!isKey(b)) || (a < b ? -1 : a > b ? 1 : 0));
  const by = lower(r.byType);
  return {
    at: r.at,
    by: by === "user" ? "user" : by === "application" ? "app" : by === "system" ? "platform" : "unknown",
    ...(r.changeType && /^(create|update|delete)$/i.test(r.changeType) ? { changeType: cap(lower(r.changeType)) as LiveChange["changeType"] } : {}),
    items: keyFirst.slice(0, 4).map(([path, v]) => ({ path, ...(show(v!.previousValue) != null ? { from: show(v!.previousValue)! } : {}), ...(show(v!.newValue) != null ? { to: show(v!.newValue)! } : {}) })),
    count: entries.length,
  };
}

export type LifecycleInput = {
  kind: string;
  read?: LiveRead;
  /** provisioningState stored at generation (used only when the live read has none) */
  metaProvisioningState?: string;
  /** This resource's change records (any order) */
  changes?: readonly ChangeRow[];
  /** An active planned-maintenance event lists this resource */
  maintenance?: boolean;
  now: number;
};

/** The card's lifecycle: undefined when nothing is in progress and nothing changed recently */
export function resolveLifecycle(i: LifecycleInput): LiveLifecycle | undefined {
  const op = operationState(i.kind, i.read, i.metaProvisioningState);
  const recent = (i.changes ?? []).filter((c) => { const t = Date.parse(c.at); return Number.isFinite(t) && i.now - t <= RECENT_CHANGE_MS && i.now - t >= -60_000; });
  const change = describeChange(recent);
  const asOf = i.read?.asOf ?? new Date(i.now).toISOString();
  if (!op && !change && !i.maintenance) return undefined;
  if (!op) return { state: "ready", ...(change ? { change } : {}), ...(i.maintenance ? { cause: "maintenance" } : {}), asOf };
  // A failed operation keeps its state word; its cause is the last change when there is one
  const cause: LiveLifecycle["cause"] = i.maintenance && (!change || change.by === "platform") ? "maintenance"
    : change ? (change.by === "unknown" ? "unknown" : change.by) : "unknown";
  return { state: op.state, ...(op.raw ? { raw: op.raw } : {}), cause, ...(change ? { change } : {}), asOf };
}

/** Spec facts read now (rebuilt from the live body); a scale set's instance count is the actual one */
export function liveSpecOf(azureResourceId: string, read: LiveRead | undefined): LiveSpec | undefined {
  if (!read?.row && !read?.instances) return undefined;
  const facts = read.row ? resourceSpec(armTypeOf(azureResourceId), read.row) : [];
  const out: LiveSpec = { facts, asOf: read.asOf };
  if (read.instances) {
    const i = facts.findIndex((f) => f.k === "instances");
    const fact = { k: "instances", v: read.instances.actual };
    if (i >= 0) facts[i] = fact;
    else facts.push(fact);
    if (read.sku?.capacity != null && read.sku.capacity !== read.instances.actual) out.instancesTarget = read.sku.capacity;
    const states = Object.entries(read.instances.byProvisioning).filter(([k]) => k !== "Succeeded");
    if (states.length) out.instanceStates = Object.fromEntries(states);
  }
  return facts.length || out.instancesTarget != null ? out : undefined;
}
