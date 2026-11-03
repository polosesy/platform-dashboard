// AKS 보안 점검 › 인벤토리 › AKS 관리 부품 — vulnerabilities in the images Microsoft builds for AKS (the customer can't
// patch them: "관리실이 고칠 엘리베이터") and whether Microsoft has fixed them yet.
//
// Sources (public, GET, fixed hosts):
//   AKS Vulnerability Data API — https://cve-api.prod-aks.azure.com (Learn: security-vulnerability-api-reference)
//     container-images/<image>:<tag>/scan-reports   Microsoft's scan (trivy) of that exact tag → its active CVE IDs
//     aks-releases/_index · <v>/scan-reports         every image of an AKS release (system namespaces)
//     aks-k8s-releases/<k8s>/scan-reports            images tied to a Kubernetes version (CoreDNS, kube-proxy, add-ons)
//     vhd-releases/<distro>/<version>/scan-reports   a node image's OS packages
//   AKS release tracker — https://releases.aks.azure.com/parsed_data.json (the data behind the page): the AKS release each
//     region runs now, when it arrived, the ones before it
//
// Per running image: our tag's CVEs vs the newest tag Microsoft ships for that image (AKS release + Kubernetes version
// reports, newest by version) — a CVE gone from the newest tag = fixedInLatest (arrives with the next release / add-on
// update), still there = pendingMs (Microsoft knows, not fixed yet — mostly waiting on a vendor fix). No newer tag in the
// reports, or no scan of it = unknown (never guessed). An image without a report of its own (a build newer than the last
// scan — ama-logs ships often) = notScanned, its CVEs unknown — not "clean". Microsoft's patch rule (Learn
// concepts-vulnerability-management): container images with a vendor fix are rebuilt weekly; on the current node image
// nothing with a vendor fix older than 30 days remains.

import type { Env } from "../env.js";
import type { AksCveStatus, AksManagedComponent, AksManagedFamily, AksManagedSource, AksManagedVulnsResponse, AksNodeImageVulns } from "@aud/types";
import { CacheManager, cachePrefix } from "../infra/cacheManager.js";
import { safeMessage } from "../infra/requestParams.js";
import { debug } from "../infra/logger.js";
import { fetchOfficial, loadFeeds } from "./advisoryFeeds.js";
import { compareSemverish, cveOrgRecords } from "./vulnDb.js";
import { collectPolicyInventory } from "./k8sPolicyCollector.js";
import { isSystemNamespace, type PolicyInventory } from "./policyAnalyzer.js";
import { getClusterContext } from "./azureEndpoints.js";

export const CVE_API = "https://cve-api.prod-aks.azure.com/api/v1";
export const TRACKER_DATA = "https://releases.aks.azure.com/parsed_data.json";

// ── Pure ──

/** Namespaces AKS manages (add-ons and platform parts) besides kube-* */
const MANAGED_NS = /^(kube-|aks-|azure-|gatekeeper-system$|calico-system$|app-routing-system$|tigera-operator$)/;

const FAMILIES: Array<{ family: AksManagedFamily; re: RegExp; notes: string }> = [
  { family: "amaMetrics", re: /prometheus-collector|ama-metrics|kube-state-metrics/, notes: "https://github.com/Azure/prometheus-collector/releases" },
  { family: "amaLogs", re: /azuremonitor\/containerinsights\/ciprod/, notes: "https://github.com/microsoft/Docker-Provider/blob/ci_prod/ReleaseNotes.md" },
  { family: "networking", re: /cilium|azure-cns|azure-ipam|azure-cni|containernetworking|retina|hubble|cni-dropgz|ip-masq/, notes: "https://github.com/Azure/azure-container-networking/releases" },
  { family: "csi", re: /csi/, notes: "https://github.com/kubernetes-sigs/azurefile-csi-driver/releases" },
  { family: "defender", re: /defender|azuredefender/, notes: "https://learn.microsoft.com/azure/defender-for-cloud/release-notes" },
  { family: "policy", re: /azure-policy|gatekeeper/, notes: "https://learn.microsoft.com/azure/governance/policy/concepts/policy-for-kubernetes" },
  { family: "agc", re: /application-lb|alb-controller/, notes: "https://learn.microsoft.com/azure/application-gateway/for-containers/alb-controller-release-notes" },
  { family: "kubernetes", re: /\/kubernetes\/|coredns|konnectivity|kube-proxy|autoscaler|metrics-server/, notes: "https://github.com/Azure/AKS/releases" },
];

