// AKS 모니터링 › 클러스터 · 워크로드 › 조립식 표 — columns as blocks (pure).
//
// A block is one column of the workload table and one value a heatmap tile can show: the workload's kind, a heatmap signal (`h:<metric>` — Kubernetes and Java / Spring), or an
// application metric of another runtime (`a:<id>` — API services/appRuntimes.ts). The viewer snaps blocks together —
// add, remove, move — and the set is remembered in this browser (`aud.workload.blocks`). Presets are starting sets.
// Each runtime has a guide: what says a workload is of that kind, which library / exporter exposes the metrics, the
// configuration, and what the platform needs to read them.

import type { AppColumnId, AppMetricsResponse, AppRuntimeBasis, AppRuntimeEvidence, AppRuntimeKind, HeatMetric } from "@aud/types";

export const HEAT_BLOCKS: HeatMetric[] = ["ready", "memory", "cpu", "cpuNow", "restarts", "oldGen", "jvmHeadroom", "http5xx", "logErrors", "poolUsage", "poolPending"];
export const APP_BLOCKS: AppColumnId[] = [
  "nodeEventLoopLag", "nodeHeapUsed", "pyRss", "goGoroutines", "goHeapInuse", "dotnetMemory",
  "nginxConnections", "nginxRequests", "redisClients", "redisMemory", "pgConnections", "openFds",
];
export type BlockId = "kind" | `h:${HeatMetric}` | `a:${AppColumnId}`;
export const ALL_BLOCKS: BlockId[] = ["kind", ...HEAT_BLOCKS.map((m): BlockId => `h:${m}`), ...APP_BLOCKS.map((a): BlockId => `a:${a}`)];
const KNOWN = new Set<string>(ALL_BLOCKS);

/** Which runtime a block belongs to (the guide and the "add" list group by it) — heat application signals are Java's */
export const BLOCK_RUNTIME: Partial<Record<BlockId, AppRuntimeKind | "any">> = {
  "h:oldGen": "jvm", "h:jvmHeadroom": "jvm", "h:http5xx": "jvm", "h:poolUsage": "jvm", "h:poolPending": "jvm",
  "a:nodeEventLoopLag": "nodejs", "a:nodeHeapUsed": "nodejs", "a:pyRss": "python", "a:goGoroutines": "go", "a:goHeapInuse": "go",
  "a:dotnetMemory": "dotnet", "a:nginxConnections": "nginx", "a:nginxRequests": "nginx", "a:redisClients": "redis", "a:redisMemory": "redis",
  "a:pgConnections": "postgres", "a:openFds": "any",
};

export type PresetId = "basic" | "java" | "runtimes" | "data" | "all";
export const PRESETS: Record<PresetId, BlockId[]> = {
  basic: ["kind", "h:ready", "h:memory", "h:cpu", "h:restarts", "h:logErrors"],
  java: ["kind", "h:ready", "h:memory", "h:cpu", "h:oldGen", "h:jvmHeadroom", "h:http5xx", "h:poolUsage"],
  runtimes: ["kind", "h:ready", "h:memory", "h:cpu", "a:nodeEventLoopLag", "a:nodeHeapUsed", "a:goGoroutines", "a:pyRss", "a:dotnetMemory", "a:openFds"],
  data: ["kind", "h:ready", "h:memory", "h:restarts", "a:nginxConnections", "a:nginxRequests", "a:redisClients", "a:redisMemory", "a:pgConnections"],
  all: ALL_BLOCKS,
};
export const PRESET_IDS = Object.keys(PRESETS) as PresetId[];
export const BLOCKS_STORAGE_KEY = "aud.workload.blocks";
export const MAX_BLOCKS = 16;

/** Pure: the remembered set — known blocks only, no repeats, at most MAX_BLOCKS; nothing readable = null (the automatic set) */
export function parseBlocks(raw: string | null): BlockId[] | null {
  try {
    const v: unknown = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(v)) return null;
    const out = [...new Set(v.filter((x): x is BlockId => typeof x === "string" && KNOWN.has(x)))].slice(0, MAX_BLOCKS);
    return out.length ? out : null;
  } catch {
    return null;
  }
}

/**
 * Pure: the automatic set (nothing chosen yet) — the kind, then every heatmap signal measured in this cluster (what
 * the table showed before blocks), in the heatmap's order. Choosing anything makes it the viewer's own set.
 */
export function autoBlocks(measured: HeatMetric[]): BlockId[] {
  return ["kind", ...HEAT_BLOCKS.filter((m) => measured.includes(m)).map((m): BlockId => `h:${m}`)];
}

