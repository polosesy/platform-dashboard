// WAF on the live diagram — Front Door (catalog EDGE-10/11, per served domain) and Application Gateway (AGW-08, per
// rule-bound listener). Pure, tested from apps/api/test/afdWaf.test.ts. The API resolves each unit to prevent /
// detect / disabled / none / unknown (services/wafCoverage.ts) and sends it as card metadata. On the card: one WAF
// badge (icon + state word, toggles the policy sub-cards); the card status, health and fault impact never use it.
// Orange = a unit whose configuration does not block (detect, disabled, none); unknown is never orange; never red.
import type { AfdWafDomainState, AfdWafState, WafLevel, WafTargetKind, WafUnit } from "@aud/types";
import { LIVE } from "./liveLayout";

export type WafCounts = { served: number; prevent: number; detect: number; disabled: number; none: number; unknown: number };
export type WafPolicyInfo = {
  id?: string; name: string; sku: string | null; mode: string | null; enabled: boolean | null;
  managed: Array<{ type: string; version: string; action: string | null }> | null;
  customRules: number; domains: string[]; level?: WafLevel;
};
export type WafDomainInfo = { host: string; kind: WafTargetKind; policy?: string; state: AfdWafDomainState; reason?: "policyUnreadable" | "pathScoped" | "conflict"; level?: WafLevel };
export type WafTone = "neutral" | "public" | "muted";
export type WafFacts = {
  state: AfdWafState; unit: WafUnit; counts: WafCounts; policies: WafPolicyInfo[]; domains: WafDomainInfo[];
  unserved: string[]; readError?: string; skuNoWaf?: boolean;
};
export type WafBadge = {
  labelKey: string; vars?: Record<string, string | number>; tone: WafTone;
  /** the full wording for screen readers and the summary-zoom title (ld.chip.waf.*) */
  ariaKey: string; ariaVars?: Record<string, string | number>;
  hint: { key: string; vars: Record<string, string | number> };
};
export type WafSubCard = {
  /** "p:<policy name>" · "more" · "none" · "unknown" — also the panel key */
  key: string;
  kind: "policy" | "more" | "none" | "unknown";
  name?: string;
  pill: string;
  tone: WafTone;
  units: number;
  managed?: number | null;
  custom?: number;
  level?: WafLevel;
  /** none bucket: how many of the units are a Front Door endpoint's default domain */
  endpointNone?: number;
  more?: number;
};

/** Policy cards shown before "+k" — the rest are in the WAF panel */
export const MAX_POLICY_CARDS = 4;

const STATES = new Set<AfdWafState>(["prevent", "detect", "partial", "none", "unknown", "unreadable", "noDomains"]);
const parse = <T,>(v: string | undefined, fallback: T): T => { try { return v ? (JSON.parse(v) as T) : fallback; } catch { return fallback; } };
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The WAF facts of a Front Door / Application Gateway card (null = none, or a diagram made before WAF was read) */
export function wafFacts(meta: Record<string, string> | undefined): WafFacts | null {
  const state = meta?.wafState as AfdWafState | undefined;
  if (!state || !STATES.has(state)) return null;
  return {
    state,
    unit: meta!.wafUnit === "listener" ? "listener" : "domain",
    counts: parse<WafCounts>(meta!.wafCounts, { served: 0, prevent: 0, detect: 0, disabled: 0, none: 0, unknown: 0 }),
    policies: parse<WafPolicyInfo[]>(meta!.wafPolicies, []),
    domains: parse<WafDomainInfo[]>(meta!.wafDomains, []),
    unserved: parse<string[]>(meta!.wafUnserved, []),
    ...(meta!.wafReadError ? { readError: meta!.wafReadError } : {}),
    ...(meta!.wafSkuNoWaf === "true" ? { skuNoWaf: true } : {}),
  };
}

