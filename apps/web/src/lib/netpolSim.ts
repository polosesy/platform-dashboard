// AKS 보안 점검 › 네트워크 노출 › 정책 시뮬레이션 (pure). Replays the observed connections (Hubble, the policy insights
// network) against the network policies — as deployed, and after a set of changes (a policy off, an audit policy
// enforced, a virtual default-deny / DNS allow / "allow what was observed") — and says what would pass, be blocked, or
// can't be told. Cilium semantics (it enforces Kubernetes NetworkPolicy and CiliumNetworkPolicy together):
// - a pod is in default-deny for a direction when a selecting policy isolates that direction (enableDefaultDeny false
//   = no); not isolated = everything passes
// - an isolated direction passes when any rule of any selecting policy matches the peer and the port
// - a deny rule (ingressDeny / egressDeny) that matches wins over every allow
// - traffic from the local node (kubelet probes) always reaches its pods (allow-localhost)
// - a connection needs the sender's egress and the receiver's ingress
// Unknown is never "allowed" or "blocked": a CIDR rule with no observed address, a named port, an unread label, a rule
// field this model does not evaluate — they answer "unknown", and the verdict says why.

import type { NetEdge, NetNode, NetpolModel, NetpolPeer, NetpolPolicy, NetpolPort, NetpolRule, NetpolSelector, NetworkInsight } from "@aud/types";

export type Tri = "yes" | "no" | "unknown";
export type Verdict = "allow" | "deny" | "unknown";
export type Dir = "ingress" | "egress";

/** One side of a connection as the rules see it */
export type Endpoint =
  | { kind: "pod"; id: string; namespace: string; labels: Record<string, string> | null; serviceAccount?: string }
  | { kind: "ext"; entities: string[] | null; ips: string[] | null; names: string[]; host?: "local" | "remote" };

export type DirReason = "notIsolated" | "allowed" | "noRule" | "denyRule" | "unknownMatch" | "unknownSelection" | "hostAlways" | "unknownEndpoint";
/** The rule that decided: policy id, the rule, its position in that direction's list (shown as "rule n") */
export type RuleHit = { policy: string; rule: NetpolRule; index: number };
export type DirVerdict = { v: Verdict; reason: DirReason; by: string[]; hits?: RuleHit[] };
export type FlowVerdict = { v: Verdict; egress?: DirVerdict; ingress?: DirVerdict };

/** A policy of the simulation — deployed or virtual (added by a change) */
export type SimPolicy = NetpolPolicy & { virtual?: true };

export type SimChange =
  | { op: "off"; policyId: string }
  | { op: "enforce"; policyId: string }
  | { op: "denyAll"; namespace: string; dir: Dir }
  | { op: "allowDns"; namespace: string }
  | { op: "allowObserved"; namespace: string; dir: Dir };

export const changeKey = (c: SimChange) => (c.op === "off" || c.op === "enforce" ? `${c.op}:${c.policyId}` : c.op === "allowDns" ? `allowDns:${c.namespace}` : `${c.op}:${c.namespace}:${c.dir}`);

// ── Labels and selectors ──

type Ctx = { nsLabels: Map<string, Record<string, string>> };

/** A selector key's value for a pod: Cilium prefixes, the namespace pseudo-labels, the service account; undefined = absent, null = can't tell */
function labelOf(key: string, pod: Extract<Endpoint, { kind: "pod" }>, ctx: Ctx): string | undefined | null {
  const k = key.replace(/^(k8s|any):/, "");
  if (k === "io.kubernetes.pod.namespace") return pod.namespace;
  if (k.startsWith("io.cilium.k8s.namespace.labels.")) {
    const ns = ctx.nsLabels.get(pod.namespace);
    return ns ? ns[k.slice("io.cilium.k8s.namespace.labels.".length)] : null;
  }
  if (k === "io.cilium.k8s.policy.serviceaccount") return pod.serviceAccount ?? null;
  if (k.startsWith("io.cilium.") || k.startsWith("reserved:")) return null;
  if (!pod.labels) return null;
  return pod.labels[k];
}

export function matchSelector(s: NetpolSelector, get: (key: string) => string | undefined | null): Tri {
  let unknown = false;
  for (const [k, v] of Object.entries(s.matchLabels ?? {})) {
    const x = get(k);
    if (x === null) unknown = true;
    else if (x !== v) return "no";
  }
  for (const e of s.matchExpressions ?? []) {
    const x = get(e.key);
    if (x === null) { unknown = true; continue; }
    const vals = e.values ?? [];
    const ok = e.operator === "In" ? x !== undefined && vals.includes(x)
      : e.operator === "NotIn" ? x === undefined || !vals.includes(x)
        : e.operator === "Exists" ? x !== undefined
          : e.operator === "DoesNotExist" ? x === undefined : null;
    if (ok === null) unknown = true;
    else if (!ok) return "no";
  }
  return unknown ? "unknown" : "yes";
}

