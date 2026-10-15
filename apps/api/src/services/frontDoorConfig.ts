// Azure Front Door Standard/Premium (microsoft.cdn/profiles, sku *_AzureFrontDoor): the routing configuration that
// Resource Graph does not carry (origin groups, origins, routes are ARM child resources — read with GET), and the
// pure resolution of each origin to a resource in the graph. Catalog rows EDGE-04..07; tested from
// apps/api/test/frontDoor.test.ts.
//
// Learn: origins and origin groups https://learn.microsoft.com/azure/frontdoor/origin · routes
// https://learn.microsoft.com/azure/frontdoor/front-door-route-matching · Private Link origins (Premium)
// https://learn.microsoft.com/azure/frontdoor/private-link · WAF on Standard/Premium is attached per domain by a
// security policy (catalog EDGE-10; coverage over the routes' domains EDGE-11)
// https://learn.microsoft.com/azure/web-application-firewall/afds/afds-overview
import type { AfdWafDomainState, AfdWafState } from "@aud/types";
import { CacheManager } from "../infra/cacheManager.js";
import { debug } from "../infra/logger.js";
import type { AddressIndex } from "./backendMembers.js";

const API = "2024-02-01";

export type AfdOrigin = {
  group: string;
  name: string;
  hostName: string;
  enabled: boolean;
  /** EDGE-06: the Azure resource the origin was picked from (App Service, Storage …) */
  azureOriginId?: string;
  /** EDGE-07: Premium Private Link origin — the target resource and the approval state */
  privateLinkId?: string;
  privateLinkStatus?: string;
};
export type AfdRoute = {
  endpoint: string; name: string; originGroup: string; enabled: boolean;
  /** EDGE-11: the domains the route serves — custom domain ids, plus the endpoint's own domain unless unlinked */
  customDomains?: string[];
  linkToDefaultDomain?: boolean;
};
/** EDGE-10: a WAF security policy — the WAF policy and the domains (afdEndpoints/… or customDomains/…) it covers */
export type AfdSecurityPolicy = { wafPolicyId: string; domains: string[]; patterns: string[] };
export type AfdConfig = {
  endpoints: Array<{ name: string; hostName: string; enabled: boolean }>;
  routes: AfdRoute[];
  origins: AfdOrigin[];
  /** null = the security policies could not be read (never "no WAF"); undefined = not asked (tests, old cache) */
  securityPolicies?: AfdSecurityPolicy[] | null;
  /** custom domain id → host name (panel only) */
  customDomainHosts?: Record<string, string>;
};

type Fetcher = { fetchJson<T>(url: string): Promise<T> };
type List<T> = { value?: T[]; nextLink?: string };
type Child = { name?: string; id?: string; properties?: Record<string, unknown> };

const cache = new CacheManager<AfdConfig>(200, 10 * 60_000);
const inflight = new Map<string, Promise<AfdConfig>>();
const lastSeg = (id: unknown) => String(id ?? "").split("/").pop()?.toLowerCase() ?? "";

async function list(f: Fetcher, url: string): Promise<Child[]> {
  return (await listAll(f, url)).items;
}

/** All pages (at most 10); `truncated` = a next page was left — a cut list must not read as "not there" */
async function listAll(f: Fetcher, url: string): Promise<{ items: Child[]; truncated: boolean }> {
  const out: Child[] = [];
  let next: string | undefined = url;
  for (let i = 0; next && i < 10; i++) {
    const page: List<Child> = await f.fetchJson<List<Child>>(next);
    out.push(...(page.value ?? []));
    next = page.nextLink;
  }
  return { items: out, truncated: !!next };
}

/** Security policies of type WebApplicationFirewall (EDGE-10); null when unreadable or cut short */
async function readSecurityPolicies(f: Fetcher, base: string): Promise<AfdSecurityPolicy[] | null> {
  try {
    const { items, truncated } = await listAll(f, `${base}/securityPolicies?api-version=${API}`);
    if (truncated) return null;
    const out: AfdSecurityPolicy[] = [];
    for (const x of items) {
      type Par = { type?: string; wafPolicy?: { id?: string }; associations?: Array<{ domains?: Array<{ id?: string }>; patternsToMatch?: string[] }> };
      const par = (x.properties?.parameters ?? {}) as Par;
      if (par.type !== "WebApplicationFirewall" || !par.wafPolicy?.id) continue;
      const assoc = par.associations ?? [];
      out.push({
        wafPolicyId: par.wafPolicy.id.toLowerCase(),
        domains: assoc.flatMap((a) => (a.domains ?? []).map((d) => String(d.id ?? "").toLowerCase())).filter(Boolean),
        patterns: [...new Set(assoc.flatMap((a) => a.patternsToMatch ?? []))],
      });
    }
    return out;
  } catch (e) {
    debug(`[afd] security policies not read: ${String(e).slice(0, 120)}`);
    return null;
  }
}

