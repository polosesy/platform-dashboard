import type { HubbleCoverage, HubbleFlow, HubbleFlowSet, HubbleNodeCoverage } from "@aud/types";

// ──────────────────────────────────────────────────────────────
// Hubble multi-node merge
//
// Each cilium agent only sees its own node, so flows are read from every
// agent and merged here. Pure functions — no Kubernetes access.
// ──────────────────────────────────────────────────────────────

/** Flows read from one cilium agent. */
export type AgentBatch = {
  nodeName: string;
  podName: string;
  flows: HubbleFlow[];
  /** Older history was evicted from the ring buffer (or cut by `--last`) */
  truncated: boolean;
  error?: string;
};

/**
 * One packet is reported at several observation points (TO_STACK, TO_ENDPOINT,
 * TO_NETWORK) and, for cross-node traffic, again by the receiving node. Those
 * copies share the same 5-tuple and TCP flags within a few milliseconds.
 */
const SAME_PACKET_WINDOW_MS = 50;

/** Identities below this are Cilium reserved ones (host, world, …) shared by unrelated peers. */
const FIRST_WORKLOAD_IDENTITY = 256;

// Security identity first: egress leaving the node is reported before and after
// SNAT — with the pod IP and pod name, then with the node IP and no pod name —
// but both copies carry the workload's identity.
function endpointKey(ip: string | undefined, ep: HubbleFlow["source"]): string {
  if (ep.identity >= FIRST_WORKLOAD_IDENTITY) return `id:${ep.identity}`;
  return ep.podName ? `${ep.namespace}/${ep.podName}` : ip || `${ep.namespace}/${ep.workloadName}`;
}

function packetKey(f: HubbleFlow): string {
  const l7 = f.l7 ? `${f.l7.type}:${f.l7.dns?.query ?? ""}:${f.l7.http?.url ?? ""}:${f.l7.http?.code ?? ""}` : "";
  return [
    `${endpointKey(f.sourceIp, f.source)}:${f.sourcePort}`,
    `${endpointKey(f.destinationIp, f.destination)}:${f.destinationPort}`,
    f.l4Protocol,
    f.tcpFlags ?? "",
    f.isReply ? "r" : "",
    f.verdict,
    l7,
    // A policy-verdict event and the trace event of the same SYN share everything else — keep both
    f.eventKind ?? "",
  ].join("|");
}

/** Collapse repeated observations of the same packet. Result is newest first. */
export function dedupeObservations(flows: HubbleFlow[]): HubbleFlow[] {
  const decorated = flows.map((f) => ({ f, k: packetKey(f), t: Date.parse(f.time) }));
  decorated.sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : (a.t || 0) - (b.t || 0)));

  const kept: typeof decorated = [];
  let lastKey = "";
  let lastTime = Number.NaN;
  for (const d of decorated) {
    // Compare with the last *kept* copy so a steady stream is not chained away
    if (d.k === lastKey && Number.isFinite(d.t) && d.t - lastTime <= SAME_PACKET_WINDOW_MS) continue;
    kept.push(d);
    lastKey = d.k;
    lastTime = d.t;
  }
  return kept.sort((a, b) => (b.t || 0) - (a.t || 0)).map((d) => d.f);
}

function timeRange(flows: HubbleFlow[]): { oldest: number; newest: number } | null {
  let oldest = Infinity;
  let newest = -Infinity;
  for (const f of flows) {
    const t = Date.parse(f.time);
    if (!Number.isFinite(t)) continue;
    if (t < oldest) oldest = t;
    if (t > newest) newest = t;
  }
  return Number.isFinite(oldest) ? { oldest, newest } : null;
}

const iso = (t: number | undefined) => (t === undefined || !Number.isFinite(t) ? null : new Date(t).toISOString());

/**
 * Merge per-agent batches into one newest-first list and describe what it covers.
 * `nodesTotal` is the number of agents that exist, including ones that failed.
 */
export function mergeAgentBatches(batches: AgentBatch[], nodesTotal: number, limit: number): HubbleFlowSet {
  const raw = batches.flatMap((b) => b.flows);
  const deduped = dedupeObservations(raw);
  const flows = deduped.slice(0, limit);

  const nodes: HubbleNodeCoverage[] = batches.map((b) => {
    const r = timeRange(b.flows);
    return {
      nodeName: b.nodeName,
      podName: b.podName,
      events: b.flows.length,
      oldest: iso(r?.oldest),
      newest: iso(r?.newest),
      bufferFull: b.truncated,
      ...(b.error ? { error: b.error } : {}),
    };
  });

  const observed = batches.filter((b) => !b.error);
  const ranges = observed.map((b) => ({ b, r: timeRange(b.flows) })).filter((x) => x.r !== null);
  const newest = ranges.length ? Math.max(...ranges.map((x) => x.r!.newest)) : undefined;

  // A node whose buffer wrapped has nothing before its oldest event, so the span
  // every node covers starts at the latest of those cut-off points.
  const cutOffs = ranges.filter((x) => x.b.truncated).map((x) => x.r!.oldest);
  let commonSince = cutOffs.length
    ? Math.max(...cutOffs)
    : ranges.length ? Math.min(...ranges.map((x) => x.r!.oldest)) : undefined;
  // Applying `limit` drops the oldest merged events, which also shortens the span
  if (deduped.length > limit) {
    const kept = timeRange(flows);
    if (kept && (commonSince === undefined || kept.oldest > commonSince)) commonSince = kept.oldest;
  }

  const coverage: HubbleCoverage = {
    source: "agents",
    nodesObserved: observed.length,
    nodesTotal: Math.max(nodesTotal, batches.length),
    nodes,
    commonSince: iso(commonSince),
    newest: iso(newest),
    commonWindowMinutes:
      commonSince !== undefined && newest !== undefined
        ? Math.round(((newest - commonSince) / 60_000) * 10) / 10
        : 0,
    rawEvents: raw.length,
    duplicatesRemoved: raw.length - deduped.length,
  };
  return { flows, coverage };
}

/** Coverage for a single-source read (relay / API proxy) where nodes are not known. */
export function singleSourceCoverage(source: HubbleCoverage["source"], flows: HubbleFlow[]): HubbleCoverage {
  const r = timeRange(flows);
  return {
    source,
    nodesObserved: new Set(flows.map((f) => f.nodeName).filter(Boolean)).size,
    nodesTotal: 0,
    nodes: [],
    commonSince: iso(r?.oldest),
    newest: iso(r?.newest),
    commonWindowMinutes: r ? Math.round(((r.newest - r.oldest) / 60_000) * 10) / 10 : 0,
    rawEvents: flows.length,
    duplicatesRemoved: 0,
  };
}

export function emptyCoverage(nodesTotal = 0): HubbleCoverage {
  return {
    source: "agents",
    nodesObserved: 0,
    nodesTotal,
    nodes: [],
    commonSince: null,
    newest: null,
    commonWindowMinutes: 0,
    rawEvents: 0,
    duplicatesRemoved: 0,
  };
}
