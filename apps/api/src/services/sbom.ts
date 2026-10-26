// What we run, as package coordinates an advisory database understands (OSV ecosystems):
//   platform — the npm packages actually deployed with this dashboard (node_modules of the API and the web bundle),
//              the OS packages of its image (dpkg / apk database)
//   cluster  — the Kubernetes server version and well-known open-source images (tag → Go module + version)
// Parsers are pure; reading the files happens once per process (the image does not change while it runs).
// App images and images not in KNOWN_IMAGES are never guessed — Defender covers those.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type Coord = { ecosystem: string; name: string; version: string };
export type SbomEntry = Coord & { kind: "npm" | "os" | "k8s" | "image"; components: string[]; image?: string };

// ── OS ──

/** /etc/os-release → OSV ecosystem ("Debian:12", "Alpine:v3.20") or null */
export function osEcosystem(osRelease: string): string | null {
  const v = (k: string) => new RegExp(`^${k}="?([^"\\n]*)"?`, "m").exec(osRelease)?.[1] ?? "";
  const id = v("ID").toLowerCase(), ver = v("VERSION_ID");
  if (id === "debian" && /^\d+/.test(ver)) return `Debian:${ver.split(".")[0]}`;
  if (id === "alpine" && /^\d+\.\d+/.test(ver)) return `Alpine:v${ver.split(".").slice(0, 2).join(".")}`;
  return null;
}

/** dpkg status → installed packages by source name and source version (Debian advisories are per source package) */
export function parseDpkgStatus(status: string): Array<{ name: string; version: string }> {
  const out = new Map<string, string>();
  for (const block of status.split(/\n\n+/)) {
    const f = (k: string) => new RegExp(`^${k}: (.*)$`, "m").exec(block)?.[1]?.trim() ?? "";
    if (!/install ok installed/.test(f("Status"))) continue;
    const src = /^(\S+)(?: \(([^)]+)\))?$/.exec(f("Source"));
    const name = src?.[1] || f("Package");
    const version = src?.[2] || f("Version");
    if (name && version) out.set(`${name}@${version}`, name);
  }
  return [...out].map(([k, name]) => ({ name, version: k.slice(name.length + 1) }));
}

/** apk installed database → packages by origin (Alpine advisories are per origin package) */
export function parseApkInstalled(db: string): Array<{ name: string; version: string }> {
  const out = new Map<string, { name: string; version: string }>();
  for (const block of db.split(/\n\n+/)) {
    const f = (k: string) => new RegExp(`^${k}:(.*)$`, "m").exec(block)?.[1]?.trim() ?? "";
    const name = f("o") || f("P"), version = f("V");
    if (name && version) out.set(`${name}@${version}`, { name, version });
  }
  return [...out.values()];
}

// ── npm (node_modules as deployed) ──

/** Every package.json under node_modules (scoped and nested), name@version → where */
export function scanNodeModules(root: string, label: string, acc = new Map<string, SbomEntry>(), depth = 0): Map<string, SbomEntry> {
  if (depth > 8 || acc.size > 6000 || !existsSync(root)) return acc;
  let entries: string[] = [];
  try { entries = readdirSync(root); } catch { return acc; }
  for (const e of entries) {
    if (e.startsWith(".")) continue;
    const dirs = e.startsWith("@") ? safeList(join(root, e)).map((x) => join(root, e, x)) : [join(root, e)];
    for (const d of dirs) {
      try {
        const pkg = JSON.parse(readFileSync(join(d, "package.json"), "utf8")) as { name?: string; version?: string };
        if (pkg.name && pkg.version && /^\d+\.\d+\.\d+/.test(pkg.version)) {
          const key = `${pkg.name}@${pkg.version}`;
          const cur = acc.get(key);
          if (cur) { if (!cur.components.includes(label)) cur.components.push(label); }
          else acc.set(key, { ecosystem: "npm", name: pkg.name, version: pkg.version, kind: "npm", components: [label] });
        }
      } catch { /* not a package */ }
      scanNodeModules(join(d, "node_modules"), label, acc, depth + 1);
    }
  }
  return acc;
}
const safeList = (d: string) => { try { return readdirSync(d); } catch { return []; } };

