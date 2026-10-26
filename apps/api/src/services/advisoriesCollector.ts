// 보안 › 긴급 취약점 — collection: official feeds (advisoryFeeds.ts) + what this platform runs (its own Node.js
// process, the selected cluster's images from the policy inventory, Microsoft Defender for Cloud container findings
// for the CVE IDs in question) → matched by services/advisories.ts. Each source reports its own state; a source that
// wasn't read makes the verdict "unknown", never "clear".

import type { AdvisoriesResponse, AdvisoryCve, AdvisoryItem, AdvisorySource, DependencyFinding, FindingSeverity } from "@aud/types";
import type { Env } from "../env.js";
import { CacheManager, cachePrefix } from "../infra/cacheManager.js";
import { getArmFetcherAuto } from "../infra/azureClientFactory.js";
import { HttpError, kqlString, safeMessage } from "../infra/requestParams.js";
import { withLang, type Lang } from "../infra/lang.js";
import { collectPolicyInventory } from "./k8sPolicyCollector.js";
import { getClusterContext } from "./azureEndpoints.js";
import { clusterSbom, platformSbom, type SbomEntry } from "./sbom.js";
import { cveOrgRecords, fixedFor, osvScan } from "./vulnDb.js";
import { isCveId, loadFeeds, nvdDetails, type KevEntry } from "./advisoryFeeds.js";
import { buildItem, recentKev, vendorBases, type ClusterImage, type DefenderHit, type MatchContext, type RuntimeFact } from "./advisories.js";

const ARG = "https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01";
const MAX_WATCH = 20;
const MAX_DEFENDER_CVES = 300;
const responseCache = new CacheManager<AdvisoriesResponse>(30, 120_000);
const SOURCE_ORDER: AdvisorySource["id"][] = ["cveorg", "kev", "nodejs", "php", "osv", "nvd", "defender", "cluster", "platform"];

/** Defender for Cloud container vulnerability sub-assessments for these CVE IDs (unhealthy only) */
export function defenderQuery(cves: string[]): string {
  const ids = [...new Set(cves.filter(isCveId))].slice(0, MAX_DEFENDER_CVES);
  return `securityresources
| where type =~ "microsoft.security/assessments/subassessments"
| extend cve = tostring(properties.additionalData.vulnerabilityDetails.cveId), vid = tostring(properties.id)
| extend cve = iff(isnotempty(cve), cve, vid)
| where cve in~ (${ids.map(kqlString).join(", ") || '""'})
| where tostring(properties.status.code) !~ "Healthy"
| extend sw = properties.additionalData.softwareDetails, art = properties.additionalData.artifactDetails
| project cve, pkg = tostring(sw.packageName), ver = tostring(sw.version), fixed = tostring(sw.fixedVersion), registry = tostring(art.registryHost), repo = tostring(art.repositoryName), tag = tostring(art.tags[0]), digest = tostring(art.digest)
| take 1000`;
}

const imageRef = (r: { registry: string; repo: string; tag: string; digest: string }) =>
  `${r.registry ? `${r.registry}/` : ""}${r.repo}${r.tag ? `:${r.tag}` : r.digest ? `@${r.digest}` : ""}`;
const repoOf = (image: string) => {
  const noDigest = image.split("@")[0]!;
  const slash = noDigest.lastIndexOf("/"), colon = noDigest.lastIndexOf(":");
  return (colon > slash ? noDigest.slice(0, colon) : noDigest).toLowerCase();
};

