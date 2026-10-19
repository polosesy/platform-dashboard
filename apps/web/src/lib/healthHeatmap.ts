// Resource Health heatmap (/health, instance tab) — pure; tested from apps/api/test/healthHeatmap.test.ts.
// One tile per resource, grouped by type / resource group / region. Worst first: groups with problems come first,
// and inside a group Unavailable → Degraded → Unknown → Available → Unknown on a type not on Microsoft's supported
// list (shown "–", not "?"), then by name (code points — deterministic).
// The data is the current state only (Resource Health availabilityStatuses), so nothing here implies a trend.
import type { ResourceHealthStatus } from "@aud/types";
import type { UiColor } from "./palette";

export type HealthState = ResourceHealthStatus["availabilityState"];
export type HeatmapGroupBy = "type" | "rg" | "region";

/** Lower = worse */
export const STATE_RANK: Record<HealthState, number> = { Unavailable: 0, Degraded: 1, Unknown: 2, Available: 3 };
export const STATES: HealthState[] = ["Unavailable", "Degraded", "Unknown", "Available"];
/** Display rank of an Unknown on a type not on the supported list — after Available */
export const UNLISTED_RANK = 4;

export type TileTone = { color: UiColor; alpha: number; glyph: string; dashed: boolean; hatched: boolean };

/**
 * Tile look per state — never color alone: a glyph for the problem states, a dashed outline for Unknown, a hatched
 * tile with "–" for Unknown on a type Microsoft does not list. Unknown is neutral (not measured is not a risk),
 * Available is quiet so problems stand out.
 */
export function stateTone(state: HealthState, userInitiated = false, unlisted = false): TileTone {
  // Still Unavailable (Azure's state), in a lighter red: a user stopped it, not a platform fault
  if (state === "Unavailable" && userInitiated) return { color: "danger", alpha: 0.4, glyph: "✕", dashed: false, hatched: false };
  // Unknown on a type Microsoft does not list for Resource Health: nothing to know, not a missing signal
  if (state === "Unknown" && unlisted) return { color: "ink", alpha: 0.05, glyph: "–", dashed: false, hatched: true };
  switch (state) {
    case "Unavailable": return { color: "danger", alpha: 0.85, glyph: "✕", dashed: false, hatched: false };
    case "Degraded": return { color: "warning", alpha: 0.85, glyph: "!", dashed: false, hatched: false };
    case "Unknown": return { color: "ink", alpha: 0.18, glyph: "?", dashed: true, hatched: false };
    default: return { color: "ok", alpha: 0.55, glyph: "", dashed: false, hatched: false };
  }
}

export type HeatmapGroup = {
  /** Group key (the raw type / resource group / region; "" = no region) */
  key: string;
  /** What to show: the type's name, the resource group, the region */
  label: string;
  resources: ResourceHealthStatus[];
  /** Azure's states (an unlisted-Unknown is still counted Unknown) */
  counts: Record<HealthState, number>;
  /** Of Unknown: on a type not on the supported list */
  unlisted: number;
  /** The worst state in the group (Azure's) and its display rank — an all-unlisted group ranks last */
  worst: HealthState;
  worstRank: number;
};

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const stateOf = (r: ResourceHealthStatus): HealthState => (r.availabilityState in STATE_RANK ? r.availabilityState : "Unknown");
const NONE: ReadonlySet<string> = new Set();

export function groupKey(r: ResourceHealthStatus, by: HeatmapGroupBy): string {
  if (by === "type") return (r.resourceType ?? "").toLowerCase();
  if (by === "rg") return (r.resourceGroup ?? "").toLowerCase();
  return (r.location ?? "").toLowerCase();
}

/**
 * A resource type as "<namespace> · <type>" — the fallback when the portal-name table (lib/azureTypes) does not
 * have the type. Facts only: the ARM names without "Microsoft.".
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

/**
 * Unknown on a type that is not on Microsoft's supported list (the coverage API's `statusUnlisted` types — e.g.
 * metric alert rules). Decided by the type, never by Azure's text; any other state on such a type is Azure's real
 * value and stays as it is.
 */