/** Card badge (null = nothing to protect: no served domain / public listener, or no WAF facts) */
export function wafBadge(meta: Record<string, string> | undefined): WafBadge | null {
  const f = wafFacts(meta);
  if (!f || f.state === "noDomains") return null;
  const c = f.counts;
  const hint = { key: f.unit === "listener" ? "ld.waf.hint.listeners" : "ld.chip.waf.hint", vars: { prevent: c.prevent, detect: c.detect, disabled: c.disabled, none: c.none, unknown: c.unknown, m: c.served } };
  switch (f.state) {
    case "unreadable": return { labelKey: "ld.waf.badge.unknown", tone: "muted", ariaKey: "ld.chip.waf.unknown", hint: { key: "ld.chip.waf.unreadableHint", vars: {} } };
    case "prevent": return { labelKey: "ld.waf.badge.prevent", tone: "neutral", ariaKey: "ld.chip.waf.prevent", hint };
    case "none": return { labelKey: "ld.waf.badge.none", tone: "public", ariaKey: "ld.chip.waf.none", hint: f.skuNoWaf ? { key: "ld.waf.agw.skuNoWaf", vars: {} } : hint };
    case "detect": return { labelKey: "ld.waf.badge.detect", tone: "public", ariaKey: "ld.chip.waf.detect", hint };
    case "partial": return { labelKey: "ld.waf.badge.ratio", vars: { n: c.prevent, m: c.served }, tone: "public", ariaKey: "ld.chip.waf.ratio", ariaVars: { n: c.prevent, m: c.served }, hint };
    default: return { labelKey: "ld.waf.badge.unknownN", vars: { u: c.unknown, m: c.served }, tone: "muted", ariaKey: "ld.chip.waf.unknownN", ariaVars: { u: c.unknown, m: c.served }, hint };
  }
}

/** A policy's own pill: its mode and state (not the state of the units it covers) */
export function policyPill(p: Pick<WafPolicyInfo, "mode" | "enabled">): { pill: string; tone: WafTone } {
  if (p.enabled === false) return { pill: "ld.waf.pill.disabled", tone: "public" };
  const mode = p.mode?.toLowerCase();
  if (mode === "prevention") return { pill: "ld.waf.pill.prevention", tone: "neutral" };
  if (mode === "detection") return { pill: "ld.waf.pill.detection", tone: "public" };
  return { pill: "ld.waf.pill.unknown", tone: "muted" };
}

const RANK: Record<WafTone, number> = { public: 0, muted: 1, neutral: 2 };

/**
 * The sub-cards under a protected card: policies that do not block first (detection, disabled), then unknown mode,
 * then prevention — more units first, then name (code points); at most MAX_POLICY_CARDS, then "+k"; then the units
 * without a WAF and the units not judged, always shown. Deterministic.
 */
export function wafSubCards(meta: Record<string, string> | undefined): WafSubCard[] {
  const f = wafFacts(meta);
  if (!f || f.state === "noDomains") return [];
  const policies = f.policies.map((p): WafSubCard => ({
    key: `p:${p.name}`, kind: "policy", name: p.name, ...policyPill(p), units: p.domains.length,
    managed: p.managed ? p.managed.length : null, custom: p.customRules, ...(p.level ? { level: p.level } : {}),
  })).sort((a, b) => RANK[a.tone] - RANK[b.tone] || b.units - a.units || cmp(a.name!, b.name!));
  const out = policies.slice(0, MAX_POLICY_CARDS);
  if (policies.length > MAX_POLICY_CARDS) out.push({ key: "more", kind: "more", pill: "ld.waf.pill.more", tone: "muted", units: 0, more: policies.length - MAX_POLICY_CARDS });
  const counted = (d: WafDomainInfo) => f.unit === "domain" || d.kind === "public";
  if (f.counts.none > 0) {
    out.push({ key: "none", kind: "none", pill: "ld.waf.pill.noBlock", tone: "public", units: f.counts.none, endpointNone: f.domains.filter((d) => d.state === "none" && d.kind === "endpoint" && counted(d)).length });
  }
  if (f.counts.unknown > 0) out.push({ key: "unknown", kind: "unknown", pill: "ld.waf.pill.unknown", tone: "muted", units: f.counts.unknown });
  return out;
}

/** Room the open sub-cards take below their card (same rhythm as the VMSS instance cards) */
export function wafAttachHeight(n: number): number {
  return n > 0 ? LIVE.SUB_TOP + n * LIVE.SUB_H + (n - 1) * LIVE.SUB_GAP : 0;
}
