// AKS 보안 점검 — image vulnerabilities, the entry point of an attack path ("could a running image be broken into?").
// Two sources, merged per running image reference; neither is a guess:
//  ① Microsoft Defender for Containers — vulnerability sub-assessments in Resource Graph, summarised per image
//     (registry · repository · digest · tags) and tied to a pod's image by digest, else by tag.
//  ② SBOM — a well-known open-source image at an exact semver tag (sbom.ts KNOWN_IMAGES) → OSV, with CVE.org
//     exploitation (CISA ADP SSVC) and the CISA KEV catalogue. Mirrors and hardened rebuilds (e.g. "-dhi") are not
//     mapped: a rebuilt image may carry patches the upstream version number does not show.
// An image neither source covers has no entry — the UI says "not scanned", never "clean".

import type { ImageVuln, VulnCoverage, VulnSeverity } from "@aud/types";
import type { Env } from "../env.js";
import { CacheManager, cachePrefix } from "../infra/cacheManager.js";
import { getArmFetcherAuto } from "../infra/azureClientFactory.js";
import { debug } from "../infra/logger.js";
import { safeMessage } from "../infra/requestParams.js";
import { imageCoord, type Coord } from "./sbom.js";
import { cveOrgRecords, fixedFor, osvScan, type CveOrgInfo, type OsvVuln } from "./vulnDb.js";
import { isCveId, loadFeeds } from "./advisoryFeeds.js";

const ARG = "https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01";
const cache = new CacheManager<{ byImage: ImageVuln[]; coverage: VulnCoverage }>(20, 10 * 60_000);
const SEV_RANK: Record<VulnSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3, unknown: 4 };
const EXP_RANK = { kev: 0, active: 1, poc: 2 } as const;
type Exploited = ImageVuln["exploited"];

/** Unhealthy Defender container vulnerability findings, one row per image (registry · repo · digest · tags) */
export const DEFENDER_IMAGE_QUERY = `securityresources
| where type =~ "microsoft.security/assessments/subassessments"
| where tostring(properties.status.code) =~ "Unhealthy"
| extend art = properties.additionalData.artifactDetails, sw = properties.additionalData.softwareDetails, vd = properties.additionalData.vulnerabilityDetails
| where isnotempty(tostring(art.repositoryName))
| extend sev = tolower(coalesce(tostring(vd.severity), tostring(properties.status.severity)))
| extend cve = coalesce(tostring(vd.cveId), tostring(properties.id))
| extend ex = tobool(vd.exploitabilityAssessment.exploitStepsPublished) == true or tobool(vd.exploitabilityAssessment.isInExploitKit) == true
| extend fx = tostring(sw.fixedVersion)
| summarize critical = dcountif(cve, sev == "critical"), high = dcountif(cve, sev == "high"), medium = dcountif(cve, sev == "medium"), low = dcountif(cve, sev == "low"), exploited = dcountif(cve, ex), fixable = dcountif(cve, isnotempty(fx)), top = make_list_if(pack("cve", cve, "sev", sev, "pkg", tostring(sw.packageName), "ver", tostring(sw.version), "fixed", fx, "ex", ex), sev in ("critical", "high"), 20) by registry = tolower(tostring(art.registryHost)), repo = tolower(tostring(art.repositoryName)), digest = tostring(art.digest), tags = tostring(art.tags)
| take 2000`;

export type DefenderImageRow = {
  registry: string; repo: string; digest: string; tags: string;
  critical: number; high: number; medium: number; low: number; exploited: number; fixable: number;
  top: Array<{ cve?: string; sev?: string; pkg?: string; ver?: string; fixed?: string; ex?: boolean }> | null;
};

/** "acr.azurecr.io/team/app:1.2@sha256:…" → parts; no registry = Docker Hub (docker.io, library/ for single names) */
export function imageParts(image: string): { registry: string; repo: string; tag: string; digest: string } {
  const [ref, digest = ""] = image.split("@") as [string, string?];
  const slash = ref.lastIndexOf("/"), colon = ref.lastIndexOf(":");
  const tag = colon > slash ? ref.slice(colon + 1) : "";
  const path = (colon > slash ? ref.slice(0, colon) : ref).toLowerCase();
  const first = path.split("/")[0]!;
  const hasRegistry = path.includes("/") && (first.includes(".") || first.includes(":") || first === "localhost");
  const registry = hasRegistry ? first : "docker.io";
  const repo = hasRegistry ? path.slice(first.length + 1) : path.includes("/") ? path : `library/${path}`;
  return { registry, repo, tag, digest };
}

const sevOf = (s: string | undefined): VulnSeverity => (["critical", "high", "medium", "low"].includes((s ?? "").toLowerCase()) ? (s!.toLowerCase() as VulnSeverity) : "unknown");
const worse = (a: Exploited, b: Exploited): Exploited => (!a ? b : !b ? a : EXP_RANK[a] <= EXP_RANK[b] ? a : b);