export function familyOf(image: string): { family: AksManagedFamily; notes: string } {
  const f = FAMILIES.find((x) => x.re.test(image));
  return f ? { family: f.family, notes: f.notes } : { family: "other", notes: "https://github.com/Azure/AKS/releases" };
}

/** "mcr.microsoft.com/a/b:1.2@sha256:…" → ["mcr.microsoft.com/a/b", "1.2"] (no tag = null) */
export function splitImage(ref: string): [string, string] | null {
  const noDigest = ref.split("@")[0]!;
  const i = noDigest.lastIndexOf(":");
  if (i < 0 || noDigest.slice(i).includes("/")) return null;
  return [noDigest.slice(0, i), noDigest.slice(i + 1)];
}

export type RunningImage = { image: string; tag: string; where: Map<string, { containers: Set<string>; pods: number }> };

/** Running Microsoft images of the managed namespaces, one per image:tag */
export function managedImages(pods: PolicyInventory["pods"]): RunningImage[] {
  const by = new Map<string, RunningImage>();
  for (const p of pods) {
    if (!p.mcr?.length || !(isSystemNamespace(p.namespace) || MANAGED_NS.test(p.namespace))) continue;
    for (const c of p.mcr) {
      const it = splitImage(c.image);
      if (!it) continue;
      const k = `${it[0]}:${it[1]}`;
      const ri = by.get(k) ?? { image: it[0], tag: it[1], where: new Map() };
      const w = ri.where.get(p.namespace) ?? { containers: new Set<string>(), pods: 0 };
      w.containers.add(c.container);
      w.pods++;
      ri.where.set(p.namespace, w);
      by.set(k, ri);
    }
  }
  return [...by.values()].sort((a, b) => (a.image < b.image ? -1 : a.image > b.image ? 1 : compareSemverish(a.tag, b.tag)));
}

type Images = { image_repo_tags?: string[] };
type ReleaseReport = { container_targets?: Array<{ container_image?: string; active_container_images?: Images }> };

/**
 * Tags of `image` in the release reports newer than ours, newest first — the candidates to compare with. Empty = ours is
 * the newest known (an add-on build can be newer than every report: ama-logs ships between AKS releases).
 */
export function newerTags(image: string, ours: string, reports: ReleaseReport[]): string[] {
  const tags = new Set<string>();
  for (const r of reports) for (const t of r.container_targets ?? []) for (const ref of t.active_container_images?.image_repo_tags ?? []) {
    const it = splitImage(ref);
    if (it && it[0] === image && compareSemverish(it[1], ours) > 0) tags.add(it[1]);
  }
  return [...tags].sort(compareSemverish).reverse();
}

/** Whether `image` appears in the reports at all */
export function inReports(image: string, reports: ReleaseReport[]): boolean {
  return reports.some((r) => (r.container_targets ?? []).some((t) => (t.active_container_images?.image_repo_tags ?? []).some((ref) => splitImage(ref)?.[0] === image)));
}

/** Our CVEs against the newest tag's: gone = fixed there, still there = Microsoft has not fixed it */
export function classify(ours: string[], latest: string[] | null, same: boolean): Map<string, AksCveStatus> {
  const inLatest = latest ? new Set(latest) : null;
  return new Map(ours.map((id) => [id, same ? "pendingMs" : !inLatest ? "unknown" : inLatest.has(id) ? "pendingMs" : "fixedInLatest"]));
}

