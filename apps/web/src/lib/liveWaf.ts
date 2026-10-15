// Front Door WAF on the live diagram (catalog EDGE-10 / EDGE-11) — pure, tested from apps/api/test/livePeering.test.ts.
// The API resolves every served domain to prevent / detect / disabled / none / unknown (services/frontDoorConfig.ts
// resolveAfdWaf) and sends the profile's state and counts as Front Door metadata. One card chip says it; the card
// status, health and fault impact never use it. Orange = a served domain whose configuration does not block
// (detect, disabled, none); unknown is never orange.
import type { AfdWafDomainState, AfdWafState } from "@aud/types";

export type WafCounts = { served: number; prevent: number; detect: number; disabled: number; none: number; unknown: number };
export type WafPolicyInfo = {
  name: string; sku: string | null; mode: string | null; enabled: boolean | null;
  managed: Array<{ type: string; version: string; action: string | null }> | null;
  customRules: number; domains: string[];
};
export type WafDomainInfo = { host: string; kind: "endpoint" | "custom"; policy?: string; state: AfdWafDomainState; reason?: "policyUnreadable" | "pathScoped" | "conflict" };
export type WafChip = { key: string; vars?: Record<string, string | number>; tone: "public" | "muted" | undefined; hint: { key: string; vars: Record<string, string | number> } };

const STATES = new Set<AfdWafState>(["prevent", "detect", "partial", "none", "unknown", "unreadable", "noDomains"]);
const parse = <T,>(v: string | undefined, fallback: T): T => { try { return v ? (JSON.parse(v) as T) : fallback; } catch { return fallback; } };

/** The WAF facts of a Front Door card (null = not a Front Door Standard/Premium, or an older diagram) */
export function wafFacts(meta: Record<string, string> | undefined): { state: AfdWafState; counts: WafCounts; policies: WafPolicyInfo[]; domains: WafDomainInfo[]; unserved: string[]; readError?: string } | null {
  const state = meta?.wafState as AfdWafState | undefined;
  if (!state || !STATES.has(state)) return null;
  return {
    state,
    counts: parse<WafCounts>(meta!.wafCounts, { served: 0, prevent: 0, detect: 0, disabled: 0, none: 0, unknown: 0 }),
    policies: parse<WafPolicyInfo[]>(meta!.wafPolicies, []),
    domains: parse<WafDomainInfo[]>(meta!.wafDomains, []),
    unserved: parse<string[]>(meta!.wafUnserved, []),
    ...(meta!.wafReadError ? { readError: meta!.wafReadError } : {}),
  };
}

/** Card chip (null = nothing to say: no domain served, or no WAF facts) */
export function wafChip(meta: Record<string, string> | undefined): WafChip | null {
  const f = wafFacts(meta);
  if (!f || f.state === "noDomains") return null;
  const c = f.counts;
  const hint = { key: "ld.chip.waf.hint", vars: { prevent: c.prevent, detect: c.detect, disabled: c.disabled, none: c.none, unknown: c.unknown, m: c.served } };
  switch (f.state) {
    case "unreadable": return { key: "ld.chip.waf.unknown", tone: "muted", hint: { key: "ld.chip.waf.unreadableHint", vars: {} } };
    case "prevent": return { key: "ld.chip.waf.prevent", tone: undefined, hint };
    case "none": return { key: "ld.chip.waf.none", tone: "public", hint };
    case "detect": return { key: "ld.chip.waf.detect", tone: "public", hint };
    case "partial": return { key: "ld.chip.waf.ratio", vars: { n: c.prevent, m: c.served }, tone: "public", hint };
    default: return { key: "ld.chip.waf.unknownN", vars: { u: c.unknown, m: c.served }, tone: "muted", hint };
  }
}