const NS_KEYS = /^(k8s:|any:)?(io\.kubernetes\.pod\.namespace|io\.cilium\.k8s\.namespace\.labels\.)/;
const mentionsNamespace = (s: NetpolSelector) => [...Object.keys(s.matchLabels ?? {}), ...(s.matchExpressions ?? []).map((e) => e.key)].some((k) => NS_KEYS.test(k));

// ── Addresses ──

const ip4 = (ip: string): number | null => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  return p.some((x) => x > 255) ? null : ((p[0]! << 24) >>> 0) + (p[1]! << 16) + (p[2]! << 8) + p[3]!;
};
export function inCidr(ip: string, cidr: string): boolean | null {
  const [base, bits] = cidr.split("/");
  const a = ip4(ip), b = ip4(base ?? "");
  const n = bits === undefined ? 32 : Number(bits);
  if (a === null || b === null || !Number.isInteger(n) || n < 0 || n > 32) return null;
  const mask = n === 0 ? 0 : (0xffffffff << (32 - n)) >>> 0;
  return ((a & mask) >>> 0) === ((b & mask) >>> 0);
}
const fqdnMatch = (name: string, rule: { name?: string; pattern?: string }): boolean => {
  const n = name.toLowerCase().replace(/\.$/, "");
  if (rule.name) return n === rule.name.toLowerCase().replace(/\.$/, "");
  if (rule.pattern) {
    const re = new RegExp(`^${rule.pattern.toLowerCase().replace(/\.$/, "").split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[-a-z0-9_.]*")}$`);
    return re.test(n);
  }
  return false;
};

// ── Rules ──

function peerMatch(peer: NetpolPeer, policy: NetpolPolicy, ep: Endpoint, ctx: Ctx): Tri {
  if (peer.kind === "any") return "yes";
  if (peer.kind === "pods") {
    if (ep.kind !== "pod") return "no";
    const nsOk: Tri = peer.ns === "same" ? (ep.namespace === policy.namespace ? "yes" : "no") : peer.ns === "all" ? "yes"
      : (() => { const l = ctx.nsLabels.get(ep.namespace); return l ? matchSelector(peer.ns, (k) => (k === "kubernetes.io/metadata.name" ? ep.namespace : l[k])) : "unknown"; })();
    if (nsOk === "no") return "no";
    const podOk: Tri = peer.pods ? matchSelector(peer.pods, (k) => labelOf(k, ep, ctx)) : "yes";
    return nsOk === "yes" && podOk === "yes" ? "yes" : podOk === "no" ? "no" : "unknown";
  }
  if (peer.kind === "endpoints") {
    if (ep.kind !== "pod") return "no"; // endpoint selectors never select reserved identities (world, host, …)
    if (!peer.clusterwide && !mentionsNamespace(peer.selector) && ep.namespace !== policy.namespace) return "no";
    return matchSelector(peer.selector, (k) => labelOf(k, ep, ctx));
  }
  if (peer.kind === "entity") {
    const e = peer.entity === "world-ipv4" || peer.entity === "world-ipv6" ? "world" : peer.entity;
    if (e === "all") return "yes";
    if (ep.kind === "pod") return e === "cluster" ? "yes" : "no";
    if (!ep.entities) return "unknown";
    return ep.entities.includes(e) ? "yes" : "no";
  }
  if (peer.kind === "cidr") {
    if (ep.kind === "pod") return "no";
    if (!ep.ips?.length) return "unknown";
    const hits = ep.ips.map((ip) => {
      const inside = inCidr(ip, peer.cidr);
      if (inside === null) return null;
      if (!inside) return false;
      const ex = (peer.except ?? []).map((x) => inCidr(ip, x));
      return ex.includes(null) ? null : !ex.includes(true);
    });
    if (hits.includes(null)) return "unknown";
    return hits.every(Boolean) ? "yes" : hits.some(Boolean) ? "unknown" : "no"; // some addresses only = can't tell for the connection
  }
  // fqdn
  if (ep.kind === "pod") return "no";
  if (!ep.names.length) return "unknown";
  return ep.names.some((n) => fqdnMatch(n, peer)) ? "yes" : "unknown"; // a name we saw not matching ≠ no other name was used
}

/** "443" (TCP) · "udp/53" · "ICMP" */
export function parsePort(p: string): { protocol: "TCP" | "UDP" | "ICMP"; port: number | null } {
  if (p === "ICMP") return { protocol: "ICMP", port: null };
  const m = /^(udp|tcp|sctp)\/(\d+)$/i.exec(p);
  if (m) return { protocol: m[1]!.toUpperCase() === "UDP" ? "UDP" : "TCP", port: Number(m[2]) };
  const n = Number(p);
  return { protocol: "TCP", port: Number.isFinite(n) ? n : null };
}

function portMatch(ports: NetpolPort[], p: string): Tri {
  if (!ports.length) return "yes";
  const f = parsePort(p);
  if (f.protocol === "ICMP") return "no";
  let unknown = false;
  for (const r of ports) {
    if (r.protocol !== "ANY" && r.protocol !== f.protocol) continue;
    if (r.port === undefined) return "yes";
    const n = Number(r.port);
    if (!Number.isFinite(n)) { unknown = true; continue; } // named port
    if (f.port === null) { unknown = true; continue; }
    if (f.port === n || (r.endPort !== undefined && f.port >= n && f.port <= r.endPort)) return "yes";
  }
  return unknown ? "unknown" : "no";
}

