// Can the Internet reach an instance-level public IP? A static evaluation of the subnet NSG and the NIC NSG for one
// ip configuration (catalog PIP-04). Pure — unit-tested from apps/api/test/nsgExposure.test.ts.
//
// Facts it follows (Microsoft Learn):
//   - A Standard public IP is closed to inbound traffic until an NSG allows it; Basic is open by default
//     (virtual-network/ip-services/public-ip-addresses)
//   - Inbound: the subnet NSG is evaluated first, then the NIC NSG — traffic needs both to allow; rules run in priority
//     order and the first match wins; default rules 65000 AllowVnetInBound · 65001 AllowAzureLoadBalancerInBound ·
//     65500 DenyAllInbound (virtual-network/network-security-group-how-it-works, network-security-groups-overview)
//   - NSG rules see the destination after the public IP is translated: a rule applies when its destination is "*",
//     VirtualNetwork, a prefix containing the private IP, or an application security group of that ip configuration
//   - The VirtualNetwork tag includes address prefixes of user-defined routes — a 0.0.0.0/0 route widens
//     AllowVnetInBound to the Internet (virtual-network/service-tags-overview)
//   - Azure Virtual Network Manager security admin rules run before NSGs and can end evaluation
//
// Not a runtime check: effective security rules need a running VM and an /action permission this platform does not use.
import type { InboundExposure } from "@aud/types";

/** One security rule as ARM / Resource Graph returns it (flat or under `properties`) */
export type NsgRuleInput = { name?: string; properties?: Record<string, unknown> } & Record<string, unknown>;
export type NsgInput = { securityRules?: NsgRuleInput[] } | null | undefined;

type Proto = "tcp" | "udp";
type SourceClass = "wide" | "scoped" | "vnet" | "none";
type Rule = {
  priority: number;
  allow: boolean;
  protos: Proto[];
  ports: Array<[number, number]>;
  sources: Array<{ cls: SourceClass; key: string }>;
  applies: boolean | "unknown";
};

export type ExposureTarget = {
  /** Private IP of the ip configuration that holds the public IP */
  privateIp?: string;
  /** ASG ids of that ip configuration (lower-case); undefined = not known */
  asgIds?: string[];
  /** Public IP SKU name ("Standard" | "Basic") */
  pipSku?: string;
  /** The subnet's route table has a route outside private address space (widens the VirtualNetwork tag) */
  vnetTagWidened?: boolean;
  /** A Virtual Network Manager exists in the visible subscriptions */
  avnmPresent?: boolean;
};

const DEFAULT_RULES: NsgRuleInput[] = [
  { name: "AllowVnetInBound", properties: { priority: 65000, direction: "Inbound", access: "Allow", protocol: "*", sourceAddressPrefix: "VirtualNetwork", destinationAddressPrefix: "VirtualNetwork", destinationPortRange: "*" } },
  { name: "AllowAzureLoadBalancerInBound", properties: { priority: 65001, direction: "Inbound", access: "Allow", protocol: "*", sourceAddressPrefix: "AzureLoadBalancer", destinationAddressPrefix: "*", destinationPortRange: "*" } },
  { name: "DenyAllInBound", properties: { priority: 65500, direction: "Inbound", access: "Deny", protocol: "*", sourceAddressPrefix: "*", destinationAddressPrefix: "*", destinationPortRange: "*" } },
];

const WIDE = /^(\*|any|internet|0\.0\.0\.0\/0|::\/0)$/i;
const NOT_INTERNET_TAGS = /^(virtualnetwork|azureloadbalancer)$/i;

function ipToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim());
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!;
}

/** IPv4 prefix ("10.0.0.0/8", "1.2.3.4") → [first, last], null when not IPv4 */
export function cidrRange(prefix: string): [number, number] | null {
  const [ip, len] = prefix.trim().split("/");
  const base = ipToInt(ip ?? "");
  if (base == null) return null;
  const bits = len == null ? 32 : Number(len);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  const size = 2 ** (32 - bits);
  const first = Math.floor(base / size) * size;
  return [first, first + size - 1];
}

const PRIVATE_RANGES = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "168.63.129.16/32"].map((c) => cidrRange(c)!);

/** An IPv4 prefix that lies wholly inside private / non-Internet space */
export function isPrivatePrefix(prefix: string): boolean {
  const r = cidrRange(prefix);
  return !!r && PRIVATE_RANGES.some(([a, b]) => r[0] >= a && r[1] <= b);
}

