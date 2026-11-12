// AKS 모니터링 › 클러스터 · 워크로드 › 조립식 표 — columns as blocks (pure).
//
// A block is one column: the workload's kind, a heatmap signal (`h:<metric>` — Kubernetes and Java / Spring), or an
// application metric of another runtime (`a:<id>` — API services/appRuntimes.ts). The viewer snaps blocks together —
// add, remove, move — and the set is remembered in this browser (`aud.workload.blocks`). Presets are starting sets.
// Each runtime has a guide: what says a workload is of that kind, which library / exporter exposes the metrics, the
// configuration, and what the platform needs to read them.

import type { AppColumnId, AppMetricsResponse, AppRuntimeKind, HeatMetric } from "@aud/types";

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

/** Pure: the remembered set — known blocks only, no repeats, at most MAX_BLOCKS; anything unreadable = the basic set */
export function parseBlocks(raw: string | null): BlockId[] {
  try {
    const v: unknown = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(v)) return PRESETS.basic;
    const out = [...new Set(v.filter((x): x is BlockId => typeof x === "string" && KNOWN.has(x)))].slice(0, MAX_BLOCKS);
    return out.length ? out : PRESETS.basic;
  } catch {
    return PRESETS.basic;
  }
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

/** Pure: the kinds of a workload as the "종류" cell shows them — measured kinds first, then image hints */
export function kindsOf(w: AppMetricsResponse["workloads"][number] | undefined): { kind: AppRuntimeKind; basis: "metrics" | "image" }[] {
  return [...(w?.kinds ?? [])].sort((a, b) => Number(a.basis === "image") - Number(b.basis === "image") || (a.kind < b.kind ? -1 : 1));
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

/** Pure: workloads of no measured kind — the ones the guide is for (image-hinted ones first, then by name) */
export function unidentified(apps: AppMetricsResponse["workloads"]): AppMetricsResponse["workloads"] {
  return apps.filter((w) => !w.kinds.some((k) => k.basis === "metrics"))
    .sort((a, b) => Number(b.kinds.length > 0) - Number(a.kinds.length > 0) || (`${a.namespace}/${a.workload}` < `${b.namespace}/${b.workload}` ? -1 : 1));
}