function ruleMatch(rule: NetpolRule, policy: NetpolPolicy, peer: Endpoint, port: string, ctx: Ctx): Tri {
  const peers = rule.peers.map((x) => peerMatch(x, policy, peer, ctx));
  const p: Tri = peers.includes("yes") ? "yes" : peers.includes("unknown") || rule.unsupported?.length ? "unknown" : "no";
  if (p === "no") return "no";
  const q = portMatch(rule.ports, port);
  return q === "no" ? "no" : p === "yes" && q === "yes" ? "yes" : "unknown";
}

function selects(policy: NetpolPolicy, pod: Extract<Endpoint, { kind: "pod" }>, ctx: Ctx): Tri {
  if (policy.source !== "cilium-clusterwide" && policy.namespace !== pod.namespace) return "no";
  return matchSelector(policy.selector, (k) => labelOf(k, pod, ctx));
}

/** One direction at `subject` (the pod whose policies decide) toward `peer` on `port` */
export function dirVerdict(policies: SimPolicy[], subject: Extract<Endpoint, { kind: "pod" }>, dir: Dir, peer: Endpoint, port: string, ctx: Ctx): DirVerdict {
  if (dir === "ingress" && peer.kind === "ext" && peer.host === "local") return { v: "allow", reason: "hostAlways", by: [] };
  const sel = policies.map((p) => ({ p, d: p[dir], s: p[dir] ? selects(p, subject, ctx) : ("no" as Tri) })).filter((x) => x.d && x.s !== "no");
  // Deny rules first — they win over every allow
  let denyUnknown = false;
  for (const x of sel) for (const [i, r] of x.d!.rules.entries()) if (r.deny) {
    const m = ruleMatch(r, x.p, peer, port, ctx);
    if (m === "yes" && x.s === "yes") return { v: "deny", reason: "denyRule", by: [x.p.id], hits: [{ policy: x.p.id, rule: r, index: i }] };
    if (m !== "no") denyUnknown = true;
  }
  const isolating = sel.filter((x) => x.d!.isolates);
  const isolated: Tri = isolating.some((x) => x.s === "yes") ? "yes" : isolating.length ? "unknown" : "no";
  const allowedBy: string[] = [];
  const hits: RuleHit[] = [];
  let allowUnknown = false;
  for (const x of sel) for (const [i, r] of x.d!.rules.entries()) if (!r.deny) {
    const m = ruleMatch(r, x.p, peer, port, ctx);
    if (m === "yes" && x.s === "yes") { allowedBy.push(x.p.id); hits.push({ policy: x.p.id, rule: r, index: i }); break; }
    if (m !== "no") allowUnknown = true;
  }
  if (isolated === "no") return denyUnknown ? { v: "unknown", reason: "unknownMatch", by: [] } : { v: "allow", reason: "notIsolated", by: [] };
  if (allowedBy.length) return denyUnknown ? { v: "unknown", reason: "unknownMatch", by: allowedBy, hits } : { v: "allow", reason: "allowed", by: allowedBy, hits };
  if (isolated === "unknown") return { v: "unknown", reason: "unknownSelection", by: isolating.map((x) => x.p.id) };
  if (allowUnknown || denyUnknown || (peer.kind === "ext" && !peer.entities)) return { v: "unknown", reason: peer.kind === "ext" && !peer.entities ? "unknownEndpoint" : "unknownMatch", by: [] };
  return { v: "deny", reason: "noRule", by: isolating.filter((x) => x.s === "yes").map((x) => x.p.id) };
}

export function flowVerdict(policies: SimPolicy[], src: Endpoint, dst: Endpoint, port: string, ctx: Ctx): FlowVerdict {
  const egress = src.kind === "pod" ? dirVerdict(policies, src, "egress", dst, port, ctx) : undefined;
  const ingress = dst.kind === "pod" ? dirVerdict(policies, dst, "ingress", src, port, ctx) : undefined;
  const vs = [egress?.v, ingress?.v].filter(Boolean) as Verdict[];
  const v: Verdict = !vs.length ? "unknown" : vs.includes("deny") ? "deny" : vs.includes("unknown") ? "unknown" : "allow";
  return { v, ...(egress ? { egress } : {}), ...(ingress ? { ingress } : {}) };
}

// ── The observed network as endpoints ──

const WORLD = ["world", "all"];
export type Endpoints = { of: (nodeId: string, peerOf?: string) => Endpoint; nodes: Map<string, NetNode> };