export async function collectAdvisories(
  env: Env, bearerToken: string | undefined, opts: { clusterId: string | null; watch: string[]; lang: Lang },
): Promise<AdvisoriesResponse> {
  const watch = [...new Set(opts.watch.map((c) => c.trim().toUpperCase()).filter(isCveId))].slice(0, MAX_WATCH);
  const key = `${cachePrefix(bearerToken)}:advisories:${opts.clusterId?.toLowerCase() ?? "-"}:${watch.join(",")}:${opts.lang}`;
  const hit = responseCache.get(key);
  if (hit) return hit;
  const tr = (ko: string, en: string) => (opts.lang === "en" ? en : ko);
  const now = new Date();
  const at = now.toISOString();

  const feeds = await loadFeeds(env);
  const kevBy = new Map<string, KevEntry>((feeds.kev ?? []).map((k) => [k.cve, k]));
  const kevRecent = recentKev(feeds.kev ?? [], now);
  // News, not history: posts of the last 180 days, two per product (older ones are in the vendors' archives)
  const recent = (p: { date: string; cves: string[] }) => p.cves.length > 0 && !!p.date && now.getTime() - new Date(p.date).getTime() <= 180 * 86_400_000;
  const nodePosts = feeds.nodePosts.filter(recent).slice(0, 2);
  const phpPosts = feeds.phpPosts.filter(recent).slice(0, 6);
  const vendorCves = [...nodePosts, ...phpPosts].flatMap((p) => p.cves);

  // This dashboard's own runtime (the API and web containers share one image)
  // Signed-in users only: the exact runtime version tells an attacker which CVEs to try
  const runtimes: RuntimeFact[] = bearerToken
    ? [{ product: "nodejs", version: process.versions.node, where: tr("이 대시보드 (API·웹 — 같은 이미지)", "This dashboard (API and web — one image)"), evidence: "runtime" }]
    : [];
  const sources: AdvisorySource[] = [
    ...feeds.sources,
    bearerToken ? { id: "platform", state: "ok", checkedAt: at, detail: `Node.js ${process.versions.node}` } : { id: "platform", state: "signin", checkedAt: null },
  ];

  // Cluster images (policy inventory — same Kubernetes read as AKS 보안 점검)
  let clusterImages: ClusterImage[] | null = null;
  let k8sVersion: string | null = null;
  if (!opts.clusterId) sources.push({ id: "cluster", state: "noData", checkedAt: null, detail: tr("클러스터를 고르지 않음", "No cluster selected") });
  else if (!bearerToken) sources.push({ id: "cluster", state: "signin", checkedAt: null });
  else {
    try {
      const inv = await collectPolicyInventory(env, bearerToken, opts.clusterId, opts.lang);
      const byImage = new Map<string, Set<string>>();
      for (const w of inv.workloads) for (const c of w.security?.containers ?? []) {
        if (!c.image) continue;
        byImage.set(c.image, (byImage.get(c.image) ?? new Set()).add(`${w.namespace}/${w.name}`));
      }
      clusterImages = [...byImage].map(([image, wl]) => ({ image, workloads: [...wl].sort() }));
      k8sVersion = await getClusterContext(env, bearerToken, opts.clusterId).then((c) => c.containment.cluster.k8sVersion || null).catch(() => null);
      sources.push({ id: "cluster", state: "ok", checkedAt: at, detail: tr(`이미지 ${clusterImages.length}개`, `${clusterImages.length} images`) });
    } catch (e) {
      sources.push({ id: "cluster", state: e instanceof HttpError && e.status === 401 ? "signin" : "failed", checkedAt: at, detail: safeMessage(e).slice(0, 120) });
    }
  }

  // Defender for Cloud container findings (signed-in users; ARG over the caller's subscriptions)
  let defender: DefenderHit[] | null = null;
  const defenderCves = [...new Set([...watch, ...vendorCves, ...kevRecent.map((k) => k.cve)])];
  if (!bearerToken) sources.push({ id: "defender", state: "signin", checkedAt: null });
  else {
    try {
      const arm = await getArmFetcherAuto(env, bearerToken);
      type Row = { cve: string; pkg: string; ver: string; fixed: string; registry: string; repo: string; tag: string; digest: string };
      const rows = (await arm.postJson<{ data?: Row[] }>(ARG, { query: defenderQuery(defenderCves), options: { resultFormat: "objectArray", $top: 1000 } }, { timeoutMs: 20_000 })).data ?? [];
      defender = rows.filter((r) => r.repo).map((r) => ({ cve: r.cve.toUpperCase(), image: imageRef(r), pkg: r.pkg, version: r.ver, fixed: r.fixed || null }));
      sources.push({ id: "defender", state: rows.length ? "ok" : "noData", checkedAt: at,
        detail: rows.length ? tr(`발견 ${rows.length}건`, `${rows.length} findings`) : tr("해당 CVE의 컨테이너 취약점 결과 없음 — Defender for Containers 스캔이 없거나 해당 없음", "No container findings for these CVEs — no Defender for Containers scan, or not present") });
    } catch (e) {
      sources.push({ id: "defender", state: e instanceof HttpError && e.status === 401 ? "signin" : "failed", checkedAt: at, detail: safeMessage(e).slice(0, 120) });
    }
  }

  // What we run (signed-in users only — exact versions tell an attacker what to try) × OSV
  const sbom: SbomEntry[] = [];
  let unmappedImages = 0;
  if (bearerToken) {
    sbom.push(...platformSbom().entries.map((e) => ({ ...e, components: e.components.map((c) => (c === "web" ? tr("웹", "web") : c)) })));
    if (clusterImages) {
      const c = clusterSbom(k8sVersion, clusterImages);
      sbom.push(...c.entries.map((e) => ({ ...e, components: [...e.components] })));
      unmappedImages = c.unmapped;
    }
  }
  const platformCount = sbom.filter((e) => e.kind === "npm" || e.kind === "os").length;
  const osvOn = env.AUD_ADVISORY_FEEDS && env.AUD_ADVISORY_OSV;
  const osv = bearerToken && osvOn ? await osvScan(env, sbom) : { matches: [], pending: 0, failed: false, queried: 0 };
  sources.push(!bearerToken ? { id: "osv", state: "signin", checkedAt: null }
    : !osvOn ? { id: "osv", state: "disabled", checkedAt: null }
    : { id: "osv", state: osv.failed ? "failed" : "ok", checkedAt: at, url: "https://osv.dev/",
        detail: tr(`패키지 ${osv.queried}개 대조 · 일치 ${osv.matches.length}${osv.pending ? ` · 상세 대기 ${osv.pending}` : ""}`, `${osv.queried} packages checked · ${osv.matches.length} matches${osv.pending ? ` · ${osv.pending} details pending` : ""}`) });

  // CVE details: the CVE.org record first (CNA score, CISA ADP SSVC), NVD only for a score CVE.org lacks; KEV flag
  const findingCves = [...new Set(osv.matches.flatMap((m) => m.vuln.aliases.filter(isCveId)))];
  const org = await cveOrgRecords(env, [...new Set([...watch, ...vendorCves, ...findingCves])]);
  sources.push(!env.AUD_ADVISORY_FEEDS ? { id: "cveorg", state: "disabled", checkedAt: null }
    : { id: "cveorg", state: org.failed ? "failed" : "ok", checkedAt: at, url: "https://www.cve.org/", ...(org.pending ? { detail: tr(`기록 대기 ${org.pending}`, `${org.pending} records pending`) } : {}) });
  const nvd = await nvdDetails(env, [...new Set([...watch, ...vendorCves])].filter((id) => !org.records.get(id)?.cvss));
  sources.push(nvd.source);
  const cve = (id: string): AdvisoryCve => {
    const o = org.records.get(id);
    const d = nvd.details.get(id) ?? null;
    const k = kevBy.get(id);
    return {
      id, title: o?.title ?? null, cna: o?.cna ?? null, exploitation: o?.exploitation ?? null,
      scoreSource: o?.cvss ? "cveorg" : d?.cvss ? "nvd" : null,
      cvss: o?.cvss ?? d?.cvss ?? null, description: o?.description ?? d?.description ?? k?.description ?? null, published: o?.published ?? d?.published ?? null,
      kev: k ? { dateAdded: k.dateAdded, dueDate: k.dueDate, ransomware: k.ransomware, requiredAction: k.requiredAction } : null,
    };
  };

  // OSV matches → findings (one per advisory × package version, components merged)
  const sevOfScore = (n: number): FindingSeverity => (n >= 9 ? "critical" : n >= 7 ? "high" : n >= 4 ? "medium" : "low");
  const byKey = new Map<string, DependencyFinding>();
  for (const { entry, vuln } of osv.matches) {
    const cves = vuln.aliases.filter(isCveId);
    const recs = cves.map((c) => org.records.get(c)).filter((r): r is NonNullable<typeof r> => !!r);
    const score = recs.map((r) => r.cvss).find(Boolean) ?? null;
    const exploited: DependencyFinding["exploited"] = cves.some((c) => kevBy.has(c)) ? "kev"
      : recs.some((r) => r.exploitation === "active") ? "active" : recs.some((r) => r.exploitation === "poc") ? "poc" : null;
    const k = `${vuln.id}|${entry.ecosystem}|${entry.name}|${entry.version}`;
    const cur = byKey.get(k);
    if (cur) { for (const c of entry.components) if (!cur.components.includes(c)) cur.components.push(c); continue; }
    byKey.set(k, {
      id: vuln.id, cves, summary: vuln.summary ?? recs.find((r) => r.title)?.title ?? null,
      severity: vuln.severity !== "unknown" ? vuln.severity : score ? sevOfScore(score.score) : "unknown",
      cvss: score ? { score: score.score, version: score.version } : null, exploited,
      kind: entry.kind, ecosystem: entry.ecosystem, pkg: entry.name, version: entry.version, fixed: fixedFor(vuln, entry),
      where: entry.kind === "npm" || entry.kind === "os" ? "platform" : "cluster", components: [...entry.components], image: entry.image ?? null,
      url: `https://osv.dev/vulnerability/${encodeURIComponent(vuln.id)}`,
    });
  }
  const EXP = { kev: 0, active: 1, poc: 2 } as const;
  const SEVR: Record<FindingSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3, unknown: 4 };
  const findings = [...byKey.values()].sort((a, b) =>
    (a.exploited ? EXP[a.exploited] : 9) - (b.exploited ? EXP[b.exploited] : 9) || SEVR[a.severity] - SEVR[b.severity] ||
    (a.fixed ? 0 : 1) - (b.fixed ? 0 : 1) || a.pkg.localeCompare(b.pkg)).slice(0, 500);

  const ctx: MatchContext = {
    runtimes, clusterImages, defender,
    workloadsOf: (image) => {
      const repo = repoOf(image);
      return [...new Set((clusterImages ?? []).filter((c) => repoOf(c.image) === repo || repoOf(c.image).endsWith(`/${repo}`)).flatMap((c) => c.workloads))].sort();
    },
  };

  const items: AdvisoryItem[] = withLang(opts.lang, () => {
    const vendor = [
      ...vendorBases("nodejs", nodePosts, feeds.nodeReleases, cve),
      ...vendorBases("php", phpPosts, feeds.phpReleases, cve),
    ].map((b) => buildItem(b, ctx));
    const covered = new Set(vendor.flatMap((v) => v.cves.map((c) => c.id)));
    const watched = watch.filter((id) => !covered.has(id)).map((id) => {
      const k = kevBy.get(id);
      const c = cve(id);
      return buildItem({ key: `watch:${id}`, kind: "watch", product: null, title: c.title || k?.name || id, date: c.published, url: `https://www.cve.org/CVERecord?id=${id}`, cves: [c], fixes: [], eolLines: [] }, ctx);
    });
    const kev = kevRecent.map((k) => buildItem({
      key: `kev:${k.cve}`, kind: "kev", product: null, title: k.name || `${k.vendor} ${k.product}`, date: k.dateAdded,
      url: `https://www.cve.org/CVERecord?id=${k.cve}`, cves: [cve(k.cve)], fixes: [], eolLines: [],
    }, ctx));
    const rank = { affected: 0, unknown: 1, notDetected: 2, clear: 3 } as const;
    const main = [...vendor, ...watched].sort((a, b) => rank[a.status] - rank[b.status] || (b.date ?? "").localeCompare(a.date ?? ""));
    return [...main, ...kev];
  });

  const main = items.filter((i) => i.kind !== "kev");
  const byKind = { npm: 0, os: 0, k8s: 0, image: 0 };
  for (const e of sbom) byKind[e.kind]++;
  const out: AdvisoriesResponse = {
    generatedAt: at,
    clusterId: opts.clusterId,
    // CVE.org is the record of reference — first; then exploitation, vendors, matching, platform
    sources: SOURCE_ORDER.flatMap((id) => sources.filter((x) => x.id === id)),
    runtimes: runtimes.map((r) => ({ product: r.product, version: r.version, where: r.where, evidence: r.evidence })),
    items,
    summary: {
      affected: main.filter((i) => i.status === "affected").length,
      unknown: main.filter((i) => i.status === "unknown").length,
      clear: main.filter((i) => i.status === "clear" || i.status === "notDetected").length,
      kevRecent: kevRecent.length,
      findingsSevere: findings.filter((f) => f.exploited || f.severity === "critical" || f.severity === "high").length,
    },
    components: { platform: platformCount, cluster: sbom.length - platformCount, byKind, unmappedImages },
    findings,
  };
  // Lookups still pending → don't cache, so the next load shows them
  if (!nvd.pending && !org.pending && !osv.pending) responseCache.set(key, out);
  return out;
}
