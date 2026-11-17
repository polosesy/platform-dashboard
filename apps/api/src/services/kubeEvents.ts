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

/**
 * Pure: a Kubernetes object named for the workload — itself, its ReplicaSet (`<wl>-<hash>`), a Deployment pod
 * (`<wl>-<hash>-<5>`), a StatefulSet pod (`<wl>-<n>`), a DaemonSet / Job pod (`<wl>-<5>`). Kubernetes' generated
 * suffixes use "bcdfghjklmnpqrstvwxz2456789" (no vowels, no 0 1 3) — so `orders-db-0` is the orders-db StatefulSet, not
 * orders. stg 2026-11-17, every Deployment / StatefulSet / DaemonSet × every pod of its namespace (7,361 pairs) against
 * owner references: this rule 0 wrong, a bare name prefix 16 wrong.
 */
export function ownedBy(name: string, workload: string): boolean {
  if (name === workload) return true;
  if (!name.startsWith(`${workload}-`)) return false;
  const rest = name.slice(workload.length + 1);
  return /^[bcdfghjklmnpqrstvwxz2456789]{5,10}(-[bcdfghjklmnpqrstvwxz2456789]{5})?$/.test(rest) || /^\d+$/.test(rest);
}

/**
 * The events that belong to a workload: pods and ReplicaSets by the generated-name rule (ownedBy); other kinds (HPA,
 * PDB, the workload itself …) by name or the workload's name prefix — their names are chosen by people, not generated
 */
export function eventBelongs(e: { name: string; kind: string }, workload: string): boolean {
  if (e.kind === "Pod" || e.kind === "ReplicaSet") return ownedBy(e.name, workload);
  return e.name === workload || e.name.startsWith(`${workload}-`);
}

type CoreEvent = k8s.CoreV1Event;

/** Pure: API events → newest first, Warning only, workload filter, message only when allowed */
/** client-node gives Dates (or strings from raw JSON); empty → undefined */
const iso = (v: unknown): string | undefined => (v instanceof Date ? v.toISOString() : v ? String(v) : undefined);

export function mapEvents(items: CoreEvent[], opts: { workload?: string; messages: boolean; limit?: number }): KubeEvent[] {
  return matchingEvents(items, opts).slice(0, opts.limit ?? 200);
}

/** All matching Warning events, newest first (the response says how many there were before the limit) */
export function matchingEvents(items: CoreEvent[], opts: { workload?: string; messages: boolean }): KubeEvent[] {
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
        // who reported it (kubelet · default-scheduler · horizontal-pod-autoscaler …) — kubectl's SOURCE column
        ...((e.source?.component || e.reportingComponent) ? { component: e.source?.component || e.reportingComponent } : {}),
        ...(opts.messages && e.message ? { message: redactLogLine(e.message).line.slice(0, 1000) } : {}),
      };
    })
    .filter((e) => !opts.workload || eventBelongs(e, opts.workload))
    .sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));
}

/** Pages of 500 (the API's continue token), at most PAGES — more than that = `truncated`, never a silent cut */
const PAGE = 500;
const PAGES = 4;

const cache = new CacheManager<{ items: CoreEvent[]; truncated: boolean }>(20, 15_000);

export async function listWarningEvents(
  env: Env, bearerToken: string | undefined, clusterId: string,
  opts: { namespace?: string; workload?: string; messages: boolean; limit?: number },
): Promise<KubeEventsResponse> {
  if (opts.namespace && !NAME.test(opts.namespace)) throw new HttpError(400, "invalid_namespace", "namespace is not a Kubernetes name");
  if (opts.workload && !NAME.test(opts.workload)) throw new HttpError(400, "invalid_workload", "workload is not a Kubernetes name");
  const key = `${cachePrefix(bearerToken)}:kube-events:${clusterId.toLowerCase()}:${opts.namespace ?? "*"}`;
  let got = cache.get(key);
  if (!got) {
    const kc = await loadKubeConfig(env, bearerToken, clusterId);
    const core = kc.makeApiClient(k8s.CoreV1Api);
    const items: CoreEvent[] = [];
    let next: string | undefined;
    try {
      for (let page = 0; page < PAGES; page++) {
        const q = { fieldSelector: "type=Warning", limit: PAGE, ...(next ? { _continue: next } : {}) };
        const list = opts.namespace
          ? await core.listNamespacedEvent({ namespace: opts.namespace, ...q })
          : await core.listEventForAllNamespaces(q);
        items.push(...list.items);
        next = list.metadata?._continue || undefined;
        if (!next) break;
      }
    } catch (e) {
      throw k8sError(e);
    }
    got = { items, truncated: !!next };
    cache.set(key, got);
  }
  const all = matchingEvents(got.items, { workload: opts.workload, messages: opts.messages });
  return {
    clusterId, generatedAt: new Date().toISOString(), source: "k8sApi",
    events: all.slice(0, opts.limit ?? 200), messages: opts.messages,
    total: all.length, truncated: got.truncated,
  };
}
