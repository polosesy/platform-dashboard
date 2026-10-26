// 보안 › 긴급 취약점 — matching (pure). An advisory is matched against what the platform runs:
//   runtime   — this dashboard's own process (process.versions — exact)
//   imageTag  — cluster images whose name says the runtime (node:24.13.0-…, php:8.3.12-fpm …) — the tag is what the
//               image claims; `node:24`/`latest` name no patch version → unknown, never assumed
//   defender  — Microsoft Defender for Cloud container findings for these CVE IDs (packages inside app images)
// "Fixed" = at or above the vendor's first security release in that line on/after the advisory date (nodejs.org
// dist index `security`, php.net release "security" tag). A line with no such release is end of life.

import type {
  AdvisoryCve, AdvisoryFix, AdvisoryItem, AdvisoryProduct, AdvisoryStatus, ExposureEvidence, ExposureStatus, ExposureTarget,
} from "@aud/types";
import type { FeedPost, KevEntry, Release } from "./advisoryFeeds.js";
import { L } from "../infra/lang.js";

// ── Versions ──

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((x) => Number.parseInt(x, 10) || 0), pb = b.split(".").map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

export const lineOf = (product: AdvisoryProduct, version: string) =>
  product === "nodejs" ? version.split(".")[0]! : version.split(".").slice(0, 2).join(".");

const DAY = 86_400_000;
/** First security release per line on/after the advisory date (releases can be dated a day before the post) */
export function fixesFor(releases: Release[], advisoryDate: string | null): AdvisoryFix[] {
  const since = advisoryDate ? new Date(advisoryDate).getTime() - 2 * DAY : 0;
  const byLine = new Map<string, Release[]>();
  for (const r of releases) if (r.security && new Date(r.date).getTime() >= since) byLine.set(r.line, [...(byLine.get(r.line) ?? []), r]);
  return [...byLine.entries()]
    .map(([line, list]) => { const first = [...list].sort((a, b) => compareVersions(a.version, b.version))[0]!; return { line, version: first.version, date: first.date }; })
    .sort((a, b) => compareVersions(b.line, a.line));
}

/** Newest security release per line (for a runtime with no advisory: "latest security release") */
export function latestSecurity(releases: Release[]): AdvisoryFix[] {
  const best = new Map<string, Release>();
  for (const r of releases) if (r.security && (!best.has(r.line) || compareVersions(r.version, best.get(r.line)!.version) > 0)) best.set(r.line, r);
  return [...best.values()].map((r) => ({ line: r.line, version: r.version, date: r.date }));
}

// ── Image references ──

export type ImageRuntime = { product: AdvisoryProduct; line: string | null; version: string | null; reason: "exact" | "lineOnly" | "noVersion" };
const NODE_REPOS = /(^|\/)(node|nodejs|dhi-node)$/i;
const PHP_REPOS = /(^|\/)(php|php-fpm|php-apache|dhi-php)$/i;

/** What runtime an image name says it carries — only official-looking runtime repositories, never app images */
export function imageRuntime(image: string): ImageRuntime | null {
  const noDigest = image.split("@")[0]!;
  const slash = noDigest.lastIndexOf("/");
  const colon = noDigest.lastIndexOf(":");
  const repo = colon > slash ? noDigest.slice(0, colon) : noDigest;
  const tag = colon > slash ? noDigest.slice(colon + 1) : "";
  const product: AdvisoryProduct | null = NODE_REPOS.test(repo) ? "nodejs" : PHP_REPOS.test(repo) ? "php" : null;
  if (!product) return null;
  const full = /^v?(\d+)\.(\d+)\.(\d+)/.exec(tag);
  if (full) {
    const version = `${full[1]}.${full[2]}.${full[3]}`;
    return { product, line: lineOf(product, version), version, reason: "exact" };
  }
  const line = product === "nodejs" ? /^(\d+)(?:[.-]|$)/.exec(tag)?.[1] : /^(\d+\.\d+)(?:[.-]|$)/.exec(tag)?.[1];
  return line ? { product, line, version: null, reason: "lineOnly" } : { product, line: null, version: null, reason: "noVersion" };
}

// ── Exposure ──

export type RuntimeFact = { product: AdvisoryProduct; version: string; where: string; evidence: ExposureEvidence };
export type ClusterImage = { image: string; workloads: string[] };
export type DefenderHit = { cve: string; image: string; pkg: string; version: string; fixed: string | null };

