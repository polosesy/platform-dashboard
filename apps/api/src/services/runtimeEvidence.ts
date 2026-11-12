// AKS 모니터링 › 앱 런타임 — evidence other than the runtime's own metrics. Nothing here guesses from a name:
//   spec  = what the workload's manifest declares: the executable it starts, a variable only that runtime reads, or
//           the OpenTelemetry Operator's inject annotation (Kubernetes API — the template list the VPA section reads)
//   scan  = Defender for Containers scanned the image and found packages of that language in it (Resource Graph;
//           Defender lists packages with a finding only — absence says nothing, and a language found in an image is
//           "this image contains it", which the screen says in those words)
//   image = a Docker Hub official image (`redis:7`, `docker.io/library/nginx`) — the publisher states what it is;
//           a mirror or a look-alike name is NOT claimed
// Values of variables are never read (only names); commands are reduced to the executable's base name.

import type { AppRuntimeKind } from "@aud/types";
import type { Env } from "../env.js";
import { CacheManager, cachePrefix } from "../infra/cacheManager.js";
import { getArmFetcherAuto } from "../infra/azureClientFactory.js";
import { imageParts } from "./imageVulns.js";

export type RuntimeEvidence = { kind: AppRuntimeKind; evidence: string };
export type SpecContainer = { name?: string; image?: string; command?: string[]; args?: string[]; env?: Array<{ name?: string }> };

/** Launchers that only start the real program (skipped to find the executable) */
const WRAPPERS = new Set(["sh", "bash", "ash", "dash", "tini", "dumb-init", "exec", "env", "su-exec", "gosu", "nohup", "catatonit"]);
const EXECUTABLES: Array<[RegExp, AppRuntimeKind]> = [
  [/^java$/, "jvm"],
  [/^(node|nodejs)$/, "nodejs"],
  [/^(python|python\d(\.\d+)?|gunicorn|uvicorn|celery)$/, "python"],
  [/^dotnet$/, "dotnet"],
  [/^(nginx|openresty)$/, "nginx"],
  [/^(redis-server|valkey-server)$/, "redis"],
  [/^(postgres|postmaster)$/, "postgres"],
];
/** Variables the runtime itself reads (not team conventions such as JAVA_OPTS · NODE_ENV) */
const RUNTIME_ENV: Array<[RegExp, AppRuntimeKind]> = [
  [/^(JAVA_TOOL_OPTIONS|JDK_JAVA_OPTIONS|_JAVA_OPTIONS)$/, "jvm"],
  [/^NODE_OPTIONS$/, "nodejs"],
  [/^(PYTHONPATH|PYTHONUNBUFFERED|PYTHONDONTWRITEBYTECODE|PYTHONHASHSEED)$/, "python"],
  [/^(DOTNET_[A-Z0-9_]+|ASPNETCORE_[A-Z0-9_]+|COMPlus_[A-Za-z0-9_]+)$/, "dotnet"],
  [/^(GOMAXPROCS|GOMEMLIMIT|GOGC|GODEBUG)$/, "go"],
];
const OTEL_INJECT: Record<string, AppRuntimeKind> = { java: "jvm", nodejs: "nodejs", python: "python", dotnet: "dotnet", go: "go" };

/** Pure: the executable a container's `command` starts (wrappers and flags skipped; `sh -c "<line>"` → its first word) */
export function executableOf(command: string[] | undefined): string | null {
  const words = (command ?? []).flatMap((w, i, all) => (all[i - 1] === "-c" ? w.trim().split(/\s+/) : [w]));
  for (const w of words.slice(0, 8)) {
    if (!w || w.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) continue;
    const base = w.split("/").pop()!.toLowerCase();
    if (WRAPPERS.has(base)) continue;
    return /^[a-z0-9._+-]{1,40}$/.test(base) ? base : null;
  }
  return null;
}

/**
 * Pure: what the manifest declares. `args` alone are not read — they go to the image's entrypoint, which the
 * manifest does not show.
 */
export function runtimesOfSpec(containers: SpecContainer[], annotations: Record<string, string> = {}): RuntimeEvidence[] {
  const out: RuntimeEvidence[] = [];
  const add = (kind: AppRuntimeKind, evidence: string) => { if (!out.some((x) => x.kind === kind)) out.push({ kind, evidence }); };
  for (const c of containers) {
    const exe = executableOf(c.command);
    const byExe = exe ? EXECUTABLES.find(([re]) => re.test(exe))?.[1] : undefined;
    if (byExe && exe) add(byExe, `command: ${exe}`);
  }
  for (const [key, value] of Object.entries(annotations)) {
    const lang = /^instrumentation\.opentelemetry\.io\/inject-([a-z]+)$/.exec(key)?.[1];
    if (lang && OTEL_INJECT[lang] && value && value !== "false") add(OTEL_INJECT[lang]!, `annotation: inject-${lang}`);
  }
  for (const c of containers) {
    for (const e of c.env ?? []) {
      const kind = e.name ? RUNTIME_ENV.find(([re]) => re.test(e.name!))?.[1] : undefined;
      if (kind) add(kind, `env: ${e.name}`);
    }
  }
  return out;
}