export function endpointsOf(model: NetpolModel, net: NetworkInsight): Endpoints {
  const wl = new Map(model.workloads.map((w) => [w.id, w]));
  const nodes = new Map(net.nodes.map((n) => [n.id, n]));
  const extIps = (list: NetworkInsight["unmatchedExternal"], from?: string) => {
    const xs = list.filter((x) => !from || x.from.includes(from));
    return { ips: xs.map((x) => x.ip), names: [...new Set(xs.flatMap((x) => x.names ?? []))] };
  };
  const of = (id: string, peerOf?: string): Endpoint => {
    const n = nodes.get(id);
    const w = wl.get(id);
    if (w) return { kind: "pod", id, namespace: w.namespace, labels: w.labels, ...(w.serviceAccount ? { serviceAccount: w.serviceAccount } : {}) };
    if (n?.kind === "workload") return { kind: "pod", id, namespace: n.namespace ?? id.split("/")[0]!, labels: null };
    if (id === "ext:host") return { kind: "ext", entities: ["host", "cluster", "all"], ips: null, names: [], host: "local" };
    if (id === "ext:remote-node") return { kind: "ext", entities: ["remote-node", "cluster", "all"], ips: null, names: [], host: "remote" };
    if (id === "apiserver") return { kind: "ext", entities: ["kube-apiserver", "all"], ips: null, names: [] };
    if (id === "ext:world") return { kind: "ext", entities: WORLD, ...extIps(net.unmatchedExternal, peerOf) };
    if (id === "ext:private") return { kind: "ext", entities: WORLD, ...extIps(net.privateExternal, peerOf) };
    if (id === "platform:imds") return { kind: "ext", entities: WORLD, ips: ["169.254.169.254"], names: [] };
    if (id === "platform:wireserver" || id === "probe:lb") return { kind: "ext", entities: WORLD, ips: ["168.63.129.16"], names: [] };
    if (n?.kind === "paas" || n?.kind === "azureService") {
      const ips = n.observedIps?.length ? n.observedIps : n.ips ?? [];
      return { kind: "ext", entities: WORLD, ips: ips.length ? ips : null, names: n.host ? [n.host] : [] };
    }
    return { kind: "ext", entities: null, ips: null, names: [] };
  };
  return { of, nodes };
}

// ── Changes → the policy set ──

const KUBE_DNS: NetpolPolicy["egress"] = {
  isolates: false,
  rules: [{
    peers: [{ kind: "pods", ns: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } }, pods: { matchLabels: { "k8s-app": "kube-dns" } } }],
    ports: [{ protocol: "UDP", port: "53" }, { protocol: "TCP", port: "53" }],
  }],
};

/** Allow rules for exactly what was observed from / to the namespace's workloads (a draft that keeps today's traffic) */
function observedRules(model: NetpolModel, net: NetworkInsight, eps: Endpoints, namespace: string, dir: Dir): NetpolRule[] {
  const wl = new Map(model.workloads.map((w) => [w.id, w]));
  const rules: NetpolRule[] = [];
  for (const e of net.edges) {
    const self = dir === "egress" ? e.from : e.to;
    const other = dir === "egress" ? e.to : e.from;
    if (wl.get(self)?.namespace !== namespace && !(eps.nodes.get(self)?.namespace === namespace)) continue;
    if (e.count <= e.dropped) continue; // only connections that actually went through
    const ep = eps.of(other, self);
    const ports: NetpolPort[] = e.ports.filter((p) => p !== "ICMP").map((p) => { const f = parsePort(p); return { protocol: f.protocol === "UDP" ? "UDP" : "TCP", ...(f.port !== null ? { port: String(f.port) } : {}) }; });
    let peers: NetpolPeer[] = [];
    if (ep.kind === "pod") {
      const w = wl.get(ep.id);
      if (!w || !Object.keys(w.labels).length) continue; // no labels to select it by — left out of the draft
      peers = [{ kind: "endpoints", selector: { matchLabels: { ...w.labels, "k8s:io.kubernetes.pod.namespace": w.namespace } }, clusterwide: true }];
    } else if (ep.host === "local") peers = [{ kind: "entity", entity: "host" }];
    else if (ep.host === "remote") peers = [{ kind: "entity", entity: "remote-node" }];
    else if (other === "apiserver") peers = [{ kind: "entity", entity: "kube-apiserver" }];
    else if (ep.ips?.length) peers = ep.ips.filter((ip) => ip4(ip) !== null).map((ip) => ({ kind: "cidr" as const, cidr: `${ip}/32` }));
    if (!peers.length) continue;
    rules.push({ peers, ports });
  }
  return rules;
}

