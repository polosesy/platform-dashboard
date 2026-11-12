// The platform's own metrics (Prometheus text format) — how the API itself is doing: requests by route, calls to
// Azure by target and status (throttling · timeouts), process and event loop. No dependency, no tenant data: label
// values are route patterns (`/api/kubernetes/cluster/:id/overview` — never the id), HTTP status codes and the
// upstream's kind. Served by `GET /metrics` on the API port (loopback in a pod) and, when AUD_METRICS_PORT is set, by
// a listener of its own that answers nothing else (the scrape target).

import { monitorEventLoopDelay } from "node:perf_hooks";

const BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];
type Labels = Record<string, string>;
const keyOf = (l: Labels) => Object.keys(l).sort().map((k) => `${k}="${String(l[k]).replace(/[\\"\n]/g, "_")}"`).join(",");

class Counter {
  private v = new Map<string, number>();
  constructor(readonly name: string, readonly help: string) {}
  inc(l: Labels, by = 1) { const k = keyOf(l); this.v.set(k, (this.v.get(k) ?? 0) + by); }
  render(): string[] { return [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`, ...[...this.v].map(([k, n]) => `${this.name}{${k}} ${n}`)]; }
}
class Histogram {
  private v = new Map<string, { b: number[]; sum: number; count: number }>();
  constructor(readonly name: string, readonly help: string) {}
  observe(l: Labels, seconds: number) {
    const k = keyOf(l);
    let s = this.v.get(k);
    if (!s) { s = { b: BUCKETS.map(() => 0), sum: 0, count: 0 }; this.v.set(k, s); }
    BUCKETS.forEach((le, i) => { if (seconds <= le) s!.b[i]!++; });
    s.sum += seconds; s.count++;
  }
  render(): string[] {
    const out = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [k, s] of this.v) {
      const pre = k ? `${k},` : "";
      BUCKETS.forEach((le, i) => out.push(`${this.name}_bucket{${pre}le="${le}"} ${s.b[i]}`));
      out.push(`${this.name}_bucket{${pre}le="+Inf"} ${s.count}`, `${this.name}_sum{${k}} ${s.sum.toFixed(3)}`, `${this.name}_count{${k}} ${s.count}`);
    }
    return out;
  }
}

const httpTotal = new Counter("aud_http_requests_total", "API requests by route pattern, method and status");
const httpSeconds = new Histogram("aud_http_request_duration_seconds", "API request duration by route pattern");
const upTotal = new Counter("aud_upstream_requests_total", "Calls to Azure and other upstreams by target and result (HTTP status, timeout or error)");
const upSeconds = new Histogram("aud_upstream_request_duration_seconds", "Upstream call duration by target");

/** Pure: a bounded label for a route — the matched pattern, never the concrete path (ids, names) */
export function routeLabel(baseUrl: string | undefined, routePath: unknown): string {
  if (typeof routePath !== "string") return "unmatched";
  return `${baseUrl ?? ""}${routePath}`.replace(/\/+$/, "") || "/";
}
/** Pure: the upstream's kind from a fetcher label ("ARM", "LogAnalytics", "Prometheus" …) — lower case, one word */
export function upstreamTarget(label: string): string {
  return (/^[A-Za-z]+/.exec(label)?.[0] ?? "other").toLowerCase().slice(0, 24);
}

export function recordHttp(route: string, method: string, status: number, seconds: number): void {
  httpTotal.inc({ route, method, status: String(status) });
  httpSeconds.observe({ route }, seconds);
}
/** `result` = the HTTP status, or "timeout" / "error" when no answer came */
export function recordUpstream(label: string, result: number | "timeout" | "error", seconds: number): void {
  const target = upstreamTarget(label);
  upTotal.inc({ target, result: String(result) });
  upSeconds.observe({ target }, seconds);
}

let loop: ReturnType<typeof monitorEventLoopDelay> | null = null;
const started = Date.now() / 1000 - process.uptime();

/** The whole exposition; `version` = AUD_VERSION */
export function renderMetrics(version: string | undefined): string {
  if (!loop) { loop = monitorEventLoopDelay({ resolution: 20 }); loop.enable(); }
  const mem = process.memoryUsage();
  const lag = Number.isFinite(loop.percentile(99)) ? loop.percentile(99) / 1e9 : 0;
  loop.reset();
  const gauge = (name: string, help: string, value: number | string, labels = "") => [`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name}${labels} ${value}`];
  return [
    ...gauge("aud_build_info", "The running build", 1, `{version="${(version ?? "dev").replace(/[\\"\n]/g, "_")}"}`),
    ...gauge("nodejs_version_info", "Node.js version", 1, `{version="${process.version}"}`),
    ...gauge("process_start_time_seconds", "Start time of the process since unix epoch in seconds", started.toFixed(0)),
    ...gauge("process_resident_memory_bytes", "Resident memory size in bytes", mem.rss),
    ...gauge("nodejs_heap_size_used_bytes", "Process heap size used in bytes", mem.heapUsed),
    ...gauge("nodejs_eventloop_lag_p99_seconds", "The 99th percentile of the event loop delay since the last scrape", lag.toFixed(4)),
    ...httpTotal.render(), ...httpSeconds.render(), ...upTotal.render(), ...upSeconds.render(),
  ].join("\n") + "\n";
}