/** Defender rows → the pod images they belong to: same registry + repository, then the pod's digest, else its tag */
export function defenderVulns(images: string[], rows: DefenderImageRow[]): ImageVuln[] {
  const out: ImageVuln[] = [];
  for (const image of images) {
    const p = imageParts(image);
    const same = rows.filter((r) => r.registry === p.registry && r.repo === p.repo);
    if (!same.length) continue;
    const tagsOf = (r: DefenderImageRow): string[] => { try { const t = JSON.parse(r.tags || "[]"); return Array.isArray(t) ? t.map(String) : []; } catch { return []; } };
    const byDigest = p.digest ? same.filter((r) => r.digest === p.digest) : [];
    const byTag = !byDigest.length && p.tag ? same.filter((r) => tagsOf(r).includes(p.tag)) : [];
    const hit = byDigest.length ? byDigest : byTag;
    if (!hit.length) continue;
    // The same tag pushed twice (two digests): the worse result — the pod may run either
    const r = [...hit].sort((a, b) => b.critical - a.critical || b.high - a.high || b.exploited - a.exploited)[0]!;
    const top = (r.top ?? [])
      .map((t) => ({ id: t.cve ?? "?", cve: t.cve && isCveId(t.cve) ? t.cve : null, severity: sevOf(t.sev), exploited: (t.ex ? "poc" : null) as Exploited, pkg: t.pkg ?? "", version: t.ver ?? "", fixed: t.fixed || null, url: t.cve && isCveId(t.cve) ? `https://www.cve.org/CVERecord?id=${t.cve}` : null }))
      .sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || Number(!a.exploited) - Number(!b.exploited) || Number(!a.fixed) - Number(!b.fixed))
      .slice(0, 5);
    out.push({
      image, source: "defender", basis: byDigest.length ? "digest" : "tag",
      counts: { critical: r.critical, high: r.high, medium: r.medium, low: r.low },
      // Defender's own signal is "exploit steps published / in an exploit kit" — a proof of concept, not KEV
      exploited: r.exploited > 0 ? "poc" : null,
      fixable: r.fixable, top,
    });
  }
  return out;
}

/** SBOM path: OSV advisories of each image's module version, with CVE.org exploitation and CISA KEV */
export function sbomVulns(
  images: string[], byCoord: Map<string, { coord: Coord; vulns: OsvVuln[] }>,
  records: Map<string, CveOrgInfo>, kev: Set<string>,
): ImageVuln[] {
  const out: ImageVuln[] = [];
  for (const image of images) {
    const c = imageCoord(image);
    const hit = c ? byCoord.get(`${c.ecosystem}|${c.name}|${c.version}`) : undefined;
    if (!c || !hit) continue;
    const findings = hit.vulns.map((v) => {
      const cves = v.aliases.filter(isCveId);
      const recs = cves.map((x) => records.get(x)).filter((x): x is CveOrgInfo => !!x);
      const score = recs.map((x) => x.cvss?.score).find((x) => typeof x === "number");
      const severity: VulnSeverity = v.severity !== "unknown" ? v.severity : score === undefined ? "unknown" : score >= 9 ? "critical" : score >= 7 ? "high" : score >= 4 ? "medium" : "low";
      const exploited: Exploited = cves.some((x) => kev.has(x)) ? "kev" : recs.some((x) => x.exploitation === "active") ? "active" : recs.some((x) => x.exploitation === "poc") ? "poc" : null;
      return { id: v.id, cve: cves[0] ?? null, severity, exploited, pkg: c.name, version: c.version, fixed: fixedFor(v, c), url: `https://osv.dev/vulnerability/${encodeURIComponent(v.id)}` };
    });
    if (!findings.length) {
      // Mapped and looked up, nothing found — a real "no known advisories" for this version
      out.push({ image, source: "sbom", basis: "version", counts: { critical: 0, high: 0, medium: 0, low: 0 }, exploited: null, fixable: 0, top: [] });
      continue;
    }
    const counts = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const f of findings) if (f.severity !== "unknown") counts[f.severity]++;
    out.push({
      image, source: "sbom", basis: "version", counts,
      exploited: findings.reduce<Exploited>((a, f) => worse(a, f.exploited), null),
      fixable: findings.filter((f) => f.fixed).length,
      top: findings.sort((a, b) => (a.exploited ? EXP_RANK[a.exploited] : 9) - (b.exploited ? EXP_RANK[b.exploited] : 9) || SEV_RANK[a.severity] - SEV_RANK[b.severity] || Number(!a.fixed) - Number(!b.fixed)).slice(0, 5),
    });
  }
  return out;
}

