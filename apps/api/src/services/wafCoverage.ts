// WAF coverage of a protected entry point — shared by Front Door (catalog EDGE-10/11, per served domain) and
// Application Gateway (AGW-08, per rule-bound listener). Pure; tested from apps/api/test/afdWaf.test.ts and
// agwWaf.test.ts. Configuration only: it labels the card (WAF badge + policy sub-cards), never its status.
import type { AfdWafDomainState, AfdWafState, WafLevel, WafTargetKind, WafUnit } from "@aud/types";

/** A WAF policy as Resource Graph shows it (Front Door or Application Gateway policy types) */
export type WafPolicyFacts = {
  /** lower-case ARM id (Portal link / copy in the panel; never a node) */
  id?: string;
  name: string;
  sku: string | null;
  mode: string | null;
  enabled: boolean | null;
  /** null = the property was absent (Resource Graph omits empty arrays — not "none") */
  managed: Array<{ type: string; version: string; action: string | null }> | null;
  customRules: number;
};

export type WafCoveragePolicy = WafPolicyFacts & { level?: WafLevel; domains: string[] };
export type WafCoverageTarget = {
  host: string;
  kind: WafTargetKind;
  policy?: string;
  state: AfdWafDomainState;
  reason?: "policyUnreadable" | "pathScoped" | "conflict";
  level?: WafLevel;
};
export type WafCoverage = {
  unit: WafUnit;
  state: AfdWafState;
  /** `served` = the units that count (served domains / public rule-bound listeners) */
  counts: { served: number; prevent: number; detect: number; disabled: number; none: number; unknown: number };
  policies: WafCoveragePolicy[];
  domains: WafCoverageTarget[];
  /** associated with a WAF but used by no active route (Front Door; panel only) */
  unserved: string[];
  readError?: "securityPolicies" | "wafPolicies";
  /** Application Gateway SKU that cannot run a WAF (Standard / Standard_v2) */
  skuNoWaf?: boolean;
};

/** One Resource Graph row of a WAF policy → facts */
export function wafPolicyFacts(row: { id?: string; name?: string; sku?: { name?: string } | string | null; properties?: Record<string, unknown> }): WafPolicyFacts {
  const p = (row.properties ?? {}) as {
    policySettings?: { mode?: string; enabledState?: string; state?: string };
    managedRules?: { managedRuleSets?: Array<{ ruleSetType?: string; ruleSetVersion?: string; ruleSetAction?: string }> };
    customRules?: { rules?: unknown[] } | unknown[];
  };
  const sets = p.managedRules?.managedRuleSets;
  const custom = Array.isArray(p.customRules) ? p.customRules : p.customRules?.rules ?? [];
  const enabledRaw = p.policySettings?.enabledState ?? p.policySettings?.state;
  return {
    ...(row.id ? { id: row.id.toLowerCase() } : {}),
    name: row.name ?? "",
    sku: typeof row.sku === "string" ? row.sku : row.sku?.name ?? null,
    mode: p.policySettings?.mode ?? null,
    enabled: enabledRaw == null ? null : enabledRaw !== "Disabled",
    managed: Array.isArray(sets) ? sets.map((m) => ({ type: m.ruleSetType ?? "", version: m.ruleSetVersion ?? "", action: m.ruleSetAction ?? null })) : null,
    customRules: custom.length,
  };
}

/** The state of one unit under a policy (or a legacy configuration) */
export function policyState(pol: Pick<WafPolicyFacts, "mode" | "enabled"> | undefined): { state: AfdWafDomainState; reason?: "policyUnreadable" } {
  if (!pol) return { state: "unknown", reason: "policyUnreadable" };
  if (pol.enabled === false) return { state: "disabled" };
  const mode = pol.mode?.toLowerCase();
  if (pol.enabled && mode === "prevention") return { state: "prevent" };
  if (pol.enabled && mode === "detection") return { state: "detect" };
  return { state: "unknown", reason: "policyUnreadable" };
}

/** Profile / gateway state from the unit counts: all prevent, all none, all detect, a gap, or only unknowns left */
export function wafAggregate(c: WafCoverage["counts"]): AfdWafState {
  const n = c.served;
  return n === 0 ? "noDomains"
    : c.prevent === n ? "prevent"
    : c.none === n ? "none"
    : c.detect === n ? "detect"
    : c.detect + c.disabled + c.none > 0 ? "partial"
    : "unknown";
}

/** Card / panel metadata (strings — the spec is shared JSON) */
export function wafMetadata(w: WafCoverage | undefined): Record<string, string> {
  if (!w) return {};
  return {
    wafState: w.state,
    wafUnit: w.unit,
    wafCounts: JSON.stringify(w.counts),
    wafPolicies: JSON.stringify(w.policies),
    wafDomains: JSON.stringify(w.domains),
    ...(w.unserved.length ? { wafUnserved: JSON.stringify(w.unserved) } : {}),
    ...(w.readError ? { wafReadError: w.readError } : {}),
    ...(w.skuNoWaf ? { wafSkuNoWaf: "true" } : {}),
  };
}