export function applyChanges(model: NetpolModel, net: NetworkInsight | null, changes: SimChange[]): SimPolicy[] {
  const off = new Set(changes.filter((c) => c.op === "off").map((c) => (c as { policyId: string }).policyId));
  const enforce = new Set(changes.filter((c) => c.op === "enforce").map((c) => (c as { policyId: string }).policyId));
  const out: SimPolicy[] = model.policies.filter((p) => !off.has(p.id)).map((p) => (enforce.has(p.id) ? {
    ...p,
    ingress: p.ingress ? { ...p.ingress, isolates: true } : null,
    egress: p.egress ? { ...p.egress, isolates: true } : null,
  } : p));
  const eps = net ? endpointsOf(model, net) : null;
  for (const c of changes) {
    if (c.op === "denyAll") {
      out.push({ id: `virtual:denyAll:${c.namespace}:${c.dir}`, source: "kubernetes", name: `default-deny-${c.dir}`, namespace: c.namespace, selector: {},
        ingress: c.dir === "ingress" ? { isolates: true, rules: [] } : null, egress: c.dir === "egress" ? { isolates: true, rules: [] } : null, virtual: true });
    } else if (c.op === "allowDns") {
      out.push({ id: `virtual:allowDns:${c.namespace}`, source: "kubernetes", name: "allow-dns", namespace: c.namespace, selector: {}, ingress: null, egress: KUBE_DNS, virtual: true });
    } else if (c.op === "allowObserved" && net && eps) {
      const rules = observedRules(model, net, eps, c.namespace, c.dir);
      out.push({ id: `virtual:allowObserved:${c.namespace}:${c.dir}`, source: "cilium", name: `allow-observed-${c.dir}`, namespace: c.namespace, selector: {},
        ingress: c.dir === "ingress" ? { isolates: false, rules } : null, egress: c.dir === "egress" ? { isolates: false, rules } : null, virtual: true });
    }
  }
  return out;
}

// ── The simulation ──

/**
 * allow = a rule lets it through · open = nothing isolates either side (it passes because no policy applies — the
 * map colours this apart: "allowed by a rule" and "nobody checks" are different security facts) · deny · partial
 * (some ports blocked) · unknown
 */
export type EdgeState = "allow" | "open" | "deny" | "partial" | "unknown";
export type SimEdge = {
  edge: NetEdge;
  ports: Array<{ port: string; before: FlowVerdict; after: FlowVerdict }>;
  before: EdgeState;
  after: EdgeState;
  /** Ports that passed before and are blocked after (a break) / blocked before and pass after (an opening) */
  broken: string[];
  opened: string[];
  /** What Hubble saw: every event dropped · none dropped · some */
  observed: "passed" | "dropped" | "mixed";
  /** The verdict for the deployed policies disagrees with what was observed (model incomplete, policy changed, audit mode) */
  mismatch: boolean;
  /** The state changed (allowed by a rule ↔ open counts too — a default-deny on an open namespace shows up here) */
  changed: boolean;
};

export type IsolationRow = { namespace: string; workloads: number; ingress: [number, number]; egress: [number, number]; ingressUnknown: [number, number]; egressUnknown: [number, number] };

export type SimResult = {
  edges: SimEdge[];
  counts: { edges: number; allow: number; open: number; deny: number; partial: number; unknown: number; broken: number; opened: number; mismatch: number; changed: number };
  /** Per namespace: isolated workloads [before, after] per direction */
  isolation: IsolationRow[];
};

/** A verdict that passes only because neither side is isolated (or it comes from the node) */
const isOpen = (f: FlowVerdict) => f.v === "allow" && [f.egress, f.ingress].every((d) => !d || d.reason === "notIsolated" || d.reason === "hostAlways");
const edgeState = (fs: FlowVerdict[]): EdgeState => {
  const vs = fs.map((f) => f.v);
  if (vs.every((v) => v === "allow")) return fs.every(isOpen) ? "open" : "allow";
  return vs.every((v) => v === "deny") ? "deny" : vs.includes("deny") && vs.includes("allow") ? "partial" : vs.includes("unknown") ? "unknown" : "partial";
};

function isolatedOf(policies: SimPolicy[], pod: Extract<Endpoint, { kind: "pod" }>, dir: Dir, ctx: Ctx): Tri {
  const xs = policies.filter((p) => p[dir]?.isolates).map((p) => selects(p, pod, ctx));
  return xs.includes("yes") ? "yes" : xs.includes("unknown") ? "unknown" : "no";
}

