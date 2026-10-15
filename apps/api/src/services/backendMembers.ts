// Load Balancer / Application Gateway frontends and backend-pool members — pure; unit-tested from
// apps/api/test/backendMembers.test.ts. Catalog rows LB-01..06, AGW-01..05, VMSS-04
// (docs/architecture/azure-resource-relationships.md).
//
// A pool names its members three ways (Microsoft docs: "NICs · virtual machine scale sets · public IP addresses ·
// internal IP addresses · FQDN"): a NIC ip configuration (configuration evidence), an IP address, or an FQDN.
// An address is resolved to the resource that holds it NOW, and only when exactly one candidate matches inside
// the allowed VNets — otherwise the member stays "unresolved" (never a guessed line).

export type Frontend = {
  name: string;
  kind: "public" | "private";
  ip?: string;
  publicIpId?: string;
  /** Listener names on this frontend (AGW) */
  listeners: string[];
  /** A routing rule (AGW) or a load-balancing / inbound NAT rule (LB) uses this frontend */
  ruleBound: boolean;
};

export type Member = { via: "nic" | "ip" | "fqdn"; ref?: string; address?: string; vnetId?: string };

export type Pool = {
  name: string;
  members: Member[];
  /** Rules that send traffic IN to this pool (null = the properties do not say) */
  inboundRuleRefs: number | null;
  /** LB outbound rules on this pool (null = unknown) */
  outboundRuleRefs: number | null;
  /** AGW: backend ports of the HTTP settings of the rules that use this pool */
  ports: number[];
};

type Obj = Record<string, unknown>;
const props = (o: unknown): Obj => {
  if (!o || typeof o !== "object") return {};
  const x = o as Obj;
  return (x.properties && typeof x.properties === "object" ? (x.properties as Obj) : x);
};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const idOf = (v: unknown): string | undefined => {
  const id = v && typeof v === "object" ? (v as Obj).id : undefined;
  return typeof id === "string" && id ? id.toLowerCase() : undefined;
};
const lastSeg = (id: string | undefined) => (id ? id.split("/").pop() ?? id : "");
const nameOf = (o: unknown): string => {
  const x = (o ?? {}) as Obj;
  return typeof x.name === "string" ? x.name : lastSeg(idOf(o));
};
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const countOrNull = (o: Obj, ...keys: string[]): number | null => {
  let known = false, n = 0;
  for (const k of keys) {
    const v = o[k];
    if (Array.isArray(v)) { known = true; n += v.length; } else if (v && typeof v === "object") { known = true; n += 1; }
  }
  return known ? n : null;
};

/** Frontends with their kind, IP and whether any rule uses them. `pipIp` resolves a public IP resource id. */
export function parseFrontends(kind: "appGateway" | "lb", properties: unknown, pipIp: (id: string) => string | undefined = () => undefined): Frontend[] {
  const p = props(properties);
  const out: Frontend[] = [];
  for (const fe of arr(p.frontendIPConfigurations)) {
    const fp = props(fe);
    const name = nameOf(fe);
    const publicIpId = idOf(fp.publicIPAddress);
    const ip = publicIpId ? pipIp(publicIpId) : str(fp.privateIPAddress);
    out.push({ name, kind: publicIpId ? "public" : "private", ...(ip ? { ip } : {}), ...(publicIpId ? { publicIpId } : {}), listeners: [], ruleBound: false });
  }
  const byName = new Map(out.map((f) => [f.name.toLowerCase(), f]));
  if (kind === "appGateway") {
    // Listener → frontend; a rule references a listener (v1/v2 HTTP listeners and v2 TCP/TLS listeners)
    const listenerFe = new Map<string, Frontend>();
    for (const l of [...arr(p.httpListeners), ...arr(p.listeners)]) {
      const f = byName.get(lastSeg(idOf(props(l).frontendIPConfiguration)).toLowerCase());
      if (!f) continue;
      const ln = nameOf(l);
      f.listeners.push(ln);
      listenerFe.set(ln.toLowerCase(), f);
    }
    for (const r of [...arr(p.requestRoutingRules), ...arr(p.routingRules)]) {
      const rp = props(r);
      const f = listenerFe.get(lastSeg(idOf(rp.httpListener) ?? idOf(rp.listener)).toLowerCase());
      if (f) f.ruleBound = true;
    }
  } else {
    for (const fe of arr(p.frontendIPConfigurations)) {
      const fp = props(fe);
      const f = byName.get(nameOf(fe).toLowerCase());
      if (f && (arr(fp.loadBalancingRules).length || arr(fp.inboundNatRules).length || arr(fp.inboundNatPools).length)) f.ruleBound = true;
    }
  }
  return out;
}

