// Azure Front Door Standard/Premium (microsoft.cdn/profiles, sku *_AzureFrontDoor): the routing configuration that
// Resource Graph does not carry (origin groups, origins, routes are ARM child resources — read with GET), and the
// pure resolution of each origin to a resource in the graph. Catalog rows EDGE-04..07; tested from
// apps/api/test/frontDoor.test.ts.
//
// Learn: origins and origin groups https://learn.microsoft.com/azure/frontdoor/origin · routes
// https://learn.microsoft.com/azure/frontdoor/front-door-route-matching · Private Link origins (Premium)
// https://learn.microsoft.com/azure/frontdoor/private-link
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
export type AfdRoute = { endpoint: string; name: string; originGroup: string; enabled: boolean };
export type AfdConfig = { endpoints: Array<{ name: string; hostName: string; enabled: boolean }>; routes: AfdRoute[]; origins: AfdOrigin[] };

type Fetcher = { fetchJson<T>(url: string): Promise<T> };
type List<T> = { value?: T[]; nextLink?: string };
type Child = { name?: string; id?: string; properties?: Record<string, unknown> };

const cache = new CacheManager<AfdConfig>(200, 10 * 60_000);
const inflight = new Map<string, Promise<AfdConfig>>();
const lastSeg = (id: unknown) => String(id ?? "").split("/").pop()?.toLowerCase() ?? "";

async function list(f: Fetcher, url: string): Promise<Child[]> {
  const out: Child[] = [];
  let next: string | undefined = url;
  for (let i = 0; next && i < 10; i++) {
    const page: List<Child> = await f.fetchJson<List<Child>>(next);
    out.push(...(page.value ?? []));
    next = page.nextLink;
  }
  return out;
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
    const [groups, endpoints] = await Promise.all([
      list(fetcher, `${base}/originGroups?api-version=${API}`),
      list(fetcher, `${base}/afdEndpoints?api-version=${API}`),
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
        routes.push({ endpoint: e.name ?? "", name: r.name ?? "", originGroup: lastSeg((p.originGroup as { id?: string } | undefined)?.id), enabled: String(p.enabledState ?? "Enabled") !== "Disabled" });
      }
    }
    const cfg: AfdConfig = {
      endpoints: endpoints.map((e) => ({ name: e.name ?? "", hostName: String(e.properties?.hostName ?? ""), enabled: String(e.properties?.enabledState ?? "Enabled") !== "Disabled" })),
      routes, origins,
    };
    debug(`[afd] ${lastSeg(profileId)}: endpoints ${cfg.endpoints.length} routes ${routes.length} origins ${origins.length}`);
    cache.set(key, cfg);
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
  const used = new Set(cfg.routes.filter((r) => r.enabled).map((r) => r.originGroup));
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
