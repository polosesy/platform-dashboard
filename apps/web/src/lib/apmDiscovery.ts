// 서비스 (APM) › 서비스 맵 — services found WITHOUT instrumentation (Datadog Service Discovery): the workloads and
// connections Cilium saw on the network (Hubble service map — the same sample as Pod 트래픽), joined to the trace
// service graph by exact names only:
//   a trace service = a Hubble workload when the service graph / RED named that workload (namespace/name), or when the
//   service name is the workload name and only one workload of that name was seen;
//   every other Hubble workload = "discovered" (it talks on the network, it sends no traces);
//   a Hubble connection is added when an end is discovered, or when two traced services talk with no trace edge between
//   them (an uninstrumented hop — e.g. a client library without spans).
// Facts only: a connection = flows Cilium saw in the sample (count, drops, port) — never requests, rates or latency.
import type { HubbleServiceMapResponse, ServiceGraphResponse } from "@aud/types";

export type NetCard = { id: string; namespace: string; workload: string; flows: number; dropped: number; pods: number };
export type NetLink = { source: string; target: string; flows: number; dropped: number; port: number; protocol: string };
export type NetDiscovery = {
  cards: NetCard[];
  links: NetLink[];
  /** Hubble workloads matched to a trace service (id → service) */
  matched: number;
  /** the sample the discovery came from */
  sample: { flows: number; windowMinutes: number; namespaces: number };
};

/** Pure: the discovery. `scope` "traced" = only namespaces that hold a traced workload (default) · "all" = every namespace */
export function discoverFromNetwork(
  graph: Pick<ServiceGraphResponse, "nodes" | "edges">,
  hubble: Pick<HubbleServiceMapResponse, "nodes" | "edges" | "totalFlowsAnalyzed" | "timeWindowMinutes">,
  scope: "traced" | "all" = "traced",
): NetDiscovery {
  const workloads = hubble.nodes.filter((n) => n.serviceType === "workload" && n.workloadName);
  const byName = new Map<string, typeof workloads>();
  for (const w of workloads) byName.set(w.workloadName, [...(byName.get(w.workloadName) ?? []), w]);
  // Hubble node id → trace service
  const toService = new Map<string, string>();
  for (const n of graph.nodes) {
    if (n.entry) continue;
    const exact = n.workload ? workloads.find((w) => w.namespace === n.workload!.namespace && w.workloadName === n.workload!.name) : undefined;
    const same = byName.get(n.service);
    const hit = exact ?? (same && same.length === 1 ? same[0] : undefined);
    if (hit) toService.set(hit.id, n.service);
  }
  const tracedNs = new Set<string>([...toService.keys()].map((id) => workloads.find((w) => w.id === id)!.namespace));
  for (const n of graph.nodes) { const ns = n.namespace ?? n.workload?.namespace; if (!n.entry && ns) tracedNs.add(ns); }
  const inScope = (ns: string) => scope === "all" || tracedNs.has(ns);
  const cards: NetCard[] = workloads.filter((w) => !toService.has(w.id) && inScope(w.namespace))
    .map((w) => ({ id: `net:${w.id}`, namespace: w.namespace, workload: w.workloadName, flows: w.metrics.totalFlows, dropped: w.metrics.droppedFlows, pods: w.podCount }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const cardIds = new Set(cards.map((c) => c.id));
  const traceEdge = new Set(graph.edges.map((e) => `${e.client}>${e.server}`));
  // a Hubble node → the map's id (trace service, discovered card, or nothing)
  const idOf = (hid: string) => toService.get(hid) ?? (cardIds.has(`net:${hid}`) ? `net:${hid}` : null);
  const merged = new Map<string, NetLink>();
  for (const e of hubble.edges) {
    const s = idOf(e.sourceId), t = idOf(e.destinationId);
    if (!s || !t || s === t) continue;
    const bothTraced = !s.startsWith("net:") && !t.startsWith("net:");
    if (bothTraced && traceEdge.has(`${s}>${t}`)) continue;
    const k = `${s}>${t}`;
    const cur = merged.get(k);
    if (cur) { cur.flows += e.metrics.flowCount; cur.dropped += e.metrics.droppedCount; }
    else merged.set(k, { source: s, target: t, flows: e.metrics.flowCount, dropped: e.metrics.droppedCount, port: e.port, protocol: e.protocol });
  }
  return {
    cards, links: [...merged.values()].sort((a, b) => (`${a.source}>${a.target}` < `${b.source}>${b.target}` ? -1 : 1)),
    matched: toService.size,
    sample: { flows: hubble.totalFlowsAnalyzed, windowMinutes: hubble.timeWindowMinutes, namespaces: new Set(workloads.filter((w) => inScope(w.namespace)).map((w) => w.namespace)).size },
  };
}