function classifySource(prefix: string): SourceClass {
  const p = prefix.trim();
  if (WIDE.test(p)) return "wide";
  if (/^virtualnetwork$/i.test(p)) return "vnet";
  if (NOT_INTERNET_TAGS.test(p)) return "none";
  if (cidrRange(p)) return isPrivatePrefix(p) ? "none" : "scoped";
  if (/:/.test(p)) return /^(fc|fd|fe8)/i.test(p) ? "none" : "scoped"; // IPv6 prefix
  return "scoped"; // another service tag (AzureCloud, Storage.KoreaCentral …)
}

function parsePorts(specs: string[]): Array<[number, number]> | null {
  const out: Array<[number, number]> = [];
  for (const raw of specs) {
    const s = raw.trim();
    if (s === "*" ) { out.push([0, 65535]); continue; }
    const m = /^(\d+)(?:-(\d+))?$/.exec(s);
    if (!m) return null;
    const a = Number(m[1]), b = m[2] ? Number(m[2]) : a;
    if (a > b || b > 65535) return null;
    out.push([a, b]);
  }
  return out;
}

const list = (single: unknown, many: unknown): string[] => [
  ...(typeof single === "string" && single ? [single] : []),
  ...(Array.isArray(many) ? many.filter((x): x is string => typeof x === "string" && !!x) : []),
];
const idList = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String((x as { id?: unknown })?.id ?? "").toLowerCase()).filter(Boolean) : []);

function destinationApplies(p: Record<string, unknown>, t: ExposureTarget): boolean | "unknown" {
  const asgs = idList(p.destinationApplicationSecurityGroups);
  if (asgs.length) {
    if (!t.asgIds) return "unknown";
    return asgs.some((a) => t.asgIds!.includes(a));
  }
  const dests = list(p.destinationAddressPrefix, p.destinationAddressPrefixes);
  if (!dests.length) return "unknown";
  const ip = t.privateIp ? ipToInt(t.privateIp) : null;
  let unknown = false;
  for (const d of dests) {
    if (/^(\*|any|virtualnetwork|0\.0\.0\.0\/0)$/i.test(d.trim())) return true;
    const r = cidrRange(d);
    if (r) { if (ip == null) unknown = true; else if (ip >= r[0] && ip <= r[1]) return true; continue; }
    unknown = true; // another tag as destination — cannot place the private IP in it
  }
  return unknown ? "unknown" : false;
}

/** Parse one rule; null = not an inbound TCP/UDP rule (ICMP, ESP, outbound …); "bad" = could not be read */
function parseRule(r: NsgRuleInput, t: ExposureTarget): Rule | null | "bad" {
  const p = (r.properties && typeof r.properties === "object" ? r.properties : r) as Record<string, unknown>;
  if (String(p.direction ?? "").toLowerCase() !== "inbound") return null;
  const proto = String(p.protocol ?? "*").toLowerCase();
  const protos: Proto[] = proto === "*" ? ["tcp", "udp"] : proto === "tcp" || proto === "udp" ? [proto] : [];
  if (!protos.length) return null;
  const priority = Number(p.priority);
  const access = String(p.access ?? "").toLowerCase();
  const ports = parsePorts(list(p.destinationPortRange, p.destinationPortRanges));
  if (!Number.isFinite(priority) || (access !== "allow" && access !== "deny") || !ports || !ports.length) return "bad";
  const srcPrefixes = list(p.sourceAddressPrefix, p.sourceAddressPrefixes);
  const sources = srcPrefixes.map((s) => ({ cls: classifySource(s), key: s.trim() }));
  // A source ASG is never an Internet address
  if (!sources.length && !idList(p.sourceApplicationSecurityGroups).length) return "bad";
  return { priority, allow: access === "allow", protos, ports, sources, applies: destinationApplies(p, t) };
}

type Cell = { wide: boolean; scoped: Set<string>; unknown: boolean };

/** Elementary port intervals covering 0..65535 from every rule boundary */
function segments(rules: Rule[]): Array<[number, number]> {
  const cuts = new Set<number>([0, 65536]);
  for (const r of rules) for (const [a, b] of r.ports) { cuts.add(a); cuts.add(b + 1); }
  const sorted = [...cuts].sort((x, y) => x - y);
  const out: Array<[number, number]> = [];
  for (let i = 0; i < sorted.length - 1; i++) out.push([sorted[i]!, sorted[i + 1]! - 1]);
  return out;
}