export function simulate(model: NetpolModel, net: NetworkInsight | null, changes: SimChange[], opts: { includeSystem?: boolean } = {}): SimResult {
  const ctx: Ctx = { nsLabels: new Map(model.namespaces.map((n) => [n.name, n.labels])) };
  const before = applyChanges(model, net, []);
  const after = applyChanges(model, net, changes);
  const sysNs = new Set(model.namespaces.filter((n) => n.system).map((n) => n.name));
  const edges: SimEdge[] = [];
  if (net?.available) {
    const eps = endpointsOf(model, net);
    for (const e of net.edges) {
      const src = eps.of(e.from, e.to), dst = eps.of(e.to, e.from);
      const sys = (ep: Endpoint) => ep.kind === "pod" && sysNs.has(ep.namespace);
      if (!opts.includeSystem && (sys(src) || (src.kind !== "pod" && sys(dst)))) continue;
      const ports = (e.ports.length ? e.ports : ["0"]).map((p) => ({ port: p, before: flowVerdict(before, src, dst, p, ctx), after: flowVerdict(after, src, dst, p, ctx) }));
      const b = edgeState(ports.map((p) => p.before)), a = edgeState(ports.map((p) => p.after));
      const observed = e.dropped === 0 ? "passed" : e.dropped >= e.count ? "dropped" : "mixed";
      edges.push({
        edge: e, ports, before: b, after: a,
        broken: ports.filter((p) => p.before.v === "allow" && p.after.v === "deny").map((p) => p.port),
        opened: ports.filter((p) => p.before.v === "deny" && p.after.v === "allow").map((p) => p.port),
        observed,
        mismatch: (observed === "dropped" && (b === "allow" || b === "open")) || (observed === "passed" && b === "deny"),
        changed: b !== a,
      });
    }
  }
  const counts = { edges: edges.length, allow: 0, open: 0, deny: 0, partial: 0, unknown: 0, broken: 0, opened: 0, mismatch: 0, changed: 0 };
  for (const x of edges) {
    counts[x.after]++;
    if (x.changed) counts.changed++;
    if (x.broken.length) counts.broken++;
    if (x.opened.length) counts.opened++;
    if (x.mismatch) counts.mismatch++;
  }
  const rows = new Map<string, IsolationRow>();
  for (const w of model.workloads) {
    if (!opts.includeSystem && w.system) continue;
    const pod: Extract<Endpoint, { kind: "pod" }> = { kind: "pod", id: w.id, namespace: w.namespace, labels: w.labels, ...(w.serviceAccount ? { serviceAccount: w.serviceAccount } : {}) };
    const r = rows.get(w.namespace) ?? { namespace: w.namespace, workloads: 0, ingress: [0, 0], egress: [0, 0], ingressUnknown: [0, 0], egressUnknown: [0, 0] };
    r.workloads++;
    for (const [i, set] of [before, after].entries()) {
      for (const d of ["ingress", "egress"] as const) {
        const t = isolatedOf(set, pod, d, ctx);
        if (t === "yes") r[d][i]++;
        else if (t === "unknown") r[d === "ingress" ? "ingressUnknown" : "egressUnknown"][i]++;
      }
    }
    rows.set(w.namespace, r);
  }
  return { edges, counts, isolation: [...rows.values()].sort((a, b) => a.namespace.localeCompare(b.namespace)) };
}

/**
 * What one change does on its own (against the deployed policies) — so a change with no effect says why instead of
 * silently showing nothing. Allow rules are a union: a default-deny on a namespace that other policies already
 * isolate adds nothing, the existing allow rules still let the observed connections through.
 */
export type ChangeEffect = {
  broken: number;
  opened: number;
  /** Connections whose state changed (open → allowed by a rule counts) */
  changed: number;
  /** Isolated workloads added (+) or removed (−), both directions */
  isolation: number;
  /** Why nothing changed, when nothing did */
  why: "alreadyIsolated" | "noTraffic" | "rulesAllow" | null;
};

export function changeEffects(model: NetpolModel, net: NetworkInsight | null, changes: SimChange[], opts: { includeSystem?: boolean } = {}): Map<string, ChangeEffect> {
  const out = new Map<string, ChangeEffect>();
  for (const c of changes) {
    const r = simulate(model, net, [c], opts);
    const isolation = r.isolation.reduce((s, x) => s + (x.ingress[1] - x.ingress[0]) + (x.egress[1] - x.egress[0]), 0);
    const nsOf = c.op === "off" || c.op === "enforce" ? model.policies.find((p) => p.id === c.policyId)?.namespace ?? "" : c.namespace;
    const touches = r.edges.filter((x) => x.edge.from.startsWith(`${nsOf}/`) || x.edge.to.startsWith(`${nsOf}/`)).length;
    const nothing = !r.counts.broken && !r.counts.opened && !r.counts.changed && !isolation;
    const why: ChangeEffect["why"] = !nothing ? null
      : c.op === "denyAll" ? "alreadyIsolated"
        : !touches ? "noTraffic" : "rulesAllow";
    out.set(changeKey(c), { broken: r.counts.broken, opened: r.counts.opened, changed: r.counts.changed, isolation, why });
  }
  return out;
}

/** "What if this namespace kept only default-deny?" — every policy of the namespace off + a virtual default-deny both ways */
export const withoutAllows = (model: NetpolModel, namespace: string): SimChange[] => [
  ...model.policies.filter((p) => p.namespace === namespace).map((p) => ({ op: "off" as const, policyId: p.id })),
  { op: "denyAll", namespace, dir: "ingress" },
  { op: "denyAll", namespace, dir: "egress" },
];

// ── The namespace matrix ──

/** Column / row group of an endpoint: its namespace, or the kind of the outside peer */
export function groupOf(id: string, eps: Endpoints): string {
  const ep = eps.of(id);
  if (ep.kind === "pod") return `ns:${ep.namespace}`;
  const n = eps.nodes.get(id);
  return n?.kind === "apiserver" || id === "apiserver" ? "apiserver" : n?.kind ?? (id.startsWith("ext:host") || id.startsWith("ext:remote") ? "node" : "unknown");
}

export type MatrixCell = { row: string; col: string; edges: SimEdge[]; state: EdgeState; broken: number; opened: number; mismatch: number; changed: number };
export type Matrix = { rows: string[]; cols: string[]; cells: Map<string, MatrixCell> };

const COL_ORDER = ["apiserver", "paas", "azureService", "private", "internet", "node", "platform", "probe", "unknown"];