/** Map with at most `width` calls in flight; results in input order */
async function pool<T, R>(items: T[], f: (x: T) => Promise<R>, width = 6): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await f(items[i]!); }
  }));
  return out;
}

/** Origin groups → origins, endpoints → routes of one profile (cached per caller identity for 10 minutes) */
export async function fetchFrontDoorConfig(fetcher: Fetcher, profileId: string, cacheKey: string): Promise<AfdConfig> {
  const key = `${cacheKey}:afd:${profileId.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const running = inflight.get(key);
  if (running) return running;
  const base = `https://management.azure.com${profileId}`;
  const task = (async () => {
    const [groups, endpoints, securityPolicies, customDomains] = await Promise.all([
      list(fetcher, `${base}/originGroups?api-version=${API}`),
      list(fetcher, `${base}/afdEndpoints?api-version=${API}`),
      // WAF (EDGE-10): a failure leaves the routing configuration valid — read apart, null = unknown
      readSecurityPolicies(fetcher, base),
      // host names of custom domains, for the panel only
      list(fetcher, `${base}/customDomains?api-version=${API}`).catch(() => [] as Child[]),
    ]);
    // Children of every group / endpoint at once (a profile with 20 routes took ~20 s one by one)
    const [originLists, routeLists] = await Promise.all([
      pool(groups, (g) => list(fetcher, `${base}/originGroups/${encodeURIComponent(g.name ?? "")}/origins?api-version=${API}`)),
      pool(endpoints, (e) => list(fetcher, `${base}/afdEndpoints/${encodeURIComponent(e.name ?? "")}/routes?api-version=${API}`)),
    ]);
    const origins: AfdOrigin[] = [];
    for (const [gi, g] of groups.entries()) {
      for (const o of originLists[gi] ?? []) {
        const p = o.properties ?? {};
        const spl = p.sharedPrivateLinkResource as { privateLink?: { id?: string }; status?: string } | undefined;
        origins.push({
          group: (g.name ?? "").toLowerCase(), name: o.name ?? "", hostName: String(p.hostName ?? "").toLowerCase(),
          enabled: String(p.enabledState ?? "Enabled") !== "Disabled",
          ...((p.azureOrigin as { id?: string } | undefined)?.id ? { azureOriginId: String((p.azureOrigin as { id: string }).id).toLowerCase() } : {}),
          ...(spl?.privateLink?.id ? { privateLinkId: spl.privateLink.id.toLowerCase(), privateLinkStatus: spl.status } : {}),
        });
      }
    }
    const routes: AfdRoute[] = [];
    for (const [ei, e] of endpoints.entries()) {
      for (const r of routeLists[ei] ?? []) {
        const p = r.properties ?? {};
        routes.push({
          endpoint: e.name ?? "", name: r.name ?? "", originGroup: lastSeg((p.originGroup as { id?: string } | undefined)?.id),
          enabled: String(p.enabledState ?? "Enabled") !== "Disabled",
          customDomains: ((p.customDomains as Array<{ id?: string }> | undefined) ?? []).map((d) => String(d.id ?? "").toLowerCase()).filter(Boolean),
          linkToDefaultDomain: String(p.linkToDefaultDomain ?? "Enabled") !== "Disabled",
        });
      }
    }
    const cfg: AfdConfig = {
      endpoints: endpoints.map((e) => ({ name: e.name ?? "", hostName: String(e.properties?.hostName ?? ""), enabled: String(e.properties?.enabledState ?? "Enabled") !== "Disabled" })),
      routes, origins, securityPolicies,
      customDomainHosts: Object.fromEntries(customDomains.filter((d) => d.id).map((d) => [String(d.id).toLowerCase(), String(d.properties?.hostName ?? d.name ?? "")])),
    };
    debug(`[afd] ${lastSeg(profileId)}: endpoints ${cfg.endpoints.length} routes ${routes.length} origins ${origins.length} waf ${securityPolicies?.length ?? "unread"}`);
    // A partial read (WAF unknown) is kept one minute, not ten
    cache.set(key, cfg, securityPolicies ? undefined : 60_000);
    return cfg;
  })().finally(() => inflight.delete(key));
  inflight.set(key, task);
  return task;
}