export type MatchContext = {
  runtimes: RuntimeFact[];
  /** null = the cluster inventory was not read (unknown, not "no images") */
  clusterImages: ClusterImage[] | null;
  /** null = Defender findings were not read */
  defender: DefenderHit[] | null;
  /** Workloads per image, for Defender hits (image → ns/workload) */
  workloadsOf: (image: string) => string[];
};

const statusFor = (version: string | null, line: string | null, fixes: AdvisoryFix[]): ExposureStatus => {
  if (!line) return "unknown";
  const fix = fixes.find((f) => f.line === line);
  if (!fix) return fixes.length ? "eol" : "unknown";
  if (!version) return "unknown";
  return compareVersions(version, fix.version) >= 0 ? "fixed" : "affected";
};

let seq = 0;
const tid = (p: string) => `${p}${++seq}`;

export function targetsFor(product: AdvisoryProduct | null, cves: string[], fixes: AdvisoryFix[], ctx: MatchContext): ExposureTarget[] {
  const out: ExposureTarget[] = [];
  if (product) {
    for (const r of ctx.runtimes.filter((x) => x.product === product)) {
      const line = lineOf(product, r.version);
      out.push({ id: tid("rt"), evidence: r.evidence, product, where: r.where, image: null, workloads: [], pkg: null, current: r.version,
        fixed: fixes.find((f) => f.line === line)?.version ?? null, status: statusFor(r.version, line, fixes), note: null, cves });
    }
    for (const ci of ctx.clusterImages ?? []) {
      const rt = imageRuntime(ci.image);
      if (!rt || rt.product !== product) continue;
      const status = statusFor(rt.version, rt.line, fixes);
      out.push({ id: tid("img"), evidence: "imageTag", product, where: ci.workloads[0] ?? "", image: ci.image, workloads: ci.workloads, pkg: null,
        current: rt.version ?? (rt.line ? `${rt.line}.x` : null), fixed: rt.line ? fixes.find((f) => f.line === rt.line)?.version ?? null : null,
        status, note: rt.reason === "exact" ? null : rt.reason, cves });
    }
  }
  const want = new Set(cves);
  const byImage = new Map<string, DefenderHit[]>();
  for (const h of ctx.defender ?? []) if (want.has(h.cve)) byImage.set(`${h.image}|${h.pkg}`, [...(byImage.get(`${h.image}|${h.pkg}`) ?? []), h]);
  for (const hits of byImage.values()) {
    const h = hits[0]!;
    const wl = ctx.workloadsOf(h.image);
    out.push({ id: tid("df"), evidence: "defender", product, where: wl[0] ?? "", image: h.image, workloads: wl, pkg: h.pkg, current: h.version || null,
      fixed: h.fixed || null, status: "affected", note: null, cves: [...new Set(hits.map((x) => x.cve))] });
  }
  const rank: Record<ExposureStatus, number> = { affected: 0, eol: 1, unknown: 2, fixed: 3 };
  return out.sort((a, b) => rank[a.status] - rank[b.status] || a.where.localeCompare(b.where));
}

export function statusOf(targets: ExposureTarget[], product: AdvisoryProduct | null, ctx: MatchContext): AdvisoryStatus {
  if (targets.some((t) => t.status === "affected" || t.status === "eol")) return "affected";
  if (targets.some((t) => t.status === "unknown")) return "unknown";
  // Nothing found: only "clear" when every way to find it was actually read
  if (!targets.length) return ctx.defender !== null && (product === null || ctx.clusterImages !== null) ? "notDetected" : "unknown";
  return "clear";
}

const PRODUCT_LABEL: Record<AdvisoryProduct, string> = { nodejs: "Node.js", php: "PHP" };