/** CVE IDs of a container-image scan report (all scanners) */
export function scanCves(json: unknown): string[] {
  const groups = (json as { active_cves?: Array<{ cves?: Array<{ id?: string }> }> })?.active_cves;
  if (!Array.isArray(groups)) throw new Error("unexpected_shape");
  return [...new Set(groups.flatMap((g) => (g.cves ?? []).map((c) => c.id).filter((x): x is string => typeof x === "string")))].sort();
}

/**
 * Node label kubernetes.azure.com/node-image-version → the VHD report path:
 * AKSUbuntu-2404gen2containerd-202610.23.0 → AKSUbuntu-gen2-2404containerd/202610.23.0 ·
 * AKSAzureLinux-V3gen2-202610.23.0 → AKSAzureLinuxV3-gen2/202610.23.0 · AKSAzureLinux-V2gen2 → AKSAzureLinux-gen2 ·
 * AKSCBLMariner-V2gen2 → AKSCBLMarinerV2-gen2. Anything else (Windows …) = null.
 */
export function vhdReportPath(label: string): string | null {
  const u = /^AKSUbuntu-(\d{4})(gen2)?([a-z]*?)containerd-(\d{6}\.\d{2}\.\d+)$/.exec(label);
  if (u) return `AKSUbuntu-${u[2] ? "gen2" : "gen1"}-${u[1]}${u[3]}containerd/${u[4]}`;
  const a = /^AKS(AzureLinux|CBLMariner)-V(\d)(gen2)?([a-z]*)-(\d{6}\.\d{2}\.\d+)$/.exec(label);
  if (a) {
    const gen = `${a[3] ? "gen2" : "gen1"}${a[4]}`;
    const name = a[1] === "AzureLinux" && a[2] === "2" ? "AKSAzureLinux" : `AKS${a[1]}V${a[2]}`;
    return `${name}-${gen}/${a[5]}`;
  }
  return null;
}

/** A node image's OS packages: distinct CVEs, kernel's share, the packages with the most */
export function summarizeVhd(json: unknown): Omit<AksNodeImageVulns, "image" | "nodes" | "report" | "state" | "regionCurrent"> {
  const pkgs = (json as { os_package_targets?: Array<{ name?: string; version?: string; active_cves?: Array<{ id?: string }> }> })?.os_package_targets;
  if (!Array.isArray(pkgs)) throw new Error("unexpected_shape");
  const all = new Set<string>(), kernel = new Set<string>();
  const rows: { name: string; version: string; cves: number }[] = [];
  for (const p of pkgs) {
    const ids = (p.active_cves ?? []).map((c) => c.id).filter((x): x is string => !!x);
    for (const id of ids) { all.add(id); if (/^linux-/.test(p.name ?? "")) kernel.add(id); }
    if (ids.length) rows.push({ name: p.name ?? "", version: p.version ?? "", cves: ids.length });
  }
  // The kernel ships as ~15 linux-* packages with the same CVE list — one row for them
  const nonKernel = rows.filter((r) => !/^linux-/.test(r.name)).sort((a, b) => b.cves - a.cves || (a.name < b.name ? -1 : 1));
  const k = rows.find((r) => /^linux-(image|modules)-/.test(r.name)) ?? rows.find((r) => /^linux-/.test(r.name));
  const top = [...(k ? [{ name: "linux (kernel)", version: k.version, cves: kernel.size }] : []), ...nonKernel].slice(0, 8);
  return { packages: pkgs.length, withCves: rows.length, cves: all.size, kernelCves: kernel.size, top };
}

const regionKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
type TrackerEntry = { Version?: string; ReleaseNote?: string; ReleaseDate?: string };
type TrackerRegion = { RegionName?: string; Current?: TrackerEntry; Recent?: TrackerEntry[]; InProgress?: unknown };
export type TrackerFacts = {
  rp: Map<string, NonNullable<AksManagedVulnsResponse["release"]["region"]>>;
  /** "ubuntu 24.04" / "azure linux" … → region → newest node image version */
  images: Map<string, Map<string, string>>;
};