export type AfdOriginLink = {
  rel: "EDGE-04" | "EDGE-05" | "EDGE-06" | "EDGE-07";
  targetId: string;
  origin: string;
  group: string;
  evidence: "cfg" | "ipMatch" | "fqdnMatch";
  /** EDGE-07: Private Link approval state reported by Front Door */
  status?: string;
};

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * Each enabled origin of a group an enabled route uses, to exactly one resource — first match wins:
 * Private Link target (EDGE-07, cfg) > azureOrigin (EDGE-06, cfg) > an IP literal held by exactly one public IP's
 * owner (EDGE-05, ipMatch) > a host name equal to exactly one App Service / Container App / AGC frontend / public IP
 * DNS name (EDGE-04, fqdnMatch, no DNS lookup). Everything else is counted as external — never guessed.
 * `ownerOf` maps an address-index target (a NIC) to the node drawn for it (its VM).
 */
export function resolveAfdOrigins(
  cfg: AfdConfig,
  idx: AddressIndex,
  known: ReadonlySet<string>,
  ownerOf: (id: string) => string = (id) => id,
): { links: AfdOriginLink[]; external: number; ambiguous: number; unusedGroups: number } {
  const used = new Set(activeRoutes(cfg).map((r) => r.originGroup));
  const links: AfdOriginLink[] = [];
  let external = 0, ambiguous = 0;
  for (const o of cfg.origins) {
    if (!o.enabled || !used.has(o.group)) continue;
    const base = { origin: o.name, group: o.group };
    if (o.privateLinkId && known.has(o.privateLinkId)) { links.push({ ...base, rel: "EDGE-07", targetId: o.privateLinkId, evidence: "cfg", ...(o.privateLinkStatus ? { status: o.privateLinkStatus } : {}) }); continue; }
    if (o.azureOriginId && known.has(o.azureOriginId)) { links.push({ ...base, rel: "EDGE-06", targetId: o.azureOriginId, evidence: "cfg" }); continue; }
    const hits = idx.get(o.hostName) ?? [];
    const ip = IPV4.test(o.hostName);
    const cand = [...new Set(hits.filter((h) => (ip ? h.source === "pip" : h.source === "site" || h.source === "containerApp" || h.source === "agcFrontend" || h.source === "pipFqdn")).map((h) => ownerOf(h.targetId)))].filter((id) => known.has(id));
    if (cand.length === 1) { links.push({ ...base, rel: ip ? "EDGE-05" : "EDGE-04", targetId: cand[0]!, evidence: ip ? "ipMatch" : "fqdnMatch" }); continue; }
    if (cand.length > 1) ambiguous++;
    else external++;
  }
  const groups = new Set(cfg.origins.map((o) => o.group));
  return { links, external, ambiguous, unusedGroups: [...groups].filter((g) => !used.has(g)).length };
}

/** Enabled routes on enabled endpoints — what actually takes traffic */
export function activeRoutes(cfg: AfdConfig): AfdRoute[] {
  const off = new Set(cfg.endpoints.filter((e) => !e.enabled).map((e) => e.name.toLowerCase()));
  return cfg.routes.filter((r) => r.enabled && !off.has(r.endpoint.toLowerCase()));
}

/** A WAF policy as Resource Graph shows it (microsoft.network/frontdoorwebapplicationfirewallpolicies) */
export type WafPolicyFacts = {
  name: string;
  sku: string | null;
  mode: string | null;
  enabled: boolean | null;
  /** null = the property was absent (Resource Graph omits empty arrays — not "none") */
  managed: Array<{ type: string; version: string; action: string | null }> | null;
  customRules: number;
};

export type AfdWafDomain = {
  host: string;
  kind: "endpoint" | "custom";
  policy?: string;
  state: AfdWafDomainState;
  reason?: "policyUnreadable" | "pathScoped" | "conflict";
};
export type AfdWaf = {
  state: AfdWafState;
  counts: { served: number; prevent: number; detect: number; disabled: number; none: number; unknown: number };
  policies: Array<WafPolicyFacts & { domains: string[] }>;
  domains: AfdWafDomain[];
  /** associated with a WAF but served by no active route (panel only) */
  unserved: string[];
  readError?: "securityPolicies" | "wafPolicies";
};

/** One Resource Graph row of a WAF policy → facts (Front Door or Application Gateway policy types) */
export function wafPolicyFacts(row: { name?: string; sku?: { name?: string } | string | null; properties?: Record<string, unknown> }): WafPolicyFacts {
  const p = (row.properties ?? {}) as {
    policySettings?: { mode?: string; enabledState?: string; state?: string };
    managedRules?: { managedRuleSets?: Array<{ ruleSetType?: string; ruleSetVersion?: string; ruleSetAction?: string }> };
    customRules?: { rules?: unknown[] } | unknown[];
  };
  const sets = p.managedRules?.managedRuleSets;
  const custom = Array.isArray(p.customRules) ? p.customRules : p.customRules?.rules ?? [];
  const enabledRaw = p.policySettings?.enabledState ?? p.policySettings?.state;
  return {
    name: row.name ?? "",
    sku: typeof row.sku === "string" ? row.sku : row.sku?.name ?? null,
    mode: p.policySettings?.mode ?? null,
    enabled: enabledRaw == null ? null : enabledRaw !== "Disabled",
    managed: Array.isArray(sets) ? sets.map((m) => ({ type: m.ruleSetType ?? "", version: m.ruleSetVersion ?? "", action: m.ruleSetAction ?? null })) : null,
    customRules: custom.length,
  };
}

