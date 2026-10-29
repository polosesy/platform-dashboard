// Warning kube events of a namespace / workload, from the Kubernetes API (core/v1 events, list only —
// k8sReadSurface.ts). AKS keeps events about an hour, so this is "what is wrong now", not history. Container Insights
// KubeEvents is empty when the cluster's data collection rule streams only Perf/Syslog (as measured), and Loki
// `{job="kubernetes-events"}` is a customer-specific pipeline — neither is assumed.
//
// Messages can carry probe response bodies and secret names: viewers get type · reason · object · count · time;
// the message goes to operators only, redacted (logRedaction.ts).

import * as k8s from "@kubernetes/client-node";
import type { Env } from "../env.js";
import type { KubeEvent, KubeEventsResponse } from "@aud/types";
import { CacheManager, cachePrefix } from "../infra/cacheManager.js";
import { HttpError } from "../infra/requestParams.js";
import { loadKubeConfig } from "./kubernetes.js";
import { k8sError } from "./aksAccess.js";
import { redactLogLine } from "./logRedaction.js";

const NAME = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;

/** The events that belong to a workload: the workload itself, its ReplicaSets and pods (name prefix), HPA/PDB of it */
export function eventBelongs(e: { name: string; kind: string }, workload: string): boolean {
  return e.name === workload || e.name.startsWith(`${workload}-`);
}

type CoreEvent = k8s.CoreV1Event;

/** Pure: API events → newest first, Warning only, workload filter, message only when allowed */
/** client-node gives Dates (or strings from raw JSON); empty → undefined */
const iso = (v: unknown): string | undefined => (v instanceof Date ? v.toISOString() : v ? String(v) : undefined);

export function mapEvents(items: CoreEvent[], opts: { workload?: string; messages: boolean; limit?: number }): KubeEvent[] {
  return items
    .filter((e) => (e.type ?? "") === "Warning")
    .map((e): KubeEvent => {
      // `count` accumulates from the first occurrence; the TTL runs from the last — a probe failing every 10 s keeps
      // one event alive for days (stg 2026-10-29: Unhealthy ×1311 since 10-23, not 1311 in the last hour).
      // events.k8s.io-style events leave lastTimestamp empty: the last time is series.lastObservedTime, eventTime the first.
      const last = iso(e.lastTimestamp ?? e.series?.lastObservedTime ?? e.eventTime ?? e.firstTimestamp ?? e.metadata?.creationTimestamp);
      const first = iso(e.firstTimestamp ?? e.eventTime);
      return {
        time: last ?? "",
        ...(first ? { firstTime: first } : {}),
        type: "Warning",
        reason: e.reason ?? "",
        kind: e.involvedObject?.kind ?? "",
        namespace: e.involvedObject?.namespace ?? e.metadata?.namespace ?? "",
        name: e.involvedObject?.name ?? "",
        count: e.count ?? e.series?.count ?? 1,
        ...(opts.messages && e.message ? { message: redactLogLine(e.message).line.slice(0, 1000) } : {}),
      };
    })
    .filter((e) => !opts.workload || eventBelongs(e, opts.workload))
    .sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0))
    .slice(0, opts.limit ?? 200);
}

const cache = new CacheManager<CoreEvent[]>(20, 15_000);

export async function listWarningEvents(
  env: Env, bearerToken: string | undefined, clusterId: string,
  opts: { namespace?: string; workload?: string; messages: boolean },
): Promise<KubeEventsResponse> {
  if (opts.namespace && !NAME.test(opts.namespace)) throw new HttpError(400, "invalid_namespace", "namespace is not a Kubernetes name");
  if (opts.workload && !NAME.test(opts.workload)) throw new HttpError(400, "invalid_workload", "workload is not a Kubernetes name");
  const key = `${cachePrefix(bearerToken)}:kube-events:${clusterId.toLowerCase()}:${opts.namespace ?? "*"}`;
  let items = cache.get(key);
  if (!items) {
    const kc = await loadKubeConfig(env, bearerToken, clusterId);
    const core = kc.makeApiClient(k8s.CoreV1Api);
    try {
      const list = opts.namespace
        ? await core.listNamespacedEvent({ namespace: opts.namespace, fieldSelector: "type=Warning", limit: 500 })
        : await core.listEventForAllNamespaces({ fieldSelector: "type=Warning", limit: 500 });
      items = list.items;
    } catch (e) {
      throw k8sError(e);
    }
    cache.set(key, items);
  }
  return {
    clusterId, generatedAt: new Date().toISOString(), source: "k8sApi",
    events: mapEvents(items, { workload: opts.workload, messages: opts.messages }), messages: opts.messages,
  };
}
