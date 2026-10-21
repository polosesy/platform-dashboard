// Private Link usage — pure join (no Azure calls), unit-tested from apps/api/test/privateLinkUsage.test.ts.
//
// Who uses a Private Endpoint is read from observed evidence only:
//   access — the PaaS service's own log saw a caller IP / identity (Key Vault audit, Storage logs, Redis clients)
//   flow   — a VNet flow log saw packets from a source IP to the Private Endpoint IP (Traffic Analytics)
// The caller is found by its NIC IP, by being the only compute in the source subnet, or by its managed identity.
// Anything that cannot be pinned to exactly one resource is listed as unresolved — never drawn.
import type {
  LbInbound,
  LbInboundCaller,
  PlEndpoint,
  PlEvidence,
  PlPlace,
  PlPublicAccess,
  PlSourceStatus,
  PlUnresolved,
  PlUsageGrade,
  PrivateLinkUsage,
} from "@aud/types";

export type PluCaller = { nodeId: string; ips: string[]; vnetId?: string };
/** A subnet and the compute that owns all of its IPs (AKS node pool, VMSS, App Service integration, …) */
export type PluSubnet = { nodeId: string; vnetId: string; cidr: string; owners: string[] };
export type PluPe = { peNodeId: string; targetNodeId: string; vnetId?: string; ip?: string; state?: PlEndpoint["connectionState"] };
/** NIC inventory (Resource Graph) of the PE's VNet and its peers */
export type PluNic = { ip: string; nicName: string; vmArmId?: string; peArmId?: string };
export type PluAccessRow = {
  targetNodeId: string;
  source: "kvAudit" | "storageLogs" | "redisClients";
  ip?: string;
  oid?: string;
  requests?: number;
  failed?: number;
  clients?: number;
  bytes?: number;
  first?: string;
  last?: string;
  ops?: string[];
};
export type PluFlowRow = { srcIp: string; destIp: string; bytes: number; flows: number; allowed: number; denied: number; first?: string; last?: string; ports?: number[] };

export type PluInput = {
  callers: PluCaller[];
  subnets: PluSubnet[];
  pes: PluPe[];
  nics: PluNic[];
  /** Azure resource ID (lower case) → diagram node id */
  nodeByArmId: ReadonlyMap<string, string>;
  /** Principal / object id → resources holding that identity (resource name for display) */
  identities: ReadonlyMap<string, Array<{ armId: string; name: string }>>;
  /** VNet node id → directly peered VNet node ids */
  peerings: ReadonlyMap<string, ReadonlySet<string>>;
  access: PluAccessRow[];
  flows: PluFlowRow[];
  /** PE node id → PEBytesIn + PEBytesOut over the window when measured */
  peBytes: ReadonlyMap<string, number>;
  sources: PlSourceStatus[];
  /** AKS cluster node id of an AKS node or node-pool scale set (by its cluster ARM id — never by name) */
  clusterOf?: ReadonlyMap<string, string>;
  /** Subnets of the diagram outside this scope — to say where an address is, never to draw */
  outerSubnets?: PluSubnet[];
  /** Every subnet / VNet prefix of the diagram: an address in them is internal even outside RFC 1918 */
  knownCidrs?: string[];
  /** On-premises sites reachable from this scope (S2S of its gateway, or of a hub it uses by gateway transit) */
  sites?: PluSite[];
};

/** An on-premises site: its local network gateway's prefixes. BGP / NAT sites are not used for inference. */
export type PluSite = { siteNodeId: string; prefixes: string[]; bgp: boolean; nat: boolean };

/** Prefixes that can name a site: not a single host, not wider than /8, never a default route */
const siteUsable = (cidr: string) => {
  const bits = Number(cidr.split("/")[1] ?? "32");
  return Number.isInteger(bits) && bits >= 8 && bits < 32;
};

export type PluOutput = {
  endpoints: PlEndpoint[];
  usages: PrivateLinkUsage[];
  unresolved: PlUnresolved[];
  publicAccess: PlPublicAccess[];
};