export function matrixOf(model: NetpolModel, net: NetworkInsight | null, sim: SimResult): Matrix {
  const cells = new Map<string, MatrixCell>();
  if (!net) return { rows: [], cols: [], cells };
  const eps = endpointsOf(model, net);
  for (const x of sim.edges) {
    const row = groupOf(x.edge.from, eps), col = groupOf(x.edge.to, eps);
    const k = `${row}|${col}`;
    const c = cells.get(k) ?? { row, col, edges: [], state: "allow" as EdgeState, broken: 0, opened: 0, mismatch: 0, changed: 0 };
    c.edges.push(x);
    if (x.broken.length) c.broken++;
    if (x.opened.length) c.opened++;
    if (x.mismatch) c.mismatch++;
    if (x.changed) c.changed++;
    cells.set(k, c);
  }
  for (const c of cells.values()) {
    const s = new Set(c.edges.map((x) => x.after));
    c.state = s.size === 1 ? [...s][0]!
      : s.has("deny") || s.has("partial") ? "partial"
        : [...s].every((x) => x === "allow" || x === "open") ? (s.has("open") ? "open" : "allow") : "unknown";
  }
  const nsFirst = (a: string, b: string) => {
    const ia = a.startsWith("ns:") ? -1 : COL_ORDER.indexOf(a), ib = b.startsWith("ns:") ? -1 : COL_ORDER.indexOf(b);
    return ia - ib || a.localeCompare(b);
  };
  const rows = [...new Set([...cells.values()].map((c) => c.row))].sort(nsFirst);
  const cols = [...new Set([...cells.values()].map((c) => c.col))].sort(nsFirst);
  return { rows, cols, cells };
}

// ── Reading a verdict: the platform status grammar, the two checkpoints, who blocked and who let through ──

/**
 * The platform's status grammar (live card · workload heatmap · Hubble map): ● ok · ▲ warn · ■ danger · ? can't tell.
 * Rule-allowed = ok (a policy decided and let it through) · open = warn (nobody checks — a gap, not an error) ·
 * blocked = danger, partly blocked ◧ (half a square: some ports) · can't tell = neutral, never a colour of its own.
 */
export type Level = "ok" | "warn" | "danger" | "unknown";
export const STATE_LEVEL: Record<EdgeState, Level> = { allow: "ok", open: "warn", partial: "danger", deny: "danger", unknown: "unknown" };
export const STATE_GLYPH: Record<EdgeState, string> = { allow: "●", open: "▲", partial: "◧", deny: "■", unknown: "?" };

/**
 * One checkpoint of a connection: the sender's egress, then the receiver's ingress. pass = a rule let it through ·
 * block = isolated and no rule (or a deny rule) · unchecked = no policy isolates that side · host = from the node,
 * always allowed · unknown · outside = that side is not a pod (internet, Azure, the API server) — no policy there.
 */
export type Gate = "pass" | "block" | "unchecked" | "host" | "unknown" | "outside";
export const gateOf = (d: DirVerdict | undefined): Gate =>
  !d ? "outside" : d.reason === "hostAlways" ? "host" : d.reason === "notIsolated" ? "unchecked" : d.v === "allow" ? "pass" : d.v === "deny" ? "block" : "unknown";
export const GATE_LEVEL: Record<Gate, Level> = { pass: "ok", host: "ok", block: "danger", unchecked: "warn", unknown: "unknown", outside: "unknown" };
export const GATE_GLYPH: Record<Gate, string> = { pass: "●", host: "●", block: "■", unchecked: "▲", unknown: "?", outside: "·" };