/**
 * One NSG for one target: for each protocol and port interval, whether any Internet address may connect (wide),
 * which listed sources may (scoped), and whether an unreadable input could change the answer.
 */
function evaluateNsg(nsg: NonNullable<NsgInput>, t: ExposureTarget, reasons: Set<string>): Map<Proto, Array<{ seg: [number, number]; cell: Cell }>> {
  const rules: Rule[] = [];
  for (const raw of [...(nsg.securityRules ?? []), ...DEFAULT_RULES]) {
    const r = parseRule(raw, t);
    if (r === "bad") { reasons.add("ruleUnparsed"); continue; }
    if (r) rules.push(r);
  }
  rules.sort((a, b) => a.priority - b.priority);
  const out = new Map<Proto, Array<{ seg: [number, number]; cell: Cell }>>();
  for (const proto of ["tcp", "udp"] as const) {
    const mine = rules.filter((r) => r.protos.includes(proto));
    const cells: Array<{ seg: [number, number]; cell: Cell }> = [];
    for (const seg of segments(mine)) {
      const port = seg[0];
      const cell: Cell = { wide: false, scoped: new Set(), unknown: false };
      for (const r of mine) {
        if (!r.ports.some(([a, b]) => port >= a && port <= b)) continue;
        if (r.applies === false) continue;
        const wide = r.sources.some((s) => s.cls === "wide");
        const vnetWidened = !!t.vnetTagWidened && r.sources.some((s) => s.cls === "vnet");
        if (r.applies === "unknown") {
          // Cannot tell whether the rule targets this VM: an allow from the Internet makes the answer unknown
          if (r.allow && (wide || vnetWidened || r.sources.some((s) => s.cls === "scoped"))) { cell.unknown = true; reasons.add("asgUnknown"); }
          continue;
        }
        if (wide) { cell.wide = r.allow; break; } // first match for an arbitrary Internet address decides
        if (vnetWidened && r.allow) { cell.unknown = true; reasons.add("vnetTagWidened"); continue; }
        if (r.allow) for (const s of r.sources) if (s.cls === "scoped") cell.scoped.add(s.key);
      }
      cells.push({ seg, cell });
    }
    out.set(proto, cells);
  }
  return out;
}

function overlaps(a: string, b: string): boolean {
  const ra = cidrRange(a), rb = cidrRange(b);
  if (!ra || !rb) return true; // a tag on either side: its ranges are not known here — conservatively overlapping
  return ra[0] <= rb[1] && rb[0] <= ra[1];
}

/** Subnet NSG ∩ NIC NSG for one cell: both must let the source in */
function combine(x: Cell | undefined, y: Cell | undefined): Cell {
  if (!x && !y) return { wide: false, scoped: new Set(), unknown: false };
  if (!x) return y!;
  if (!y) return x;
  const scoped = new Set<string>();
  if (x.wide) for (const s of y.scoped) scoped.add(s);
  if (y.wide) for (const s of x.scoped) scoped.add(s);
  for (const a of x.scoped) for (const b of y.scoped) if (overlaps(a, b)) { scoped.add(a); scoped.add(b); }
  return { wide: x.wide && y.wide, scoped, unknown: x.unknown || y.unknown };
}

function cellAt(cells: Array<{ seg: [number, number]; cell: Cell }> | undefined, port: number): Cell | undefined {
  return cells?.find(({ seg }) => port >= seg[0] && port <= seg[1])?.cell;
}

function formatPorts(byProto: Map<Proto, Array<[number, number]>>): string[] {
  const merge = (iv: Array<[number, number]>) => {
    const out: Array<[number, number]> = [];
    for (const [a, b] of [...iv].sort((p, q) => p[0] - q[0])) {
      const last = out.at(-1);
      if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
      else out.push([a, b]);
    }
    return out;
  };
  const fmt = ([a, b]: [number, number]) => (a === 0 && b === 65535 ? "*" : a === b ? String(a) : `${a}-${b}`);
  const tcp = merge(byProto.get("tcp") ?? []).map(fmt);
  const udp = merge(byProto.get("udp") ?? []).map(fmt);
  return [...tcp, ...udp.filter((u) => !tcp.includes(u)).map((u) => `${u}/udp`)];
}

/**
 * The exposure verdict of one ip configuration. `subnetNsg` / `nicNsg`: the NSG document, `null` when none is
 * associated, `undefined` when one is associated but could not be read.
 */