const NIC_OF_IPCONFIG = /^(.*?)\/ipconfigurations\/[^/]+$/i;

/** Backend pools and how each member is named, with the rules that use the pool */
export function parsePools(kind: "appGateway" | "lb", properties: unknown): Pool[] {
  const p = props(properties);
  // AGW: pool → ports via rules (basic rules and path maps) → backend HTTP settings
  const settingsPort = new Map<string, number>();
  for (const s of [...arr(p.backendHttpSettingsCollection), ...arr(p.backendSettingsCollection)]) {
    const port = Number(props(s).port);
    if (Number.isFinite(port)) settingsPort.set(nameOf(s).toLowerCase(), port);
  }
  const agwUse = new Map<string, { refs: number; ports: Set<number> }>();
  const use = (poolId: string | undefined, settingsId: string | undefined) => {
    if (!poolId) return;
    const k = lastSeg(poolId).toLowerCase();
    const u = agwUse.get(k) ?? { refs: 0, ports: new Set<number>() };
    u.refs++;
    const port = settingsId ? settingsPort.get(lastSeg(settingsId).toLowerCase()) : undefined;
    if (port != null) u.ports.add(port);
    agwUse.set(k, u);
  };
  if (kind === "appGateway") {
    for (const r of [...arr(p.requestRoutingRules), ...arr(p.routingRules)]) {
      const rp = props(r);
      use(idOf(rp.backendAddressPool), idOf(rp.backendHttpSettings) ?? idOf(rp.backendSettings));
    }
    for (const m of arr(p.urlPathMaps)) {
      const mp = props(m);
      use(idOf(mp.defaultBackendAddressPool), idOf(mp.defaultBackendHttpSettings));
      for (const pr of arr(mp.pathRules)) {
        const pp = props(pr);
        use(idOf(pp.backendAddressPool), idOf(pp.backendHttpSettings));
      }
    }
  }

  const pools: Pool[] = [];
  for (const pool of arr(p.backendAddressPools)) {
    const pp = props(pool);
    const name = nameOf(pool);
    const members: Member[] = [];
    for (const c of arr(pp.backendIPConfigurations)) {
      const id = idOf(c);
      if (id) members.push({ via: "nic", ref: id.replace(NIC_OF_IPCONFIG, "$1") });
    }
    if (kind === "appGateway") {
      for (const a of arr(pp.backendAddresses)) {
        const x = (a ?? {}) as Obj;
        if (str(x.ipAddress)) members.push({ via: "ip", address: String(x.ipAddress) });
        else if (str(x.fqdn)) members.push({ via: "fqdn", address: String(x.fqdn).toLowerCase() });
      }
      const u = agwUse.get(name.toLowerCase());
      pools.push({ name, members: dedupe(members), inboundRuleRefs: u?.refs ?? 0, outboundRuleRefs: 0, ports: [...(u?.ports ?? [])].sort((a, b) => a - b) });
    } else {
      for (const a of arr(pp.loadBalancerBackendAddresses)) {
        const ap = props(a);
        const nicCfg = idOf(ap.networkInterfaceIPConfiguration);
        if (nicCfg) members.push({ via: "nic", ref: nicCfg.replace(NIC_OF_IPCONFIG, "$1") });
        else if (str(ap.ipAddress)) members.push({ via: "ip", address: String(ap.ipAddress), ...(idOf(ap.virtualNetwork) ? { vnetId: idOf(ap.virtualNetwork) } : {}) });
      }
      pools.push({
        name,
        members: dedupe(members),
        inboundRuleRefs: countOrNull(pp, "loadBalancingRules", "inboundNatRules"),
        outboundRuleRefs: countOrNull(pp, "outboundRules", "outboundRule"),
        ports: [],
      });
    }
  }
  return pools;
}