export const isUnlistedUnknown = (r: ResourceHealthStatus, unlisted: ReadonlySet<string>) =>
  r.availabilityState === "Unknown" && unlisted.has((r.resourceType ?? "").toLowerCase());

/** Display order (lower = worse): Azure's state, an unlisted-Unknown after Available */
export const displayRank = (r: ResourceHealthStatus, unlisted: ReadonlySet<string> = NONE) =>
  isUnlistedUnknown(r, unlisted) ? UNLISTED_RANK : STATE_RANK[stateOf(r)];

/** Tile comparator inside a group: worst first, then by name, then by id */
export const byTile = (unlisted: ReadonlySet<string> = NONE) => (a: ResourceHealthStatus, b: ResourceHealthStatus) =>
  displayRank(a, unlisted) - displayRank(b, unlisted) || cmp(a.resourceName.toLowerCase(), b.resourceName.toLowerCase()) || cmp(a.resourceId, b.resourceId);

export type GroupOptions = {
  /** Types not on the supported list (coverage `statusUnlisted`) — empty when coverage is not known */
  unlisted?: ReadonlySet<string>;
  /** Name of a type (the portal name); default typeLabel */
  typeName?: (type: string) => string;
};

function groupLabel(r: ResourceHealthStatus, by: HeatmapGroupBy, typeName: (type: string) => string): string {
  if (by === "type") return typeName(r.resourceType ?? "");
  if (by === "rg") return r.resourceGroup ?? "";
  return r.location ?? "";
}

/**
 * Groups, worst first: by the worst display rank, then by how many resources have a problem (Unavailable, then
 * Degraded), then by size, then by key. A resource without a region goes to the "" group (shown last among equals).
 */
export function groupResources(resources: ResourceHealthStatus[], by: HeatmapGroupBy, opts: GroupOptions = {}): HeatmapGroup[] {
  const unlisted = opts.unlisted ?? NONE;
  const typeName = opts.typeName ?? typeLabel;
  const groups = new Map<string, HeatmapGroup>();
  for (const r of resources) {
    const key = groupKey(r, by);
    let g = groups.get(key);
    if (!g) {
      g = { key, label: groupLabel(r, by, typeName), resources: [], counts: { Unavailable: 0, Degraded: 0, Unknown: 0, Available: 0 }, unlisted: 0, worst: "Available", worstRank: Infinity };
      groups.set(key, g);
    }
    const s = stateOf(r);
    const rank = displayRank(r, unlisted);
    g.resources.push(r);
    g.counts[s]++;
    if (rank === UNLISTED_RANK) g.unlisted++;
    if (rank < g.worstRank) { g.worstRank = rank; g.worst = s; }
  }
  const tile = byTile(unlisted);
  for (const g of groups.values()) g.resources.sort(tile);
  return [...groups.values()].sort((a, b) =>
    a.worstRank - b.worstRank
    || b.counts.Unavailable - a.counts.Unavailable
    || b.counts.Degraded - a.counts.Degraded
    || b.resources.length - a.resources.length
    || (a.key === "" ? 1 : 0) - (b.key === "" ? 1 : 0)
    || cmp(a.key, b.key));
}

/** The "표시 범위" options: every group in heatmap order (problems first), with its size */
export const scopeOptions = (groups: HeatmapGroup[]) => groups.map((g) => ({ key: g.key, label: g.label, n: g.resources.length }));

/** Counts of a group for its header: user-initiated Unavailable and unlisted-Unknown counted apart */
export function groupStateCounts(g: HeatmapGroup): { unavailable: number; user: number; degraded: number; unknown: number; unlisted: number; available: number } {
  const user = g.resources.filter(isUserInitiated).length;
  return { unavailable: g.counts.Unavailable - user, user, degraded: g.counts.Degraded, unknown: g.counts.Unknown - g.unlisted, unlisted: g.unlisted, available: g.counts.Available };
}

/** At most `max` tiles per group; the rest is a "+k" that filters the list to the group */
export function visibleTiles(g: HeatmapGroup, max: number): { tiles: ResourceHealthStatus[]; more: number } {
  return g.resources.length > max ? { tiles: g.resources.slice(0, max), more: g.resources.length - max } : { tiles: g.resources, more: 0 };
}