/** node_modules roots of this deployment: every ancestor's node_modules (API) and <ancestor>/web/node_modules (web bundle) */
export function nodeModuleRoots(from: string): Array<{ dir: string; label: "API" | "web" }> {
  const roots: Array<{ dir: string; label: "API" | "web" }> = [];
  let d = from;
  for (let i = 0; i < 8; i++) {
    for (const [dir, label] of [[join(d, "node_modules"), "API"], [join(d, "web", "node_modules"), "web"]] as const) {
      if (existsSync(dir) && !roots.some((r) => r.dir === dir)) roots.push({ dir, label });
    }
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  return roots;
}

let platformCache: { entries: SbomEntry[]; os: string | null } | null = null;

/** The platform's own SBOM (read once — the image doesn't change while it runs) */
export function platformSbom(): { entries: SbomEntry[]; os: string | null } {
  if (platformCache) return platformCache;
  const acc = new Map<string, SbomEntry>();
  for (const r of nodeModuleRoots(dirname(fileURLToPath(import.meta.url)))) scanNodeModules(r.dir, r.label, acc);
  let os: string | null = null;
  try { os = osEcosystem(readFileSync("/etc/os-release", "utf8")); } catch { /* not Linux (local Windows dev) */ }
  if (os?.startsWith("Debian")) {
    try { for (const p of parseDpkgStatus(readFileSync("/var/lib/dpkg/status", "utf8"))) acc.set(`deb:${p.name}@${p.version}`, { ecosystem: os, name: p.name, version: p.version, kind: "os", components: ["OS"] }); } catch { /* no dpkg db (distroless) */ }
  } else if (os?.startsWith("Alpine")) {
    try { for (const p of parseApkInstalled(readFileSync("/lib/apk/db/installed", "utf8"))) acc.set(`apk:${p.name}@${p.version}`, { ecosystem: os, name: p.name, version: p.version, kind: "os", components: ["OS"] }); } catch { /* none */ }
  }
  // The repo's own workspaces (@aud/*) are not published packages
  platformCache = { entries: [...acc.values()].filter((e) => !e.name.startsWith("@aud/")), os };
  return platformCache;
}

// ── Cluster ──

/**
 * Well-known open-source images → Go module (the module the project publishes advisories under in the Go
 * vulnerability database / GitHub Advisory DB). `major: true` = the module path carries /vN for N ≥ 2.
 */
export const KNOWN_IMAGES: Array<{ re: RegExp; module: string; major?: true }> = [
  { re: /(^|\/)cilium\/(cilium|operator-generic|operator-azure|hubble-relay)$/, module: "github.com/cilium/cilium" },
  { re: /(^|\/)argoproj\/argocd$/, module: "github.com/argoproj/argo-cd", major: true },
  { re: /(^|\/)coredns(\/coredns)?$/, module: "github.com/coredns/coredns" },
  { re: /(^|\/)grafana\/loki$/, module: "github.com/grafana/loki", major: true },
  { re: /(^|\/)ingress-nginx\/controller$/, module: "k8s.io/ingress-nginx" },
  { re: /(^|\/)kube-state-metrics(\/kube-state-metrics)?$/, module: "k8s.io/kube-state-metrics", major: true },
  { re: /(^|\/)(jetstack\/)?cert-manager-(controller|webhook|cainjector)$/, module: "github.com/cert-manager/cert-manager" },
  { re: /(^|\/)kyverno\/kyverno$/, module: "github.com/kyverno/kyverno" },
  { re: /(^|\/)kedacore\/keda$/, module: "github.com/kedacore/keda", major: true },
  { re: /(^|\/)velero\/velero$/, module: "github.com/vmware-tanzu/velero" },
  { re: /(^|\/)external-secrets\/external-secrets$/, module: "github.com/external-secrets/external-secrets" },
  { re: /(^|\/)openpolicyagent\/gatekeeper$/, module: "github.com/open-policy-agent/gatekeeper", major: true },
];

/** An image reference → Go module coordinate, when it is a known project with a semver tag */
export function imageCoord(image: string): Coord | null {
  const noDigest = image.split("@")[0]!;
  const slash = noDigest.lastIndexOf("/"), colon = noDigest.lastIndexOf(":");
  const repo = (colon > slash ? noDigest.slice(0, colon) : noDigest).toLowerCase();
  const tag = colon > slash ? noDigest.slice(colon + 1) : "";
  const known = KNOWN_IMAGES.find((k) => k.re.test(repo));
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(tag);
  if (!known || !m) return null;
  const major = Number(m[1]);
  const module = known.major && major >= 2 ? `${known.module}/v${major}` : known.module;
  return { ecosystem: "Go", name: module, version: `${m[1]}.${m[2]}.${m[3]}` };
}

/** Cluster SBOM: Kubernetes server version + known images (by workload) */
export function clusterSbom(k8sVersion: string | null, images: Array<{ image: string; workloads: string[] }>): { entries: SbomEntry[]; unmapped: number } {
  const out: SbomEntry[] = [];
  const kv = /^v?(\d+\.\d+\.\d+)/.exec(k8sVersion ?? "")?.[1];
  if (kv) out.push({ ecosystem: "Go", name: "k8s.io/kubernetes", version: kv, kind: "k8s", components: ["Kubernetes (AKS)"] });
  let unmapped = 0;
  for (const i of images) {
    const c = imageCoord(i.image);
    if (!c) { unmapped++; continue; }
    const cur = out.find((e) => e.name === c.name && e.version === c.version);
    if (cur) cur.components.push(...i.workloads.filter((w) => !cur.components.includes(w)));
    else out.push({ ...c, kind: "image", components: [...i.workloads], image: i.image });
  }
  return { entries: out, unmapped };
}
