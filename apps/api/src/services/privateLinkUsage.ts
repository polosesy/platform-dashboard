// Private Link usage — pure join (no Azure calls), unit-tested from apps/api/test/privateLinkUsage.test.ts.
//
// Who uses a Private Endpoint is read from observed evidence only:
//   access — the PaaS service's own log saw a caller IP / identity (Key Vault audit, Storage logs, Redis clients)
//   flow   — a VNet flow log saw packets from a source IP to the Private Endpoint IP (Traffic Analytics)
// The caller is found by its NIC IP, by being the only compute in the source subnet, or by its managed identity.
// Anything that cannot be pinned to exactly one resource is listed as unresolved — never drawn.
import type {
  PlEndpoint,
  PlEvidence,
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
  | { ok: true; nodeId: string; attribution: PrivateLinkUsage["attribution"]; identityName?: string }
  | { ok: false; reason: "nicNoVm" | "notInDiagram" | "ambiguous"; nicName?: string; candidates?: string[] };

/** The one diagram resource behind a source IP (and / or identity), or why there is none */
export function resolveCaller(input: Pick<PluInput, "callers" | "subnets" | "nics" | "nodeByArmId" | "identities">, ip: string | undefined, oid?: string): Resolved {
  const byIdentity = (): Resolved | null => {
    if (!oid) return null;
    const holders = input.identities.get(oid.toLowerCase()) ?? [];
    const inDiagram = holders.map((h) => ({ h, node: input.nodeByArmId.get(h.armId.toLowerCase()) })).filter((x) => x.node);
    if (inDiagram.length === 1) return { ok: true, nodeId: inDiagram[0]!.node!, attribution: "identity", identityName: inDiagram[0]!.h.name };
    if (inDiagram.length > 1) return { ok: false, reason: "ambiguous", candidates: inDiagram.map((x) => x.node!).sort(cmp) };
    return null;
  };
  const identityName = () => {
    const holders = oid ? input.identities.get(oid.toLowerCase()) ?? [] : [];
    return holders.length === 1 ? holders[0]!.name : undefined;
  };
  if (ip && isPrivateV4(ip)) {
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
    if (owners.length === 1) return { ok: true, nodeId: owners[0]!, attribution: "subnetOwner", identityName: identityName() };
    const viaIdentity = byIdentity();
    if (viaIdentity) return viaIdentity;
    if (owners.length > 1) return { ok: false, reason: "ambiguous", candidates: owners };
    return { ok: false, reason: "notInDiagram" };
  }
  return byIdentity() ?? { ok: false, reason: "notInDiagram" };
}

const GRADE_RANK: Record<PlUsageGrade, number> = { access: 0, flow: 1 };

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
    // the strongest way the caller was pinned wins (NIC > subnet owner > identity)
    if (r.attribution === "nic" || (r.attribution === "subnetOwner" && u.attribution === "identity")) u.attribution = r.attribution;
    u.evidence.push(ev);
    if (GRADE_RANK[ev.grade] < GRADE_RANK[u.grade]) u.grade = ev.grade;
    u.lastSeen = maxIso(u.lastSeen, ev.lastSeen);
    usages.set(id, u);
  };

  // ── access logs: the service saw the caller ──
  for (const row of input.access) {
    if (row.ip && !isPrivateV4(row.ip) && V4.test(row.ip)) {
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
      unresolved.push({ targetNodeId: row.targetNodeId, ip: row.ip, reason: r.reason, nicName: r.nicName, candidates: r.candidates, requests: row.requests ?? row.clients, lastSeen: row.last });
      continue;
    }
    // Which Private Endpoint: the target's PE in the caller's VNet, else in a VNet peered with it — exactly one
    const vnet = vnetOfCaller.get(r.nodeId) ?? input.callers.find((c) => c.nodeId === r.nodeId)?.vnetId;
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
      unresolved.push({ targetNodeId: pe.targetNodeId, peNodeId: pe.peNodeId, ip: f.srcIp, reason: r.reason, nicName: r.nicName, candidates: r.candidates, lastSeen: f.last });
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