// ── IPv4 helpers ──

const V4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
export function ipv4ToInt(ip: string): number | null {
  const m = V4.exec(ip.trim());
  if (!m) return null;
  const p = m.slice(1).map(Number);
  if (p.some((x) => x > 255)) return null;
  return ((p[0]! << 24) >>> 0) + (p[1]! << 16) + (p[2]! << 8) + p[3]!;
}
export function isPrivateV4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n == null) return false;
  return (n >>> 24) === 10 || (n >>> 20) === ((172 << 4) | 1) || (n >>> 16) === ((192 << 8) | 168);
}
/** Carrier-grade NAT space (RFC 6598) — not public, used by some VNets and on-premises networks */
export function isCgnatV4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  return n != null && (n >>> 22) === ((100 << 2) | 1);
}
/** Not the public Internet: RFC 1918, 100.64.0.0/10, or a prefix of the diagram's own VNets / subnets */
export function isInternalV4(ip: string, knownCidrs: readonly string[] = []): boolean {
  return isPrivateV4(ip) || isCgnatV4(ip) || knownCidrs.some((c) => ipInCidr(ip, c));
}

export function ipInCidr(ip: string, cidr: string): boolean {
  const [base, bitsRaw] = cidr.split("/");
  const n = ipv4ToInt(ip), b = ipv4ToInt(base ?? "");
  const bits = Number(bitsRaw);
  if (n == null || b == null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return ((n & mask) >>> 0) === ((b & mask) >>> 0);
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const maxIso = (a?: string, b?: string) => (!a ? b : !b ? a : a > b ? a : b);

type Resolved =
  | { ok: true; nodeId: string; attribution: PrivateLinkUsage["attribution"]; identityName?: string; vnetId?: string; via?: string[] }
  | { ok: false; reason: "nicNoVm" | "notInDiagram" | "ambiguous"; nicName?: string; candidates?: string[]; basis?: "subnet" | "identity"; place?: PlPlace };

/** The one AKS cluster all ids belong to (a cluster node or its node-pool scale sets), else null */
export function collapseToCluster(ids: readonly string[], clusterOf: ReadonlyMap<string, string> | undefined): string | null {
  if (!clusterOf || ids.length < 2) return null;
  const set = new Set<string>();
  for (const id of ids) {
    const c = clusterOf.get(id);
    if (!c) return null;
    set.add(c);
  }
  return set.size === 1 ? [...set][0]! : null;
}

/** Where an address outside the scope is: one subnet of another VNet / overlapping VNets / private / CGNAT */
export function classifyPlace(ip: string, outer: readonly PluSubnet[], clusterOf?: ReadonlyMap<string, string>, sites: readonly PluSite[] = []): PlPlace | undefined {
  const hits = outer.filter((s) => ipInCidr(ip, s.cidr));
  const vnets = new Set(hits.map((h) => h.vnetId));
  // On-premises sites whose address space holds it (exact containment; no longest-prefix pick between sites)
  const siteHits = sites
    .filter((s) => !s.bgp && !s.nat)
    .map((s) => ({ s, prefix: s.prefixes.filter(siteUsable).find((c) => ipInCidr(ip, c)) }))
    .filter((x): x is { s: PluSite; prefix: string } => !!x.prefix);
  const siteIds = new Set(siteHits.map((x) => x.s.siteNodeId));
  if (vnets.size + siteIds.size > 1) return { kind: "overlap", matches: vnets.size + siteIds.size };
  if (siteHits.length) return { kind: "onPremSite", siteNodeId: siteHits[0]!.s.siteNodeId, prefix: siteHits[0]!.prefix, basis: "cfg" };
  if (hits.length) {
    const h = [...hits].sort((a, b) => cmp(a.nodeId, b.nodeId))[0]!;
    const owner = h.owners.length === 1 ? h.owners[0] : collapseToCluster(h.owners, clusterOf) ?? undefined;
    return { kind: "otherVnet", vnetNodeId: h.vnetId, subnetNodeId: h.nodeId, ...(owner ? { ownerNodeId: owner } : {}) };
  }
  if (isCgnatV4(ip)) return { kind: "cgnat" };
  if (isPrivateV4(ip)) return { kind: "private" };
  return undefined;
}

/** The one diagram resource behind a source IP (and / or identity), or why there is none */
export function resolveCaller(
  input: Pick<PluInput, "callers" | "subnets" | "nics" | "nodeByArmId" | "identities" | "clusterOf" | "outerSubnets" | "knownCidrs" | "sites">,
  ip: string | undefined,
  oid?: string,
): Resolved {
  const byIdentity = (): Resolved | null => {
    if (!oid) return null;
    const holders = input.identities.get(oid.toLowerCase()) ?? [];
    const inDiagram = holders.map((h) => ({ h, node: input.nodeByArmId.get(h.armId.toLowerCase()) })).filter((x) => x.node);
    if (inDiagram.length === 1) return { ok: true, nodeId: inDiagram[0]!.node!, attribution: "identity", identityName: inDiagram[0]!.h.name };
    if (inDiagram.length > 1) {
      // The kubelet identity sits on the cluster and on each node-pool scale set — one cluster is one caller
      const nodes = [...new Set(inDiagram.map((x) => x.node!))].sort(cmp);
      const cluster = collapseToCluster(nodes, input.clusterOf);
      if (cluster) return { ok: true, nodeId: cluster, attribution: "identity", identityName: inDiagram[0]!.h.name };
      return { ok: false, reason: "ambiguous", candidates: nodes, basis: "identity" };
    }
    return null;
  };
  const identityName = () => {
    const holders = oid ? input.identities.get(oid.toLowerCase()) ?? [] : [];
    return holders.length === 1 ? holders[0]!.name : undefined;
  };
  if (ip && isInternalV4(ip, input.knownCidrs)) {
    // 1. a NIC IP of a resource on the diagram
    const direct = input.callers.filter((c) => c.ips.includes(ip));
    if (direct.length === 1) return { ok: true, nodeId: direct[0]!.nodeId, attribution: "nic", identityName: identityName() };
    // 2. the NIC inventory: VM NIC (on or off the diagram) or a NIC without a VM
    const nic = input.nics.find((n) => n.ip === ip && !n.peArmId);
    if (nic) {
      if (nic.vmArmId) {
        const node = input.nodeByArmId.get(nic.vmArmId.toLowerCase());
        if (node) return { ok: true, nodeId: node, attribution: "nic", identityName: identityName() };
        return byIdentity() ?? { ok: false, reason: "notInDiagram", nicName: nic.nicName };
      }
      return byIdentity() ?? { ok: false, reason: "nicNoVm", nicName: nic.nicName };
    }
    // 3. the subnet's single owner (AKS node pool, VMSS, App Service integration)
    const subnet = input.subnets.filter((s) => ipInCidr(ip, s.cidr));
    const owners = [...new Set(subnet.flatMap((s) => s.owners))].sort(cmp);
    const vnetId = subnet[0]?.vnetId;
    if (owners.length === 1) return { ok: true, nodeId: owners[0]!, attribution: "subnetOwner", identityName: identityName(), vnetId };
    // Node pools of one AKS cluster share the subnet: the caller is that cluster (which pool / pod is unknown)
    const cluster = collapseToCluster(owners, input.clusterOf);
    if (cluster) return { ok: true, nodeId: cluster, attribution: "aksCluster", identityName: identityName(), vnetId, via: owners };
    const viaIdentity = byIdentity();
    // An identity result is used only when it names one resource — otherwise the subnet candidates stay the answer
    if (viaIdentity?.ok) return viaIdentity;
    if (owners.length > 1) return { ok: false, reason: "ambiguous", candidates: owners, basis: "subnet" };
    if (viaIdentity) return viaIdentity;
    const place = classifyPlace(ip, input.outerSubnets ?? [], input.clusterOf, input.sites);
    return { ok: false, reason: "notInDiagram", ...(place ? { place } : {}) };
  }
  return byIdentity() ?? { ok: false, reason: "notInDiagram" };
}

const GRADE_RANK: Record<PlUsageGrade, number> = { access: 0, flow: 1 };

/** An internal load balancer's private frontend IPs (from the diagram) */
export type PluLb = { lbNodeId: string; ips: string[] };

/**
 * Who sent packets to an internal load balancer — VNet flow logs only (the caller side records the frontend IP as
 * destination; at the backend Azure rewrites it to the backend IP unless Floating IP). Same caller rules as the
 * Private Endpoint use: one resource (NIC, the subnet's single owner, one AKS cluster) or an unresolved row with
 * the reason. Denied-only pairs are listed, never drawn. Bytes are per caller pair (flow log), never the LB metric.
 */
export function joinLbInbound(input: Pick<PluInput, "callers" | "subnets" | "nics" | "nodeByArmId" | "identities" | "clusterOf" | "outerSubnets" | "knownCidrs" | "sites">, lbs: readonly PluLb[], flows: readonly PluFlowRow[]): LbInbound {
  const byIp = new Map<string, string>();
  for (const lb of lbs) for (const ip of lb.ips) byIp.set(ip, lb.lbNodeId);
  const callers = new Map<string, LbInboundCaller>();
  const unresolved: PlUnresolved[] = [];
  for (const f of flows) {
    const lbNodeId = byIp.get(f.destIp);
    if (!lbNodeId) continue;
    if (f.allowed === 0 && f.denied > 0) {
      unresolved.push({ targetNodeId: lbNodeId, ip: f.srcIp, reason: "denied", deniedFlows: f.denied, lastSeen: f.last });
      continue;
    }
    const r = resolveCaller(input, f.srcIp);
    if (!r.ok) {
      unresolved.push({ targetNodeId: lbNodeId, ip: f.srcIp, ...failure(r), lastSeen: f.last });
      continue;
    }
    if (r.nodeId === lbNodeId) continue;
    const id = `lbi:${r.nodeId}>${lbNodeId}`;
    const c = callers.get(id) ?? { id, callerNodeId: r.nodeId, lbNodeId, frontendIps: [], attribution: r.attribution, evidence: [] };
    if (!c.frontendIps.includes(f.destIp)) c.frontendIps.push(f.destIp);
    if (isPrivateV4(f.srcIp)) c.callerIp ??= f.srcIp;
    if (r.attribution === "nic" || ((r.attribution === "subnetOwner" || r.attribution === "aksCluster") && c.attribution === "identity")) c.attribution = r.attribution;
    if (r.via?.length) c.viaNodeIds = [...new Set([...(c.viaNodeIds ?? []), ...r.via])].sort(cmp);
    c.evidence.push({
      source: "vnetFlow", grade: "flow", firstSeen: f.first, lastSeen: f.last, bytes: f.bytes, flows: f.flows,
      ...(f.denied ? { deniedFlows: f.denied } : {}), ...(f.ports?.length ? { ports: [...f.ports].sort((a, b) => a - b).slice(0, 5) } : {}),
    });
    c.lastSeen = maxIso(c.lastSeen, f.last);
    callers.set(id, c);
  }
  const list = [...callers.values()]
    .map((c) => ({ ...c, frontendIps: [...c.frontendIps].sort(cmp) }))
    .sort((a, b) => cmp(a.lbNodeId, b.lbNodeId) || cmp(b.lastSeen ?? "", a.lastSeen ?? "") || cmp(a.id, b.id));
  unresolved.sort((a, b) => cmp(a.targetNodeId, b.targetNodeId) || cmp(a.reason, b.reason) || cmp(a.ip ?? "", b.ip ?? ""));
  return { frontends: lbs.map((l) => ({ lbNodeId: l.lbNodeId, ips: [...l.ips].sort(cmp) })).sort((a, b) => cmp(a.lbNodeId, b.lbNodeId)), callers: list, unresolved };
}

const failure = (r: Extract<Resolved, { ok: false }>): Pick<PlUnresolved, "reason" | "nicName" | "candidates" | "basis" | "place"> => ({
  reason: r.reason,
  ...(r.nicName ? { nicName: r.nicName } : {}),
  ...(r.candidates ? { candidates: r.candidates } : {}),
  ...(r.basis ? { basis: r.basis } : {}),
  ...(r.place ? { place: r.place } : {}),
});

export function joinPrivateLinkUsage(input: PluInput): PluOutput {
  const usages = new Map<string, PrivateLinkUsage>();
  const unresolved: PlUnresolved[] = [];
  const pub = new Map<string, { requests: number; ips: Set<string>; names: Set<string>; last?: string }>();
  const vnetOfCaller = new Map(input.callers.map((c) => [c.nodeId, c.vnetId]));

  const addUsage = (r: Extract<Resolved, { ok: true }>, pe: PluPe, ip: string | undefined, ev: PlEvidence) => {
    const id = `plu:${r.nodeId}>${pe.peNodeId}`;
    const u = usages.get(id) ?? {
      id, callerNodeId: r.nodeId, peNodeId: pe.peNodeId, targetNodeId: pe.targetNodeId, attribution: r.attribution, grade: ev.grade, evidence: [],
    };
    if (ip && isPrivateV4(ip)) u.callerIp ??= ip;
    if (r.identityName) u.identityName ??= r.identityName;
    // the strongest way the caller was pinned wins (NIC > subnet owner = AKS cluster > identity)
    if (r.attribution === "nic" || ((r.attribution === "subnetOwner" || r.attribution === "aksCluster") && u.attribution === "identity")) u.attribution = r.attribution;
    if (r.via?.length) u.viaNodeIds = [...new Set([...(u.viaNodeIds ?? []), ...r.via])].sort(cmp);
    u.evidence.push(ev);
    if (GRADE_RANK[ev.grade] < GRADE_RANK[u.grade]) u.grade = ev.grade;
    u.lastSeen = maxIso(u.lastSeen, ev.lastSeen);
    usages.set(id, u);
  };

  // ── access logs: the service saw the caller ──
  for (const row of input.access) {
    if (row.ip && !isInternalV4(row.ip, input.knownCidrs) && V4.test(row.ip)) {
      // Public path: bypassed the Private Endpoint — counted, IP not listed
      const p = pub.get(row.targetNodeId) ?? { requests: 0, ips: new Set<string>(), names: new Set<string>() };
      p.requests += row.requests ?? row.clients ?? 1;
      p.ips.add(row.ip);
      const holders = row.oid ? input.identities.get(row.oid.toLowerCase()) ?? [] : [];
      if (holders.length === 1) p.names.add(holders[0]!.name);
      p.last = maxIso(p.last, row.last);
      pub.set(row.targetNodeId, p);
      continue;
    }
    if (!row.ip && !row.oid) {
      unresolved.push({ targetNodeId: row.targetNodeId, reason: "noIp", requests: row.requests ?? row.clients, lastSeen: row.last });
      continue;
    }
    const r = resolveCaller(input, row.ip, row.oid);
    if (!r.ok) {
      unresolved.push({ targetNodeId: row.targetNodeId, ip: row.ip, ...failure(r), requests: row.requests ?? row.clients, lastSeen: row.last });
      continue;
    }
    // Which Private Endpoint: the target's PE in the caller's VNet (the source subnet's when known), else in a VNet
    // peered with it — exactly one
    const vnet = r.vnetId ?? vnetOfCaller.get(r.nodeId) ?? input.callers.find((c) => c.nodeId === r.nodeId)?.vnetId;
    const forTarget = input.pes.filter((p) => p.targetNodeId === row.targetNodeId);
    let cands = forTarget.filter((p) => vnet && p.vnetId === vnet);
    if (!cands.length && vnet) cands = forTarget.filter((p) => p.vnetId && input.peerings.get(vnet)?.has(p.vnetId));
    if (cands.length !== 1) {
      unresolved.push({ targetNodeId: row.targetNodeId, ip: row.ip, reason: "peUnconfirmed", requests: row.requests ?? row.clients, lastSeen: row.last, candidates: cands.map((c) => c.peNodeId).sort(cmp) });
      continue;
    }
    addUsage(r, cands[0]!, row.ip, {
      source: row.source, grade: "access", firstSeen: row.first, lastSeen: row.last,
      ...(row.requests != null ? { requests: row.requests } : {}), ...(row.failed != null ? { failed: row.failed } : {}),
      ...(row.clients != null ? { clients: row.clients } : {}), ...(row.bytes != null ? { bytes: row.bytes } : {}),
      ...(row.ops?.length ? { operations: [...row.ops].sort(cmp).slice(0, 5) } : {}),
    });
  }

  // ── flow logs: packets reached the Private Endpoint IP ──
  for (const f of input.flows) {
    const pe = input.pes.find((p) => p.ip === f.destIp);
    if (!pe) continue;
    if (f.allowed === 0 && f.denied > 0) {
      unresolved.push({ targetNodeId: pe.targetNodeId, peNodeId: pe.peNodeId, ip: f.srcIp, reason: "denied", deniedFlows: f.denied, lastSeen: f.last });
      continue;
    }
    const r = resolveCaller(input, f.srcIp);
    if (!r.ok) {
      unresolved.push({ targetNodeId: pe.targetNodeId, peNodeId: pe.peNodeId, ip: f.srcIp, ...failure(r), lastSeen: f.last });
      continue;
    }
    addUsage(r, pe, f.srcIp, {
      source: "vnetFlow", grade: "flow", firstSeen: f.first, lastSeen: f.last, bytes: f.bytes, flows: f.flows,
      ...(f.denied ? { deniedFlows: f.denied } : {}), ...(f.ports?.length ? { ports: [...f.ports].sort((a, b) => a - b).slice(0, 5) } : {}),
    });
  }

  const usageList = [...usages.values()]
    .map((u) => ({ ...u, evidence: [...u.evidence].sort((a, b) => GRADE_RANK[a.grade] - GRADE_RANK[b.grade] || cmp(a.source, b.source)) }))
    .sort((a, b) => GRADE_RANK[a.grade] - GRADE_RANK[b.grade] || cmp(b.lastSeen ?? "", a.lastSeen ?? "") || cmp(a.id, b.id));

  // ── per Private Endpoint: used / no use observed / unknown ──
  const usedPe = new Set(usageList.map((u) => u.peNodeId));
  const endpoints: PlEndpoint[] = input.pes.map((p) => {
    const looked = input.sources.some((s) => (s.targetNodeId === p.targetNodeId || (s.source === "vnetFlow" && !s.targetNodeId)) && (s.state === "ok" || s.state === "empty"));
    const bytes = input.peBytes.get(p.peNodeId);
    const activity: PlEndpoint["activity"] = usedPe.has(p.peNodeId) || (bytes != null && bytes > 0) ? "used" : looked && bytes == null ? "noUseObserved" : looked && bytes === 0 ? "noUseObserved" : "unknown";
    return { peNodeId: p.peNodeId, targetNodeId: p.targetNodeId, ...(p.state ? { connectionState: p.state } : {}), activity };
  }).sort((a, b) => cmp(a.peNodeId, b.peNodeId));

  const publicAccess: PlPublicAccess[] = [...pub.entries()].map(([targetNodeId, p]) => ({
    targetNodeId, requests: p.requests, distinctIps: p.ips.size, ...(p.names.size ? { identityNames: [...p.names].sort(cmp) } : {}), ...(p.last ? { lastSeen: p.last } : {}),
  })).sort((a, b) => cmp(a.targetNodeId, b.targetNodeId));

  unresolved.sort((a, b) => cmp(a.targetNodeId, b.targetNodeId) || cmp(a.reason, b.reason) || cmp(a.ip ?? "", b.ip ?? "") || cmp(a.peNodeId ?? "", b.peNodeId ?? ""));
  return { endpoints, usages: usageList, unresolved, publicAccess };
}