/** parsed_data.json → per region: the AKS release (RP) now + before, and the newest node image per distro */
export function parseTracker(json: unknown): TrackerFacts {
  const sections = (json as { Sections?: Record<string, { Components?: Record<string, { RegionalStatuses?: Record<string, TrackerRegion[]> | null }> }> })?.Sections;
  if (!sections?.RP) throw new Error("unexpected_shape");
  const regions = (c: { RegionalStatuses?: Record<string, TrackerRegion[]> | null } | undefined) => Object.values(c?.RegionalStatuses ?? {}).flat();
  const rp = new Map<string, NonNullable<AksManagedVulnsResponse["release"]["region"]>>();
  for (const r of regions(sections.RP.Components?.["Resource Provider"])) {
    if (!r.RegionName || !r.Current?.Version) continue;
    rp.set(regionKey(r.RegionName), {
      current: r.Current.Version, since: r.Current.ReleaseDate ?? null, notes: r.Current.ReleaseNote ?? null,
      inProgress: !!r.InProgress, recent: (r.Recent ?? []).filter((x) => x.Version).map((x) => ({ version: x.Version!, date: x.ReleaseDate ?? null })).slice(0, 3),
    });
  }
  const images = new Map<string, Map<string, string>>();
  for (const sec of ["UbuntuImage", "CBLMarinerImage"]) {
    for (const [name, comp] of Object.entries(sections[sec]?.Components ?? {})) {
      const m = new Map<string, string>();
      for (const r of regions(comp)) if (r.RegionName && r.Current?.Version) m.set(regionKey(r.RegionName), r.Current.Version);
      images.set(name.toLowerCase(), m);
    }
  }
  return { rp, images };
}

/** The tracker's distro name for a VHD report path (Ubuntu 22.04 / 24.04, Azure Linux [FIPS]) */
export function trackerDistro(report: string): string | null {
  const u = /^AKSUbuntu-gen\d-(\d{2})(\d{2})(fips)?/.exec(report);
  if (u) return u[3] ? `ubuntu ${u[1]}.${u[2]} fips` : `ubuntu ${u[1]}.${u[2]}`;
  if (/^AKSAzureLinux/.test(report)) return /fips/.test(report) ? "azure linux fips" : "azure linux";
  return null;
}

/** Releases after the region's (index order = chronological) */
export function releasesAfter(index: string[], current: string | null): string[] {
  if (!current) return [];
  const i = index.indexOf(current);
  return i < 0 ? index.filter((v) => v > current) : index.slice(i + 1);
}

// ── Fetching (public API, fixed host — cached, single-flight) ──

const docCache = new CacheManager<unknown>(400, 6 * 3_600_000);
const missing = Symbol("missing");
const inflight = new Map<string, Promise<unknown>>();

/** GET JSON from the AKS sources; 404 = `missing` (cached — no report for that tag); other failures throw */
async function getDoc(url: string, maxBytes = 8_000_000): Promise<unknown> {
  const hit = docCache.get(url);
  if (hit !== undefined) return hit;
  const run = inflight.get(url);
  if (run) return run;
  const job = (async () => {
    try {
      const v = JSON.parse(await fetchOfficial(url, { maxBytes, timeoutMs: 20_000 }));
      docCache.set(url, v);
      return v;
    } catch (e) {
      if (/HTTP 404/.test(safeMessage(e))) { docCache.set(url, missing); return missing; }
      throw e;
    }
  })().finally(() => inflight.delete(url));
  inflight.set(url, job);
  return job;
}