/** Pure: rows by one application metric — rows with a value first (higher first, or lower first), the rest keep their order */
export function sortByApp<R>(rows: R[], valueOf: (r: R) => number | undefined, dir: "desc" | "asc"): R[] {
  return rows.map((r, i) => ({ r, i, v: valueOf(r) })).sort((x, y) =>
    Number(x.v === undefined) - Number(y.v === undefined) || (x.v !== undefined && y.v !== undefined ? (dir === "desc" ? y.v - x.v : x.v - y.v) : 0) || x.i - y.i,
  ).map((x) => x.r);
}

// Saved sets: the viewer names a set and keeps it (this browser) — changes are a draft until "저장"
export const SETS_STORAGE_KEY = "aud.workload.blockSets";
export const MAX_SETS = 10;
export const SET_NAME_MAX = 30;
export type BlockSet = { name: string; blocks: BlockId[] };

/** Pure: same blocks in the same order (null = the automatic set) */
export function sameBlocks(a: BlockId[] | null, b: BlockId[] | null): boolean {
  return a === b || (!!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]));
}
/** Pure: a set's name as stored — trimmed, inner spaces single, bounded; "" = no name */
export function setName(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, SET_NAME_MAX);
}
/** Pure: the saved sets — named, known blocks only, no repeated name, at most MAX_SETS; unreadable = none */
export function parseSets(raw: string | null): BlockSet[] {
  try {
    const v: unknown = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(v)) return [];
    const out: BlockSet[] = [];
    for (const x of v as { name?: unknown; blocks?: unknown }[]) {
      const name = typeof x?.name === "string" ? setName(x.name) : "";
      const blocks = parseBlocks(JSON.stringify(x?.blocks ?? null));
      if (name && blocks && !out.some((s) => s.name === name)) out.push({ name, blocks });
      if (out.length >= MAX_SETS) break;
    }
    return out;
  } catch {
    return [];
  }
}
/** Pure: save under a name — the same name is replaced in place, a new one goes last; full or no name = unchanged */
export function saveSet(sets: BlockSet[], rawName: string, blocks: BlockId[]): BlockSet[] {
  const name = setName(rawName);
  if (!name || !blocks.length) return sets;
  if (sets.some((s) => s.name === name)) return sets.map((s) => (s.name === name ? { name, blocks } : s));
  return sets.length >= MAX_SETS ? sets : [...sets, { name, blocks }];
}
/** Pure: take a saved set out */
export function deleteSet(sets: BlockSet[], name: string): BlockSet[] {
  return sets.filter((s) => s.name !== name);
}

/** Pure: add at the end (no repeats, bounded) */
export function addBlock(blocks: BlockId[], id: BlockId): BlockId[] {
  return blocks.includes(id) || blocks.length >= MAX_BLOCKS || !KNOWN.has(id) ? blocks : [...blocks, id];
}
/** Pure: remove — the last block stays (a table needs a column) */
export function removeBlock(blocks: BlockId[], id: BlockId): BlockId[] {
  return blocks.length <= 1 ? blocks : blocks.filter((b) => b !== id);
}
/** Pure: move one place left (−1) or right (+1); at the edge nothing moves */
export function moveBlock(blocks: BlockId[], id: BlockId, dir: -1 | 1): BlockId[] {
  const i = blocks.indexOf(id), j = i + dir;
  if (i < 0 || j < 0 || j >= blocks.length) return blocks;
  const out = [...blocks];
  [out[i], out[j]] = [out[j]!, out[i]!];
  return out;
}
/** Pure: the preset a set equals (same blocks, same order), or null = the viewer's own */
export function presetOf(blocks: BlockId[]): PresetId | null {
  return PRESET_IDS.find((p) => PRESETS[p].length === blocks.length && PRESETS[p].every((b, i) => b === blocks[i])) ?? null;
}

const UNITS = ["B", "Ki", "Mi", "Gi", "Ti"];
/** Pure: an application value in its unit — ms · bytes (Mi / Gi) · a count · per second · a ratio as % */
export function formatAppValue(unit: AppMetricsResponse["columns"][number]["unit"], v: number): string {
  if (!Number.isFinite(v)) return "—";
  if (unit === "ms") return v >= 100 ? `${Math.round(v)}ms` : `${v.toFixed(1)}ms`;
  if (unit === "perSec") return `${v >= 100 ? Math.round(v) : v.toFixed(1)}/s`;
  if (unit === "ratio") return `${Math.round(v * 100)}%`;
  if (unit === "count") return Math.round(v).toLocaleString();
  let i = 0, x = Math.abs(v);
  while (x >= 1024 && i < UNITS.length - 1) { x /= 1024; i++; }
  return `${x >= 100 || i === 0 ? Math.round(x) : x.toFixed(1)}${UNITS[i]}`;
}