/** Recommended actions, most important first (localized with L()) */
export function actionsFor(item: Pick<AdvisoryItem, "product" | "fixes" | "cves">, targets: ExposureTarget[]): string[] {
  const out: string[] = [];
  const p = item.product;
  const affected = targets.filter((t) => t.status === "affected" && t.evidence !== "defender");
  if (p && affected.length) {
    const lines = [...new Set(affected.map((t) => (t.current ? lineOf(p, t.current.replace(/\.x$/, ".0")) : "")))].filter(Boolean);
    for (const line of lines) {
      const fix = item.fixes.find((f) => f.line === line);
      if (!fix) continue;
      out.push(p === "nodejs"
        ? L(`Node.js ${line}.x → ${fix.version} 이상: 기본 이미지를 node:${fix.version}-<변형>(또는 같은 버전의 하드닝 미러)으로 바꾸고 다시 빌드·배포`, `Node.js ${line}.x → ${fix.version} or later: switch the base image to node:${fix.version}-<variant> (or the hardened mirror of that version), rebuild and redeploy`)
        : L(`PHP ${line} → ${fix.version} 이상: php-fpm·mod_php·php-cgi 모두 해당 — php:${fix.version}-<변형> 이미지로 다시 빌드·배포`, `PHP ${line} → ${fix.version} or later: php-fpm, mod_php and php-cgi alike — rebuild on php:${fix.version}-<variant> and redeploy`));
    }
  }
  if (p && targets.some((t) => t.status === "eol")) {
    out.push(L(`지원이 끝난 ${PRODUCT_LABEL[p]} 라인 — 수정판이 없습니다. 지원 라인(${item.fixes.map((f) => f.line).join(", ")})으로 이전`, `${PRODUCT_LABEL[p]} line out of support — no fix exists. Move to a supported line (${item.fixes.map((f) => f.line).join(", ")})`));
  }
  if (targets.some((t) => t.status === "unknown" && t.evidence === "imageTag")) {
    out.push(L("태그가 패치 버전을 밝히지 않는 이미지(예: node:24, latest) — 정확한 버전 태그나 다이제스트로 고정해야 판정할 수 있음", "Images whose tag doesn't name the patch version (node:24, latest …) — pin an exact version tag or digest so they can be checked"));
  }
  if (targets.some((t) => t.evidence === "defender")) {
    out.push(L("Defender가 찾은 패키지: 수정 버전으로 올린 뒤 이미지를 다시 빌드·푸시하고 워크로드를 다시 배포 (Defender 재스캔은 최대 24시간)", "Packages found by Defender: update to the fixed version, rebuild and push the image, redeploy the workloads (Defender rescans within about 24 h)"));
  }
  const kev = item.cves.filter((c) => c.kev);
  if (kev.length) {
    out.push(L(`실제 악용 확인(CISA KEV): ${kev.map((c) => `${c.id} — 기한 ${c.kev!.dueDate}`).join(", ")} — 우선 처리`, `Exploited in the wild (CISA KEV): ${kev.map((c) => `${c.id} — due ${c.kev!.dueDate}`).join(", ")} — do these first`));
  }
  return out;
}

export function buildItem(base: Omit<AdvisoryItem, "targets" | "status" | "actions">, ctx: MatchContext): AdvisoryItem {
  const targets = targetsFor(base.product, base.cves.map((c) => c.id), base.fixes, ctx);
  return { ...base, targets, status: statusOf(targets, base.product, ctx), actions: actionsFor(base, targets) };
}

/** Vendor posts → advisory bases (CVE details attached by the caller) */
export function vendorBases(product: AdvisoryProduct, posts: FeedPost[], releases: Release[], cve: (id: string) => AdvisoryCve): Array<Omit<AdvisoryItem, "targets" | "status" | "actions">> {
  // One item per set of CVEs: release notes that repeat an advisory's CVEs ("PHP 8.5.12 Released!") are not news
  const seen = new Set<string>();
  const unique = posts.filter((p) => {
    if (!p.cves.length || p.cves.every((c) => seen.has(c))) return false;
    p.cves.forEach((c) => seen.add(c));
    return true;
  });
  return unique.slice(0, 2).map((p) => {
    const fixes = fixesFor(releases, p.date);
    return {
      key: `${product}:${p.url}`, kind: "vendor" as const, product, title: p.title, date: p.date || null, url: p.url,
      cves: p.cves.map(cve), fixes, eolLines: [],
    };
  });
}

/** KEV entries added in the last `days` days, newest first */
export function recentKev(kev: KevEntry[], now: Date, days = 30): KevEntry[] {
  const since = now.getTime() - days * DAY;
  return kev.filter((k) => new Date(k.dateAdded).getTime() >= since).sort((a, b) => b.dateAdded.localeCompare(a.dateAdded) || a.cve.localeCompare(b.cve));
}

export const PRODUCT_NAMES = PRODUCT_LABEL;
