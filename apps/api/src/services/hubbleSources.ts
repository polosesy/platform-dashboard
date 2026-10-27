// Which source the Hubble views read for a cluster: exec on the cilium agents (when the deployment and the
// connection allow it) > ACNS container network logs (rows in the last hour) > Hubble metrics in the cluster's
// Azure Monitor workspace > none. The flow-shaped sources (exec, logs) feed the existing tabs; metrics have their
// own counts-only view (no edges, no flows — services/hubbleMetrics.ts).

import type { Env } from "../env.js";
import type { HubbleDataSource, HubbleSourcesResponse } from "@aud/types";
import { hubbleExecDecision } from "./aksAccess.js";
import { flowLogsAvailability } from "./containerNetworkLogs.js";
import { getHubbleMetricsSummary } from "./hubbleMetrics.js";
import { hubbleUiAvailability } from "./hubbleUiSource.js";

type Facts = Pick<HubbleSourcesResponse, "exec" | "flowLogs" | "hubbleUi" | "metrics">;

/** exec > ACNS flow logs (durable, Azure) > Hubble UI (live relay sample) > metrics (counts only) > none */
export function pickSource(f: Facts): HubbleDataSource {
  if (f.exec.allowed) return "exec";
  if (f.flowLogs.state === "ok") return "flowLogs";
  if (f.hubbleUi.state === "ok") return "hubbleUi";
  if (f.metrics.state === "ok") return "metrics";
  return "none";
}

export async function getHubbleSources(env: Env, bearerToken: string | undefined, clusterId: string): Promise<HubbleSourcesResponse> {
  const exec = hubbleExecDecision(env, clusterId);
  // Exec allowed: nothing else is read (the existing path, unchanged)
  const [flowLogs, hubbleUi, metrics] = exec.allowed
    ? [{ state: "notEnabled" as const, rows1h: null, newest: null }, { state: "notConfigured" as const }, { state: "noWorkspace" as const }]
    : await Promise.all([
      flowLogsAvailability(env, bearerToken, clusterId),
      hubbleUiAvailability(env, clusterId),
      getHubbleMetricsSummary(env, bearerToken, clusterId, 15).then((m) => ({ state: m.state, ...(m.message ? { message: m.message } : {}) })),
    ]);
  const facts: Facts = {
    exec,
    flowLogs: { state: flowLogs.state, rows1h: flowLogs.rows1h, newest: flowLogs.newest },
    hubbleUi,
    metrics,
  };
  return { clusterId, generatedAt: new Date().toISOString(), selected: pickSource(facts), ...facts };
}