function dedupe(members: Member[]): Member[] {
  const seen = new Set<string>();
  return members.filter((m) => {
    const k = `${m.via}|${m.ref ?? m.address}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ── address → holder ──

export type AddressEntry = {
  address: string;
  targetId: string;
  /** VNet of a private address (lowercase id); public addresses and host names have none */
  vnetId?: string;
  source: "nic" | "lbFrontend" | "pe" | "pip" | "site" | "containerApp" | "agcFrontend" | "pipFqdn";
};

export type AddressIndex = Map<string, AddressEntry[]>;

export function buildAddressIndex(entries: AddressEntry[]): AddressIndex {
  const idx: AddressIndex = new Map();
  for (const e of entries) {
    const k = e.address.toLowerCase();
    const list = idx.get(k) ?? [];
    if (!list.some((x) => x.targetId === e.targetId)) list.push(e);
    idx.set(k, list);
  }
  return idx;
}

export type UnresolvedReason = "none" | "ambiguous" | "fqdn";
export type Resolution =
  | { targetId: string; evidence: "cfg" | "ipMatch" | "fqdnMatch"; source?: AddressEntry["source"] }
  | { unresolved: UnresolvedReason; candidates?: number };

const UNIFORM_INSTANCE_NIC = /^(\/subscriptions\/[^/]+\/resourcegroups\/[^/]+\/providers\/microsoft\.compute\/virtualmachinescalesets\/[^/]+)\/virtualmachines\//i;

/**
 * Resolve one member. `scopeVnets` = VNets a private address may be in (AGW: its own and connected peers;
 * LB IP pool: the member's virtualNetwork); `known` = resource ids present in the graph.
 */
export function resolveMember(member: Member, scopeVnets: ReadonlySet<string>, idx: AddressIndex, known: ReadonlySet<string>): Resolution {
  if (member.via === "nic") {
    const ref = (member.ref ?? "").toLowerCase();
    if (known.has(ref)) return { targetId: ref, evidence: "cfg" };
    // A Uniform instance NIC is not a top-level resource: the member is the scale set
    const vmss = UNIFORM_INSTANCE_NIC.exec(ref)?.[1];
    if (vmss && known.has(vmss)) return { targetId: vmss, evidence: "cfg" };
    return { unresolved: "none" };
  }
  const list = idx.get((member.address ?? "").toLowerCase()) ?? [];
  if (member.via === "fqdn") {
    const hits = list.filter((e) => e.source === "site" || e.source === "containerApp");
    if (hits.length === 1) return { targetId: hits[0]!.targetId, evidence: "fqdnMatch", source: hits[0]!.source };
    return hits.length > 1 ? { unresolved: "ambiguous", candidates: hits.length } : { unresolved: "fqdn" };
  }
  const allowed = member.vnetId ? new Set([member.vnetId]) : scopeVnets;
  const hits = list.filter((e) => (e.vnetId ? allowed.has(e.vnetId) : e.source === "pip"));
  if (hits.length === 1) return { targetId: hits[0]!.targetId, evidence: "ipMatch", source: hits[0]!.source };
  return hits.length > 1 ? { unresolved: "ambiguous", candidates: hits.length } : { unresolved: "none" };
}

/** The BackendServer dimension value Azure reports for an AGW member: "ip:port" (one per backend port) */
export function backendServerKeys(address: string, ports: number[]): string[] {
  return ports.length ? ports.map((p) => `${address}:${p}`) : [address];
}