const dirSig = (d: DirVerdict | undefined) => (d ? `${d.v}:${d.reason}:${d.by.join(",")}:${(d.hits ?? []).map((h) => `${h.policy}#${h.index}`).join(",")}` : "-");
const flowSig = (f: FlowVerdict) => `${dirSig(f.egress)}|${dirSig(f.ingress)}`;

/** A connection's ports grouped by identical verdicts (before and after) — "443, 8443" on one row when the same rules decide */
export type PortGroup = { ports: string[]; before: FlowVerdict; after: FlowVerdict };
export function portGroups(x: SimEdge): PortGroup[] {
  const out = new Map<string, PortGroup>();
  for (const p of x.ports) {
    const k = `${flowSig(p.before)}/${flowSig(p.after)}`;
    const g = out.get(k);
    if (g) g.ports.push(p.port);
    else out.set(k, { ports: [p.port], before: p.before, after: p.after });
  }
  return [...out.values()];
}

/**
 * Who blocked and who let through, over a set of connections (a matrix cell) — counted in connections, each reason once
 * per connection. block: isolated by `policies` with no matching allow rule, or a deny rule · allow: the rule that let it
 * through (the exception to a default-deny) · unchecked: the namespace whose side nothing isolates · unknown: why not.
 */
export type ReasonItem =
  | { kind: "block"; dir: Dir; how: "noRule"; policies: string[]; edges: number }
  | { kind: "block"; dir: Dir; how: "denyRule"; hit: RuleHit; edges: number }
  | { kind: "allow"; dir: Dir; hit: RuleHit; edges: number }
  | { kind: "unchecked"; dir: Dir; namespace: string; edges: number }
  | { kind: "host"; edges: number }
  | { kind: "unknown"; dir: Dir; reason: DirReason; policies: string[]; edges: number };

export function cellReasons(edges: SimEdge[], when: "before" | "after"): ReasonItem[] {
  const acc = new Map<string, { item: ReasonItem; seen: Set<number> }>();
  const add = (key: string, i: number, make: () => ReasonItem) => {
    const a = acc.get(key) ?? { item: make(), seen: new Set<number>() };
    a.seen.add(i);
    acc.set(key, a);
  };
  edges.forEach((x, i) => {
    for (const p of x.ports) {
      const f = p[when];
      for (const dir of ["egress", "ingress"] as const) {
        const d = f[dir];
        if (!d) continue;
        const ns = (dir === "egress" ? x.edge.from : x.edge.to).split("/")[0] ?? "";
        const h = d.hits?.[0];
        if (d.reason === "hostAlways") add("host", i, () => ({ kind: "host", edges: 0 }));
        else if (d.reason === "notIsolated") add(`unchecked|${dir}|${ns}`, i, () => ({ kind: "unchecked", dir, namespace: ns, edges: 0 }));
        else if (d.reason === "denyRule" && h) add(`deny|${dir}|${h.policy}#${h.index}`, i, () => ({ kind: "block", dir, how: "denyRule", hit: h, edges: 0 }));
        else if (d.reason === "noRule") add(`noRule|${dir}|${d.by.join(",")}`, i, () => ({ kind: "block", dir, how: "noRule", policies: d.by, edges: 0 }));
        else if (d.v === "allow") for (const x2 of d.hits ?? []) add(`allow|${dir}|${x2.policy}#${x2.index}`, i, () => ({ kind: "allow", dir, hit: x2, edges: 0 }));
        else add(`unknown|${dir}|${d.reason}|${d.by.join(",")}`, i, () => ({ kind: "unknown", dir, reason: d.reason, policies: d.by, edges: 0 }));
      }
    }
  });
  const rank = { block: 0, allow: 1, unchecked: 2, host: 3, unknown: 4 } as const;
  return [...acc.values()].map((a) => ({ ...a.item, edges: a.seen.size })).sort((a, b) => rank[a.kind] - rank[b.kind] || b.edges - a.edges);
}

// ── Rules as short text (labels and numbers only — the screen adds the words) ──

const shortKey = (k: string) => k.replace(/^(k8s|any):/, "").replace(/^io\.kubernetes\.pod\.namespace$/, "ns").replace(/^io\.cilium\.k8s\.namespace\.labels\./, "ns.")
  .replace(/^kubernetes\.io\/metadata\.name$/, "ns").replace(/^io\.cilium\.k8s\.policy\.serviceaccount$/, "sa");
/** "app=web, tier In (a,b)" — "" = every pod */
export function selectorText(s: NetpolSelector): string {
  return [
    ...Object.entries(s.matchLabels ?? {}).map(([k, v]) => `${shortKey(k)}=${v}`),
    ...(s.matchExpressions ?? []).map((e) => (e.operator === "Exists" ? shortKey(e.key) : e.operator === "DoesNotExist" ? `!${shortKey(e.key)}`
      : `${shortKey(e.key)} ${e.operator} (${(e.values ?? []).join(",")})`)),
  ].join(", ");
}
export type PeerKind = "any" | "podsSame" | "podsAll" | "podsNs" | "endpoints" | "cidr" | "entity" | "fqdn";
export function peerText(p: NetpolPeer): { kind: PeerKind; text: string; ns?: string } {
  if (p.kind === "any") return { kind: "any", text: "" };
  if (p.kind === "pods") {
    const pods = p.pods ? selectorText(p.pods) : "";
    return p.ns === "same" ? { kind: "podsSame", text: pods } : p.ns === "all" ? { kind: "podsAll", text: pods } : { kind: "podsNs", text: pods, ns: selectorText(p.ns) };
  }
  if (p.kind === "endpoints") return { kind: "endpoints", text: selectorText(p.selector) };
  if (p.kind === "cidr") return { kind: "cidr", text: `${p.cidr}${p.except?.length ? ` − ${p.except.join(", ")}` : ""}` };
  if (p.kind === "entity") return { kind: "entity", text: p.entity };
  return { kind: "fqdn", text: p.name ?? p.pattern ?? "" };
}
/** "TCP 443, UDP 53, TCP 8000-8100" — "" = every port */
export const portsText = (ports: NetpolPort[]) =>
  ports.map((x) => `${x.protocol === "ANY" ? "" : `${x.protocol} `}${x.port ?? "*"}${x.endPort !== undefined ? `-${x.endPort}` : ""}`.trim()).join(", ");

/** A virtual policy id (from a change) back to its change — for naming it on screen */
export function virtualChange(id: string): SimChange | null {
  const [v, op, ns, dir] = id.split(":");
  if (v !== "virtual" || !ns) return null;
  if (op === "allowDns") return { op, namespace: ns };
  if ((op === "denyAll" || op === "allowObserved") && (dir === "ingress" || dir === "egress")) return { op, namespace: ns, dir };
  return null;
}