export function internetInboundExposure(subnetNsg: NsgInput, nicNsg: NsgInput, target: ExposureTarget): InboundExposure {
  const reasons = new Set<string>();
  const nsgs: InboundExposure["nsgs"] = [];
  if (subnetNsg === undefined || nicNsg === undefined) reasons.add("nsgUnreadable");
  if (target.avnmPresent) reasons.add("avnm");
  const present: Array<[("subnet" | "nic"), NonNullable<NsgInput>]> = [];
  if (subnetNsg) present.push(["subnet", subnetNsg]);
  if (nicNsg) present.push(["nic", nicNsg]);
  for (const [k] of present) nsgs.push(k);

  const base = { nsgs, basis: "cfg" as const, rangeCount: 0 };
  if (!present.length && !reasons.has("nsgUnreadable")) {
    if (/^basic$/i.test(target.pipSku ?? "")) return { ...base, state: target.avnmPresent ? "unknown" : "open", ports: ["*"], sources: "any", reasons: [...reasons] };
    return { ...base, state: target.avnmPresent ? "unknown" : "noNsg", ports: [], sources: "none", reasons: [...reasons] };
  }

  const evals = present.map(([k, n]) => [k, evaluateNsg(n, target, reasons)] as const);
  const wide = new Map<Proto, Array<[number, number]>>();
  const scopedPorts = new Map<Proto, Array<[number, number]>>();
  const scopedSources = new Set<string>();
  let anyUnknown = false;
  for (const proto of ["tcp", "udp"] as const) {
    const cuts = new Set<number>([0, 65536]);
    for (const [, e] of evals) for (const { seg } of e.get(proto) ?? []) { cuts.add(seg[0]); cuts.add(seg[1] + 1); }
    const sorted = [...cuts].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length - 1; i++) {
      const seg: [number, number] = [sorted[i]!, sorted[i + 1]! - 1];
      const sub = evals.find(([k]) => k === "subnet")?.[1], nic = evals.find(([k]) => k === "nic")?.[1];
      const c = combine(sub ? cellAt(sub.get(proto), seg[0]) : undefined, nic ? cellAt(nic.get(proto), seg[0]) : undefined);
      if (c.unknown) anyUnknown = true;
      if (c.wide) (wide.get(proto) ?? wide.set(proto, []).get(proto)!).push(seg);
      else if (c.scoped.size) {
        (scopedPorts.get(proto) ?? scopedPorts.set(proto, []).get(proto)!).push(seg);
        for (const s of c.scoped) scopedSources.add(s);
      }
    }
  }
  const azureCloud = [...scopedSources].some((s) => /^azurecloud(\.|$)/i.test(s));
  const tagsOnly = scopedSources.size > 0 && [...scopedSources].every((s) => !cidrRange(s) && !/:/.test(s));
  const why = [...reasons];
  if (wide.size) {
    return { ...base, state: target.avnmPresent ? "unknown" : "open", ports: formatPorts(wide), sources: "any", reasons: why };
  }
  const unknown = anyUnknown || reasons.has("nsgUnreadable") || reasons.has("avnm") || reasons.has("ruleUnparsed");
  if (scopedSources.size) {
    return {
      ...base, state: unknown ? "unknown" : "scoped", ports: formatPorts(scopedPorts), sources: tagsOnly ? "tags" : "ranges",
      rangeCount: scopedSources.size, ...(azureCloud ? { azureCloud } : {}), reasons: why,
    };
  }
  return { ...base, state: unknown ? "unknown" : "closed", ports: [], sources: "none", reasons: why };
}

const RANK: Record<InboundExposure["state"], number> = { open: 4, scoped: 3, unknown: 2, noNsg: 1, closed: 0 };

/** The most exposed of several verdicts (a VM with several NICs / ip configurations) */
export function mostExposed(list: InboundExposure[]): InboundExposure | undefined {
  return [...list].sort((a, b) => RANK[b.state] - RANK[a.state])[0];
}

/** A route table's routes widen the VirtualNetwork tag when a prefix lies outside private address space */
export function routesWidenVnetTag(routes: unknown): boolean {
  if (!Array.isArray(routes)) return false;
  return routes.some((r) => {
    const p = (r as { properties?: { addressPrefix?: unknown }; addressPrefix?: unknown });
    const prefix = String(p.properties?.addressPrefix ?? p.addressPrefix ?? "");
    return !!cidrRange(prefix) && !isPrivatePrefix(prefix);
  });
}
