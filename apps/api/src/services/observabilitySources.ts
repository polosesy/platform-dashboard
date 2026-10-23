// AKS 모니터링 data sources beyond Container Insights / Prometheus: Loki · Tempo · Pyroscope · Grafana.
// Honest states only — "read" means this dashboard reads it now (Loki through `aks.observability.loki`, checked with
// a cached /ready probe); Tempo, Pyroscope and Grafana are links (Grafana Explore) and never "read": reading those
// unauthenticated backends directly was rejected for security. Whether the cluster ships to them comes from the
// observability stack's workspace metrics (`pipeline`), never guessed.

import type { ObservabilitySource, ObservabilitySourcesResponse, ObservabilityStackResponse, WorkloadHeatmapResponse } from "@aud/types";
import type { Env } from "../env.js";
import { CacheManager } from "../infra/cacheManager.js";
import { clusterConnection } from "../infra/azureClientFactory.js";
import { lokiConfig, lokiStateOf } from "./lokiLogs.js";
import { getObservabilityStack, grafanaExploreUrl } from "./observabilityStack.js";

type Stack = Pick<ObservabilityStackResponse, "metricsState" | "components"> | null;
export type LokiProbe = { state: "ok" | "unreachable" | "failed"; status?: number } | null;

const checkValue = (stack: Stack, kind: string, check: string) =>
  stack?.components.filter((c) => c.kind === kind).flatMap((c) => c.checks.filter((k) => k.id === check)) ?? [];

/** Shipping seen in the workspace metrics — null when the stack view itself could not be read */
export function pipelineOf(kind: "loki" | "tempo" | "pyroscope", stack: Stack): "seen" | "notSeen" | null {
  if (!stack || stack.metricsState !== "ok") return null;
  const has = (k: string) => stack.components.some((c) => c.kind === k);
  const positive = (k: string, check: string) => checkValue(stack, k, check).some((c) => (c.value ?? 0) > 0);
  if (kind === "loki") return has("loki") || positive("alloy", "logsSent") ? "seen" : "notSeen";
  if (kind === "tempo") return has("tempo") || positive("alloy", "spansAccepted") ? "seen" : "notSeen";
  return positive("pyroscope", "profilesSent") || positive("alloy", "profilesSent") ? "seen" : "notSeen";
}

/** One state per source (pure) */
export function sourceStates(i: { lokiConfigured: boolean; probe: LokiProbe; grafana: WorkloadHeatmapResponse["grafana"]; stack: Stack }): ObservabilitySource[] {
  const g = i.grafana;
  const link = (uid: string | undefined) => (g && uid ? grafanaExploreUrl(g.endpoint, uid, "") : undefined);
  const loki: ObservabilitySource = (() => {
    const href = link(g?.datasources.loki);
    const base = { kind: "loki" as const, pipeline: pipelineOf("loki", i.stack), ...(href ? { href } : {}) };
    if (!i.lokiConfigured) return { ...base, state: href ? "link" : "off" };
    if (!i.probe) return { ...base, state: "error" };
    if (i.probe.state === "ok") return { ...base, state: "read" };
    if (i.probe.state === "unreachable") return { ...base, state: "blocked" };
    return { ...base, state: "error", ...(i.probe.status ? { detail: `HTTP ${i.probe.status}` } : {}) };
  })();
  const linkOnly = (kind: "tempo" | "pyroscope"): ObservabilitySource => {
    const href = link(g?.datasources[kind]);
    return { kind, state: href ? "link" : "off", pipeline: pipelineOf(kind, i.stack), ...(href ? { href } : {}) };
  };
  const grafana: ObservabilitySource = { kind: "grafana", state: g ? "link" : "off", pipeline: null, ...(g ? { href: g.endpoint } : {}) };
  return [loki, linkOnly("tempo"), linkOnly("pyroscope"), grafana];
}

// /ready answers 200 when Loki is up — the cheapest probe, reads no log data (so no operator gate). Cached per
// cluster (the network path is a fact of the cluster, not of the user) — including "blocked", so a 3 s timeout
// is not paid on every page load.
const probeCache = new CacheManager<{ probe: LokiProbe; at: string }>(50, 60_000);
const inflight = new Map<string, Promise<{ probe: LokiProbe; at: string }>>();

async function probeLokiReady(cfg: { url: string; tenant?: string }): Promise<LokiProbe> {
  try {
    const res = await fetch(`${cfg.url}/ready`, { headers: cfg.tenant ? { "X-Scope-OrgID": cfg.tenant } : {}, signal: AbortSignal.timeout(3000) });
    await res.body?.cancel().catch(() => undefined);
    return res.ok ? { state: "ok" } : { state: "failed", status: res.status };
  } catch (e) {
    return { state: lokiStateOf(e).state === "unreachable" ? "unreachable" : "failed" };
  }
}

function lokiProbe(cfg: { url: string; tenant?: string }, clusterId: string): Promise<{ probe: LokiProbe; at: string }> {
  const key = `loki-ready:${clusterId.toLowerCase()}`;
  const hit = probeCache.get(key);
  if (hit) return Promise.resolve(hit);
  const running = inflight.get(key);
  if (running) return running;
  const job = probeLokiReady(cfg)
    .then((probe) => { const r = { probe, at: new Date().toISOString() }; probeCache.set(key, r); return r; })
    .finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

export async function getObservabilitySources(env: Env, bearerToken: string | undefined, clusterId: string): Promise<ObservabilitySourcesResponse> {
  const cfg = lokiConfig(env, clusterId);
  const grafana = clusterConnection(env, clusterId).connection.aks?.observability?.grafana ?? null;
  const [stack, probe] = await Promise.all([
    getObservabilityStack(env, bearerToken, clusterId).catch(() => null),
    cfg ? lokiProbe(cfg, clusterId) : Promise.resolve(null),
  ]);
  return {
    clusterId,
    generatedAt: new Date().toISOString(),
    lokiCheckedAt: probe?.at ?? null,
    sources: sourceStates({
      lokiConfigured: !!cfg,
      probe: probe?.probe ?? null,
      grafana: grafana ? { endpoint: grafana.endpoint.replace(/\/+$/, ""), datasources: grafana.datasources ?? {} } : null,
      stack,
    }),
  };
}