/** Evidence order: the runtime's own metrics first, then what else said so (every one a fact with its source) */
export const BASIS_ORDER: AppRuntimeBasis[] = ["metrics", "telemetry", "config", "spec", "scan", "image"];
/** Pure: the kinds of a workload as the cell shows them — strongest evidence first */
export function kindsOf(w: AppMetricsResponse["workloads"][number] | undefined): AppRuntimeEvidence[] {
  return [...(w?.kinds ?? [])].sort((a, b) => BASIS_ORDER.indexOf(a.basis) - BASIS_ORDER.indexOf(b.basis) || (a.kind < b.kind ? -1 : 1));
}
/** Pure: "17.0.9" → "17" · "3.11.4" → "3.11" · "1.22.3" → "1.22" — the part people name a runtime by */
export function shortVersion(kind: AppRuntimeKind, version: string | undefined): string {
  const p = (version ?? "").split(".");
  if (!p[0]) return "";
  return kind === "jvm" || kind === "nodejs" || kind === "redis" ? p[0] : p.slice(0, 2).join(".");
}

/** What each runtime's guide shows: the library / exporter, its detection metric, and how to expose it (code, not prose) */
export const RUNTIME_GUIDE: Record<AppRuntimeKind, { library: string; detect: string; snippet: string }> = {
  jvm: {
    library: "Micrometer (Spring Boot Actuator)", detect: "jvm_memory_used_bytes",
    snippet: "# build.gradle\nimplementation 'org.springframework.boot:spring-boot-starter-actuator'\nimplementation 'io.micrometer:micrometer-registry-prometheus'\n\n# application.properties\nmanagement.endpoints.web.exposure.include=health,prometheus\nmanagement.metrics.tags.application=${spring.application.name}",
  },
  nodejs: {
    library: "prom-client", detect: "nodejs_version_info",
    snippet: "// npm i prom-client\nconst client = require('prom-client');\nclient.collectDefaultMetrics();            // nodejs_* · process_*\napp.get('/metrics', async (_req, res) => {\n  res.set('Content-Type', client.register.contentType);\n  res.end(await client.register.metrics());\n});",
  },
  python: {
    library: "prometheus_client", detect: "python_info",
    snippet: "# pip install prometheus-client\nfrom prometheus_client import start_http_server\nstart_http_server(8000)   # python_* · process_* on :8000/metrics",
  },
  go: {
    library: "prometheus/client_golang", detect: "go_info",
    snippet: "// go get github.com/prometheus/client_golang\nimport \"github.com/prometheus/client_golang/prometheus/promhttp\"\n\nhttp.Handle(\"/metrics\", promhttp.Handler())   // go_* · process_*",
  },
  dotnet: {
    library: "prometheus-net", detect: "dotnet_total_memory_bytes",
    snippet: "// dotnet add package prometheus-net.AspNetCore\napp.UseRouting();\napp.MapMetrics();   // dotnet_* · process_* on /metrics",
  },
  nginx: {
    library: "nginx-prometheus-exporter (sidecar)", detect: "nginx_up",
    snippet: "# nginx.conf\nlocation = /stub_status { stub_status; allow 127.0.0.1; deny all; }\n\n# sidecar container\nimage: nginx/nginx-prometheus-exporter\nargs: [\"--nginx.scrape-uri=http://127.0.0.1:8080/stub_status\"]\nports: [{ name: metrics, containerPort: 9113 }]",
  },
  redis: {
    library: "redis_exporter (sidecar)", detect: "redis_up",
    snippet: "# sidecar container\nimage: oliver006/redis_exporter\nenv: [{ name: REDIS_ADDR, value: \"redis://127.0.0.1:6379\" }]\nports: [{ name: metrics, containerPort: 9121 }]",
  },
  postgres: {
    library: "postgres_exporter", detect: "pg_up",
    snippet: "# sidecar or its own Deployment\nimage: quay.io/prometheuscommunity/postgres-exporter\nenv: [{ name: DATA_SOURCE_URI, value: \"127.0.0.1:5432/postgres?sslmode=disable\" }]   # user / password from a Secret\nports: [{ name: metrics, containerPort: 9187 }]",
  },
};
export const RUNTIME_ORDER: AppRuntimeKind[] = ["jvm", "nodejs", "python", "go", "dotnet", "nginx", "redis", "postgres"];

/** The pod annotations the usual collectors (Alloy · ama-metrics pod-annotation scraping) read to find the endpoint */
export const SCRAPE_SNIPPET = "# pod template annotations\nprometheus.io/scrape: \"true\"\nprometheus.io/port: \"<metrics port>\"\nprometheus.io/path: \"/metrics\"";

/** Pure: workloads of no measured kind — the ones the guide is for (those known by other evidence first, then by name) */
export function unidentified(apps: AppMetricsResponse["workloads"]): AppMetricsResponse["workloads"] {
  return apps.filter((w) => !w.kinds.some((k) => k.basis === "metrics"))
    .sort((a, b) => Number(b.kinds.length > 0) - Number(a.kinds.length > 0) || (`${a.namespace}/${a.workload}` < `${b.namespace}/${b.workload}` ? -1 : 1));
}