/** One result per image: Defender (a scan of that very image) wins over the SBOM version lookup */
export function mergeVulns(defender: ImageVuln[], sbom: ImageVuln[]): ImageVuln[] {
  const by = new Map(sbom.map((v) => [v.image, v]));
  for (const d of defender) {
    const s = by.get(d.image);
    // Keep the stronger exploitation signal from KEV / CVE.org even when Defender's scan is the one shown
    by.set(d.image, s ? { ...d, exploited: worse(d.exploited, s.exploited) } : d);
  }
  return [...by.values()].sort((a, b) => a.image.localeCompare(b.image));
}

/** The heatmap weight of an image result: exploited in the wild = crit, critical/high = warn, the rest low; null = nothing open */
export function vulnWeight(v: ImageVuln): "crit" | "warn" | "low" | null {
  if (v.exploited === "kev" || v.exploited === "active") return "crit";
  if (v.counts.critical || v.counts.high) return "warn";
  if (v.exploited || v.counts.medium || v.counts.low) return "low";
  return null;
}

/** Defender (Resource Graph) + SBOM (OSV · CVE.org · KEV) for the cluster's running images — each source fails on its own */
export async function collectImageVulns(env: Env, bearerToken: string | undefined, clusterId: string, images: string[]): Promise<{ byImage: ImageVuln[]; coverage: VulnCoverage }> {
  const list = [...new Set(images.filter(Boolean))].sort();
  const key = `${cachePrefix(bearerToken)}:image-vulns:${clusterId.toLowerCase()}:${list.length}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const defenderP = (async () => {
    const arm = await getArmFetcherAuto(env, bearerToken);
    const sub = /\/subscriptions\/([^/]+)\//i.exec(clusterId)?.[1];
    const res = await arm.postJson<{ data?: DefenderImageRow[] }>(ARG, { query: DEFENDER_IMAGE_QUERY, ...(sub ? { subscriptions: [sub] } : {}), options: { resultFormat: "objectArray", $top: 1000 } }, { timeoutMs: 20_000 });
    return res.data ?? [];
  })();

  const sbomOn = env.AUD_ADVISORY_FEEDS && env.AUD_ADVISORY_OSV;
  const coords = new Map<string, Coord>();
  for (const image of list) {
    const c = imageCoord(image);
    if (c) coords.set(`${c.ecosystem}|${c.name}|${c.version}`, c);
  }
  const sbomP = (async () => {
    if (!sbomOn || !coords.size) return { byCoord: new Map<string, { coord: Coord; vulns: OsvVuln[] }>(), records: new Map<string, CveOrgInfo>(), kev: new Set<string>(), pending: 0 };
    const entries = [...coords.values()].map((c) => ({ ...c, kind: "image" as const, components: [] }));
    const [scan, feeds] = await Promise.all([
      osvScan(env, entries, 10_000),
      // KEV is a 6-hour cached feed; a cold start waits at most 8 s (exploitation then comes from CVE.org only)
      Promise.race([loadFeeds(env).then((f) => f.kev ?? []), new Promise<null>((r) => setTimeout(() => r(null), 8_000).unref?.())]),
    ]);
    const byCoord = new Map<string, { coord: Coord; vulns: OsvVuln[] }>();
    for (const [k, coord] of coords) byCoord.set(k, { coord, vulns: [] });
    for (const m of scan.matches) byCoord.get(`${m.entry.ecosystem}|${m.entry.name}|${m.entry.version}`)?.vulns.push(m.vuln);
    const org = await cveOrgRecords(env, scan.matches.flatMap((m) => m.vuln.aliases.filter(isCveId)), 6_000);
    if (scan.failed) throw new Error("OSV lookup failed");
    return { byCoord, records: org.records, kev: new Set((feeds ?? []).map((k) => k.cve)), pending: scan.pending + org.pending + (feeds ? 0 : 1) };
  })();

  const [dR, sR] = await Promise.allSettled([defenderP, sbomP]);
  if (dR.status === "rejected") debug(`[image-vulns] defender: ${safeMessage(dR.reason)}`);
  if (sR.status === "rejected") debug(`[image-vulns] sbom: ${safeMessage(sR.reason)}`);
  const defender = dR.status === "fulfilled" ? defenderVulns(list, dR.value) : [];
  const sbom = sR.status === "fulfilled" ? sbomVulns(list, sR.value.byCoord, sR.value.records, sR.value.kev) : [];
  const byImage = mergeVulns(defender, sbom);
  const pending = sR.status === "fulfilled" ? sR.value.pending : 0;
  const coverage: VulnCoverage = {
    images: list.length,
    scanned: byImage.length,
    defender: dR.status === "rejected" ? "failed" : defender.length ? "ok" : "noData",
    sbomMapped: list.filter((i) => imageCoord(i)).length,
    sbom: !sbomOn ? "disabled" : sR.status === "rejected" ? "failed" : "ok",
    pending,
  };
  const out = { byImage, coverage };
  if (!pending && dR.status === "fulfilled") cache.set(key, out);
  return out;
}