let tracker: { at: number; facts: TrackerFacts } | null = null;
let trackerRun: Promise<TrackerFacts> | null = null;
/** The tracker file is ~25 MB — parsed once per 6 hours, only the small facts kept */
async function trackerFacts(): Promise<TrackerFacts> {
  if (tracker && Date.now() - tracker.at < 6 * 3_600_000) return tracker.facts;
  trackerRun ??= (async () => {
    try {
      const facts = parseTracker(JSON.parse(await fetchOfficial(TRACKER_DATA, { maxBytes: 64_000_000, timeoutMs: 30_000 })));
      tracker = { at: Date.now(), facts };
      return facts;
    } finally { trackerRun = null; }
  })();
  return trackerRun;
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]!); }));
}

const resultCache = new CacheManager<AksManagedVulnsResponse>(50, 30 * 60_000);

export async function collectAksManagedVulns(env: Env, bearerToken: string | undefined, clusterId: string): Promise<AksManagedVulnsResponse> {
  const key = `${cachePrefix(bearerToken)}:aks-managed:${clusterId.toLowerCase()}`;
  const hit = resultCache.get(key);
  if (hit) return hit;

  const [inv, ctx] = await Promise.all([
    collectPolicyInventory(env, bearerToken, clusterId),
    getClusterContext(env, bearerToken, clusterId).catch(() => null),
  ]);
  const { result, partial } = await buildManagedVulns(env, clusterId, inv, ctx?.containment.cluster.location ?? null, ctx?.containment.cluster.k8sVersion || null);
  // A partial read (CVE.org still filling, a source failed) is cached briefly so the next load completes it
  resultCache.set(key, result, partial ? 2 * 60_000 : undefined);
  return result;
}

