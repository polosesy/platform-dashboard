// Relationship scan of a real tenant — READ-ONLY, aggregates only (resource types, property paths, counts; no ids,
// no names). Local tool for scripts/relationships (verify.mjs --tenant). Never commit its output.
//   cd apps/api && npx tsx scripts/relationship-scan.ts <out dir>
// Reads the platform credential from the repo-root .env (the home connection), like the API does.
//  1. providers API: every resource type of every namespace, its locations (regional vs global) and api versions
//  2. Resource Graph: every resource's properties walked; each string that is an ARM id → (source type, path, target type)
import { readFileSync, writeFileSync } from "node:fs";
import { loadEnv } from "../src/env.js";
import { getAnonymousArmFetcher } from "../src/infra/azureClientFactory.js";
const OUT = process.argv[2]!;
const raw = Object.fromEntries(readFileSync("../../.env", "utf8").split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, "")]; }));
// Local tool: the platform credential through the dev gate (loopback only), never through a served request
const env = loadEnv({ ...process.env, ...raw, AUD_ANONYMOUS_SP: "true", API_BIND_HOST: "127.0.0.1" });
const arm = await getAnonymousArmFetcher(env);
const sub = env.AZURE_SUBSCRIPTION_IDS!.split(",")[0]!.trim();

// 1. providers (all namespaces, registered or not)
const prov = await arm.fetchJson<{ value: Array<{ namespace: string; registrationState: string; resourceTypes: Array<{ resourceType: string; locations?: string[]; apiVersions?: string[]; capabilities?: string }> }> }>(
  `https://management.azure.com/subscriptions/${sub}/providers?api-version=2021-04-01`, { timeoutMs: 60_000 });
const types = prov.value.flatMap((p) => p.resourceTypes.map((t) => ({
  type: `${p.namespace}/${t.resourceType}`.toLowerCase(),
  registered: p.registrationState === "Registered",
  scope: !t.locations?.length ? "none" : t.locations.every((l) => l.toLowerCase() === "global") ? "global" : t.locations.some((l) => l.toLowerCase() === "global") ? "mixed" : "regional",
  regions: t.locations?.length ?? 0,
  latestApi: (t.apiVersions ?? []).filter((v) => !v.includes("preview")).sort().at(-1) ?? (t.apiVersions ?? []).sort().at(-1) ?? null,
})));
writeFileSync(`${OUT}/providers.json`, JSON.stringify({ namespaces: prov.value.length, types }, null, 0));
console.log("providers:", prov.value.length, "namespaces,", types.length, "resource types;", Object.entries(types.reduce((m, t) => ((m[t.scope] = (m[t.scope] ?? 0) + 1), m), {} as Record<string, number>)));

// 2. tenant property scan
const ARM_ID = /^\/subscriptions\/[^/]+\/resourcegroups\/[^/]+\/providers\/([^/]+)\/([^/]+)\/[^/]+((?:\/[^/]+\/[^/]+)*)$/i;
const typeOf = (id: string): string | null => {
  const m = ARM_ID.exec(id.trim());
  if (!m) return null;
  const segs = m[3]!.split("/").filter(Boolean);
  let t = `${m[1]}/${m[2]}`;
  for (let i = 0; i + 1 < segs.length; i += 2) t += `/${segs[i]}`;
  return t.toLowerCase();
};
const agg = new Map<string, { source: string; path: string; target: string; count: number }>();
const walk = (v: unknown, path: string, src: string, selfId: string) => {
  if (typeof v === "string") {
    if (v.toLowerCase() === selfId || !v.startsWith("/")) return;
    const t = typeOf(v);
    if (!t) return;
    const k = `${src}|${path}|${t}`;
    const e = agg.get(k) ?? { source: src, path, target: t, count: 0 };
    e.count++;
    agg.set(k, e);
  } else if (Array.isArray(v)) v.forEach((x) => walk(x, `${path}[]`, src, selfId));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k, src, selfId);
};
let skip: string | undefined, n = 0;
const typeCount = new Map<string, number>();
for (let page = 0; page < 60; page++) {
  const r = await arm.postJson<{ data: Array<{ id: string; type: string; properties: unknown }>; $skipToken?: string }>(
    "https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01",
    { query: "resources | project id, type, properties", options: { $top: 1000, ...(skip ? { $skipToken: skip } : {}) } }, { timeoutMs: 60_000 });
  for (const row of r.data) {
    n++;
    const t = row.type.toLowerCase();
    typeCount.set(t, (typeCount.get(t) ?? 0) + 1);
    walk(row.properties, "properties", t, row.id.toLowerCase());
  }
  if (!r.$skipToken) break;
  skip = r.$skipToken;
}
const refs = [...agg.values()].map((e) => ({ ...e, path: e.path.replace(/\.properties\./g, ".") })).sort((a, b) => a.source.localeCompare(b.source) || b.count - a.count);
writeFileSync(`${OUT}/tenant-refs.json`, JSON.stringify({ resources: n, types: Object.fromEntries([...typeCount].sort()), refs }, null, 0));
console.log("tenant:", n, "resources,", typeCount.size, "types,", refs.length, "distinct (source, path, target) references");
