// Resource Health heatmap (/health, instance tab) — pure; tested from apps/api/test/healthHeatmap.test.ts.
// One tile per resource, grouped by type / resource group / region. Worst first: groups with problems come first,
// and inside a group Unavailable → Degraded → Unknown → Available, then by name (code points — deterministic).
// The data is the current state only (Resource Health availabilityStatuses), so nothing here implies a trend.
import type { ResourceHealthStatus } from "@aud/types";
import type { UiColor } from "./palette";

export type HealthState = ResourceHealthStatus["availabilityState"];
export type HeatmapGroupBy = "type" | "rg" | "region";

/** Lower = worse */
export const STATE_RANK: Record<HealthState, number> = { Unavailable: 0, Degraded: 1, Unknown: 2, Available: 3 };
export const STATES: HealthState[] = ["Unavailable", "Degraded", "Unknown", "Available"];

/**
 * Tile look per state — never color alone: a glyph for the problem states, a dashed outline for Unknown.
 * Unknown is neutral (not measured is not a risk), Available is quiet so problems stand out.
 */
export function stateTone(state: HealthState, userInitiated = false): { color: UiColor; alpha: number; glyph: string; dashed: boolean } {
  // Still Unavailable (Azure's state), in a lighter red: a user stopped it, not a platform fault
  if (state === "Unavailable" && userInitiated) return { color: "danger", alpha: 0.4, glyph: "✕", dashed: false };
  switch (state) {
    case "Unavailable": return { color: "danger", alpha: 0.85, glyph: "✕", dashed: false };
    case "Degraded": return { color: "warning", alpha: 0.85, glyph: "!", dashed: false };
    case "Unknown": return { color: "ink", alpha: 0.18, glyph: "?", dashed: true };
    default: return { color: "ok", alpha: 0.55, glyph: "", dashed: false };
  }
}

export type HeatmapGroup = {
  /** Group key (the raw type / resource group / region; "" = no region) */
  key: string;
  /** What to show: the type's last segment ("virtualMachines"), the resource group, the region */
  label: string;
  resources: ResourceHealthStatus[];
  counts: Record<HealthState, number>;
  /** The worst state in the group */
  worst: HealthState;
};

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const stateOf = (r: ResourceHealthStatus): HealthState => (r.availabilityState in STATE_RANK ? r.availabilityState : "Unknown");

export function groupKey(r: ResourceHealthStatus, by: HeatmapGroupBy): string {
  if (by === "type") return (r.resourceType ?? "").toLowerCase();
  if (by === "rg") return (r.resourceGroup ?? "").toLowerCase();
  return (r.location ?? "").toLowerCase();
}

/**
 * A resource type as "<namespace> · <type>" — "KeyVault · vaults" and "RecoveryServices · vaults" stay apart (the
 * last segment alone collided). Facts only: the ARM names without "Microsoft.", no invented display names.
 */
export function typeLabel(type: string): string {
  const parts = (type ?? "").split("/");
  if (parts.length < 2) return type ?? "";
  const ns = parts[0]!.replace(/^microsoft\./i, "");
  return `${ns} · ${parts.slice(1).join("/")}`;
}

/**
 * Unavailable because of a user action (Learn: non-platform events, "stopping a virtual machine"): Azure's own
 * reasonType — "Customer Initiated" / "User Initiated", case-insensitive. Never from the power state or the text.
 */
export const isUserInitiated = (r: ResourceHealthStatus) =>
  r.availabilityState === "Unavailable" && /^(customer|user)[ _-]?initiated$/i.test((r.reasonType ?? "").trim());

function groupLabel(r: ResourceHealthStatus, by: HeatmapGroupBy): string {
  if (by === "type") return typeLabel(r.resourceType ?? "");
  if (by === "rg") return r.resourceGroup ?? "";
  return r.location ?? "";
}

/** Tile order inside a group: worst first, then by name, then by id */
export const byTile = (a: ResourceHealthStatus, b: ResourceHealthStatus) =>
  STATE_RANK[stateOf(a)] - STATE_RANK[stateOf(b)] || cmp(a.resourceName.toLowerCase(), b.resourceName.toLowerCase()) || cmp(a.resourceId, b.resourceId);

/**
 * Groups, worst first: by the worst state, then by how many resources have a problem (Unavailable, then
 * Degraded), then by size, then by key. A resource without a region goes to the "" group (shown last among equals).
 */
export function groupResources(resources: ResourceHealthStatus[], by: HeatmapGroupBy): HeatmapGroup[] {
  const groups = new Map<string, HeatmapGroup>();
  for (const r of resources) {
    const key = groupKey(r, by);
    let g = groups.get(key);
    if (!g) {
      g = { key, label: groupLabel(r, by), resources: [], counts: { Unavailable: 0, Degraded: 0, Unknown: 0, Available: 0 }, worst: "Available" };
      groups.set(key, g);
    }
    const s = stateOf(r);
    g.resources.push(r);
    g.counts[s]++;
    if (STATE_RANK[s] < STATE_RANK[g.worst]) g.worst = s;
  }
  for (const g of groups.values()) g.resources.sort(byTile);
  return [...groups.values()].sort((a, b) =>
    STATE_RANK[a.worst] - STATE_RANK[b.worst]
    || b.counts.Unavailable - a.counts.Unavailable
    || b.counts.Degraded - a.counts.Degraded
    || b.resources.length - a.resources.length
    || (a.key === "" ? 1 : 0) - (b.key === "" ? 1 : 0)
    || cmp(a.key, b.key));
}

/** The "표시 범위" options: every group in heatmap order (problems first), with its size */
export const scopeOptions = (groups: HeatmapGroup[]) => groups.map((g) => ({ key: g.key, label: g.label, n: g.resources.length }));

/** Problem counts of a group for its header: user-initiated Unavailable counted apart */
export function groupStateCounts(g: HeatmapGroup): { unavailable: number; user: number; degraded: number; unknown: number; available: number } {
  const user = g.resources.filter(isUserInitiated).length;
  return { unavailable: g.counts.Unavailable - user, user, degraded: g.counts.Degraded, unknown: g.counts.Unknown, available: g.counts.Available };
}

/** At most `max` tiles per group; the rest is a "+k" that filters the list to the group */
export function visibleTiles(g: HeatmapGroup, max: number): { tiles: ResourceHealthStatus[]; more: number } {
  return g.resources.length > max ? { tiles: g.resources.slice(0, max), more: g.resources.length - max } : { tiles: g.resources, more: 0 };
}