/** Everything after the cluster reads (exported for the tests / a live probe with a given inventory) */
export async function buildManagedVulns(env: Env, clusterId: string, inv: Pick<PolicyInventory, "pods" | "nodes">, location: string | null, k8sVersion: string | null): Promise<{ result: AksManagedVulnsResponse; partial: boolean }> {
  const now = new Date().toISOString();
  const running = managedImages(inv.pods);
  const sources: AksManagedSource[] = [];

  if (!env.AUD_ADVISORY_FEEDS) {
    const off = (id: AksManagedSource["id"]): AksManagedSource => ({ id, state: "disabled", checkedAt: null });
    return { partial: false, result: {
      clusterId, generatedAt: now, location, k8sVersion, sources: [off("cveApi"), off("releaseTracker"), off("kev"), off("cveOrg")],
      release: { latest: null, region: null, notYetInRegion: [] },
      components: running.map((r) => ({ ...familyOf(r.image), image: r.image, tag: r.tag, where: whereOf(r), scan: "failed", cves: [], latest: null })),
      nodeImages: [], totals: { components: running.length, scanned: 0, cves: 0, fixedInLatest: 0, pendingMs: 0, unknown: 0, kev: 0 }, pending: 0,
    } };
  }

  // Release context: the index, this region's release (tracker), the newest + the region's report, the k8s version's report
  let apiError: string | null = null;
  const tryDoc = async (url: string, maxBytes?: number) => {
    try { const v = await getDoc(url, maxBytes); return v === missing ? null : v; } catch (e) { apiError ??= safeMessage(e).slice(0, 120); debug(`[aks-managed] ${url}: ${safeMessage(e)}`); return undefined; }
  };
  const [indexDoc, facts, k8sIndex] = await Promise.all([
    tryDoc(`${CVE_API}/aks-releases/_index`),
    trackerFacts().then((f) => { sources.push({ id: "releaseTracker", state: "ok", checkedAt: now, url: "https://releases.aks.azure.com" }); return f; })
      .catch((e) => { sources.push({ id: "releaseTracker", state: "failed", checkedAt: now, url: "https://releases.aks.azure.com", detail: safeMessage(e).slice(0, 120) }); return null; }),
    tryDoc(`${CVE_API}/aks-k8s-releases/_index`),
  ]);
  const index = ((indexDoc as { aks_release_versions?: string[] } | null | undefined)?.aks_release_versions ?? []).filter((v) => /^v\d{8}$/.test(v));
  const latest = index.at(-1) ?? null;
  const region = location && facts ? facts.rp.get(regionKey(location)) ?? null : null;
  const k8sList = (k8sIndex as { k8s_versions?: string[] } | null | undefined)?.k8s_versions ?? [];
  const [latestReport, regionReport, k8sReport] = await Promise.all([
    latest ? tryDoc(`${CVE_API}/aks-releases/${latest}/scan-reports`) : null,
    region && region.current !== latest && index.includes(region.current) ? tryDoc(`${CVE_API}/aks-releases/${region.current}/scan-reports`) : null,
    k8sVersion && k8sList.includes(k8sVersion) ? tryDoc(`${CVE_API}/aks-k8s-releases/${k8sVersion}/scan-reports`) : null,
  ]);
  const reports = [latestReport, regionReport, k8sReport].filter((r): r is ReleaseReport => !!r);

  // Per image: our tag's scan, then the newest newer tag that has a scan (up to 3 tried — the newest is often not scanned yet)
  const scans = new Map<string, string[] | null | undefined>(); // undefined = failed, null = no report
  const scan = async (ref: string) => {
    if (scans.has(ref)) return scans.get(ref);
    const d = await tryDoc(`${CVE_API}/container-images/${ref}/scan-reports`, 4_000_000);
    let v: string[] | null | undefined;
    try { v = d === undefined ? undefined : d === null ? null : scanCves(d); } catch { v = undefined; }
    scans.set(ref, v);
    return v;
  };
  const scanState = (v: string[] | null | undefined) => (v === undefined ? "failed" : v === null ? "notScanned" : "scanned") as AksManagedComponent["scan"];
  const compared = new Map<string, AksManagedComponent["latest"]>();
  await pool(running, 6, async (r) => {
    await scan(`${r.image}:${r.tag}`);
    const newer = newerTags(r.image, r.tag, reports);
    if (!newer.length) { compared.set(`${r.image}:${r.tag}`, inReports(r.image, reports) || scans.get(`${r.image}:${r.tag}`) ? { tag: r.tag, same: true, scan: scanState(scans.get(`${r.image}:${r.tag}`)), cves: scans.get(`${r.image}:${r.tag}`)?.length ?? null } : null); return; }
    for (const tag of newer.slice(0, 3)) {
      const v = await scan(`${r.image}:${tag}`);
      if (Array.isArray(v)) { compared.set(`${r.image}:${r.tag}`, { tag, same: false, scan: "scanned", cves: v.length }); return; }
    }
    compared.set(`${r.image}:${r.tag}`, { tag: newer[0]!, same: false, scan: scanState(scans.get(`${r.image}:${newer[0]}`)), cves: null });
  });

  // Node images (OS packages)
  const nodeCounts = new Map<string, number>();
  for (const n of inv.nodes ?? []) if (n.nodeImage) nodeCounts.set(n.nodeImage, (nodeCounts.get(n.nodeImage) ?? 0) + 1);
  const nodeImages: AksNodeImageVulns[] = [];
  for (const [image, nodes] of nodeCounts) {
    const report = vhdReportPath(image);
    const distro = report ? trackerDistro(report) : null;
    // Node images of one build date share the version (202610.23.0 for every Ubuntu): when the tracker lists this distro in
    // fewer regions (Ubuntu 24.04), the region's build of the same family stands in
    const inRegion = (name: string) => (location && facts ? facts.images.get(name)?.get(regionKey(location)) ?? null : null);
    const regionCurrent = distro ? inRegion(distro) ?? (facts ? [...facts.images.keys()].filter((k) => k.split(" ")[0] === distro.split(" ")[0] && !k.includes("fips")).map(inRegion).find(Boolean) ?? null : null) : null;
    const base = { image, nodes, report, regionCurrent, packages: 0, withCves: 0, cves: 0, kernelCves: 0, top: [] };
    if (!report) { nodeImages.push({ ...base, state: "unmapped" }); continue; }
    const d = await tryDoc(`${CVE_API}/vhd-releases/${report}/scan-reports`, 16_000_000);
    if (d === undefined) nodeImages.push({ ...base, state: "failed" });
    else if (d === null) nodeImages.push({ ...base, state: "notFound" });
    else { try { nodeImages.push({ ...base, state: "ok", ...summarizeVhd(d) }); } catch { nodeImages.push({ ...base, state: "failed" }); } }
  }
  sources.unshift({ id: "cveApi", state: apiError && !scans.size ? "failed" : "ok", checkedAt: now, url: "https://cve-api.prod-aks.azure.com", ...(apiError ? { detail: apiError } : {}) });

  // Exploited (KEV) + severity (CVE.org) for the container CVEs — node OS CVEs are counted, not detailed (thousands)
  const allIds = new Set<string>();
  for (const r of running) for (const id of scans.get(`${r.image}:${r.tag}`) ?? []) allIds.add(id);
  const [feeds, cveOrg] = await Promise.all([
    loadFeeds(env).catch(() => null),
    cveOrgRecords(env, [...allIds]).catch(() => ({ records: new Map(), pending: allIds.size, failed: true })),
  ]);
  const kevSrc = feeds?.sources.find((s) => s.id === "kev");
  sources.push({ id: "kev", state: kevSrc?.state === "ok" ? "ok" : "failed", checkedAt: now, url: "https://www.cisa.gov/known-exploited-vulnerabilities-catalog" });
  sources.push({ id: "cveOrg", state: cveOrg.failed ? "failed" : "ok", checkedAt: now, url: "https://www.cve.org" });
  const kev = new Set((feeds?.kev ?? []).map((k) => k.cve));

  const components: AksManagedComponent[] = running.map((r) => {
    const ours = scans.get(`${r.image}:${r.tag}`);
    const cmp = compared.get(`${r.image}:${r.tag}`) ?? null;
    const theirs = cmp && !cmp.same && cmp.scan === "scanned" ? scans.get(`${r.image}:${cmp.tag}`) ?? null : null;
    const status = classify(ours ?? [], theirs, !!cmp?.same && Array.isArray(ours));
    return {
      ...familyOf(r.image), image: r.image, tag: r.tag, where: whereOf(r), scan: scanState(ours),
      cves: (ours ?? []).map((id) => {
        const rec = cveOrg.records.get(id);
        return { id, status: status.get(id)!, kev: kev.has(id), severity: rec?.cvss?.severity?.toLowerCase() || null, score: rec?.cvss?.score ?? null };
      }).sort((a, b) => Number(b.kev) - Number(a.kev) || (b.score ?? -1) - (a.score ?? -1) || (a.id < b.id ? -1 : 1)),
      latest: cmp,
    };
  });
  const flat = components.flatMap((c) => c.cves);
  const result: AksManagedVulnsResponse = {
    clusterId, generatedAt: now, location, k8sVersion, sources,
    release: { latest, region, notYetInRegion: releasesAfter(index, region?.current ?? null) },
    components, nodeImages,
    totals: {
      components: components.length, scanned: components.filter((c) => c.scan === "scanned").length, cves: new Set(flat.map((c) => c.id)).size,
      fixedInLatest: flat.filter((c) => c.status === "fixedInLatest").length, pendingMs: flat.filter((c) => c.status === "pendingMs").length,
      unknown: flat.filter((c) => c.status === "unknown").length, kev: new Set(flat.filter((c) => c.kev).map((c) => c.id)).size,
    },
    pending: cveOrg.pending,
  };
  return { result, partial: !!(cveOrg.pending || apiError || !facts) };
}

function whereOf(r: RunningImage): AksManagedComponent["where"] {
  return [...r.where].map(([namespace, w]) => ({ namespace, containers: [...w.containers].sort(), pods: w.pods }));
}