const OFFICIAL: Array<[RegExp, AppRuntimeKind]> = [[/^library\/nginx$/, "nginx"], [/^library\/(redis|valkey)$/, "redis"], [/^library\/postgres$/, "postgres"]];
/** Pure: a Docker Hub official image names its software; anything else (a mirror, `team/my-redis`) says nothing */
export function officialImageRuntime(image: string): AppRuntimeKind | null {
  const p = imageParts(image);
  if (!["docker.io", "index.docker.io", "registry-1.docker.io"].includes(p.registry)) return null;
  return OFFICIAL.find(([re]) => re.test(p.repo))?.[1] ?? null;
}

// ---------- Defender image scan ----------

/** Languages Defender's scan found packages of, per scanned image (healthy and unhealthy findings alike) */
export const RUNTIME_SCAN_QUERY = `securityresources
| where type =~ "microsoft.security/assessments/subassessments"
| extend art = properties.additionalData.artifactDetails, sw = properties.additionalData.softwareDetails
| where isnotempty(tostring(art.repositoryName))
| extend lang = tolower(tostring(sw.language))
| where isnotempty(lang)
| summarize langs = make_set(lang, 12) by registry = tolower(tostring(art.registryHost)), repo = tolower(tostring(art.repositoryName)), digest = tostring(art.digest), tags = tostring(art.tags)
| take 2000`;
export type ScanRow = { registry: string; repo: string; digest: string; tags: string; langs: string[] | null };

const SCAN_LANG: Array<[RegExp, AppRuntimeKind]> = [
  [/^(java|jvm|kotlin|scala)$/, "jvm"], [/^(javascript|nodejs|node\.js|node|typescript)$/, "nodejs"], [/^python$/, "python"],
  [/^(go|golang)$/, "go"], [/^(\.net|dotnet|csharp|c#)$/, "dotnet"],
];

/** Pure: scan rows → per pod image the languages found — same registry + repository, then the digest, else the tag */
export function runtimesOfScan(images: Array<{ image: string; digest?: string }>, rows: ScanRow[]): Map<string, RuntimeEvidence[]> {
  const out = new Map<string, RuntimeEvidence[]>();
  const tagsOf = (r: ScanRow): string[] => { try { const t = JSON.parse(r.tags || "[]"); return Array.isArray(t) ? t.map(String) : []; } catch { return []; } };
  for (const { image, digest } of images) {
    const p = imageParts(image);
    const d = digest || p.digest;
    const same = rows.filter((r) => r.registry === p.registry && r.repo === p.repo);
    const byDigest = d ? same.filter((r) => r.digest === d) : [];
    const hit = byDigest.length ? byDigest : p.tag ? same.filter((r) => tagsOf(r).includes(p.tag)) : [];
    const found: RuntimeEvidence[] = [];
    for (const lang of hit.flatMap((r) => r.langs ?? [])) {
      const kind = SCAN_LANG.find(([re]) => re.test(lang))?.[1];
      if (kind && !found.some((x) => x.kind === kind)) found.push({ kind, evidence: `scan: ${lang}${byDigest.length ? "" : " (tag)"}` });
    }
    if (found.length) out.set(image, found);
  }
  return out;
}

const ARG = "https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01";
const scanCache = new CacheManager<ScanRow[]>(20, 10 * 60_000);

/** Defender's scan rows for the cluster's subscription — throws when Resource Graph cannot be read */
export async function collectScanRows(env: Env, bearerToken: string | undefined, clusterId: string): Promise<ScanRow[]> {
  const key = `${cachePrefix(bearerToken)}:runtime-scan:${clusterId.toLowerCase()}`;
  const hit = scanCache.get(key);
  if (hit) return hit;
  const arm = await getArmFetcherAuto(env, bearerToken);
  const sub = /\/subscriptions\/([^/]+)\//i.exec(clusterId)?.[1];
  const res = await arm.postJson<{ data?: ScanRow[] }>(ARG, { query: RUNTIME_SCAN_QUERY, ...(sub ? { subscriptions: [sub] } : {}), options: { resultFormat: "objectArray", $top: 1000 } }, { timeoutMs: 15_000 });
  const rows = res.data ?? [];
  scanCache.set(key, rows);
  return rows;
}