const byCode = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * WAF coverage of a Front Door profile (catalog EDGE-10 / EDGE-11, pure). Served domains = the custom domains of
 * every active route plus the endpoint's own domain unless the route unlinked it. Each one is prevent / detect /
 * disabled (policy off) / none (read, no WAF) / unknown (policy not readable, path-scoped association, or in two
 * associations). `securityPolicies` null → unreadable (never "none"); `wafById` null → every policy unknown.
 */
export function resolveAfdWaf(profileId: string, cfg: AfdConfig, wafById: ReadonlyMap<string, WafPolicyFacts> | null): AfdWaf {
  const base = profileId.toLowerCase();
  const served = new Map<string, { host: string; kind: "endpoint" | "custom" }>();
  for (const r of activeRoutes(cfg)) {
    if (r.linkToDefaultDomain !== false) {
      const ep = cfg.endpoints.find((e) => e.name.toLowerCase() === r.endpoint.toLowerCase());
      served.set(`${base}/afdendpoints/${r.endpoint.toLowerCase()}`, { host: ep?.hostName || r.endpoint, kind: "endpoint" });
    }
    for (const d of r.customDomains ?? []) served.set(d, { host: cfg.customDomainHosts?.[d] || lastSeg(d), kind: "custom" });
  }
  const counts = { served: served.size, prevent: 0, detect: 0, disabled: 0, none: 0, unknown: 0 };
  const sorted = [...served].sort(([a], [b]) => byCode(a, b));
  if (cfg.securityPolicies == null) {
    return {
      state: "unreadable", counts: { ...counts, unknown: served.size }, policies: [], unserved: [], readError: "securityPolicies",
      domains: sorted.slice(0, 100).map(([, d]) => ({ ...d, state: "unknown" as const })),
    };
  }
  const sps = cfg.securityPolicies;
  const owners = new Map<string, AfdSecurityPolicy[]>();
  for (const sp of sps) for (const d of new Set(sp.domains)) (owners.get(d) ?? owners.set(d, []).get(d)!).push(sp);
  const domains: AfdWafDomain[] = [];
  for (const [id, d] of sorted) {
    const own = owners.get(id) ?? [];
    let state: AfdWafDomainState = "unknown";
    let reason: AfdWafDomain["reason"];
    let policy: string | undefined;
    if (!own.length) state = "none";
    else if (own.length > 1) reason = "conflict";
    else {
      const sp = own[0]!;
      const pol = wafById?.get(sp.wafPolicyId);
      policy = pol?.name || lastSeg(sp.wafPolicyId);
      const mode = pol?.mode?.toLowerCase();
      if (sp.patterns.length !== 1 || sp.patterns[0] !== "/*") reason = "pathScoped";
      else if (!pol) reason = "policyUnreadable";
      else if (pol.enabled === false) state = "disabled";
      else if (pol.enabled && mode === "prevention") state = "prevent";
      else if (pol.enabled && mode === "detection") state = "detect";
      else reason = "policyUnreadable";
    }
    counts[state]++;
    domains.push({ host: d.host, kind: d.kind, ...(policy ? { policy } : {}), state, ...(reason ? { reason } : {}) });
  }
  const policies = [...new Set(sps.map((sp) => sp.wafPolicyId))].sort(byCode).slice(0, 20).map((wid) => {
    const doms = [...new Set(sps.filter((sp) => sp.wafPolicyId === wid).flatMap((sp) => sp.domains))].filter((d) => served.has(d)).map((d) => served.get(d)!.host).sort(byCode);
    const pol = wafById?.get(wid);
    return { ...(pol ?? { name: lastSeg(wid), sku: null, mode: null, enabled: null, managed: null, customRules: 0 }), domains: doms };
  });
  const unserved = [...new Set(sps.flatMap((sp) => sp.domains))].filter((d) => !served.has(d)).map((d) => cfg.customDomainHosts?.[d] || lastSeg(d)).sort(byCode);
  const n = counts.served;
  const state: AfdWafState = n === 0 ? "noDomains"
    : counts.prevent === n ? "prevent"
    : counts.none === n ? "none"
    : counts.detect === n ? "detect"
    : counts.detect + counts.disabled + counts.none > 0 ? "partial"
    : "unknown";
  return { state, counts, policies, domains: domains.slice(0, 100), unserved: unserved.slice(0, 50), ...(wafById ? {} : { readError: "wafPolicies" as const }) };
}
