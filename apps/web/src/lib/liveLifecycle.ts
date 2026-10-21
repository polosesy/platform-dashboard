// A resource's operation state on the live diagram — pure (no React), unit-tested from apps/api/test/lifecycle.test.ts.
// The API reads it on every poll (services/lifecycle.ts): what is in progress (updating, scaling, …) and, only when a
// record says it, why (a user's / an app's change, an Azure platform change, planned maintenance). On the card it
// is one neutral chip — never the status colour, never fault impact; the panel gives the change before → after.
import type { LiveLifecycle, LiveSpec } from "@aud/types";

export type LifecycleChip = {
  /** ld.lc.state.* or ld.lc.recent */
  stateKey: string;
  /** ld.lc.causeShort.* (omitted for a recent change by an unknown principal) */
  causeKey?: string;
  /** "info" while something runs, "muted" for a change that finished */
  tone: "info" | "muted" | "warn";
};

/** The card chip, or null when the resource is simply ready */
export function lifecycleChip(lc: LiveLifecycle | undefined): LifecycleChip | null {
  if (!lc) return null;
  if (lc.state === "ready") {
    if (lc.cause === "maintenance") return { stateKey: "ld.lc.maintenanceActive", tone: "info" };
    if (!lc.change) return null;
    return { stateKey: "ld.lc.recent", ...(lc.change.by !== "unknown" ? { causeKey: `ld.lc.causeShort.${lc.change.by}` } : {}), tone: "muted" };
  }
  return {
    stateKey: `ld.lc.state.${lc.state}`,
    ...(lc.cause ? { causeKey: `ld.lc.causeShort.${lc.cause}` } : {}),
    // A failed operation is already a warning in the card status (provisioning Failed) — the chip says the same
    tone: lc.state === "failed" ? "warn" : "info",
  };
}

/** A scale set's instance count as read now: actual, and the target when they differ */
export function instancesOf(live: LiveSpec | undefined): { n: number; target?: number } | null {
  const f = live?.facts.find((x) => x.k === "instances");
  if (!f || typeof f.v !== "number") return null;
  return { n: f.v, ...(live!.instancesTarget != null ? { target: live!.instancesTarget } : {}) };
}

export type SpecFactView = { k: string; v: string | number | boolean; live?: boolean };

/**
 * The panel's spec: the facts stored at generation, each replaced by the value read on this poll when there is one
 * (marked live); facts only the live read has are added at the end. Without a live read the stored facts stay.
 */
export function mergeSpecFacts(stored: ReadonlyArray<{ k: string; v: string | number | boolean }>, live: LiveSpec | undefined): SpecFactView[] {
  if (!live) return stored.map((f) => ({ ...f }));
  const now = new Map(live.facts.map((f) => [f.k, f.v] as const));
  const out: SpecFactView[] = stored.map((f) => (now.has(f.k) ? { k: f.k, v: now.get(f.k)!, live: true } : { ...f }));
  for (const f of live.facts) if (!stored.some((s) => s.k === f.k)) out.push({ k: f.k, v: f.v, live: true });
  return out;
}
