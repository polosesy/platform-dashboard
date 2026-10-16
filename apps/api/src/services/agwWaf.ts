// Application Gateway WAF (catalog AGW-08) — pure; tested from apps/api/test/agwWaf.test.ts.
// A WAF_v2 gateway takes a WAF policy at three levels — path rule > listener > gateway — or, on v1, the inline
// webApplicationFirewallConfiguration. Units = rule-bound HTTP listeners; public ones count toward the state, private
// ones are listed only. A listener whose path rules carry a policy in another state is "unknown" (path-scoped):
// one verdict per listener would be wrong. Standard / Standard_v2 cannot run a WAF at all (`skuNoWaf`).
// Learn: application-gateway/application-gateway-waf-configuration · web-application-firewall/ag/policy-overview
import { parseFrontends } from "./backendMembers.js";
import { policyState, wafAggregate, type WafCoverage, type WafCoveragePolicy, type WafCoverageTarget, type WafPolicyFacts } from "./wafCoverage.js";
import type { AfdWafDomainState, WafLevel } from "@aud/types";

type Obj = Record<string, unknown>;
const props = (x: unknown): Obj => ((x as { properties?: Obj } | undefined)?.properties ?? {});
const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
const nameOf = (x: unknown) => String((x as { name?: unknown } | undefined)?.name ?? "");
const idOf = (x: unknown) => {
  const id = (x as { id?: unknown } | undefined)?.id;
  return typeof id === "string" ? id.toLowerCase() : undefined;
};
const lastSeg = (id: string | undefined) => (id ?? "").split("/").pop() ?? "";
const byCode = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * WAF coverage of one Application Gateway (null = no rule-bound HTTP listener: nothing to protect).
 * `sku` = properties.sku ({ tier }); `wafById` null = the WAF policy query failed.
 */
export function resolveAgwWaf(properties: unknown, wafById: ReadonlyMap<string, WafPolicyFacts> | null): WafCoverage | null {
  const p = (properties ?? {}) as Obj;
  const tier = String((p.sku as { tier?: unknown } | undefined)?.tier ?? "");
  const gatewayPolicy = idOf(p.firewallPolicy);
  const legacy = p.webApplicationFirewallConfiguration as { enabled?: boolean; firewallMode?: string } | undefined;
  const kindOfListener = new Map<string, "public" | "private">();
  for (const f of parseFrontends("appGateway", p)) for (const l of f.listeners) kindOfListener.set(l.toLowerCase(), f.kind);

  // Rule-bound HTTP listeners, with the path maps their rules use
  const listeners = new Map(arr(p.httpListeners).map((l) => [nameOf(l).toLowerCase(), l]));
  const pathMaps = new Map(arr(p.urlPathMaps).map((m) => [nameOf(m).toLowerCase(), m]));
  const used = new Map<string, Set<string>>();
  for (const r of arr(p.requestRoutingRules)) {
    const rp = props(r);
    const ln = lastSeg(idOf(rp.httpListener)).toLowerCase();
    if (!listeners.has(ln)) continue;
    const maps = used.get(ln) ?? used.set(ln, new Set()).get(ln)!;
    const pm = lastSeg(idOf(rp.urlPathMap)).toLowerCase();
    if (pm) maps.add(pm);
  }
  if (!used.size) return null;

  const skuNoWaf = /^standard(_v2)?$/i.test(tier);
  const polOf = (id: string | undefined) => (id ? wafById?.get(id) : undefined);
  const stateOf = (id: string | undefined, level: WafLevel): { state: AfdWafDomainState; reason?: WafCoverageTarget["reason"]; level?: WafLevel; policyId?: string } => {
    if (id) return { ...policyState(polOf(id)), level, policyId: id };
    return { state: "none" };
  };
  const counts = { served: 0, prevent: 0, detect: 0, disabled: 0, none: 0, unknown: 0 };
  const targets: WafCoverageTarget[] = [];
  const policyUnits = new Map<string, { level: WafLevel; hosts: string[] }>();
  for (const ln of [...used.keys()].sort(byCode)) {
    const l = listeners.get(ln)!;
    const display = nameOf(l) || ln;
    const kind = kindOfListener.get(ln) ?? "private";
    const listenerPolicy = idOf(props(l).firewallPolicy);
    let v = listenerPolicy ? stateOf(listenerPolicy, "listener")
      : gatewayPolicy ? stateOf(gatewayPolicy, "gateway")
      : legacy ? { state: (legacy.enabled === false ? "disabled" : legacy.firewallMode?.toLowerCase() === "prevention" ? "prevent" : legacy.firewallMode?.toLowerCase() === "detection" ? "detect" : "unknown") as AfdWafDomainState, level: "legacy" as WafLevel }
      : stateOf(undefined, "gateway");
    // A path rule with its own policy in another state: no single verdict for the listener
    const pathPolicies = [...(used.get(ln) ?? [])].flatMap((pm) => arr(props(pathMaps.get(pm)).pathRules).map((pr) => idOf(props(pr).firewallPolicy)).filter((x): x is string => !!x));
    for (const pid of new Set(pathPolicies)) {
      const ps = stateOf(pid, "path");
      (policyUnits.get(pid) ?? policyUnits.set(pid, { level: "path", hosts: [] }).get(pid)!).hosts.push(display);
      if (ps.state !== v.state) v = { state: "unknown", reason: "pathScoped" };
    }
    if (v.policyId) {
      const e = policyUnits.get(v.policyId) ?? policyUnits.set(v.policyId, { level: v.level!, hosts: [] }).get(v.policyId)!;
      if (!e.hosts.includes(display)) e.hosts.push(display);
    }
    const pol = v.policyId ? polOf(v.policyId) : undefined;
    targets.push({
      host: display, kind, state: v.state,
      ...(v.policyId ? { policy: pol?.name || lastSeg(v.policyId) } : v.level === "legacy" ? { policy: "WAF" } : {}),
      ...(v.reason ? { reason: v.reason } : {}),
      ...(v.level ? { level: v.level } : {}),
    });
    // Only public listeners are an Internet-facing unit; private ones are listed
    if (kind === "public") { counts.served++; counts[v.state]++; }
  }
  const policies: WafCoveragePolicy[] = [...policyUnits].sort(([a], [b]) => byCode(a, b)).slice(0, 20).map(([pid, u]) => {
    const pol = polOf(pid);
    return { ...(pol ?? { name: lastSeg(pid), sku: null, mode: null, enabled: null, managed: null, customRules: 0 }), id: pid, level: u.level, domains: u.hosts.sort(byCode) };
  });
  if (!gatewayPolicy && legacy && !policies.length) {
    policies.push({
      name: "WAF", sku: tier || null, mode: legacy.firewallMode ?? null, enabled: legacy.enabled ?? null, managed: null, customRules: 0, level: "legacy",
      domains: targets.map((x) => x.host),
    });
  }
  return {
    unit: "listener", state: wafAggregate(counts), counts, policies, domains: targets.slice(0, 100), unserved: [],
    ...(wafById ? {} : { readError: "wafPolicies" as const }),
    ...(skuNoWaf && !gatewayPolicy && !legacy && !policies.length ? { skuNoWaf: true } : {}),
  };
}
