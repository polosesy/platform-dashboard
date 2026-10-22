import type {
  ArchitectureGraph,
  ArchitectureNode,
  ArchitectureEdge,
  GraphNodeKind,
  EdgeKind,
  InboundExposure,
  LivePeering,
} from "@aud/types";
import type {
  DiagramSpec,
  DiagramNodeSpec,
  DiagramEdgeSpec,
  DiagramEdgeKind,
  DiagramFlowType,
  DiagramGroupSpec,
  DiagramIconKind,
  DiagramLayoutKind,
  HealthRule,
  MetricAggregation,
  MetricBinding,
  SubResource,
  SubResourceKind,
} from "@aud/types";
import { inferImplicitEdges } from "./dependencyInference.js";
import { MAX_PROBED_GROUPS } from "./frontDoorConfig.js";
import { backendServerKeys } from "./backendMembers.js";
import { wafMetadata, type WafCoverage } from "./wafCoverage.js";
import { specJson, type SpecFact } from "./resourceSpec.js";
import ELK from "elkjs";
import { debug } from "../infra/logger.js";

// ── Kinds to exclude (infra-only, not useful for live monitoring) ──

const EXCLUDED_KINDS: Set<GraphNodeKind> = new Set([
  "subscription",
  "resourceGroup",
  "dns",
  "logAnalytics",
]);

// ── Network container kinds (rendered as group nodes) ──

const NETWORK_CONTAINER_KINDS = new Set<GraphNodeKind>(["vnet", "subnet"]);

// ── GraphNodeKind → DiagramIconKind ──

const KIND_TO_ICON: Record<GraphNodeKind, DiagramIconKind> = {
  subscription: "subscription",
  resourceGroup: "resourceGroup",
  vnet: "vnet",
  subnet: "subnet",
  nsg: "nsg",
  nic: "nic",
  vm: "vm",
  vmss: "vmss",
  lb: "lb",
  appGateway: "appGateway",
  frontDoor: "frontDoor",
  trafficManager: "trafficManager",
  aks: "aks",
  containerApp: "containerApp",
  privateEndpoint: "privateEndpoint",
  publicIP: "publicIP",
  natGateway: "natGateway",
  storage: "storage",
  sql: "sql",
  cosmosDb: "cosmosDb",
  redis: "redis",
  postgres: "postgres",
  keyVault: "keyVault",
  appInsights: "appInsights",
  logAnalytics: "logAnalytics",
  firewall: "firewall",
  functionApp: "functionApp",
  appService: "appService",
  serviceBus: "serviceBus",
  eventHub: "eventHub",
  dns: "dns",
  agc: "agc",
  vnetGateway: "vnetGateway",
  bastion: "bastion",
  paas: "paas",
  unknown: "custom",
};

// ── Default Azure Monitor metric bindings per resource type ──
//
// Two card metrics per kind (apps/web/src/lib/liveMetricFormat.ts CARD_CELLS: cell 1 = load / activity with the
// trend, cell 2 = quality), the rest for the detail panel. Rules are pass conditions with a level (warning /
// critical); a failing one sets at least that status. `when` keeps a few requests from turning a card red.
// Bindings belong to the server: saved diagrams get the current table through `effectiveBindings`.

const mon = (metric: string, aggregation: MetricAggregation, extra: Partial<MetricBinding> = {}): MetricBinding =>
  ({ source: "monitor", metric, aggregation, ...extra });
const derived = (op: "share" | "ratio" | "sum", a: string, b: string, minDenominator?: number): MetricBinding =>
  ({ source: "derived", derive: { op, of: [a, b], ...(minDenominator != null ? { minDenominator } : {}) } });
const rule = (metric: string, op: HealthRule["op"], threshold: number, level: "warning" | "critical", when?: HealthRule["when"]): HealthRule =>
  ({ metric, op, threshold, weight: 1, level, ...(when ? { when } : {}) });
const health = (...rules: HealthRule[]): MetricBinding => ({ source: "composite", rules });
/** "below w is fine, critical from c": cpu < 85 warn, < 95 crit */
const under = (metric: string, w: number, c: number, when?: HealthRule["when"]) => [rule(metric, "<", w, "warning", when), rule(metric, "<", c, "critical", when)];
/** "at least w is fine, critical below c": availability ≥ 99 warn, ≥ 90 crit */
const atLeast = (metric: string, w: number, c: number, when?: HealthRule["when"]) => [rule(metric, ">=", w, "warning", when), rule(metric, ">=", c, "critical", when)];
const ENOUGH_REQUESTS = (metric: string) => ({ metric, atLeast: 20 });

/** Memory used % for VMs / scale sets: 100 − "Available Memory Percentage" (platform metric, no agent needed) */
const MEMORY_FROM_AVAILABLE: MetricBinding = mon("Available Memory Percentage", "avg", { transform: "complement", optional: true });
const PRIVATE_V4 = /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/;
/** A quote inside an Azure Monitor $filter value is doubled */
const monEsc = (v: string) => v.replace(/'/g, "''");
const parseJsonList = (v: string | undefined): string[] => {
  if (!v) return [];
  try { const x = JSON.parse(v); return Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : []; } catch { return []; }
};
/** Bytes per minute → bit/s (the unit of edge throughput from flow logs) */
const PER_MIN_TO_BPS = 8 / 60;

export const NODE_BINDINGS: Record<string, Record<string, MetricBinding>> = {
  vm: {
    cpu: mon("Percentage CPU", "avg"),
    memory: MEMORY_FROM_AVAILABLE,
    network: mon("Network In Total", "total"),
    vmAvail: mon("VmAvailabilityMetric", "avg", { scale: 100, optional: true }),
    health: health(...under("cpu", 85, 95), ...under("memory", 85, 95), rule("vmAvail", ">=", 50, "critical")),
  },
  vmss: {
    cpu: mon("Percentage CPU", "avg"),
    memory: MEMORY_FROM_AVAILABLE,
    vmAvail: mon("VmAvailabilityMetric", "avg", { scale: 100, optional: true }),
    health: health(...under("cpu", 85, 95), ...under("memory", 85, 95), ...atLeast("vmAvail", 100, 1)),
  },
  aks: {
    cpu: mon("node_cpu_usage_percentage", "avg"),
    memory: mon("node_memory_working_set_percentage", "avg"),
    health: health(...under("cpu", 80, 95), ...under("memory", 85, 95)),
  },
  lb: {
    dataPath: mon("VipAvailability", "avg"),
    backend: mon("DipAvailability", "avg"),
    bytesIn: mon("ByteCount", "total", { filter: "Direction eq 'In'", optional: true }),
    snatFail: mon("SnatConnectionCount", "total", { filter: "ConnectionState eq 'Failed'", optional: true }),
    health: health(...atLeast("dataPath", 99, 90), ...atLeast("backend", 99, 1), rule("snatFail", "<", 1, "warning")),
  },
  appGateway: {
    requests: mon("TotalRequests", "total"),
    healthyHosts: mon("HealthyHostCount", "avg"),
    // Worst minute of the last 5 (Maximum over one PT5M bucket): the usual alert rule "UnhealthyHostCount > 0 over 5 min"
    // fires on a single unhealthy minute — the newest 1-minute average alone hid it a minute later
    unhealthyHosts: mon("UnhealthyHostCount", "max", { window: "PT5M" }),
    backend: derived("share", "healthyHosts", "unhealthyHosts"),
    failedReq: mon("FailedRequests", "total"),
    errorRate: derived("ratio", "failedReq", "requests"),
    latency: mon("BackendLastByteResponseTime", "avg", { optional: true }),
    health: health(...atLeast("backend", 100, 1), ...under("errorRate", 5, 25, ENOUGH_REQUESTS("requests"))),
  },
  // Front Door classic (microsoft.network/frontdoors) — Standard/Premium is frontDoorAfd (effectiveBindings)
  frontDoor: {
    requests: mon("RequestCount", "total"),
    backend: mon("BackendHealthPercentage", "avg"),
    latency: mon("TotalLatency", "avg", { optional: true }),
    health: health(...atLeast("backend", 90, 1)),
  },
  // Front Door Standard/Premium (microsoft.cdn/profiles): requests and the 5xx share users got decide the state;
  // origin probe health is read per routed origin group (probe<i>, afdProbeBindings) and can warn, never go red —
  // probes fail where users do not (a non-200 answer to the probe path; with every origin failing Front Door sends
  // traffic anyway). No profile-wide OriginHealthPercentage: it mixes every probed group, routed or not
  // (frontdoor/monitor-front-door-reference · frontdoor/health-probes)
  frontDoorAfd: {
    requests: mon("RequestCount", "total"),
    errorRate: mon("Percentage5XX", "avg", { optional: true }),
    latency: mon("TotalLatency", "avg", { optional: true }),
    // WAF verdicts over an hour, the whole profile (EDGE-10) — panel only, never a health input: a spike is an attack
    // or false positives, there is no baseline
    wafBlock: mon("WebApplicationFirewallRequestCount", "total", { filter: "Action eq 'Block'", window: "PT1H", optional: true }),
    wafLog: mon("WebApplicationFirewallRequestCount", "total", { filter: "Action eq 'Log'", window: "PT1H", optional: true }),
    wafTotal: mon("WebApplicationFirewallRequestCount", "total", { window: "PT1H", optional: true }),
    health: health(
      ...under("errorRate", 5, 25, ENOUGH_REQUESTS("requests")),
      ...Array.from({ length: MAX_PROBED_GROUPS }, (_, i) => rule(`probe${i}`, ">=", 90, "warning")),
    ),
  },
  // VPN gateway: S2S bandwidth (AverageBandwidth is bytes/s → bit/s); state comes from Resource Health
  vnetGateway: {
    // gateway metrics accept no 1-minute grain (400 "Commonly allowed time grains") — a 15-minute average
    bandwidth: mon("AverageBandwidth", "avg", { scale: 8, optional: true, window: "PT15M" }),
    health: health(),
  },
  // On-premises site = one S2S connection (EDGE-09): its tunnel traffic (bit/s); traffic is not health
  onPremSite: {
    bitsIn: mon("BitsInPerSecond", "avg", { optional: true }),
    bitsOut: mon("BitsOutPerSecond", "avg", { optional: true }),
    health: health(),
  },
  // Application Gateway for Containers: metrics are emitted only while requests flow
  // (application-gateway/for-containers/application-gateway-for-containers-metrics)
  agc: {
    requests: mon("TotalRequests", "total"),
    beTimeouts: mon("BackendConnectionTimeouts", "total", { optional: true }),
    timeoutRate: derived("ratio", "beTimeouts", "requests"),
    healthyTargets: mon("BackendHealthyTargets", "avg", { optional: true }),
    health: health(...under("timeoutRate", 1, 5, ENOUGH_REQUESTS("requests")), rule("healthyTargets", ">=", 1, "critical", ENOUGH_REQUESTS("requests"))),
  },
  trafficManager: {
    queries: mon("QpsByEndpoint", "total"),
    health: health(),
  },
  firewall: {
    fwHealth: mon("FirewallHealth", "avg"),
    snat: mon("SNATPortUtilization", "max", { optional: true }),
    throughput: mon("Throughput", "avg", { optional: true }),
    health: health(...atLeast("fwHealth", 100, 50), ...under("snat", 80, 95)),
  },
  natGateway: {
    // Averaged over 15 minutes: Azure alerts below 90 % over 15 min — shorter grains give false positives (nat-metrics)
    dataPath: mon("DatapathAvailability", "avg", { window: "PT15M" }),
    snatFail: mon("SNATConnectionCount", "total", { filter: "ConnectionState eq 'Failed'", optional: true }),
    health: health(...atLeast("dataPath", 99, 90), rule("snatFail", "<", 1, "warning")),
  },
  publicIP: {
    bytesIn: mon("ByteCount", "total", { filter: "Direction eq 'In'", optional: true }),
    bytesOut: mon("ByteCount", "total", { filter: "Direction eq 'Out'", optional: true }),
    ddos: mon("IfUnderDDoSAttack", "max", { optional: true }),
    health: health(rule("ddos", "<", 1, "critical")),
  },
  // One-hour totals as bytes/minute: a PE idle for the last minute is not "no data" (healthEvidence.ts reads both ways)
  privateEndpoint: {
    bytesIn: mon("PEBytesIn", "total", { window: "PT1H", scale: 1 / 60 }),
    bytesOut: mon("PEBytesOut", "total", { window: "PT1H", scale: 1 / 60 }),
    health: health(),
  },
  // Public and private DNS zones: query volume has a one-hour grain (dnszones metrics reference)
  dns: {
    queries: mon("QueryVolume", "total", { window: "PT1H", scale: 1 / 60, optional: true }),
    health: health(),
  },
  nic: {
    health: health(),
  },
  storage: {
    transactions: mon("Transactions", "total"),
    availability: mon("Availability", "avg"),
    latency: mon("SuccessE2ELatency", "avg", { optional: true }),
    health: health(...atLeast("availability", 99, 90, ENOUGH_REQUESTS("transactions"))),
  },
  keyVault: {
    requests: mon("ServiceApiHit", "count"),
    availability: mon("Availability", "avg"),
    saturation: mon("SaturationShoebox", "avg", { optional: true }),
    latency: mon("ServiceApiLatency", "avg", { optional: true }),
    health: health(...atLeast("availability", 99, 90, ENOUGH_REQUESTS("requests")), rule("saturation", "<", 75, "warning")),
  },
  redis: {
    load: mon("serverLoad", "max"),
    memory: mon("usedmemorypercentage", "max"),
    health: health(...under("load", 80, 95), ...under("memory", 80, 95)),
  },
  postgres: {
    cpu: mon("cpu_percent", "avg"),
    memory: mon("memory_percent", "avg", { optional: true }),
    storage: mon("storage_percent", "avg", { optional: true }),
    dbAlive: mon("is_db_alive", "avg", { optional: true }),
    health: health(...under("cpu", 80, 95), ...under("memory", 85, 95), ...under("storage", 85, 95), rule("dbAlive", ">=", 1, "critical")),
  },
  sql: {
    // vCore databases have no DTU and DTU databases may lack the instance metrics — each is optional
    cpu: mon("cpu_percent", "avg", { optional: true }),
    memory: mon("sql_instance_memory_percent", "avg", { optional: true }),
    dtu: mon("dtu_consumption_percent", "avg", { optional: true }),
    storage: mon("storage_percent", "avg", { optional: true }),
    health: health(rule("cpu", "<", 90, "warning"), rule("dtu", "<", 90, "warning"), ...under("storage", 90, 95)),
  },
  cosmosDb: {
    requests: mon("TotalRequests", "count"),
    ru: mon("NormalizedRUConsumption", "max"),
    throttled: mon("TotalRequests", "count", { filter: "StatusCode eq '429'", optional: true }),
    health: health(rule("throttled", "<", 1, "warning")),
  },
  appService: {
    requests: mon("Requests", "total"),
    http5xx: mon("Http5xx", "total"),
    errorRate: derived("ratio", "http5xx", "requests"),
    latency: mon("HttpResponseTime", "avg", { scale: 1000, optional: true }),
    health: health(...under("errorRate", 5, 25, ENOUGH_REQUESTS("requests"))),
  },
  functionApp: {
    requests: mon("Requests", "total"),
    http5xx: mon("Http5xx", "total"),
    errorRate: derived("ratio", "http5xx", "requests"),
    executions: mon("FunctionExecutionCount", "total", { optional: true }),
    health: health(...under("errorRate", 5, 25, ENOUGH_REQUESTS("requests"))),
  },
  containerApp: {
    requests: mon("Requests", "total"),
    req5xx: mon("Requests", "total", { filter: "statusCodeCategory eq '5xx'", optional: true }),
    errorRate: derived("ratio", "req5xx", "requests"),
    replicas: mon("Replicas", "max"),
    health: health(...under("errorRate", 5, 25, ENOUGH_REQUESTS("requests"))),
  },
  serviceBus: {
    backlog: mon("ActiveMessages", "max"),
    serverErrors: mon("ServerErrors", "total"),
    throttled: mon("ThrottledRequests", "total", { optional: true }),
    health: health(rule("serverErrors", "<", 1, "warning"), rule("throttled", "<", 1, "warning")),
  },
  eventHub: {
    inMsgs: mon("IncomingMessages", "total"),
    serverErrors: mon("ServerErrors", "total"),
    throttled: mon("ThrottledRequests", "total", { optional: true }),
    health: health(rule("serverErrors", "<", 1, "warning"), rule("throttled", "<", 1, "warning")),
  },
  appInsights: {
    // A telemetry store: its numbers describe the app it watches, so they never set this card's status
    requests: mon("requests/count", "count"),
    reqFailed: mon("requests/failed", "count"),
    errorRate: derived("ratio", "reqFailed", "requests"),
    health: health(),
  },
};

/** No monitor binding: nothing is measured, so the card shows no metric row (never "미측정") */
const NOT_MEASURED: Record<string, MetricBinding> = { health: { source: "composite", rules: [] } };

/**
 * The bindings the server reads for a node. Known kinds always get the current table (a diagram saved in the
 * browser keeps whatever it was generated with, and changed thresholds or metric names must still reach it);
 * an unused public IP and a SQL logical server (not a database) get none; unknown kinds keep the spec's.
 */
export function effectiveBindings(n: Pick<DiagramNodeSpec, "resourceKind" | "icon" | "bindings" | "azureResourceId" | "metadata">): Record<string, MetricBinding> {
  const kind = n.resourceKind ?? n.icon;
  if (kind === "publicIP" && n.metadata?.unused === "true") return NOT_MEASURED;
  if (kind === "sql" && n.azureResourceId && !/\/databases\//i.test(n.azureResourceId)) return NOT_MEASURED;
  if (kind === "frontDoor" && /\/providers\/microsoft\.cdn\/profiles\//i.test(n.azureResourceId ?? "")) return { ...NODE_BINDINGS.frontDoorAfd!, ...afdProbeBindings(n.metadata?.originGroups) };
  if (kind === "lb") return { ...NODE_BINDINGS.lb!, ...privateFrontendBindings(n.metadata?.frontends) };
  return NODE_BINDINGS[kind] ?? n.bindings ?? NOT_MEASURED;
}

/**
 * Probe health of the origin groups an active route uses with probes on (`probe<i>` = metadata originGroups'
 * probeIndex): OriginHealthPercentage filtered by the OriginGroup dimension, averaged over five minutes (one bucket —
 * a probe every 30–100 s per POP). Groups with probes off have no samples and are not read.
 */
export function afdProbeBindings(groupsJson: string | undefined): Record<string, MetricBinding> {
  let groups: Array<{ name?: string; probeIndex?: number }> = [];
  try { groups = JSON.parse(groupsJson ?? "[]") as typeof groups; } catch { return {}; }
  const out: Record<string, MetricBinding> = {};
  for (const g of groups) {
    if (g.probeIndex == null || !g.name || g.probeIndex >= MAX_PROBED_GROUPS) continue;
    out[`probe${g.probeIndex}`] = mon("OriginHealthPercentage", "avg", { filter: `OriginGroup eq '${g.name.replace(/'/g, "''")}'`, window: "PT5M", optional: true });
  }
  return out;
}

/** Private frontends read per LB (more are summed by nobody — the panel lists them one by one) */
export const MAX_PRIVATE_FRONTENDS = 3;

/**
 * An internal LB's inbound side, per private frontend (catalog LB-05): bytes and SYN packets received in the last
 * hour (`ByteCount` / `SYNCount`, dimensions FrontendIPAddress + Direction — load-balancer metrics reference).
 * One window = one bucket, so 0 (measured, nothing came) and null (not measured) stay apart. Never a status input,
 * and never per caller (flow logs say who). Not counted by Azure: traffic that reaches the LB through a UDR (NVA /
 * firewall) — the panel says so. Keys `feIn<i>` / `feSyn<i>` follow the order of the metadata frontends.
 */
export function privateFrontendBindings(frontendsJson: string | undefined): Record<string, MetricBinding> {
  let fes: Array<{ kind?: string; ip?: string }> = [];
  try { fes = JSON.parse(frontendsJson ?? "[]") as typeof fes; } catch { return {}; }
  const ips = [...new Set(fes.filter((f) => f.kind === "private" && f.ip && PRIVATE_V4.test(f.ip)).map((f) => f.ip!))].slice(0, MAX_PRIVATE_FRONTENDS);
  const out: Record<string, MetricBinding> = {};
  ips.forEach((ip, i) => {
    const filter = `FrontendIPAddress eq '${monEsc(ip)}' and Direction eq 'In'`;
    out[`feIn${i}`] = mon("ByteCount", "total", { filter, window: "PT1H", optional: true });
    out[`feSyn${i}`] = mon("SYNCount", "total", { filter, window: "PT1H", optional: true });
  });
  return out;
}

/**
 * Measured traffic on a line, read from one end's Azure resource (Monitor totals per minute → bit/s):
 * - Internet → public LB: the LB's received bytes (ByteCount, Direction In) — may include outbound SNAT replies
 * - Internet → App Gateway with a public frontend: BytesReceived
 * - Private Endpoint → PaaS: PEBytesIn + PEBytesOut on the PE
 * - Internet → App Gateway: BytesReceived of the listeners on the PUBLIC frontend only (private listeners take
 *   traffic from inside the network) — `Listener eq '…'`
 * - App Gateway → backend member: response count and connect time by BackendServer ("ip:port") — quality only,
 *   Azure Monitor has no per-backend bytes, so no particles
 * - LB → backend member: health-probe availability by BackendIPAddress
 */
export function edgeBindings(
  e: Pick<DiagramEdgeSpec, "edgeKind" | "flowType" | "source" | "target" | "backend" | "exposure">,
  byId: ReadonlyMap<string, Pick<DiagramNodeSpec, "resourceKind" | "icon" | "subResources" | "metadata" | "parentId">>,
  /** Load balancers that are also an outbound (SNAT) path — their In bytes may include SNAT replies */
  snatLbs: ReadonlySet<string> = new Set(),
  /** Nodes a Front Door origin line ends at (EDGE-04..07) — a public listener there may also receive Front Door's requests */
  afdOrigins: ReadonlySet<string> = new Set(),
): { bindings: Record<string, MetricBinding>; caveats?: string[] } {
  const out = edgeBindingsOf(e, byId, snatLbs);
  const kind = (n?: { resourceKind?: string; icon: string }) => n?.resourceKind ?? n?.icon;
  const tk = kind(byId.get(e.target));
  // Internet → a gateway that is also a Front Door origin: whether it accepts only Front Door (AzureFrontDoor.Backend
  // service tag, X-Azure-FDID check) is not read — the line stays (a rule-bound public listener is configuration),
  // the panel says the bytes cannot be told apart
  if (kind(byId.get(e.source)) === "internet" && e.flowType === "ingress" && (tk === "appGateway" || tk === "lb") && afdOrigins.has(e.target)) {
    return { ...out, caveats: [...(out.caveats ?? []), "ld.edge.caveat.viaFrontDoor"] };
  }
  return out;
}

function edgeBindingsOf(
  e: Pick<DiagramEdgeSpec, "edgeKind" | "flowType" | "source" | "target" | "backend" | "exposure">,
  byId: ReadonlyMap<string, Pick<DiagramNodeSpec, "resourceKind" | "icon" | "subResources" | "metadata" | "parentId">>,
  snatLbs: ReadonlySet<string>,
): { bindings: Record<string, MetricBinding>; caveats?: string[] } {
  const src = byId.get(e.source), tgt = byId.get(e.target);
  const kindOf = (n?: { resourceKind?: string; icon: string }) => n?.resourceKind ?? n?.icon;
  if (kindOf(src) === "internet" && e.flowType === "ingress" && tgt) {
    if (kindOf(tgt) === "vm" && e.exposure) return publicIpBindings(e, tgt, byId);
    // AGC-03 / Front Door: requests (no byte metric → no particles)
    if (kindOf(tgt) === "agc") return { bindings: { rps: mon("TotalRequests", "total", { scale: 1 / 60, node: "target" }) } };
    if (kindOf(tgt) === "frontDoor") return { bindings: { rps: mon("RequestCount", "total", { scale: 1 / 60, node: "target" }) } };
    if (kindOf(tgt) === "lb") {
      return {
        // LB-05: frontend received bytes
        bindings: { throughput: mon("ByteCount", "total", { filter: "Direction eq 'In'", scale: PER_MIN_TO_BPS, node: "target" }) },
        ...(snatLbs.has(e.target) ? { caveats: ["ld.edge.caveat.snat"] } : {}),
      };
    }
    if (kindOf(tgt) === "appGateway") {
      const listeners = parseJsonList(tgt.metadata?.publicListeners);
      if (listeners.length) {
        return {
          bindings: {
            throughput: mon("BytesReceived", "total", { filter: listeners.map((l) => `Listener eq '${monEsc(l)}'`).join(" or "), scale: PER_MIN_TO_BPS, node: "target" }),
            // All listeners: when the public ones report nothing, this tells "the traffic comes in privately"
            // from "nothing is measured"
            gatewayTotal: mon("BytesReceived", "total", { scale: PER_MIN_TO_BPS, node: "target" }),
          },
          caveats: ["ld.edge.caveat.publicFrontend"],
        };
      }
      const hasPrivate = tgt.subResources?.some((s) => s.kind === "frontendIP" && !!s.endpoint && PRIVATE_V4.test(s.endpoint));
      return {
        bindings: { throughput: mon("BytesReceived", "total", { scale: PER_MIN_TO_BPS, node: "target" }) },
        ...(hasPrivate ? { caveats: ["ld.edge.caveat.publicPrivateSum"] } : {}),
      };
    }
  }
  // VPN gateway → on-premises site (EDGE-09): the connection's own bit rate, read on the site (= the connection)
  if (e.edgeKind === "hybrid") {
    return {
      bindings: {
        bitsIn: mon("BitsInPerSecond", "avg", { node: "target", optional: true }),
        bitsOut: mon("BitsOutPerSecond", "avg", { node: "target", optional: true }),
        throughput: derived("sum", "bitsIn", "bitsOut"),
      },
    };
  }
  // Backend member quality (AGW-06, LB-02): only with a known member address
  const addr = e.backend?.address;
  if (e.edgeKind === "routes" && addr && e.backend?.via !== "vmssModel") {
    if (kindOf(src) === "appGateway") {
      const filter = backendServerKeys(addr, e.backend?.ports ?? []).map((k) => `BackendServer eq '${monEsc(k)}'`).join(" or ");
      return {
        bindings: {
          backendRequests: mon("BackendResponseStatus", "total", { filter, optional: true }),
          backendConnectMs: mon("BackendConnectTime", "avg", { filter, optional: true }),
        },
      };
    }
    if (kindOf(src) === "lb") {
      return { bindings: { probe: mon("DipAvailability", "avg", { filter: `BackendIPAddress eq '${monEsc(addr)}'`, optional: true }) } };
    }
  }
  if (e.edgeKind === "privateLink" && kindOf(src) === "privateEndpoint") {
    return {
      bindings: {
        peIn: mon("PEBytesIn", "total", { scale: PER_MIN_TO_BPS }),
        peOut: mon("PEBytesOut", "total", { scale: PER_MIN_TO_BPS }),
        throughput: derived("sum", "peIn", "peOut"),
      },
    };
  }
  return { bindings: {} };
}

/**
 * Internet → VM through its instance-level public IP (PIP-04), read on the public IP resource(s) of the VM card
 * (`on: "publicIp"`; liveAggregator.measuredResourceIds takes the ids from the card's sub-resources and accepts
 * public IP ids only). SynCount / ByteCount by Direction — the Port dimension is a single "0" on these addresses.
 * Particles (throughput) only when the subnet leaves through a NAT gateway: then the VM's own outbound traffic and
 * its replies use the NAT gateway, and what arrives on the public IP is traffic that started outside
 * (nat-gateway/nat-gateway-design). Otherwise received bytes include replies to connections the VM opened —
 * shown as a value, no particles. SYN count is never a status input.
 */
function publicIpBindings(
  e: Pick<DiagramEdgeSpec, "exposure">,
  vm: Pick<DiagramNodeSpec, "subResources" | "parentId">,
  byId: ReadonlyMap<string, Pick<DiagramNodeSpec, "metadata">>,
): { bindings: Record<string, MetricBinding>; caveats?: string[] } {
  const pips = (vm.subResources ?? []).filter((s) => s.kind === "publicIP" && s.azureResourceId);
  if (!pips.length) return { bindings: {} }; // nothing to read — the line stays "not measured", never 0
  const at = { node: "target" as const, on: "publicIp" as const, filter: "Direction eq 'In'", optional: true };
  const subnet = vm.parentId ? byId.get(vm.parentId) : undefined;
  const viaNat = subnet?.metadata?.egressVia === "nat" && !e.exposure?.reasons.includes("vnetTagWidened");
  const bindings: Record<string, MetricBinding> = {
    synIn: mon("SynCount", "total", at),
    bytesIn: mon("ByteCount", "total", { ...at, scale: PER_MIN_TO_BPS }),
  };
  if (viaNat) bindings.throughput = mon("ByteCount", "total", { ...at, scale: PER_MIN_TO_BPS });
  const caveats = ["ld.edge.caveat.pipNoPort", "ld.edge.caveat.synAck", "ld.edge.caveat.nsgStage"];
  if (!viaNat) caveats.push("ld.edge.caveat.pipReplies");
  if (pips.length > 1) caveats.push("ld.edge.caveat.multiPip");
  return { bindings, caveats };
}

/**
 * The spec as the server measures it: current bindings on every node and line. Applied when a diagram is read,
 * so a diagram generated before a binding changed is measured (and judged) like a new one.
 */
export function normalizeSpecBindings(spec: DiagramSpec): DiagramSpec {
  const byId = new Map(spec.nodes.map((n) => [n.id, n]));
  const snatLbs = new Set(spec.edges.filter((e) => e.edgeKind === "outbound-internet" && e.label === "LB SNAT").map((e) => e.source));
  const afdOrigins = new Set(spec.edges.filter((e) => e.origin && (byId.get(e.source)?.resourceKind ?? byId.get(e.source)?.icon) === "frontDoor").map((e) => e.target));
  return {
    ...spec,
    nodes: spec.nodes.map((n) => (n.nodeType === "group" ? n : { ...n, bindings: effectiveBindings(n) })),
    edges: spec.edges.map((e) => {
      const { bindings, caveats } = edgeBindings(e, byId, snatLbs, afdOrigins);
      const next: DiagramEdgeSpec = { ...e, bindings };
      if (caveats) next.caveats = caveats;
      else delete next.caveats;
      return next;
    }),
  };
}

// ── Dependency inference sets ──

const COMPUTE_KINDS = new Set<string>([
  "aks", "vm", "vmss", "containerApp", "functionApp", "appService",
]);

const DATA_KINDS = new Set<string>([
  "sql", "storage", "redis", "cosmosDb", "postgres", "keyVault", "serviceBus", "eventHub", "paas",
]);

const INGRESS_KINDS = new Set<string>([
  "appGateway", "lb", "frontDoor", "trafficManager", "firewall", "agc",
]);

function inferProtocol(dataKind: string): string {
  switch (dataKind) {
    case "sql": case "postgres": return "TCP/1433";
    case "redis": return "TCP/6380";
    case "cosmosDb": return "HTTPS/443";
    case "storage": return "HTTPS/443";
    case "keyVault": return "HTTPS/443";
    case "serviceBus": case "eventHub": return "AMQP/5671";
    default: return "TCP";
  }
}

function buildEdgeLabel(srcNode: ArchitectureNode | undefined, tgtNode: ArchitectureNode | undefined): string | undefined {
  if (!srcNode?.endpoint && !tgtNode?.endpoint) return undefined;
  const parts: string[] = [];
  if (srcNode?.endpoint) parts.push(truncateEndpoint(srcNode.endpoint));
  if (tgtNode?.endpoint) parts.push(truncateEndpoint(tgtNode.endpoint));
  return parts.join(" → ");
}

function truncateEndpoint(ep: string): string {
  if (/^\d+\.\d+/.test(ep)) return ep;
  const first = ep.split(".")[0];
  return first && first.length < ep.length ? first : ep.slice(0, 24);
}

// ── Layout constants ──

const NODE_W = 220;
const NODE_H = 100;
const NODE_GAP = 20;
const SUBNET_INNER_PAD = 44;
const SUBNET_HEADER = 44;
const VNET_PAD = 30;
const VNET_HEADER = 48;
const SUBNET_GAP = 24;
const EXTERNAL_GAP = 40;

// ── Subnet tier classification ──

function subnetTier(childKinds: Set<string>): number {
  for (const k of childKinds) {
    if (INGRESS_KINDS.has(k)) return 0;
  }
  for (const k of childKinds) {
    if (COMPUTE_KINDS.has(k)) return 1;
  }
  return 2;
}

// ── Architecture pattern detection ──
// Enriches nodes with archRole / archGroupId / flowHint metadata
// without changing parentId or containment hierarchy.

/** aksNodeId: the AKS cluster graph node an aks-cluster / aks-vmss belongs to (by graph edge, never by name) */
type ArchMeta = { archRole: string; archGroupId: string; flowHint: string; aksNodeId?: string };

const ARCH_ROLE_MAP: Record<string, { role: string; hint: string }> = {
  appGateway:      { role: "gateway",          hint: "ingress" },
  frontDoor:       { role: "gateway",          hint: "ingress" },
  trafficManager:  { role: "gateway",          hint: "ingress" },
  lb:              { role: "load-balancer",     hint: "ingress" },
  firewall:        { role: "firewall",          hint: "egress" },
  natGateway:      { role: "nat-gateway",        hint: "egress" },
  agc:             { role: "gateway",            hint: "ingress" },
  vnetGateway:     { role: "gateway",            hint: "egress" },
  bastion:         { role: "bastion",            hint: "control" },
  paas:            { role: "storage",            hint: "dependency" },
  waf:             { role: "waf",               hint: "ingress" },
  vm:              { role: "vm",                hint: "east-west" },
  vmss:            { role: "vmss",              hint: "east-west" },
  aks:             { role: "aks-cluster",        hint: "control" },
  containerApp:    { role: "compute",            hint: "east-west" },
  appService:      { role: "app-service",        hint: "east-west" },
  functionApp:     { role: "function",           hint: "east-west" },
  sql:             { role: "db",                 hint: "dependency" },
  postgres:        { role: "db",                 hint: "dependency" },
  cosmosDb:        { role: "db",                 hint: "dependency" },
  redis:           { role: "cache",              hint: "dependency" },
  storage:         { role: "storage",            hint: "dependency" },
  keyVault:        { role: "storage",            hint: "dependency" },
  privateEndpoint: { role: "private-endpoint",   hint: "dependency" },
  serviceBus:      { role: "messaging",          hint: "east-west" },
  eventHub:        { role: "messaging",          hint: "east-west" },
};

function detectArchitecturePatterns(
  graph: ArchitectureGraph,
  filteredNodes: ArchitectureNode[],
  containment: { subnetParent: Map<string, string>; resourceSubnet: Map<string, string> },
): Map<string, ArchMeta> {
  const result = new Map<string, ArchMeta>();

  // Step 1: AKS cluster pattern — find AKS→VMSS edges
  const aksNodes = filteredNodes.filter((n) => n.kind === "aks");
  const aksVmssIds = new Set<string>(); // VMSS IDs belonging to an AKS cluster

  for (const aks of aksNodes) {
    const clusterName = aks.name.toLowerCase().replace(/[^a-z0-9-]/g, "");
    const groupId = `aks-${clusterName}`;

    // Mark AKS cluster itself
    result.set(aks.id, { archRole: "aks-cluster", archGroupId: groupId, flowHint: "control", aksNodeId: aks.id });

    // Find connected VMSS (agent pool node pools)
    for (const edge of graph.edges) {
      if (edge.kind !== "connects" && edge.kind !== "network") continue;
      const isFromAks = edge.source === aks.id;
      const isToAks = edge.target === aks.id;
      if (!isFromAks && !isToAks) continue;

      const otherId = isFromAks ? edge.target : edge.source;
      const otherNode = filteredNodes.find((n) => n.id === otherId);
      if (!otherNode) continue;

      if (otherNode.kind === "vmss") {
        aksVmssIds.add(otherId);
        result.set(otherId, { archRole: "aks-vmss", archGroupId: groupId, flowHint: "east-west", aksNodeId: aks.id });
      }
    }

    // Find ingress/egress in the same subnet(s) as AKS resources
    const aksSubnets = new Set<string>();
    const aksResourceIds = new Set([aks.id, ...aksVmssIds]);
    for (const rid of aksResourceIds) {
      const sub = containment.resourceSubnet.get(rid);
      if (sub) aksSubnets.add(sub);
    }

    for (const node of filteredNodes) {
      if (aksResourceIds.has(node.id) || result.has(node.id)) continue;
      const nodeSub = containment.resourceSubnet.get(node.id);
      if (!nodeSub) continue;

      // Check same VNet (via subnet parent) rather than same subnet only
      const nodeVnet = containment.subnetParent.get(nodeSub);
      let sameVnet = false;
      for (const asSub of aksSubnets) {
        if (containment.subnetParent.get(asSub) === nodeVnet) { sameVnet = true; break; }
      }
      if (!sameVnet) continue;

      if (node.kind === "appGateway" || node.kind === "lb") {
        result.set(node.id, { archRole: "aks-ingress", archGroupId: groupId, flowHint: "ingress" });
      } else if (node.kind === "firewall") {
        result.set(node.id, { archRole: "aks-egress", archGroupId: groupId, flowHint: "egress" });
      }
    }
  }

  // Step 2: Generic role assignment for unmatched nodes
  for (const node of filteredNodes) {
    if (result.has(node.id)) continue;
    if (node.kind === "vnet" || node.kind === "subnet" || node.kind === "nsg" || node.kind === "nic") continue;

    const mapping = ARCH_ROLE_MAP[node.kind];
    const role = mapping?.role ?? "generic";
    const hint = mapping?.hint ?? "east-west";

    // Step 3: archGroupId = "{resourceGroup}-{tier}"
    const tier = INGRESS_KINDS.has(node.kind) ? "ingress"
      : COMPUTE_KINDS.has(node.kind) ? "compute"
      : DATA_KINDS.has(node.kind) || node.kind === "privateEndpoint" ? "data"
      : "other";
    const rg = (node.resourceGroup ?? "default").toLowerCase().replace(/[^a-z0-9-]/g, "");
    const groupId = `${rg}-${tier}`;

    result.set(node.id, { archRole: role, archGroupId: groupId, flowHint: hint });
  }

  return result;
}

// ── Edge flow type resolution ──

function resolveFlowType(
  srcMeta: ArchMeta | undefined,
  tgtMeta: ArchMeta | undefined,
  edgeKind: DiagramEdgeKind | undefined,
): DiagramFlowType | undefined {
  // Priority 1: edge kind takes precedence
  if (edgeKind === "routes" && (srcMeta?.archRole === "gateway" || srcMeta?.archRole === "load-balancer" || srcMeta?.archRole === "aks-ingress")) return "ingress";
  // VMSS → LB = SNAT outbound egress (AKS outboundType=loadBalancer)
  if (edgeKind === "routes" && tgtMeta?.archRole === "load-balancer" && (srcMeta?.archRole === "aks-vmss" || srcMeta?.archRole === "vmss")) return "egress";
  // Subnet → NAT Gateway = explicit outbound egress
  if (tgtMeta?.archRole === "nat-gateway") return "egress";
  if (edgeKind === "privateLink") return "dependency";
  if (edgeKind === "logging") return "control";

  // Priority 2: flow hint pair resolution
  const sh = srcMeta?.flowHint;
  const th = tgtMeta?.flowHint;
  if (sh === "ingress" && th === "east-west") return "ingress";
  if (sh === "ingress" && th === "control") return "ingress";
  if (sh === "east-west" && th === "dependency") return "dependency";
  if (sh === "east-west" && th === "egress") return "egress";
  if (sh === "control" && th === "east-west") return "control";
  if (sh === "east-west" && th === "east-west") return "east-west";

  // Only return flowType when we have clear signal
  return undefined;
}

// ── Derive short stable ID from Azure resource ID ──

function shortId(azureId: string): string {
  const parts = azureId.split("/");
  const name = parts[parts.length - 1] ?? azureId;
  return name.toLowerCase().replace(/[^a-z0-9-]/g, "");
}

function buildUniqueIdMap(nodes: ArchitectureNode[]): Map<string, string> {
  const idMap = new Map<string, string>();
  const seen = new Map<string, number>();

  for (const node of nodes) {
    let sid = shortId(node.azureId ?? node.id);
    const count = seen.get(sid) ?? 0;
    seen.set(sid, count + 1);
    if (count > 0) {
      sid = `${sid}-${count + 1}`;
    }
    idMap.set(node.id, sid);
  }

  return idMap;
}

// ── Containment map builder ──

export type ContainmentDiagnostics = {
  subnetParentCount: number;
  resourceSubnetCount: number;
  pass1: number;
  pass1b: number;
  pass2Nic: number;
  pass2Other: number;
  pass3: number;
  pass4: number;
  pass5: number;
  /** Sample containment chains for debugging */
  sampleChains: string[];
  /** Edge kind distribution in the graph */
  edgeKindCounts: Record<string, number>;
  /** Graph-level node counts by kind */
  graphNodeCounts: { vnet: number; subnet: number; nic: number; total: number };
};

type ContainmentMap = {
  subnetParent: Map<string, string>;   // subnetOrigId → vnetOrigId
  resourceSubnet: Map<string, string>; // resourceOrigId → subnetOrigId
  /** Resources placed in a subnet only because they share its resource group (Pass 4) — a guess */
  rgGuess: Set<string>;
  diagnostics: ContainmentDiagnostics;
};

/** RFC 1918 private IPv4 (a frontend with any other address is public) */
function isPrivateAddress(ip: string): boolean {
  return /^10./.test(ip) || /^172.(1[6-9]|2d|3[01])./.test(ip) || /^192.168./.test(ip);
}

function buildContainmentMap(graph: ArchitectureGraph): ContainmentMap {
  const subnetParent = new Map<string, string>();
  const resourceSubnet = new Map<string, string>();
  const rgGuess = new Set<string>();
  const sampleChains: string[] = [];

  const nodeKindMap = new Map(graph.nodes.map((n) => [n.id, n.kind]));
  const nodeNameMap = new Map(graph.nodes.map((n) => [n.id, n.name]));

  // Edge kind distribution for diagnostics
  const edgeKindCounts: Record<string, number> = {};
  for (const e of graph.edges) {
    edgeKindCounts[e.kind] = (edgeKindCounts[e.kind] ?? 0) + 1;
  }

  // ── Pass 1: VNet → Subnet (contains edges) ──
  let pass1Count = 0;
  for (const edge of graph.edges) {
    if (edge.kind !== "contains") continue;
    const srcKind = nodeKindMap.get(edge.source);
    const tgtKind = nodeKindMap.get(edge.target);
    if (srcKind === "vnet" && tgtKind === "subnet") {
      subnetParent.set(edge.target, edge.source);
      pass1Count++;
    }
  }

  // Diagnostic: report Pass 1 result
  if (pass1Count === 0) {
    const vnets = graph.nodes.filter(n => n.kind === "vnet");
    const subnets = graph.nodes.filter(n => n.kind === "subnet");
    const containsEdges = graph.edges.filter(e => e.kind === "contains");
    debug(`[containment] Pass 1: 0 subnet→vnet. VNets=${vnets.length}, Subnets=${subnets.length}, Contains edges=${containsEdges.length}`);
    for (const e of containsEdges.slice(0, 5)) {
      debug(`[containment]   ${e.source.slice(0, 60)}.. (${nodeKindMap.get(e.source) ?? "?"}) → ${e.target.slice(0, 60)}.. (${nodeKindMap.get(e.target) ?? "?"})`);
    }
    if (vnets.length > 0) debug(`[containment] Sample VNet ID: ${vnets[0]!.id.slice(0, 120)}`);
    if (subnets.length > 0) debug(`[containment] Sample Subnet ID: ${subnets[0]!.id.slice(0, 120)}`);
  } else {
    debug(`[containment] Pass 1: ${pass1Count} subnet→vnet from contains edges`);
  }

  // ── Pass 1b: Fallback — infer VNet→Subnet from Azure resource ID hierarchy ──
  let pass1bCount = 0;
  for (const node of graph.nodes) {
    if (node.kind !== "subnet") continue;
    if (subnetParent.has(node.id)) continue;
    const idx = node.id.lastIndexOf("/subnets/");
    if (idx <= 0) continue;
    const parentVnetId = node.id.slice(0, idx);
    const parentKind = nodeKindMap.get(parentVnetId);
    if (parentKind === "vnet") {
      subnetParent.set(node.id, parentVnetId);
      pass1bCount++;
    } else {
      debug(`[containment] Pass 1b: parent "${parentVnetId.slice(0, 80)}" kind=${parentKind ?? "NOT_FOUND"}`);
    }
  }
  if (pass1bCount > 0) {
    debug(`[containment] Pass 1b: ID-fallback resolved ${pass1bCount} subnet→vnet`);
  }

  // ── Pass 2: Subnet → Resource (network/connects/attached-to/bound-to edges) ──
  const NETWORK_EDGE_KINDS: Set<EdgeKind> = new Set(["connects", "network", "attached-to", "bound-to"]);
  const nicToSubnet = new Map<string, string>();
  let pass2Nic = 0;
  let pass2Other = 0;
  for (const edge of graph.edges) {
    if (!NETWORK_EDGE_KINDS.has(edge.kind)) continue;
    const srcKind = nodeKindMap.get(edge.source);
    const tgtKind = nodeKindMap.get(edge.target);

    if (srcKind === "subnet" && tgtKind === "nic") {
      nicToSubnet.set(edge.target, edge.source);
      resourceSubnet.set(edge.target, edge.source);
      pass2Nic++;
      sampleChains.push(
        `Subnet "${nodeNameMap.get(edge.source) ?? "?"}" → NIC "${nodeNameMap.get(edge.target) ?? "?"}" [${edge.kind}]`,
      );
    } else if (srcKind === "subnet" && tgtKind && !NETWORK_CONTAINER_KINDS.has(tgtKind) && tgtKind !== "aks") {
      resourceSubnet.set(edge.target, edge.source);
      pass2Other++;
      if (pass2Other <= 5) {
        sampleChains.push(
          `Subnet "${nodeNameMap.get(edge.source) ?? "?"}" → ${tgtKind} "${nodeNameMap.get(edge.target) ?? "?"}" [${edge.kind}]`,
        );
      }
    }
  }
  debug(`[containment] Pass 2: ${pass2Nic} subnet→nic, ${pass2Other} subnet→other`);

  // ── Pass 3: NIC → Resource: resolve through NIC to subnet ──
  let pass3Count = 0;
  for (const edge of graph.edges) {
    if (!NETWORK_EDGE_KINDS.has(edge.kind)) continue;
    const srcKind = nodeKindMap.get(edge.source);
    if (srcKind !== "nic") continue;
    const subnetId = nicToSubnet.get(edge.source);
    if (subnetId && !resourceSubnet.has(edge.target)) {
      resourceSubnet.set(edge.target, subnetId);
      pass3Count++;
      sampleChains.push(
        `NIC "${nodeNameMap.get(edge.source) ?? "?"}" → ${nodeKindMap.get(edge.target) ?? "?"} "${nodeNameMap.get(edge.target) ?? "?"}" via subnet "${nodeNameMap.get(subnetId) ?? "?"}" [${edge.kind}]`,
      );
    }
  }
  debug(`[containment] Pass 3: ${pass3Count} resources resolved via NIC chain`);

  // ── Pass 4: Resource Group proximity fallback ──
  const subnetRgMap = new Map<string, string[]>();
  for (const node of graph.nodes) {
    if (node.kind !== "subnet") continue;
    if (!node.resourceGroup) continue;
    const rg = node.resourceGroup.toLowerCase();
    const arr = subnetRgMap.get(rg) ?? [];
    arr.push(node.id);
    subnetRgMap.set(rg, arr);
  }

  let pass4Count = 0;
  for (const node of graph.nodes) {
    if (NETWORK_CONTAINER_KINDS.has(node.kind)) continue;
    if (EXCLUDED_KINDS.has(node.kind)) continue;
    if (resourceSubnet.has(node.id)) continue;
    if (!node.resourceGroup) continue;
    // Skip PaaS resources — they belong outside VNet (connected via PE if at all)
    if (DATA_KINDS.has(node.kind)) continue;
    if (node.kind === "appInsights" || node.kind === "logAnalytics") continue;
    // Public IP addresses and NAT Gateways are not subnet resources — always external
    if (node.kind === "publicIP") continue;
    if (node.kind === "natGateway") continue;
    // Global / public entry points have no subnet: Front Door, Traffic Manager, a load balancer whose
    // frontend is a public IP (its backends decide its VNet later). Guessing a subnet drew the Internet
    // line straight into an unrelated subnet.
    if (node.kind === "frontDoor" || node.kind === "trafficManager") continue;
    // AGC: only its association places it (AGC-01); gateways / Bastion only their dedicated subnet (CT-07)
    if (node.kind === "agc" || node.kind === "vnetGateway" || node.kind === "bastion") continue;
    // A managed cluster has no subnet: its node pools do (AKS-01 places the pools), a private API server is its own
    // Private Endpoint card (CMP-21). A resource-group guess put the cluster card in an unrelated subnet.
    if (node.kind === "aks") continue;
    if (node.kind === "lb" && node.endpoint && !isPrivateAddress(node.endpoint)) continue;
    const rg = node.resourceGroup.toLowerCase();
    const rgSubnets = subnetRgMap.get(rg);
    if (!rgSubnets || rgSubnets.length === 0) continue;

    // Prefer the subnet that already has the most children
    let bestSubnet = rgSubnets[0]!;
    for (const sid of rgSubnets) {
      if (resourceSubnet.size > 0) {
        const count = [...resourceSubnet.values()].filter(v => v === sid).length;
        const bestCount = [...resourceSubnet.values()].filter(v => v === bestSubnet).length;
        if (count > bestCount) bestSubnet = sid;
      }
    }
    resourceSubnet.set(node.id, bestSubnet);
    rgGuess.add(node.id);
    pass4Count++;
    if (pass4Count <= 5) {
      sampleChains.push(
        `[RG-fallback] ${node.kind} "${node.name}" → subnet "${nodeNameMap.get(bestSubnet) ?? "?"}" (RG: ${node.resourceGroup})`,
      );
    }
  }
  if (pass4Count > 0) {
    debug(`[containment] Pass 4: RG-proximity assigned ${pass4Count} resources to subnets`);
  }

  // ── Pass 5: Nuclear failsafe — if containment is still empty, force-assign ──
  // Uses node.id hierarchy (not edges) to force VNet→Subnet containment.
  // Then assigns ALL remaining resources to the nearest subnet by resource group.
  let pass5Count = 0;
  if (subnetParent.size === 0) {
    const vnetNodes = graph.nodes.filter(n => n.kind === "vnet");
    const subnetNodesLocal = graph.nodes.filter(n => n.kind === "subnet");
    debug(`[containment] Pass 5: FAILSAFE — subnetParent is empty! VNets=${vnetNodes.length}, Subnets=${subnetNodesLocal.length}`);

    if (vnetNodes.length > 0 && subnetNodesLocal.length > 0) {
      // Force VNet→Subnet containment from node IDs
      const vnetIdSet = new Set(vnetNodes.map(n => n.id));
      for (const sub of subnetNodesLocal) {
        const idx = sub.id.lastIndexOf("/subnets/");
        if (idx > 0) {
          const parentVnetId = sub.id.slice(0, idx);
          if (vnetIdSet.has(parentVnetId)) {
            subnetParent.set(sub.id, parentVnetId);
            pass5Count++;
            sampleChains.push(`[Pass5-ID] subnet "${sub.name}" → vnet "${parentVnetId.split("/").pop()}"`);
          } else {
            // Try case-insensitive match
            const match = vnetNodes.find(v => v.id.toLowerCase() === parentVnetId.toLowerCase());
            if (match) {
              subnetParent.set(sub.id, match.id);
              pass5Count++;
              sampleChains.push(`[Pass5-CI] subnet "${sub.name}" → vnet "${match.name}" (case-insensitive)`);
            } else {
              debug(`[containment] Pass 5: subnet "${sub.name}" parent VNet "${parentVnetId.split("/").pop()}" NOT FOUND in ${vnetNodes.length} VNets`);
              // Dump first VNet ID for comparison
              if (vnetNodes.length > 0) {
                debug(`[containment] Pass 5: expected="${parentVnetId}"`);
                debug(`[containment] Pass 5: actual  ="${vnetNodes[0]!.id}"`);
              }
            }
          }
        } else {
          // No /subnets/ in ID — assign to first VNet in same RG
          if (sub.resourceGroup) {
            const sameRgVnet = vnetNodes.find(v => v.resourceGroup?.toLowerCase() === sub.resourceGroup?.toLowerCase());
            if (sameRgVnet) {
              subnetParent.set(sub.id, sameRgVnet.id);
              pass5Count++;
              sampleChains.push(`[Pass5-RG] subnet "${sub.name}" → vnet "${sameRgVnet.name}" (same RG: ${sub.resourceGroup})`);
            }
          }
        }
      }

      // Force resource→subnet containment if still empty
      if (resourceSubnet.size === 0 && subnetParent.size > 0) {
        debug(`[containment] Pass 5: Also forcing resource→subnet by RG proximity`);
        // Rebuild subnet RG map with freshly resolved subnets
        const subRgMap5 = new Map<string, string[]>();
        for (const sub of subnetNodesLocal) {
          if (!subnetParent.has(sub.id)) continue;
          if (!sub.resourceGroup) continue;
          const rg = sub.resourceGroup.toLowerCase();
          const arr = subRgMap5.get(rg) ?? [];
          arr.push(sub.id);
          subRgMap5.set(rg, arr);
        }

        for (const node of graph.nodes) {
          if (NETWORK_CONTAINER_KINDS.has(node.kind)) continue;
          if (EXCLUDED_KINDS.has(node.kind)) continue;
          if (resourceSubnet.has(node.id)) continue;
          if (!node.resourceGroup) continue;
          // Skip PaaS resources — external to VNet
          if (DATA_KINDS.has(node.kind)) continue;
          if (node.kind === "appInsights" || node.kind === "logAnalytics") continue;
          if (node.kind === "publicIP") continue;
          const rg = node.resourceGroup.toLowerCase();
          const rgSubnets = subRgMap5.get(rg);
          if (!rgSubnets || rgSubnets.length === 0) continue;
          resourceSubnet.set(node.id, rgSubnets[0]!);
          pass5Count++;
          if (pass5Count <= 10) {
            sampleChains.push(`[Pass5-Res] ${node.kind} "${node.name}" → subnet (RG: ${node.resourceGroup})`);
          }
        }
      }
    }
  }
  if (pass5Count > 0) {
    debug(`[containment] Pass 5: FAILSAFE resolved ${pass5Count} containment entries`);
  }

  // Graph-level node counts
  const graphNodeCounts = {
    vnet: graph.nodes.filter(n => n.kind === "vnet").length,
    subnet: graph.nodes.filter(n => n.kind === "subnet").length,
    nic: graph.nodes.filter(n => n.kind === "nic").length,
    total: graph.nodes.length,
  };

  debug(`[containment] Final: ${subnetParent.size} subnet→vnet, ${resourceSubnet.size} resource→subnet`);

  // Log all sample chains for server-side debugging
  for (const chain of sampleChains) {
    debug(`[containment]   ${chain}`);
  }

  return {
    subnetParent,
    resourceSubnet,
    rgGuess,
    diagnostics: {
      subnetParentCount: subnetParent.size,
      resourceSubnetCount: resourceSubnet.size,
      pass1: pass1Count,
      pass1b: pass1bCount,
      pass2Nic,
      pass2Other,
      pass3: pass3Count,
      pass4: pass4Count,
      pass5: pass5Count,
      sampleChains,
      edgeKindCounts,
      graphNodeCounts,
    },
  };
}

// ── ELK Layout Engine ──

// elkjs is CommonJS: under NodeNext the default import is module.exports, whose `.default` is the constructor
const elk = new ELK.default();

async function applyElkLayout(
  nodes: DiagramNodeSpec[],
  edges: DiagramEdgeSpec[],
): Promise<void> {
  // Build ELK graph with compound nodes
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const rootChildren: ElkNode[] = [];
  const parentChildrenMap = new Map<string, ElkNode[]>();

  type ElkNode = {
    id: string;
    width: number;
    height: number;
    children?: ElkNode[];
    layoutOptions?: Record<string, string>;
  };

  // Sort nodes: parents first, then children
  const groupNodes = nodes.filter((n) => n.nodeType === "group");
  const leafNodes = nodes.filter((n) => n.nodeType !== "group");

  // Create ELK nodes for groups
  for (const gn of groupNodes) {
    const elkNode: ElkNode = {
      id: gn.id,
      width: gn.width ?? 400,
      height: gn.height ?? 200,
      children: [],
      layoutOptions: {
        "elk.padding": "[top=50,left=30,bottom=30,right=30]",
        "elk.algorithm": "layered",
        "elk.direction": "RIGHT",
      },
    };
    if (gn.parentId) {
      const siblings = parentChildrenMap.get(gn.parentId) ?? [];
      siblings.push(elkNode);
      parentChildrenMap.set(gn.parentId, siblings);
    } else {
      rootChildren.push(elkNode);
    }
    parentChildrenMap.set(gn.id, elkNode.children!);
  }

  // Create ELK nodes for leaf resources
  for (const ln of leafNodes) {
    const elkNode: ElkNode = {
      id: ln.id,
      width: NODE_W,
      height: NODE_H,
    };
    if (ln.parentId) {
      const siblings = parentChildrenMap.get(ln.parentId) ?? [];
      siblings.push(elkNode);
      parentChildrenMap.set(ln.parentId, siblings);
    } else {
      rootChildren.push(elkNode);
    }
  }

  // Wire children into group nodes
  for (const gn of groupNodes) {
    const elkChildren = parentChildrenMap.get(gn.id) ?? [];
    // Find the elkNode in rootChildren or nested
    const findElk = (arr: ElkNode[], id: string): ElkNode | undefined => {
      for (const n of arr) {
        if (n.id === id) return n;
        if (n.children) {
          const found = findElk(n.children, id);
          if (found) return found;
        }
      }
      return undefined;
    };
    const elkNode = findElk(rootChildren, gn.id);
    if (elkNode) elkNode.children = elkChildren;
  }

  // Build ELK edges (only between nodes at the same level or cross-hierarchy)
  const elkEdges = edges.map((e) => ({
    id: e.id,
    sources: [e.source],
    targets: [e.target],
  }));

  const elkGraph = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.spacing.nodeNode": "40",
      "elk.spacing.edgeEdge": "20",
      "elk.spacing.componentComponent": "60",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.layered.spacing.nodeNodeBetweenLayers": "60",
    },
    children: rootChildren,
    edges: elkEdges,
  };

  try {
    const layout = await elk.layout(elkGraph);

    // Apply positions back from ELK result
    const applyPositions = (elkNodes: typeof rootChildren, parentX = 0, parentY = 0) => {
      for (const en of elkNodes) {
        const node = nodeMap.get(en.id);
        if (node) {
          const x = (en as { x?: number }).x ?? 0;
          const y = (en as { y?: number }).y ?? 0;
          // For nodes with a parent, position is relative to parent
          if (node.parentId) {
            node.position = { x, y };
          } else {
            node.position = { x: x + parentX, y: y + parentY };
          }
          // Update group dimensions from ELK
          if (node.nodeType === "group") {
            const w = (en as { width?: number }).width;
            const h = (en as { height?: number }).height;
            if (w) node.width = w;
            if (h) node.height = h;
          }
        }
        if (en.children) {
          const nx = (en as { x?: number }).x ?? 0;
          const ny = (en as { y?: number }).y ?? 0;
          applyPositions(en.children, parentX + nx, parentY + ny);
        }
      }
    };

    applyPositions(layout.children ?? []);
  } catch (err) {
    // ELK failed — positions remain from manual layout (the web lays out the live view itself)
    debug(`[specGenerator] ELK layout failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Main generator ──

export type GenerateDiagramResult = {
  spec: DiagramSpec;
  containmentDiagnostics: ContainmentDiagnostics;
};

export async function generateDiagramSpec(
  graph: ArchitectureGraph,
  subscriptionId: string,
  layoutMode: DiagramLayoutKind = "elk",
): Promise<GenerateDiagramResult> {
  const now = new Date().toISOString();

  // Build containment map from FULL graph (before filtering)
  const containment = buildContainmentMap(graph);

  // ── Build NIC→VM absorption map ──
  // NICs "bound-to" a VM get embedded as subResources instead of separate nodes.
  const nodeKindLookup = new Map(graph.nodes.map((n) => [n.id, n.kind]));
  const nicToVmBound = new Map<string, string>(); // nicOrigId → vmOrigId
  const vmBoundNics = new Map<string, ArchitectureNode[]>(); // vmOrigId → NIC nodes
  for (const edge of graph.edges) {
    if (edge.kind !== "bound-to") continue;
    const srcKind = nodeKindLookup.get(edge.source);
    const tgtKind = nodeKindLookup.get(edge.target);
    if (srcKind === "nic" && (tgtKind === "vm" || tgtKind === "vmss")) {
      nicToVmBound.set(edge.source, edge.target);
      const arr = vmBoundNics.get(edge.target) ?? [];
      const nicNode = graph.nodes.find((n) => n.id === edge.source);
      if (nicNode) arr.push(nicNode);
      vmBoundNics.set(edge.target, arr);
    }
  }

  // ── Frontends of AGW / LB (catalog AGW-01, LB-01): one chip per frontend — public and private both ──
  type GraphFrontend = { name: string; kind: "public" | "private"; ip?: string };
  const frontendChips = (node: ArchitectureNode): SubResource[] | undefined => {
    const list = Array.isArray(node.metadata?.frontends) ? (node.metadata!.frontends as GraphFrontend[]) : [];
    if (!list.length) return undefined;
    return list.map((f, i) => ({
      id: `${node.id}/frontendIP/${i}`,
      label: f.kind === "public" ? "Public IP" : "Frontend IP",
      kind: (f.kind === "public" ? "publicIP" : "frontendIP") as SubResourceKind,
      ...(f.ip ? { endpoint: f.ip } : {}),
      azureResourceId: node.azureId,
    }));
  };
  const appGwFrontendIPs = new Map<string, SubResource[]>();
  for (const node of graph.nodes) {
    if (node.kind !== "appGateway") continue;
    const chips = frontendChips(node);
    if (chips) { appGwFrontendIPs.set(node.id, chips); continue; }
    if (!node.endpoint) continue;
    appGwFrontendIPs.set(node.id, [{
      id: `${node.id}/frontendIP/0`,
      label: "Frontend IP",
      kind: "frontendIP" as SubResourceKind,
      endpoint: node.endpoint,
      azureResourceId: node.azureId,
    }]);
  }

  // ── Build LB Frontend IP absorption map ──
  function isPrivateIp(ip: string): boolean {
    return /^10\./.test(ip)
      || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
      || /^192\.168\./.test(ip);
  }

  const lbFrontendIPs = new Map<string, SubResource[]>();
  for (const node of graph.nodes) {
    if (node.kind !== "lb") continue;
    const chips = frontendChips(node);
    if (chips) { lbFrontendIPs.set(node.id, chips); continue; }
    if (!node.endpoint) continue;
    const isPublic = !isPrivateIp(node.endpoint);
    lbFrontendIPs.set(node.id, [{
      id: `${node.id}/frontendIP/0`,
      label: isPublic ? "Public IP" : "Frontend IP",
      kind: (isPublic ? "publicIP" : "frontendIP") as SubResourceKind,
      endpoint: node.endpoint,
      azureResourceId: node.azureId,
    }]);
  }

  // ── Build standalone NIC → Public IP absorption map ──
  // Standalone NICs (not VM-bound) with a public IP are absorbed into a PIP card.
  // The PIP becomes the main resource card; the NIC appears as its sub-resource.
  const nicToPipAzureId = new Map<string, string>(); // nicOrigId → pipAzureId (lowercase)
  for (const node of graph.nodes) {
    if (node.kind !== "nic") continue;
    if (nicToVmBound.has(node.id)) continue; // VM-bound NICs are handled separately
    const pipAzureId = typeof node.metadata?.publicIPAzureId === "string" ? node.metadata.publicIPAzureId : undefined;
    if (pipAzureId) nicToPipAzureId.set(node.id, pipAzureId);
  }

  // PIP azureId (lower) → PIP graph node (includes absorbed PIPs)
  const pipByAzureId = new Map<string, ArchitectureNode>();
  for (const node of graph.nodes) {
    if (node.kind !== "publicIP") continue;
    if (node.azureId) pipByAzureId.set(node.azureId.toLowerCase(), node);
  }

  // PIPs that must be shown in the diagram (their attached NIC is standalone, not VM-bound)
  const standalonePipIds = new Set<string>(); // PIP origIds to un-exclude
  const pipToStandaloneNics = new Map<string, ArchitectureNode[]>(); // pipOrigId → NIC nodes
  const nicToPipOrigId = new Map<string, string>(); // nicOrigId → pipOrigId (for edge retargeting)
  for (const [nicOrigId, pipAzureId] of nicToPipAzureId) {
    const pipNode = pipByAzureId.get(pipAzureId);
    if (!pipNode) continue;
    standalonePipIds.add(pipNode.id);
    nicToPipOrigId.set(nicOrigId, pipNode.id);
    const nicNode = graph.nodes.find((n) => n.id === nicOrigId);
    if (nicNode) {
      const arr = pipToStandaloneNics.get(pipNode.id) ?? [];
      arr.push(nicNode);
      pipToStandaloneNics.set(pipNode.id, arr);
    }
  }

  // ── Build NSG placement map ──
  // NSGs are placed based on their associations:
  //  - If attached to a subnet → place inside that subnet
  //  - If attached to NIC(s) only → place in the subnet of the NIC's parent resource
  const NETWORK_EDGE_KINDS_LOOKUP: Set<EdgeKind> = new Set(["connects", "network", "attached-to", "bound-to"]);
  const nsgToSubnet = new Map<string, string>(); // nsgOrigId → subnetOrigId
  const nsgToNics = new Map<string, string[]>(); // nsgOrigId → nicOrigIds[]

  for (const edge of graph.edges) {
    if (!NETWORK_EDGE_KINDS_LOOKUP.has(edge.kind)) continue;
    const srcKind = nodeKindLookup.get(edge.source);
    const tgtKind = nodeKindLookup.get(edge.target);

    // subnet → nsg
    if (srcKind === "subnet" && tgtKind === "nsg") {
      nsgToSubnet.set(edge.target, edge.source);
    }
    // nsg → subnet (reversed direction)
    if (srcKind === "nsg" && tgtKind === "subnet") {
      nsgToSubnet.set(edge.source, edge.target);
    }
    // nsg → nic
    if (srcKind === "nsg" && tgtKind === "nic") {
      const arr = nsgToNics.get(edge.source) ?? [];
      arr.push(edge.target);
      nsgToNics.set(edge.source, arr);
    }
    // nic → nsg (reversed direction)
    if (srcKind === "nic" && tgtKind === "nsg") {
      const arr = nsgToNics.get(edge.target) ?? [];
      arr.push(edge.source);
      nsgToNics.set(edge.target, arr);
    }
  }

  // ── NAT Gateway → subnet badge map ──
  // subnet→natGateway edges (source=subnet, target=natGateway, kind="network") from azure.ts
  const natGwToSubnets = new Map<string, string[]>(); // natGwOrigId → subnetOrigIds[]
  for (const edge of graph.edges) {
    if (nodeKindLookup.get(edge.source) === "subnet" && nodeKindLookup.get(edge.target) === "natGateway") {
      const arr = natGwToSubnets.get(edge.target) ?? [];
      arr.push(edge.source);
      natGwToSubnets.set(edge.target, arr);
    }
  }
  // Reverse: first attached subnet per NAT GW (used in subnet loop)
  const subnetToNatGw = new Map<string, string>(); // subnetOrigId → natGwOrigId
  for (const [ngwId, subnets] of natGwToSubnets) {
    for (const subId of subnets) {
      if (!subnetToNatGw.has(subId)) subnetToNatGw.set(subId, ngwId);
    }
  }
  // NAT GW IDs that are placed as subnet child cards (excluded from standalone external rendering)
  const embeddedNatGwOrigIds = new Set(natGwToSubnets.keys());

  // NAT GW → PIP sub-resource map: natGwOrigId → PIP origIds[] (via natgw→pip graph edges)
  const natGwToPips = new Map<string, string[]>(); // natGwOrigId → publicIP origIds[]
  for (const edge of graph.edges) {
    if (nodeKindLookup.get(edge.source) === "natGateway" && nodeKindLookup.get(edge.target) === "publicIP") {
      const arr = natGwToPips.get(edge.source) ?? [];
      arr.push(edge.target);
      natGwToPips.set(edge.source, arr);
    }
  }
  // PIPs that belong to an embedded NAT GW — excluded from external resource rendering
  const natGwPipOrigIds = new Set<string>();
  for (const natGwOrigId of embeddedNatGwOrigIds) {
    for (const pipId of natGwToPips.get(natGwOrigId) ?? []) {
      natGwPipOrigIds.add(pipId);
    }
  }

  // ── Categorize NSGs into 4 placement types ──
  // Cat 1: direct subnet attachment (nsgToSubnet) → badge in subnet header
  // Cat 2: NIC-attached, NIC bound to VM → badge above VM node
  // Cat 3: NIC-attached, standalone NIC → badge above NIC node
  // Cat 4: standalone NSG (no associations) → detached node with X marker

  // Cat 2 & 3: resolve NIC-attached NSGs to their target resource
  const nsgToVm = new Map<string, string>();        // nsgOrigId → vmOrigId
  const nsgToStandaloneNic = new Map<string, string>(); // nsgOrigId → nicOrigId
  const standaloneNsgIds = new Set<string>();        // Cat 4

  for (const [nsgId, nicIds] of nsgToNics) {
    if (nsgToSubnet.has(nsgId)) continue; // Cat 1 — already mapped to subnet
    let resolved = false;
    for (const nicId of nicIds) {
      const vmId = nicToVmBound.get(nicId);
      if (vmId) {
        nsgToVm.set(nsgId, vmId); // Cat 2
        // Also resolve the subnet for placement
        const subnetId = containment.resourceSubnet.get(nicId) ?? containment.resourceSubnet.get(vmId);
        if (subnetId) nsgToSubnet.set(nsgId, subnetId);
        resolved = true;
        break;
      }
    }
    if (!resolved) {
      // Try standalone NIC
      for (const nicId of nicIds) {
        if (!nicToVmBound.has(nicId)) {
          nsgToStandaloneNic.set(nsgId, nicId); // Cat 3
          const subnetId = containment.resourceSubnet.get(nicId);
          if (subnetId) nsgToSubnet.set(nsgId, subnetId);
          resolved = true;
          break;
        }
      }
    }
    if (!resolved) {
      standaloneNsgIds.add(nsgId); // Cat 4
    }
  }

  // Cat 4: NSGs with NO associations at all
  for (const node of graph.nodes) {
    if (node.kind !== "nsg") continue;
    if (!nsgToSubnet.has(node.id) && !nsgToVm.has(node.id) && !nsgToStandaloneNic.has(node.id)) {
      standaloneNsgIds.add(node.id);
    }
  }

  // Build reverse maps for layout: target → NSG
  const vmToNsg = new Map<string, ArchitectureNode>(); // vmOrigId → nsgNode
  const nicToNsg = new Map<string, ArchitectureNode>(); // nicOrigId → nsgNode
  for (const [nsgId, vmId] of nsgToVm) {
    const nsgNode = graph.nodes.find((n) => n.id === nsgId);
    if (nsgNode) vmToNsg.set(vmId, nsgNode);
  }
  for (const [nsgId, nicId] of nsgToStandaloneNic) {
    const nsgNode = graph.nodes.find((n) => n.id === nsgId);
    if (nsgNode) nicToNsg.set(nicId, nsgNode);
  }

  if (nsgToSubnet.size > 0) {
    debug(`[specGenerator] NSG placement: ${nsgToSubnet.size} subnet, ${nsgToVm.size} VM-attached, ${nsgToStandaloneNic.size} NIC-attached, ${standaloneNsgIds.size} standalone`);
  }

  if (vmBoundNics.size > 0) {
    debug(`[specGenerator] NIC absorption: ${nicToVmBound.size} NICs → ${vmBoundNics.size} VMs`);
  }
  debug(`[specGenerator] PIP absorption: ${nicToPipAzureId.size} standalone NICs → ${standalonePipIds.size} PIP cards`);
  if (appGwFrontendIPs.size > 0) {
    debug(`[specGenerator] AppGW Frontend IPs: ${appGwFrontendIPs.size} AppGWs with frontend IPs`);
  }
  if (lbFrontendIPs.size > 0) {
    debug(`[specGenerator] LB Frontend IPs: ${lbFrontendIPs.size} LBs with frontend IPs`);
  }

  /** Collect sub-resources (NICs, Frontend IPs, PIP-attached NICs) for a given node by its original ID. */
  function collectSubResources(nodeOrigId: string): SubResource[] | undefined {
    const subs: SubResource[] = [];

    // Public IP card: include standalone NICs as sub-resource chips
    const pipNics = pipToStandaloneNics.get(nodeOrigId);
    if (pipNics) {
      for (const nic of pipNics) {
        subs.push({
          id: idMap.get(nic.id) ?? shortId(nic.azureId ?? nic.id),
          label: nic.name,
          kind: "nic" as SubResourceKind,
          endpoint: nic.endpoint,
          azureResourceId: nic.azureId,
        });
      }
    }
    const boundNics = vmBoundNics.get(nodeOrigId);
    if (boundNics) {
      for (const nic of boundNics) {
        subs.push({
          id: idMap.get(nic.id) ?? shortId(nic.azureId ?? nic.id),
          label: nic.name,
          kind: "nic" as SubResourceKind,
          endpoint: nic.endpoint,
          azureResourceId: nic.azureId,
        });
        // The NIC's public IPs (resolved in azure.ts, every ip configuration) as sub-resources. The resource id is
        // what the Internet → VM line is measured on (PIP-04) — the server reads it back from here, never from input
        const pubIp = typeof nic.metadata?.publicIP === "string" ? nic.metadata.publicIP : undefined;
        const pips = Array.isArray(nic.metadata?.publicIPs) ? (nic.metadata.publicIPs as Array<{ id: string }>) : [];
        const nicShort = idMap.get(nic.id) ?? shortId(nic.azureId ?? nic.id);
        if (pips.length) {
          pips.forEach((p, i) => subs.push({
            id: i === 0 ? `${nicShort}/publicip` : `${nicShort}/publicip-${i + 1}`,
            label: "Public IP",
            kind: "publicIP" as SubResourceKind,
            endpoint: i === 0 ? pubIp : undefined,
            azureResourceId: p.id,
          }));
        } else if (pubIp) {
          subs.push({ id: `${nicShort}/publicip`, label: "Public IP", kind: "publicIP" as SubResourceKind, endpoint: pubIp });
        }
      }
    }
    const feIPs = appGwFrontendIPs.get(nodeOrigId);
    if (feIPs) subs.push(...feIPs);
    const lbFeIPs = lbFrontendIPs.get(nodeOrigId);
    if (lbFeIPs) subs.push(...lbFeIPs);

    // AKS — show API server connectivity type (private vs public) + node pool summary
    const aksNode = graph.nodes.find((n) => n.id === nodeOrigId && n.kind === "aks");
    if (aksNode?.endpoint) {
      const isPrivate = aksNode.metadata?.isPrivateCluster === true;
      subs.push({
        id: `${nodeOrigId}/apiserver`,
        label: isPrivate ? "Private API" : "Public API",
        kind: "apiEndpoint" as SubResourceKind,
        endpoint: aksNode.endpoint,
      });
    }

    return subs.length > 0 ? subs : undefined;
  }

  // Filter nodes — exclude infra-only kinds + absorbed NICs + absorbed Public IPs (but keep VNet/Subnet)
  const filteredNodes = graph.nodes.filter(
    (n) =>
      !EXCLUDED_KINDS.has(n.kind) &&
      !(n.kind === "nic" && nicToVmBound.has(n.id)) &&
      !(n.kind === "nic" && nicToPipAzureId.has(n.id)) && // standalone NICs absorbed into PIP card
      !(n.kind === "publicIP" && n.metadata?.absorbed === true && !standalonePipIds.has(n.id)),
  );

  // Build node ID set for edge filtering
  const nodeOriginalIds = new Set(filteredNodes.map((n) => n.id));

  // Map original IDs → unique short IDs
  const idMap = buildUniqueIdMap(filteredNodes);

  // ── Detect architecture patterns (metadata only, no parentId changes) ──
  const archMetaMap = detectArchitecturePatterns(graph, filteredNodes, containment);

  // Categorize nodes
  const vnetNodes = filteredNodes.filter((n) => n.kind === "vnet");
  const subnetNodes = filteredNodes.filter((n) => n.kind === "subnet");
  const resourceNodes = filteredNodes.filter((n) => !NETWORK_CONTAINER_KINDS.has(n.kind));

  // ── Diagnostic: containment resolution ──
  debug(`[specGenerator] Graph: ${graph.nodes.length} nodes, ${graph.edges.length} edges`);
  debug(`[specGenerator] Filtered: ${vnetNodes.length} VNets, ${subnetNodes.length} Subnets, ${resourceNodes.length} resources`);
  debug(`[specGenerator] Containment: ${containment.subnetParent.size} subnet→vnet, ${containment.resourceSubnet.size} resource→subnet`);
  if (containment.subnetParent.size === 0 && subnetNodes.length > 0) {
    console.warn(`[specGenerator] WARNING: ${subnetNodes.length} subnets found but none mapped to VNets!`);
    // Log sample subnet IDs and contains edges for debugging
    const containsEdges = graph.edges.filter(e => e.kind === "contains");
    console.warn(`[specGenerator] Contains edges: ${containsEdges.length} total`);
    const vnetSubContains = containsEdges.filter(e => {
      const nodeKindMap = new Map(graph.nodes.map(n => [n.id, n.kind]));
      return nodeKindMap.get(e.source) === "vnet" && nodeKindMap.get(e.target) === "subnet";
    });
    console.warn(`[specGenerator] VNet→Subnet contains edges: ${vnetSubContains.length}`);
    if (subnetNodes.length > 0) {
      console.warn(`[specGenerator] Sample subnet ID: ${subnetNodes[0]!.id.slice(0, 80)}...`);
    }
  }

  // Build subnet → children map (using short IDs)
  // NSG placement rules:
  //  - Cat 1 (direct subnet NSG): placed in subnet as header badge
  //  - Cat 2 (VM-attached NSG): placed above VM node (not a separate child)
  //  - Cat 3 (standalone-NIC-attached NSG): placed above NIC node (not a separate child)
  //  - Cat 4 (standalone NSG): placed as external detached resource
  const subnetChildren = new Map<string, Array<{ node: ArchitectureNode; shortId: string }>>();
  for (const res of resourceNodes) {
    if (res.kind === "nsg") {
      // Only Cat 1 (direct subnet) NSGs are placed as subnet children
      if (nsgToVm.has(res.id) || nsgToStandaloneNic.has(res.id) || standaloneNsgIds.has(res.id)) continue;
      const subnetOrigId = nsgToSubnet.get(res.id);
      if (!subnetOrigId) continue;
      const subnetShortId = idMap.get(subnetOrigId);
      if (!subnetShortId) continue;
      const arr = subnetChildren.get(subnetShortId) ?? [];
      arr.push({ node: res, shortId: idMap.get(res.id)! });
      subnetChildren.set(subnetShortId, arr);
      continue;
    }
    // natGateway is a VNet-level resource — never placed inside a subnet GroupNode
    if (res.kind === "natGateway") continue;
    const subnetOrigId = containment.resourceSubnet.get(res.id);
    if (!subnetOrigId) continue;
    const subnetShortId = idMap.get(subnetOrigId);
    if (!subnetShortId) continue;
    const arr = subnetChildren.get(subnetShortId) ?? [];
    arr.push({ node: res, shortId: idMap.get(res.id)! });
    subnetChildren.set(subnetShortId, arr);
  }

  // Build VNet → subnets map (using short IDs)
  const vnetSubnets = new Map<string, Array<{ node: ArchitectureNode; shortId: string }>>();
  for (const sub of subnetNodes) {
    const vnetOrigId = containment.subnetParent.get(sub.id);
    if (!vnetOrigId) continue;
    const vnetShortId = idMap.get(vnetOrigId);
    if (!vnetShortId) continue;
    const arr = vnetSubnets.get(vnetShortId) ?? [];
    arr.push({ node: sub, shortId: idMap.get(sub.id)! });
    vnetSubnets.set(vnetShortId, arr);
  }

  // ── Diagnostic: final containment ──
  for (const [vShortId, subs] of vnetSubnets) {
    const childCounts = subs.map(s => `${s.shortId}(${subnetChildren.get(s.shortId)?.length ?? 0} children)`);
    debug(`[specGenerator] VNet "${vShortId}" → ${subs.length} subnets: [${childCounts.join(", ")}]`);
  }

  // Height of sub-resource chip row (NIC/Frontend IP embedded in parent)
  const SUB_RESOURCE_CHIP_H = 26;

  // Effective node height accounting for embedded sub-resources
  function effectiveNodeH(node: ArchitectureNode): number {
    const nicCount = vmBoundNics.get(node.id)?.length ?? 0;
    const feIpCount = appGwFrontendIPs.get(node.id)?.length ?? 0;
    const subCount = nicCount + feIpCount;
    return NODE_H + (subCount > 0 ? SUB_RESOURCE_CHIP_H : 0);
  }

  // Compute subnet dimensions and tier
  // NSG badges are now embedded inside GroupNode/LiveNode — no extra layout height needed
  const subnetInfo = new Map<string, { width: number; height: number; tier: number }>();
  for (const [subShortId, children] of subnetChildren) {
    const childKinds = new Set(children.map((c) => c.node.kind));
    const w = NODE_W + 2 * SUBNET_INNER_PAD;
    const nonNsgChildren = children.filter((c) => c.node.kind !== "nsg");
    const totalChildH = nonNsgChildren.reduce((sum, c) => sum + effectiveNodeH(c.node), 0);
    const h = SUBNET_HEADER + totalChildH + Math.max(0, nonNsgChildren.length - 1) * NODE_GAP + SUBNET_INNER_PAD;
    subnetInfo.set(subShortId, { width: w, height: Math.max(h, SUBNET_HEADER + NODE_H + SUBNET_INNER_PAD), tier: subnetTier(childKinds) });
  }

  // Include empty subnets with minimal size
  for (const sub of subnetNodes) {
    const sid = idMap.get(sub.id)!;
    if (!subnetInfo.has(sid)) {
      subnetInfo.set(sid, { width: NODE_W + 2 * SUBNET_INNER_PAD, height: SUBNET_HEADER + SUBNET_INNER_PAD + 20, tier: 2 });
    }
  }

  // Compute VNet dimensions
  const vnetInfo = new Map<string, { width: number; height: number }>();
  for (const vnet of vnetNodes) {
    const vShortId = idMap.get(vnet.id)!;
    const subs = vnetSubnets.get(vShortId) ?? [];
    subs.sort((a, b) => {
      const ta = subnetInfo.get(a.shortId)?.tier ?? 2;
      const tb = subnetInfo.get(b.shortId)?.tier ?? 2;
      return ta - tb;
    });

    let totalSubW = 0;
    let maxSubH = 0;
    for (const sub of subs) {
      const info = subnetInfo.get(sub.shortId);
      if (!info) continue;
      totalSubW += info.width;
      maxSubH = Math.max(maxSubH, info.height);
    }
    totalSubW += Math.max(0, subs.length - 1) * SUBNET_GAP;

    // Reserve right column for NAT GW card(s) if any subnet in this VNet has a NAT GW
    const hasNatGw = subs.some((s) => subnetToNatGw.has(s.node.id));
    const natGwColW = hasNatGw ? (NODE_W + 40) : 0; // 40 = 20px gap + 20px right pad

    const vW = Math.max(totalSubW + 2 * VNET_PAD + natGwColW, 400);
    const vH = VNET_HEADER + maxSubH + VNET_PAD + 10;
    vnetInfo.set(vShortId, { width: vW, height: Math.max(vH, 200) });
  }

  // ── Compute positions ──
  const diagramNodes: DiagramNodeSpec[] = [];
  // Pending subnet → NAT GW association edges — processed after makeEdge is available
  const pendingNatGwAssocEdges: Array<{ subnetShortId: string; ngwShortId: string }> = [];
  /** Subnets with a route table (their UDR lines are made once every card has an id) */
  const pendingUdrSubnets: Array<{ subnetShortId: string; origId: string }> = [];
  let cursorY = 40;
  // Track NAT GW diagramNodes already added — one per unique NAT GW (deduplicate)
  const addedNatGwShortIds = new Set<string>();

  // Place VNets
  for (const vnet of vnetNodes) {
    const vShortId = idMap.get(vnet.id)!;
    const vSize = vnetInfo.get(vShortId) ?? { width: 600, height: 300 };
    let natGwSlot = 0; // per-VNet counter for stacking multiple NAT GW cards vertically

    diagramNodes.push({
      id: vShortId,
      label: vnet.name,
      icon: "vnet",
      nodeType: "group",
      width: vSize.width,
      height: vSize.height,
      azureResourceId: vnet.azureId,
      endpoint: vnet.endpoint,
      position: { x: 40, y: cursorY },
      bindings: {},
      metadata: vnet.endpoint ? { addressSpace: vnet.endpoint } : undefined,
      resourceKind: "vnet",
      location: vnet.location,
      resourceGroup: vnet.resourceGroup,
      tags: vnet.tags,
    });

    // Place subnets within VNet (sorted by tier)
    const subs = vnetSubnets.get(vShortId) ?? [];
    subs.sort((a, b) => {
      const ta = subnetInfo.get(a.shortId)?.tier ?? 2;
      const tb = subnetInfo.get(b.shortId)?.tier ?? 2;
      return ta - tb;
    });

    let subX = VNET_PAD;
    for (const sub of subs) {
      const sInfo = subnetInfo.get(sub.shortId);
      if (!sInfo) continue;

      const attachedNatGwOrigId = subnetToNatGw.get(sub.node.id);
      const subnetMeta: Record<string, string> = {};
      if (sub.node.endpoint) subnetMeta.prefix = sub.node.endpoint;
      // The route table, each next hop resolved (azure.ts resolveSubnetRoutes) — the subnet panel and the UDR lines
      if (sub.node.metadata?.udrRoutes && typeof sub.node.metadata.udrRoutes === "object") {
        subnetMeta.udrRoutes = JSON.stringify(sub.node.metadata.udrRoutes);
        pendingUdrSubnets.push({ subnetShortId: sub.shortId, origId: sub.node.id });
      }
      // Embed NAT GW badge info in subnet metadata so GroupNode can render it
      if (attachedNatGwOrigId) {
        const natGwNode = graph.nodes.find((n) => n.id === attachedNatGwOrigId);
        if (natGwNode) {
          const ngwShortId = idMap.get(attachedNatGwOrigId) ?? shortId(natGwNode.azureId ?? attachedNatGwOrigId);
          subnetMeta.natGwBadgeId = ngwShortId;
          subnetMeta.natGwBadgeLabel = natGwNode.name;
          if (natGwNode.azureId) subnetMeta.natGwBadgeAzureId = natGwNode.azureId;
        }
      }

      diagramNodes.push({
        id: sub.shortId,
        label: sub.node.name,
        icon: "subnet",
        nodeType: "group",
        parentId: vShortId,
        width: sInfo.width,
        height: sInfo.height,
        azureResourceId: sub.node.azureId,
        endpoint: sub.node.endpoint,
        position: { x: subX, y: VNET_HEADER },
        bindings: {},
        metadata: Object.keys(subnetMeta).length > 0 ? subnetMeta : undefined,
        resourceKind: "subnet",
        location: sub.node.location,
        resourceGroup: sub.node.resourceGroup,
      });

      // Place resources within subnet — NSG badges first (compact), then regular nodes
      const children = subnetChildren.get(sub.shortId) ?? [];
      const nsgChildren = children.filter((c) => c.node.kind === "nsg");
      const regularChildren = children.filter((c) => c.node.kind !== "nsg");

      // Sort by archGroupId so related resources are placed consecutively
      regularChildren.sort((a, b) => {
        const ga = archMetaMap.get(a.node.id)?.archGroupId ?? "";
        const gb = archMetaMap.get(b.node.id)?.archGroupId ?? "";
        return ga.localeCompare(gb);
      });

      // Cat 1: Subnet NSG badges — embedded in GroupNode header (not separate ReactFlow nodes)
      for (const nsgChild of nsgChildren) {
        diagramNodes.push({
          id: nsgChild.shortId,
          label: nsgChild.node.name,
          icon: KIND_TO_ICON[nsgChild.node.kind] ?? "nsg",
          azureResourceId: nsgChild.node.azureId,
          parentId: sub.shortId,
          groupId: inferGroup(nsgChild.node),
          position: { x: 4, y: 2 },  // not used visually — embedded in parent
          bindings: { health: { source: "composite", rules: [] } },
          resourceKind: nsgChild.node.kind,
          location: nsgChild.node.location,
          resourceGroup: nsgChild.node.resourceGroup,
          tags: nsgChild.node.tags,
          metadata: { nsgAttachedTo: sub.shortId },
        });
      }

      // Regular nodes start at normal SUBNET_HEADER (NSG badge overlaps header, no extra row)
      let childY = SUBNET_HEADER;
      for (let ci = 0; ci < regularChildren.length; ci++) {
        const child = regularChildren[ci]!;

        // Cat 2/3: NSG badge — embedded in LiveNode (not separate ReactFlow node)
        const attachedNsg = vmToNsg.get(child.node.id) ?? nicToNsg.get(child.node.id);
        if (attachedNsg) {
          const nsgSid = idMap.get(attachedNsg.id) ?? shortId(attachedNsg.azureId ?? attachedNsg.id);
          diagramNodes.push({
            id: nsgSid,
            label: attachedNsg.name,
            icon: KIND_TO_ICON[attachedNsg.kind] ?? "nsg",
            azureResourceId: attachedNsg.azureId,
            parentId: sub.shortId,
            groupId: inferGroup(attachedNsg),
            position: { x: SUBNET_INNER_PAD, y: childY },  // not used visually — embedded in target
            bindings: { health: { source: "composite", rules: [] } },
            resourceKind: attachedNsg.kind,
            location: attachedNsg.location,
            resourceGroup: attachedNsg.resourceGroup,
            tags: attachedNsg.tags,
            metadata: { nsgAttachedTo: child.shortId },
          });
          // No extra height — badge is embedded inside target node
        }

        // Build subResources for VM (bound NICs) and AppGW (frontend IPs)
        // Same chips as every other placement (NICs, the VM public IP, frontend IPs) — one builder
        const childSubResources: SubResource[] = collectSubResources(child.node.id) ?? [];

        const childArchMeta = archMetaMap.get(child.node.id);

        // AKS plane metadata enrichment — pass through agentPoolProfiles, networkProfile, etc.
        const aksPlaneMetadata: Record<string, string> = {};
        if (child.node.kind === "aks" && child.node.metadata) {
          const m = child.node.metadata;
          if (m.fqdn) aksPlaneMetadata.fqdn = String(m.fqdn);
          if (m.privateFqdn) aksPlaneMetadata.privateFqdn = String(m.privateFqdn);
          if (m.isPrivateCluster != null) aksPlaneMetadata.isPrivateCluster = String(m.isPrivateCluster);
          if (m.kubernetesVersion) aksPlaneMetadata.kubernetesVersion = String(m.kubernetesVersion);
          if (m.nodeResourceGroup) aksPlaneMetadata.nodeResourceGroup = String(m.nodeResourceGroup);
          if (m.agentPoolProfiles) aksPlaneMetadata.agentPoolProfiles = JSON.stringify(m.agentPoolProfiles);
          if (m.networkProfile) aksPlaneMetadata.networkProfile = JSON.stringify(m.networkProfile);
          if (m.authorizedIpRanges) aksPlaneMetadata.authorizedIpRanges = JSON.stringify(m.authorizedIpRanges);
          if (m.enablePrivateClusterPublicFqdn != null) aksPlaneMetadata.enablePrivateClusterPublicFqdn = String(m.enablePrivateClusterPublicFqdn);
          if (m.privateDnsZone) aksPlaneMetadata.privateDnsZone = String(m.privateDnsZone);
          const netProfile = m.networkProfile as Record<string, unknown> | undefined;
          if (netProfile?.outboundType) aksPlaneMetadata.outboundType = String(netProfile.outboundType);
        }

        // AKS-VMSS: enrich with nodepool info from parent AKS cluster
        if (child.node.kind === "vmss" && childArchMeta?.archRole === "aks-vmss") {
          // Find the parent AKS cluster and match this VMSS to its agent pool
          // The cluster this pool was linked to by its graph edge (two clusters may share a name across RGs)
          const parentAksId = childArchMeta.aksNodeId;
          if (parentAksId) {
            const parentAksNode = graph.nodes.find((n) => n.id === parentAksId);
            // Pass AKS cluster ARM ID for K8s API calls (IP, conditions, nodeImageVersion)
            if (parentAksNode?.azureId) {
              aksPlaneMetadata.aksClusterArmId = parentAksNode.azureId;
            }
            // Propagate outboundType from parent AKS cluster network profile
            const aksNetProfile = parentAksNode?.metadata?.networkProfile as Record<string, unknown> | undefined;
            if (aksNetProfile?.outboundType) {
              aksPlaneMetadata.outboundType = String(aksNetProfile.outboundType);
            }
            const pools = parentAksNode?.metadata?.agentPoolProfiles as Array<Record<string, unknown>> | undefined;
            if (pools && pools.length > 0) {
              // Match by VMSS name convention: aks-{poolname}-{hash}-vmss
              const vmssName = child.node.name.toLowerCase();
              const matchedPool = pools.find((p) => {
                const poolName = String(p.name ?? "").toLowerCase();
                return vmssName.includes(poolName);
              }) ?? pools[0]; // fallback to first pool
              if (matchedPool) {
                aksPlaneMetadata.nodepoolName = String(matchedPool.name ?? "");
                aksPlaneMetadata.nodepoolMode = String(matchedPool.mode ?? "User");
                aksPlaneMetadata.nodepoolVmSize = String(matchedPool.vmSize ?? "");
                aksPlaneMetadata.nodepoolCount = String(matchedPool.count ?? 0);
                aksPlaneMetadata.nodepoolPowerState = String(matchedPool.powerState ?? "Running");
                if (matchedPool.enableAutoScaling) {
                  aksPlaneMetadata.nodepoolAutoScale = `${matchedPool.minCount ?? 0}-${matchedPool.maxCount ?? 0}`;
                }
              }
            }
          }
        }

        diagramNodes.push({
          id: child.shortId,
          label: child.node.name,
          icon: KIND_TO_ICON[child.node.kind] ?? "custom",
          azureResourceId: child.node.azureId,
          endpoint: child.node.endpoint,
          parentId: sub.shortId,
          groupId: inferGroup(child.node),
          position: { x: SUBNET_INNER_PAD, y: childY },
          bindings: NODE_BINDINGS[child.node.kind] ?? {
            health: { source: "composite", rules: [] },
          },
          metadata: {
            ...(child.node.endpoint ? { privateIP: child.node.endpoint } : {}),
            ...(childArchMeta ? { archRole: childArchMeta.archRole, archGroupId: childArchMeta.archGroupId, flowHint: childArchMeta.flowHint } : {}),
            ...aksPlaneMetadata,
          },
          resourceKind: child.node.kind,
          location: child.node.location,
          resourceGroup: child.node.resourceGroup,
          tags: child.node.tags,
          subResources: childSubResources.length > 0 ? childSubResources : undefined,
        });
        childY += effectiveNodeH(child.node) + NODE_GAP;
      }

      // NAT GW node — no parentId, positioned globally to the right of the VNet.
      // Starts embedded as badge in subnet header; expanded to card on user interaction.
      if (attachedNatGwOrigId) {
        const natGwNode = graph.nodes.find((n) => n.id === attachedNatGwOrigId);
        if (natGwNode) {
          const ngwShortId = idMap.get(attachedNatGwOrigId) ?? shortId(natGwNode.azureId ?? attachedNatGwOrigId);
          if (!addedNatGwShortIds.has(ngwShortId)) {
            addedNatGwShortIds.add(ngwShortId);
            // Collect attached PIPs as sub-resources
            const natGwSubResources: SubResource[] = [];
            for (const pipOrigId of natGwToPips.get(attachedNatGwOrigId) ?? []) {
              const pipNode = graph.nodes.find((n) => n.id === pipOrigId);
              if (!pipNode) continue;
              const pipShortId = idMap.get(pipOrigId) ?? shortId(pipNode.azureId ?? pipOrigId);
              natGwSubResources.push({
                id: pipShortId, label: pipNode.name, kind: "publicIP" as SubResourceKind,
                endpoint: pipNode.endpoint, azureResourceId: pipNode.azureId,
              });
            }
            if (natGwSubResources.length === 0 && natGwNode.endpoint) {
              natGwSubResources.push({
                id: `${ngwShortId}/pip/0`, label: "Public IP",
                kind: "publicIP" as SubResourceKind, endpoint: natGwNode.endpoint,
              });
            }
            // Position: inside VNet, right column (after subnets), stacked vertically per VNet
            const natGwX = vSize.width - NODE_W - VNET_PAD;
            const natGwY = VNET_HEADER + VNET_PAD + natGwSlot * (NODE_H + 20);
            natGwSlot++;
            diagramNodes.push({
              id: ngwShortId,
              label: natGwNode.name,
              icon: "natGateway" as DiagramIconKind,
              azureResourceId: natGwNode.azureId,
              groupId: inferGroup(natGwNode),
              parentId: vShortId,
              position: { x: natGwX, y: natGwY },
              bindings: { health: { source: "composite", rules: [] } },
              resourceKind: natGwNode.kind,
              location: natGwNode.location,
              resourceGroup: natGwNode.resourceGroup,
              tags: natGwNode.tags,
              endpoint: natGwNode.endpoint,
              subResources: natGwSubResources.length > 0 ? natGwSubResources : undefined,
            });
          }
          // Store subnet → NAT GW pair; converted to diagram edges after makeEdge is available
          pendingNatGwAssocEdges.push({ subnetShortId: sub.shortId, ngwShortId });
        }
      }

      subX += sInfo.width + SUBNET_GAP;
    }

    cursorY += vSize.height + EXTERNAL_GAP;
  }

  // Identify resources NOT inside any subnet
  const containedResourceIds = new Set<string>();
  for (const children of subnetChildren.values()) {
    for (const c of children) containedResourceIds.add(c.shortId);
  }
  // Cat 2/3 NSGs are placed inside subnets (above their target VM/NIC)
  for (const nsgId of nsgToVm.keys()) {
    const sid = idMap.get(nsgId);
    if (sid) containedResourceIds.add(sid);
  }
  for (const nsgId of nsgToStandaloneNic.keys()) {
    const sid = idMap.get(nsgId);
    if (sid) containedResourceIds.add(sid);
  }

  const vnetSubnetIds = new Set([
    ...vnetNodes.map((n) => idMap.get(n.id)!),
    ...subnetNodes.map((n) => idMap.get(n.id)!),
  ]);

  const externalResources = resourceNodes.filter((n) => {
    if (embeddedNatGwOrigIds.has(n.id)) return false; // NAT GW placed as child card inside subnet
    if (natGwPipOrigIds.has(n.id)) return false;      // PIP belonging to embedded NAT GW → sub-resource
    const sid = idMap.get(n.id)!;
    return !containedResourceIds.has(sid) && !vnetSubnetIds.has(sid);
  });

  // ── ResourceGroup fallback: When no VNet/Subnet exists, group by RG ──
  if (vnetNodes.length === 0 && subnetNodes.length === 0 && externalResources.length > 0) {
    debug(`[specGenerator] No VNet/Subnet found — using ResourceGroup-based grouping for ${externalResources.length} resources`);
    const rgGroups = new Map<string, ArchitectureNode[]>();
    for (const res of externalResources) {
      const rg = res.resourceGroup ?? "ungrouped";
      const arr = rgGroups.get(rg) ?? [];
      arr.push(res);
      rgGroups.set(rg, arr);
    }

    const rgContainedIds = new Set<string>();
    for (const [rgName, members] of rgGroups) {
      if (members.length < 2) continue; // Skip single-resource RGs
      const rgShortId = `rg-${rgName.toLowerCase().replace(/[^a-z0-9-]/g, "")}`;
      const rgH = VNET_HEADER + members.length * NODE_H + Math.max(0, members.length - 1) * NODE_GAP + VNET_PAD;
      const rgW = NODE_W + 2 * VNET_PAD;

      diagramNodes.push({
        id: rgShortId,
        label: rgName,
        icon: "resourceGroup",
        nodeType: "group",
        width: rgW,
        height: rgH,
        position: { x: 40, y: cursorY },
        bindings: {},
      });

      for (let ci = 0; ci < members.length; ci++) {
        const res = members[ci]!;
        const resShortId = idMap.get(res.id)!;
        const isDetachedNsg = res.kind === "nsg" && standaloneNsgIds.has(res.id);
        rgContainedIds.add(resShortId);
        const rgArchMeta = archMetaMap.get(res.id);
        diagramNodes.push({
          id: resShortId,
          label: res.name,
          icon: KIND_TO_ICON[res.kind] ?? "custom",
          azureResourceId: res.azureId,
          endpoint: res.endpoint,
          parentId: rgShortId,
          groupId: inferGroup(res),
          resourceKind: res.kind,
          location: res.location,
          resourceGroup: res.resourceGroup,
          tags: res.tags,
          position: { x: VNET_PAD, y: VNET_HEADER + ci * (NODE_H + NODE_GAP) },
          bindings: NODE_BINDINGS[res.kind] ?? { health: { source: "composite", rules: [] } },
          subResources: collectSubResources(res.id),
          metadata: {
            ...(isDetachedNsg ? { detached: "true" } : {}),
            ...(rgArchMeta ? { archRole: rgArchMeta.archRole, archGroupId: rgArchMeta.archGroupId, flowHint: rgArchMeta.flowHint } : {}),
          },
        });
      }
      cursorY += rgH + EXTERNAL_GAP;
    }

    // Place remaining ungrouped resources (single-resource RGs)
    const ungrouped = externalResources.filter(r => !rgContainedIds.has(idMap.get(r.id)!));
    if (ungrouped.length > 0) {
      ungrouped.sort((a, b) => {
        const tierA = DATA_KINDS.has(a.kind) ? 0 : COMPUTE_KINDS.has(a.kind) ? 1 : 2;
        const tierB = DATA_KINDS.has(b.kind) ? 0 : COMPUTE_KINDS.has(b.kind) ? 1 : 2;
        return tierA - tierB;
      });
      const cols = Math.min(ungrouped.length, 5);
      for (let i = 0; i < ungrouped.length; i++) {
        const res = ungrouped[i]!;
        const row = Math.floor(i / cols);
        const col = i % cols;
        const ugArchMeta = archMetaMap.get(res.id);
        diagramNodes.push({
          id: idMap.get(res.id)!,
          label: res.name,
          icon: KIND_TO_ICON[res.kind] ?? "custom",
          azureResourceId: res.azureId,
          endpoint: res.endpoint,
          groupId: inferGroup(res),
          resourceKind: res.kind,
          location: res.location,
          resourceGroup: res.resourceGroup,
          tags: res.tags,
          position: {
            x: 40 + col * (NODE_W + NODE_GAP + 20),
            y: cursorY + row * (NODE_H + NODE_GAP),
          },
          bindings: NODE_BINDINGS[res.kind] ?? { health: { source: "composite", rules: [] } },
          subResources: collectSubResources(res.id),
          metadata: ugArchMeta ? { archRole: ugArchMeta.archRole, archGroupId: ugArchMeta.archGroupId, flowHint: ugArchMeta.flowHint } : undefined,
        });
      }
    }
  }

  // Place external resources below VNets — PaaS resources near their PE's subnet (when VNets exist)
  if ((vnetNodes.length > 0 || subnetNodes.length > 0) && externalResources.length > 0) {
    // ── Build PE → PaaS target mapping ──
    // privateLink edges: PE → target PaaS resource
    const peTargetMap = new Map<string, string>(); // PE origId → PaaS origId
    const paasToSubnetPos = new Map<string, { subnetX: number; vnetX: number; vnetShortId: string }>(); // PaaS shortId → position hint
    for (const edge of graph.edges) {
      if (edge.kind !== "privateLink") continue;
      const srcKind = nodeKindLookup.get(edge.source);
      if (srcKind === "privateEndpoint") {
        peTargetMap.set(edge.source, edge.target);
      }
    }

    // For each PE with a target, find the subnet the PE lives in and its horizontal position
    for (const [peOrigId, paasOrigId] of peTargetMap) {
      const peShortId = idMap.get(peOrigId);
      const paasShortId = idMap.get(paasOrigId);
      if (!peShortId || !paasShortId) continue;

      // Find the PE's subnet via containment
      const peSubnetOrigId = containment.resourceSubnet.get(peOrigId);
      if (!peSubnetOrigId) continue;
      const peSubnetShortId = idMap.get(peSubnetOrigId);
      if (!peSubnetShortId) continue;

      // Find the subnet's position in the diagram
      const subnetSpec = diagramNodes.find(n => n.id === peSubnetShortId);
      if (!subnetSpec || !subnetSpec.parentId) continue;
      const vnetSpec = diagramNodes.find(n => n.id === subnetSpec.parentId);
      if (!vnetSpec) continue;

      // Compute absolute X position of the subnet
      const subnetAbsX = (vnetSpec.position?.x ?? 0) + (subnetSpec.position?.x ?? 0);
      paasToSubnetPos.set(paasShortId, { subnetX: subnetAbsX, vnetX: vnetSpec.position?.x ?? 0, vnetShortId: vnetSpec.id });
    }

    // A public IP on a NIC that no VM uses (the NIC is only a subnet's count here): it reaches nothing — unused, with
    // that reason, instead of an "outside the VNet" card with no owner in view (catalog PIP-01)
    const nicsWithVm = new Set(graph.edges.filter((e) => e.kind === "bound-to").map((e) => e.source.toLowerCase()));
    const pipOnVmlessNic = (res: ArchitectureNode) => {
      const owner = typeof res.metadata?.attachedTo === "string" ? res.metadata.attachedTo.toLowerCase() : "";
      return /\/microsoft\.network\/networkinterfaces\//.test(owner) && !nicsWithVm.has(owner);
    };

    // Split external resources: PE-connected PaaS vs others
    const peConnectedPaaS: ArchitectureNode[] = [];
    const otherExternal: ArchitectureNode[] = [];
    for (const res of externalResources) {
      const sid = idMap.get(res.id)!;
      if (paasToSubnetPos.has(sid)) {
        peConnectedPaaS.push(res);
      } else {
        otherExternal.push(res);
      }
    }

    // Group PaaS resources by VNet short ID (hoisted — also used by otherExternal placement)
    const paasByVnet = new Map<string, Array<{ res: ArchitectureNode; sid: string }>>();

    // Place PE-connected PaaS BELOW their associated VNet (not in global grid)
    if (peConnectedPaaS.length > 0) {
      debug(`[specGenerator] PE-connected PaaS: ${peConnectedPaaS.length} resources positioned below their VNet`);

      const unassocPaaS: Array<{ res: ArchitectureNode; sid: string }> = [];
      for (const res of peConnectedPaaS) {
        const sid = idMap.get(res.id)!;
        const posHint = paasToSubnetPos.get(sid)!;
        if (posHint.vnetShortId) {
          const arr = paasByVnet.get(posHint.vnetShortId) ?? [];
          arr.push({ res, sid });
          paasByVnet.set(posHint.vnetShortId, arr);
        } else {
          unassocPaaS.push({ res, sid });
        }
      }

      // Place each VNet's PaaS group directly below that VNet
      for (const [vnetShortId, paasGroup] of paasByVnet) {
        const vnetSpec = diagramNodes.find(n => n.id === vnetShortId);
        if (!vnetSpec) continue;
        const baseX = vnetSpec.position?.x ?? 40;
        const baseY = (vnetSpec.position?.y ?? 0) + (vnetSpec.height ?? 300) + EXTERNAL_GAP;

        paasGroup.forEach(({ res, sid }, i) => {
          const col = i % 4;
          const row = Math.floor(i / 4);
          const peArchMeta = archMetaMap.get(res.id);
          diagramNodes.push({
            id: sid,
            label: res.name,
            icon: KIND_TO_ICON[res.kind] ?? "custom",
            azureResourceId: res.azureId,
            endpoint: res.endpoint,
            groupId: inferGroup(res),
            resourceKind: res.kind,
            location: res.location,
            resourceGroup: res.resourceGroup,
            tags: res.tags,
            position: { x: baseX + col * (NODE_W + NODE_GAP), y: baseY + row * (NODE_H + NODE_GAP) },
            bindings: NODE_BINDINGS[res.kind] ?? { health: { source: "composite", rules: [] } },
            subResources: collectSubResources(res.id),
            metadata: peArchMeta ? { archRole: peArchMeta.archRole, archGroupId: peArchMeta.archGroupId, flowHint: peArchMeta.flowHint } : undefined,
          });
        });
      }

      // Unassociated PaaS: fall back to global cursorY grid
      for (let i = 0; i < unassocPaaS.length; i++) {
        const { res, sid } = unassocPaaS[i]!;
        const col = i % 5;
        const row = Math.floor(i / 5);
        const peArchMeta = archMetaMap.get(res.id);
        diagramNodes.push({
          id: sid,
          label: res.name,
          icon: KIND_TO_ICON[res.kind] ?? "custom",
          azureResourceId: res.azureId,
          endpoint: res.endpoint,
          groupId: inferGroup(res),
          resourceKind: res.kind,
          location: res.location,
          resourceGroup: res.resourceGroup,
          tags: res.tags,
          position: { x: 40 + col * (NODE_W + NODE_GAP + 20), y: cursorY + row * (NODE_H + NODE_GAP) },
          bindings: NODE_BINDINGS[res.kind] ?? { health: { source: "composite", rules: [] } },
          subResources: collectSubResources(res.id),
          metadata: peArchMeta ? { archRole: peArchMeta.archRole, archGroupId: peArchMeta.archGroupId, flowHint: peArchMeta.flowHint } : undefined,
        });
      }
      if (unassocPaaS.length > 0) cursorY += NODE_H + EXTERNAL_GAP;
    }

    // Place remaining external resources — group by connected VNet when possible
    if (otherExternal.length > 0) {
      otherExternal.sort((a, b) => {
        const tierA = DATA_KINDS.has(a.kind) ? 0 : COMPUTE_KINDS.has(a.kind) ? 1 : 2;
        const tierB = DATA_KINDS.has(b.kind) ? 0 : COMPUTE_KINDS.has(b.kind) ? 1 : 2;
        return tierA - tierB;
      });

      // Build specNodeToVnet: spec short ID → owning VNet spec short ID
      const specNodeToVnet = new Map<string, string>();
      for (const dn of diagramNodes) {
        if (dn.nodeType === "group" && dn.icon === "vnet") specNodeToVnet.set(dn.id, dn.id);
      }
      for (const dn of diagramNodes) {
        if (specNodeToVnet.has(dn.id)) continue;
        let cur: typeof dn | undefined = dn;
        while (cur?.parentId) {
          if (specNodeToVnet.has(cur.parentId)) { specNodeToVnet.set(dn.id, specNodeToVnet.get(cur.parentId)!); break; }
          cur = diagramNodes.find(n => n.id === cur!.parentId);
        }
      }

      // Map each otherExternal to a VNet via graph edge traversal
      const externalToVnet = new Map<string, string>(); // sid → vnetShortId
      for (const res of otherExternal) {
        const sid = idMap.get(res.id);
        if (!sid) continue;
        for (const edge of graph.edges) {
          const peerOrigId = edge.source === res.id ? edge.target : edge.target === res.id ? edge.source : undefined;
          if (!peerOrigId) continue;
          const peerShortId = idMap.get(peerOrigId);
          if (!peerShortId) continue;
          const vnet = specNodeToVnet.get(peerShortId);
          if (vnet) { externalToVnet.set(sid, vnet); break; }
        }
      }

      // Group by VNet
      const extByVnet = new Map<string, Array<{ res: ArchitectureNode; sid: string }>>();
      const unconnectedExt: Array<{ res: ArchitectureNode; sid: string }> = [];
      for (const res of otherExternal) {
        const sid = idMap.get(res.id)!;
        const vnetId = externalToVnet.get(sid);
        if (vnetId) {
          const arr = extByVnet.get(vnetId) ?? [];
          arr.push({ res, sid });
          extByVnet.set(vnetId, arr);
        } else {
          unconnectedExt.push({ res, sid });
        }
      }

      // Place VNet-connected external resources below their VNet (below any already-placed PaaS rows)
      for (const [vnetShortId, extGroup] of extByVnet) {
        const vnetSpec = diagramNodes.find(n => n.id === vnetShortId);
        if (!vnetSpec) continue;
        const paasCount = paasByVnet.get(vnetShortId)?.length ?? 0;
        const paasRows = Math.ceil(paasCount / 4);
        const paasHeight = paasRows > 0 ? paasRows * (NODE_H + NODE_GAP) + NODE_GAP : 0;
        const baseX = vnetSpec.position?.x ?? 40;
        const baseY = (vnetSpec.position?.y ?? 0) + (vnetSpec.height ?? 300) + EXTERNAL_GAP + paasHeight;

        extGroup.forEach(({ res, sid }, i) => {
          const col = i % 4;
          const row = Math.floor(i / 4);
          const isDetachedNsg = res.kind === "nsg" && standaloneNsgIds.has(res.id);
          const isUnusedPip = res.kind === "publicIP" && (res.metadata?.unused === true || pipOnVmlessNic(res));
          const extArchMeta = archMetaMap.get(res.id);
          diagramNodes.push({
            id: sid,
            label: res.name,
            icon: KIND_TO_ICON[res.kind] ?? "custom",
            azureResourceId: res.azureId,
            endpoint: res.endpoint,
            groupId: inferGroup(res),
            resourceKind: res.kind,
            location: res.location,
            resourceGroup: res.resourceGroup,
            tags: res.tags,
            position: { x: baseX + col * (NODE_W + NODE_GAP), y: baseY + row * (NODE_H + NODE_GAP) },
            bindings: NODE_BINDINGS[res.kind] ?? { health: { source: "composite", rules: [] } },
            subResources: collectSubResources(res.id),
            metadata: {
              ...(isDetachedNsg ? { detached: "true" } : {}),
              ...(isUnusedPip ? { unused: "true", unusedReason: res.metadata?.unused === true ? "notAttached" : "nicNoVm" } : {}),
              ...(extArchMeta ? { archRole: extArchMeta.archRole, archGroupId: extArchMeta.archGroupId, flowHint: extArchMeta.flowHint } : {}),
            },
          });
        });
      }

      // Unconnected external resources: flat grid at cursorY
      if (unconnectedExt.length > 0) {
        const cols = Math.min(unconnectedExt.length, 5);
        unconnectedExt.forEach(({ res, sid }, i) => {
          const col = i % cols;
          const row = Math.floor(i / cols);
          const isDetachedNsg = res.kind === "nsg" && standaloneNsgIds.has(res.id);
          const isUnusedPip = res.kind === "publicIP" && (res.metadata?.unused === true || pipOnVmlessNic(res));
          const extArchMeta = archMetaMap.get(res.id);
          diagramNodes.push({
            id: sid,
            label: res.name,
            icon: KIND_TO_ICON[res.kind] ?? "custom",
            azureResourceId: res.azureId,
            endpoint: res.endpoint,
            groupId: inferGroup(res),
            resourceKind: res.kind,
            location: res.location,
            resourceGroup: res.resourceGroup,
            tags: res.tags,
            position: { x: 40 + col * (NODE_W + NODE_GAP + 20), y: cursorY + row * (NODE_H + NODE_GAP) },
            bindings: NODE_BINDINGS[res.kind] ?? { health: { source: "composite", rules: [] } },
            subResources: collectSubResources(res.id),
            metadata: {
              ...(isDetachedNsg ? { detached: "true" } : {}),
              ...(isUnusedPip ? { unused: "true", unusedReason: res.metadata?.unused === true ? "notAttached" : "nicNoVm" } : {}),
              ...(extArchMeta ? { archRole: extArchMeta.archRole, archGroupId: extArchMeta.archGroupId, flowHint: extArchMeta.flowHint } : {}),
            },
          });
        });
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // ██ FORCE parentId INJECTION (post-processing safety net) ██
  // Even if containment maps worked, this ensures parentId is ALWAYS set.
  // Uses Azure resource ID hierarchy as the source of truth.
  // ══════════════════════════════════════════════════════════════════

  // Build lowercase azureResourceId → spec node lookup
  const azureIdToSpecNode = new Map<string, DiagramNodeSpec>();
  for (const n of diagramNodes) {
    if (n.azureResourceId) {
      azureIdToSpecNode.set(n.azureResourceId.toLowerCase(), n);
    }
  }

  let forceSubnetParent = 0;
  let forceResourceParent = 0;

  // (A) Force Subnet → VNet parentId from Azure resource ID
  for (const n of diagramNodes) {
    if (n.parentId) continue;
    if (n.icon !== "subnet") continue;
    if (!n.azureResourceId) continue;

    const azIdLower = n.azureResourceId.toLowerCase();
    const idx = azIdLower.lastIndexOf("/subnets/");
    if (idx <= 0) continue;
    const parentVnetAzureId = azIdLower.slice(0, idx);
    const parentSpec = azureIdToSpecNode.get(parentVnetAzureId);
    if (parentSpec) {
      n.parentId = parentSpec.id;
      if (!parentSpec.nodeType) parentSpec.nodeType = "group";
      forceSubnetParent++;
      debug(`[force-parentId] Subnet "${n.id}" → VNet "${parentSpec.id}"`);
    }
  }

  // (B) Force NIC/Resource → Subnet parentId from containment maps
  // Build reverse: original graph ID → spec short ID using idMap
  const origIdToSpecId = new Map<string, string>();
  for (const [origId, sId] of idMap) {
    origIdToSpecId.set(origId.toLowerCase(), sId);
  }

  for (const n of diagramNodes) {
    if (n.parentId) continue;
    if (n.nodeType === "group") continue;
    if (!n.azureResourceId) continue;

    // Skip PaaS/data resources — they're external services positioned outside VNet.
    // Only their Private Endpoints belong inside subnets, not the PaaS resources themselves.
    if (n.resourceKind && DATA_KINDS.has(n.resourceKind)) continue;
    // Also skip App Insights / Log Analytics — always external PaaS
    if (n.resourceKind === "appInsights" || n.resourceKind === "logAnalytics") continue;

    // Try containment.resourceSubnet (uses original graph IDs)
    const azIdLower = n.azureResourceId.toLowerCase();
    // Find original graph ID that matches (may differ in case from azureResourceId)
    let subnetOrigId: string | undefined;
    for (const [origId, subId] of containment.resourceSubnet) {
      if (origId.toLowerCase() === azIdLower) {
        subnetOrigId = subId;
        break;
      }
    }
    if (!subnetOrigId) continue;

    // Find subnet spec node
    const subnetSpecId = origIdToSpecId.get(subnetOrigId.toLowerCase());
    if (subnetSpecId) {
      const subnetSpec = diagramNodes.find(sn => sn.id === subnetSpecId);
      if (subnetSpec) {
        n.parentId = subnetSpecId;
        if (!subnetSpec.nodeType) subnetSpec.nodeType = "group";
        forceResourceParent++;
      }
    }
  }

  if (forceSubnetParent > 0 || forceResourceParent > 0) {
    debug(`[force-parentId] Forced ${forceSubnetParent} subnet→VNet + ${forceResourceParent} resource→subnet parentIds`);
  }

  // ── Retarget edges from embedded NICs to their parent VMs ──
  // When a NIC is absorbed as a sub-resource of a VM, edges like LB→NIC
  // would be dropped because the NIC is no longer a separate node.
  // We redirect them to the parent VM so the flow is preserved.
  const retargetedEdges = graph.edges.map((e) => {
    // NIC→VM absorption: redirect edges that point to VM-bound NICs → parent VM
    const newSourceVm = nicToVmBound.get(e.source);
    const newTargetVm = nicToVmBound.get(e.target);
    // NIC→PIP absorption: redirect edges that point to standalone NICs → parent PIP card
    const newSourcePip = nicToPipOrigId.get(e.source);
    const newTargetPip = nicToPipOrigId.get(e.target);
    const newSource = newSourceVm ?? newSourcePip;
    const newTarget = newTargetVm ?? newTargetPip;
    if (!newSource && !newTarget) return e;
    return { ...e, source: newSource ?? e.source, target: newTarget ?? e.target };
  }).filter((e) => e.source !== e.target); // drop self-loops

  // ── Build edges (all non-containment edges between visible nodes) ──
  // member-of (Flexible VM → scale set) is membership shown as a chip on the VM card, not a line (VMSS-03)
  const CONTAINMENT_KINDS: Set<EdgeKind> = new Set(["contains", "member-of"]);
  const filteredEdgesNoNetwork = retargetedEdges.filter(
    (e) =>
      !CONTAINMENT_KINDS.has(e.kind) &&
      nodeOriginalIds.has(e.source) &&
      nodeOriginalIds.has(e.target) &&
      !isNetworkContainer(graph, e.source) &&
      !isNetworkContainer(graph, e.target),
  );

  const edgeSeen = new Set<string>();
  const uniqueEdges: ArchitectureEdge[] = [];
  for (const edge of filteredEdgesNoNetwork) {
    const key = `${edge.source}→${edge.target}`;
    if (!edgeSeen.has(key)) {
      edgeSeen.add(key);
      uniqueEdges.push(edge);
    }
  }

  const edgeIdSeen = new Set<string>();

  function makeEdge(
    srcId: string,
    tgtId: string,
    srcKind: string,
    label?: string,
    protocol?: string,
    edgeKind?: DiagramEdgeKind,
    confidence?: number,
    flowType?: DiagramFlowType,
    inferenceReasons?: string[],
  ): DiagramEdgeSpec {
    let edgeId = `${srcId}-to-${tgtId}`;
    if (edgeIdSeen.has(edgeId)) {
      let suffix = 2;
      while (edgeIdSeen.has(`${edgeId}-${suffix}`)) suffix++;
      edgeId = `${edgeId}-${suffix}`;
    }
    edgeIdSeen.add(edgeId);

    return {
      id: edgeId,
      source: srcId,
      target: tgtId,
      label,
      protocol,
      edgeKind,
      confidence,
      evidence: edgeKind === "inferred" ? "inferred" as const : "configured" as const,
      ...(inferenceReasons ? { inferenceReasons } : {}),
      flowType,
      bindings: {},
      animation: edgeKind === "logging" || edgeKind === "inferred" ? "dash" as const : "flow" as const,
    };
  }

  // Map ArchitectureEdge.kind → DiagramEdgeKind
  function toDiagramEdgeKind(kind: EdgeKind): DiagramEdgeKind | undefined {
    switch (kind) {
      case "network": case "connects": return "network";
      case "peering": return "peering";
      case "privateLink": return "privateLink";
      case "routes": return "routes";
      case "logging": return "logging";
      case "inferred": return "inferred";
      case "attached-to": return "attached-to";
      case "bound-to": return "bound-to";
      default: return undefined;
    }
  }

  // Edge label helpers for typed edges
  function edgeKindLabel(kind: EdgeKind, edge: ArchitectureEdge): string | undefined {
    switch (kind) {
      case "peering": return `VNet Peering (${edge.metadata?.peeringState ?? "Connected"})`;
      case "privateLink": return "Private Link";
      case "logging": return edge.metadata?.diagnosticCategory ?? "Diagnostics";
      case "attached-to": return "Attached";
      case "bound-to": return "NIC Binding";
      default: return undefined;
    }
  }

  // Topology-based edges (explicit from azure.ts)
  const diagramEdges: DiagramEdgeSpec[] = uniqueEdges.map((edge) => {
    const srcId = idMap.get(edge.source)!;
    const tgtId = idMap.get(edge.target)!;
    const srcNode = filteredNodes.find((n) => n.id === edge.source);
    const tgtNode = filteredNodes.find((n) => n.id === edge.target);
    const srcKind = srcNode?.kind ?? "unknown";
    const label = edgeKindLabel(edge.kind, edge) ?? buildEdgeLabel(srcNode, tgtNode);
    const protocol = edge.metadata?.protocol;
    const diagEdgeKind = toDiagramEdgeKind(edge.kind);
    const ft = resolveFlowType(archMetaMap.get(edge.source), archMetaMap.get(edge.target), diagEdgeKind);
    const de = makeEdge(srcId, tgtId, srcKind, label, protocol, diagEdgeKind, undefined, ft);
    const m = edge.metadata;
    if (m?.via && m.direction !== "outbound") {
      const ev = m.evidence === "cfg" || m.evidence === "ipMatch" || m.evidence === "fqdnMatch" ? m.evidence : undefined;
      de.backend = { via: m.via, ...(m.pool ? { pool: m.pool } : {}), ...(m.address ? { address: m.address } : {}), ...(m.ports?.length ? { ports: m.ports } : {}), ...(ev ? { evidence: ev } : {}) };
    }
    // AGC → AKS by "the only cluster in the VNet" (AGC-04 b) is a rule, not configuration: drawn dashed
    if (m?.rel === "AGC-04" && (m.evidence === "nodeRg" || m.evidence === "sameVnet")) de.rule = m.evidence;
    // Front Door origin lines: which origin, and how it was matched (EDGE-04..07)
    if (m?.origin) de.origin = { name: m.origin, group: m.pool ?? "", evidence: m.evidence === "ipMatch" || m.evidence === "fqdnMatch" ? m.evidence : "cfg", ...(m.status ? { status: m.status } : {}) };
    return de;
  });

  // Subnet → NAT GW association edges (collected during node placement, created here)
  for (const { subnetShortId, ngwShortId } of pendingNatGwAssocEdges) {
    diagramEdges.push(makeEdge(subnetShortId, ngwShortId, "subnet", "NAT Gateway", undefined, "natgw-association", undefined, "egress"));
  }

  // Subnet → the next hop its route table names (SEC-04 appliance by ipMatch, NET-07 VNet gateway): one line per
  // (subnet, card) with every prefix that goes there. Configuration — not traffic, not effective routes
  {
    const shortByLower = new Map([...idMap].map(([orig, sid]) => [orig.toLowerCase(), sid] as const));
    type R = { prefix: string; nextHopIp?: string; target?: { id: string; kind: string } };
    for (const { subnetShortId, origId } of pendingUdrSubnets) {
      const g = graph.nodes.find((n) => n.id === origId);
      const ur = g?.metadata?.udrRoutes as { routeTable?: { name: string } | null; routes?: R[] } | undefined;
      const exit = g?.metadata?.egress as { via?: string; targetId?: string } | undefined;
      const byTarget = new Map<string, { kind: string; prefixes: string[]; ip?: string; origTarget: string }>();
      for (const r of ur?.routes ?? []) {
        if (!r.target) continue;
        const sid = shortByLower.get(r.target.id.toLowerCase());
        if (!sid || sid === subnetShortId) continue;
        const cur = byTarget.get(sid) ?? byTarget.set(sid, { kind: r.target.kind, prefixes: [], ...(r.nextHopIp ? { ip: r.nextHopIp } : {}), origTarget: r.target.id.toLowerCase() }).get(sid)!;
        cur.prefixes.push(r.prefix);
      }
      for (const [sid, t] of [...byTarget].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        const edge = makeEdge(subnetShortId, sid, "subnet", undefined, undefined, "udr-route" as DiagramEdgeKind);
        const firstExit = !!exit?.targetId && exit.targetId.toLowerCase() === t.origTarget && (exit.via === "appliance" || exit.via === "gateway");
        edge.route = { routeTable: ur?.routeTable?.name ?? "", prefixes: t.prefixes, ...(t.ip ? { nextHopIp: t.ip } : {}), hop: t.kind === "gateway" ? "gateway" : "appliance", firstExit };
        diagramEdges.push(edge);
      }
    }
  }

  // Dependency-based edges: proximity-scored inference (replaces Cartesian product)
  const existingPairs = new Set<string>();
  for (const e of diagramEdges) {
    existingPairs.add(`${e.source}→${e.target}`);
    existingPairs.add(`${e.target}→${e.source}`);
  }

  const inferredEdges = inferImplicitEdges(graph, filteredNodes, existingPairs, idMap);
  for (const inf of inferredEdges) {
    const cId = idMap.get(inf.source)!;
    const dId = idMap.get(inf.target)!;
    if (!cId || !dId) continue;
    if (existingPairs.has(`${cId}→${dId}`) || existingPairs.has(`${dId}→${cId}`)) continue;

    const srcNode = filteredNodes.find((n) => n.id === inf.source);
    // No label: a guessed link must not read like a configured one (the edge panel says it is a guess)
    const ft = resolveFlowType(archMetaMap.get(inf.source), archMetaMap.get(inf.target), "inferred");
    diagramEdges.push(makeEdge(cId, dId, srcNode?.kind ?? "unknown", undefined, inf.metadata.protocol, "inferred", inf.confidence, ft, inf.reasons));
    existingPairs.add(`${cId}→${dId}`);
  }

  // ── Public load balancers belong to the VNet of their backends (they have no subnet) ──
  // A LB whose frontends are all public IPs is not inside any subnet. Its VNet is the one most of its
  // backends (routes) live in; ties by VNet id; no backend → no VNet. The web draws it in the inbound lane.
  {
    const byId = new Map(diagramNodes.map((x) => [x.id, x]));
    const vnetOf = (id: string): string | undefined => {
      let cur = byId.get(id);
      const seen = new Set<string>();
      while (cur?.parentId && !seen.has(cur.id)) {
        seen.add(cur.id);
        const p = byId.get(cur.parentId);
        if (p?.icon === "vnet") return p.id;
        cur = p;
      }
      return undefined;
    };
    for (const n of diagramNodes) {
      if (n.resourceKind !== "lb" || !n.subResources?.length || !n.subResources.every((sr) => sr.kind === "publicIP")) continue;
      const votes = new Map<string, number>();
      for (const e of diagramEdges) {
        if (e.edgeKind !== "routes" || (e.source !== n.id && e.target !== n.id)) continue;
        const v = vnetOf(e.source === n.id ? e.target : e.source);
        if (v) votes.set(v, (votes.get(v) ?? 0) + 1);
      }
      const best = [...votes.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))[0]?.[0];
      n.parentId = best;
      n.metadata = { ...n.metadata, placement: "public-frontend" };
    }
    // Everything Pass 4 put in a subnet only by resource group is marked as a guess
    const origOf = new Map([...idMap.entries()].map(([orig, sid]) => [sid, orig]));
    for (const n of diagramNodes) {
      const orig = origOf.get(n.id);
      if (orig && containment.rgGuess.has(orig) && n.metadata?.placement !== "public-frontend") {
        n.metadata = { ...n.metadata, placement: "rg-guess" };
      }
    }
  }

  // ── Outbound Internet: per-VNet Internet node + outbound edges ──
  // Azure outbound priority: NAT Gateway > LB SNAT > Instance-level PIP > Default outbound

  // Step 1: Build shortId → vnetShortId lookup from diagramNode parentId chain
  const shortIdToVnet = new Map<string, string>();
  for (const n of diagramNodes) {
    if (!n.parentId) continue;
    const parent = diagramNodes.find((p) => p.id === n.parentId);
    if (!parent) continue;
    if (parent.icon === "vnet") {
      shortIdToVnet.set(n.id, parent.id); // resource/subnet directly under VNet
    } else if (parent.parentId) {
      const gp = diagramNodes.find((p) => p.id === parent.parentId);
      if (gp?.icon === "vnet") shortIdToVnet.set(n.id, gp.id); // resource inside subnet inside VNet
    }
  }

  // Step 2: Detect outbound source nodes
  type OutboundSource = { id: string; label: string; deprecated: boolean };
  const outboundSources: OutboundSource[] = [];
  const outboundSourceSet = new Set<string>();

  // 1. NAT Gateway → Internet: edge source = NAT GW resource card node
  for (const [natGwOrigId, subnetOrigIds] of natGwToSubnets) {
    const ngwShortId = idMap.get(natGwOrigId);
    if (!ngwShortId || outboundSourceSet.has(ngwShortId)) continue;
    // Inherit VNet from one of the attached subnets
    if (!shortIdToVnet.has(ngwShortId)) {
      for (const subOrigId of subnetOrigIds) {
        const subShortId = idMap.get(subOrigId);
        const vnetId = subShortId ? shortIdToVnet.get(subShortId) : undefined;
        if (!vnetId && subShortId) {
          const subSpec = diagramNodes.find((n) => n.id === subShortId);
          if (subSpec?.parentId) { shortIdToVnet.set(ngwShortId, subSpec.parentId); break; }
        } else if (vnetId) { shortIdToVnet.set(ngwShortId, vnetId); break; }
      }
    }
    outboundSources.push({ id: ngwShortId, label: "NAT Gateway", deprecated: false });
    outboundSourceSet.add(ngwShortId);
  }
  // Standalone NAT GW resource cards (not embedded as subnet badge)
  for (const n of diagramNodes) {
    if (n.resourceKind !== "natGateway" || outboundSourceSet.has(n.id)) continue;
    outboundSources.push({ id: n.id, label: "NAT Gateway", deprecated: false });
    outboundSourceSet.add(n.id);
    // NAT GW is external (no parentId) — resolve VNet via attached subnet edges
    if (!shortIdToVnet.has(n.id)) {
      const natOrigId = [...idMap.entries()].find(([, sid]) => sid === n.id)?.[0];
      if (natOrigId) {
        for (const edge of graph.edges) {
          const otherId = edge.source === natOrigId ? edge.target : edge.target === natOrigId ? edge.source : null;
          if (!otherId || nodeKindLookup.get(otherId) !== "subnet") continue;
          const subShortId = idMap.get(otherId);
          const vnetId = subShortId ? shortIdToVnet.get(subShortId) : undefined;
          if (vnetId) { shortIdToVnet.set(n.id, vnetId); break; }
        }
      }
    }
  }

  // 2. LB with outbound rules (SNAT) → Internet (VMSS → LB routes/egress edge)
  for (const e of diagramEdges) {
    if (e.flowType !== "egress") continue;
    const targetNode = diagramNodes.find((n) => n.id === e.target);
    if (targetNode?.resourceKind !== "lb" || outboundSourceSet.has(e.target)) continue;
    outboundSources.push({ id: e.target, label: "LB SNAT", deprecated: false });
    outboundSourceSet.add(e.target);
    // LB is external — inherit VNet from the VMSS source
    if (!shortIdToVnet.has(e.target)) {
      const vnetId = shortIdToVnet.get(e.source);
      if (vnetId) shortIdToVnet.set(e.target, vnetId);
    }
  }

  // 3. An instance-level public IP (VM, or an LB frontend) is shown as a chip on the card, not as an outbound
  //    line: a public frontend is an inbound path, and the outbound rail keeps one line per egress device
  //    (NAT Gateway, LB outbound rule).

  // 4. Subnets with defaultOutboundAccess=true and no explicit egress → deprecated
  for (const subnetNode of subnetNodes) {
    if (subnetNode.metadata?.defaultOutboundAccess !== "true") continue;
    // NET-09: a 0.0.0.0/0 UDR (appliance, gateway, drop) comes before default outbound — no "retiring" line then
    const firstExit = (subnetNode.metadata?.egress as { via?: string } | undefined)?.via;
    if (firstExit === "appliance" || firstExit === "gateway" || firstExit === "dropped") continue;
    const subnetShortId = idMap.get(subnetNode.id);
    if (!subnetShortId || outboundSourceSet.has(subnetShortId)) continue;
    const hasNatGw = graph.edges.some((e) => {
      const other = e.source === subnetNode.id ? e.target : e.target === subnetNode.id ? e.source : null;
      return other !== null && nodeKindLookup.get(other) === "natGateway";
    });
    if (hasNatGw) continue;
    const children = subnetChildren.get(subnetShortId) ?? [];
    const hasExplicitChild = children.some((c) => outboundSourceSet.has(idMap.get(c.node.id) ?? ""));
    if (hasExplicitChild) continue;
    outboundSources.push({ id: subnetShortId, label: "Default outbound (retiring)", deprecated: true });
    outboundSourceSet.add(subnetShortId);
  }

  // Step 3: Group sources by VNet → one Internet node per VNet
  const outboundByVnet = new Map<string, OutboundSource[]>();
  for (const src of outboundSources) {
    const vnetId = shortIdToVnet.get(src.id) ?? "external";
    const arr = outboundByVnet.get(vnetId) ?? [];
    arr.push(src);
    outboundByVnet.set(vnetId, arr);
  }

  // Step 4: Create per-VNet Internet nodes (placeholder positions — repositioned post-ELK)
  const internetNodeIds = new Map<string, string>(); // vnetShortId|"external" → internetNodeId
  for (const [vnetId, sources] of outboundByVnet) {
    const internetNodeId = vnetId === "external" ? "internet-external" : `internet-${vnetId}`;
    internetNodeIds.set(vnetId, internetNodeId);
    const hasDeprecated = sources.some((s) => s.deprecated);

    diagramNodes.push({
      id: internetNodeId,
      // Stable token — the web shows the localized name (live-diagram/utils/localizeLabel.ts)
      label: "Internet",
      icon: "internet" as DiagramIconKind,
      position: { x: 9999, y: 0 },
      bindings: {},
      resourceKind: "internet",
      metadata: {
        direction: "egress",
        outboundMethodCount: String(sources.length),
        hasDeprecatedPath: String(hasDeprecated),
        vnetId,
      },
    });

    for (const src of sources) {
      const edge = makeEdge(src.id, internetNodeId, "internet", src.label, undefined, "outbound-internet", undefined, "egress");
      if (src.deprecated) (edge as { animation: string }).animation = "dash";
      diagramEdges.push(edge);
      existingPairs.add(`${src.id}→${internetNodeId}`);
    }
  }

  // ── Gateway / scale-set facts for chips and the panel (strings — the spec is shared JSON) ──
  {
    const gByAz = new Map(graph.nodes.filter((g) => g.azureId).map((g) => [g.azureId!.toLowerCase(), g]));
    const vmssName = new Map<string, string>();
    for (const e of graph.edges) if (e.kind === "member-of") vmssName.set(e.source, graph.nodes.find((x) => x.id === e.target)?.name ?? "");
    for (const n of diagramNodes) {
      const g = n.azureResourceId ? gByAz.get(n.azureResourceId.toLowerCase()) : undefined;
      if (!g) continue;
      const meta = g.metadata ?? {};
      // The resource's specification (resourceSpec.ts) for the panel
      if (Array.isArray(meta.spec) && meta.spec.length) n.metadata = { ...n.metadata, spec: specJson(meta.spec as SpecFact[]) };
      if (n.resourceKind === "lb" || n.resourceKind === "appGateway") {
        const out: Record<string, string> = {};
        if (meta.managedBy === "aks") out.managedBy = "aks";
        if (typeof meta.outboundRules === "number") out.outboundRules = String(meta.outboundRules);
        if (typeof meta.privateListeners === "number") out.privateListeners = String(meta.privateListeners);
        const fes = Array.isArray(meta.frontends) ? (meta.frontends as Array<{ name: string; kind: string; ip?: string; listeners: string[]; ruleBound: boolean }>) : [];
        if (fes.length) out.frontends = JSON.stringify(fes);
        const pub = fes.filter((f) => f.kind === "public" && f.ruleBound).flatMap((f) => f.listeners);
        if (pub.length) out.publicListeners = JSON.stringify(pub);
        if (Array.isArray(meta.unresolvedBackends) && meta.unresolvedBackends.length) out.unresolvedBackends = JSON.stringify(meta.unresolvedBackends);
        // Subnets whose UDR names this internal LB as next hop (subnetEgress.ts udrNextHopsToIlb) — lbInbound chip / panel
        if (meta.udrNextHop && typeof meta.udrNextHop === "object") out.udrNextHop = JSON.stringify(meta.udrNextHop);
        // AGW-08: WAF per rule-bound listener
        if (n.resourceKind === "appGateway") Object.assign(out, wafMetadata(meta.waf as WafCoverage | undefined));
        n.metadata = { ...n.metadata, ...out };
      }
      // Evidence inputs (healthEvidence.ts): provisioning state, Private Endpoint connection approval states
      if (typeof meta.provisioningState === "string") n.metadata = { ...n.metadata, provisioningState: meta.provisioningState };
      if (Array.isArray(meta.connections)) n.metadata = { ...n.metadata, peConnections: JSON.stringify((meta.connections as Array<{ status?: string }>).map((c) => c.status ?? "Unknown")) };
      if (n.resourceKind === "agc") {
        n.metadata = {
          ...n.metadata,
          agcFrontends: JSON.stringify(meta.frontends ?? []),
          agcAssociations: JSON.stringify(meta.associations ?? []),
          ...(typeof meta.clusterCandidates === "number" ? { clusterCandidates: String(meta.clusterCandidates) } : {}),
          ...(meta.wafPolicyId ? { waf: "true" } : {}),
        };
      }
      if (n.resourceKind === "frontDoor") {
        const keys = ["tier", "endpoints", "activeRoutes", "origins", "externalOrigins", "ambiguousOrigins", "configUnreadable", "classic"] as const;
        const out: Record<string, string> = {};
        for (const k of keys) if (meta[k] != null) out[k] = String(meta[k]);
        // WAF coverage (EDGE-10 / EDGE-11): badge + policy sub-cards + panel (web lib/liveWaf.ts)
        Object.assign(out, wafMetadata(meta.waf as WafCoverage | undefined));
        if (Array.isArray(meta.endpointHosts)) out.endpointHosts = JSON.stringify(meta.endpointHosts);
        if (Array.isArray(meta.originList)) out.originList = JSON.stringify(meta.originList);
        if (Array.isArray(meta.originGroups)) out.originGroups = JSON.stringify(meta.originGroups);
        n.metadata = { ...n.metadata, ...out };
      }
      if (n.resourceKind === "vmss") {
        if (typeof meta.orchestrationMode === "string") n.metadata = { ...n.metadata, orchestrationMode: meta.orchestrationMode };
        if (typeof meta.capacity === "number") n.metadata = { ...n.metadata, capacity: String(meta.capacity) };
        if (meta.managedBy === "aks") n.metadata = { ...n.metadata, managedBy: "aks" };
      }
      const set = vmssName.get(g.id);
      if (set != null && (n.resourceKind === "vm" || n.icon === "vm")) n.metadata = { ...n.metadata, scaleSet: set };
    }
  }

  // ── Inbound: Internet → public entry points (LB / Application Gateway with a public frontend) ──
  // Same rule as /architecture: an entry point whose frontend is a public IP is reachable from the Internet.
  // Internal LBs (private frontend) are not inbound paths.
  const ingressByVnet = new Map<string, string[]>();
  const graphNodeByAzureId = new Map(graph.nodes.filter((g) => g.azureId).map((g) => [g.azureId!.toLowerCase(), g]));
  for (const n of diagramNodes) {
    // AGC-03: Internet → AGC only through a public frontend; Front Door only with an active route
    if (n.resourceKind === "agc" || n.resourceKind === "frontDoor") {
      const g = n.azureResourceId ? graphNodeByAzureId.get(n.azureResourceId.toLowerCase()) : undefined;
      const open = n.resourceKind === "agc" ? Number(g?.metadata?.publicFrontends ?? 0) > 0 : Number(g?.metadata?.activeRoutes ?? (g?.metadata?.classic ? 1 : 0)) > 0;
      if (!open) continue;
      const vnetId = shortIdToVnet.get(n.id) ?? "external";
      (ingressByVnet.get(vnetId) ?? ingressByVnet.set(vnetId, []).get(vnetId)!).push(n.id);
      continue;
    }
    if (n.resourceKind !== "lb" && n.resourceKind !== "appGateway") continue;
    const isPublic = n.subResources?.some((sr) => sr.kind === "publicIP" || (sr.kind === "frontendIP" && !!sr.endpoint && !isPrivateIp(sr.endpoint)));
    if (!isPublic) continue;
    // A public frontend with no load-balancing / NAT rule takes no traffic in (e.g. the AKS "kubernetes" LB used
    // only for outbound) — it is not an inbound path. Unknown rule count keeps the line.
    const gnode = n.azureResourceId ? graphNodeByAzureId.get(n.azureResourceId.toLowerCase()) : undefined;
    const rules = gnode?.metadata?.inboundRules;
    if (typeof rules === "number") (n.metadata ??= {}).inboundRules = String(rules);
    if (rules === 0) continue;
    const vnetId = shortIdToVnet.get(n.id) ?? "external";
    (ingressByVnet.get(vnetId) ?? ingressByVnet.set(vnetId, []).get(vnetId)!).push(n.id);
  }
  // Internet → VM through its own public IP (PIP-04): open / scoped = a configured line, unknown = drawn dashed in
  // the web (weak evidence, no risk color); closed / noNsg (Standard without an NSG is closed by default) = no line,
  // the card chip says why. A VM-less NIC has nothing to reach — no line. Uniform VMSS instances have no public IP
  // resource of their own — not judged here.
  const vmEntries = new Map<string, InboundExposure>();
  for (const n of diagramNodes) {
    if (n.resourceKind !== "vm" || !n.azureResourceId) continue;
    const ex = graphNodeByAzureId.get(n.azureResourceId.toLowerCase())?.metadata?.inboundExposure as InboundExposure | undefined;
    if (!ex) continue;
    n.metadata = { ...n.metadata, pipExposure: JSON.stringify(ex) };
    if (ex.state !== "open" && ex.state !== "scoped" && ex.state !== "unknown") continue;
    vmEntries.set(n.id, ex);
    const vnetId = shortIdToVnet.get(n.id) ?? "external";
    (ingressByVnet.get(vnetId) ?? ingressByVnet.set(vnetId, []).get(vnetId)!).push(n.id);
  }
  for (const [vnetId, entryIds] of ingressByVnet) {
    const inId = vnetId === "external" ? "internet-in-external" : `internet-in-${vnetId}`;
    diagramNodes.push({
      id: inId,
      label: "Internet",
      icon: "internet" as DiagramIconKind,
      position: { x: 0, y: 0 },
      bindings: {},
      resourceKind: "internet",
      metadata: { direction: "ingress", entryCount: String(entryIds.length), vnetId },
    });
    for (const target of entryIds) {
      const edge = makeEdge(inId, target, "internet", undefined, undefined, "network", undefined, "ingress");
      const ex = vmEntries.get(target);
      if (ex) edge.exposure = ex;
      diagramEdges.push(edge);
    }
  }

  // ── S2S: one on-premises site card per connection of a gateway in view (EDGE-09), gateway → site line ──
  // The site's resource is the connection: its Resource Health and BitsIn/OutPerSecond are read on it.
  type S2s = { connectionId: string; name: string; status: string; protocol: string | null; enableBgp: boolean; policyBased: boolean; connectionMode: string | null; dpd: number | null; ingressBytes: number | null; egressBytes: number | null; tunnels: Array<{ tunnel: string; status: string; lastConnected?: string }> | null; nat: boolean; lng: { id: string; name: string; prefixes: string[]; peerIp: string | null; fqdn: string | null; bgp: boolean } | null };
  for (const gw of [...diagramNodes]) {
    if (gw.resourceKind !== "vnetGateway" || !gw.azureResourceId) continue;
    const g = graphNodeByAzureId.get(gw.azureResourceId.toLowerCase());
    const list = (Array.isArray(g?.metadata?.s2s) ? g!.metadata!.s2s : []) as S2s[];
    const gm = g?.metadata ?? {};
    gw.metadata = {
      ...gw.metadata,
      ...(typeof gm.sku === "string" ? { sku: gm.sku } : {}),
      ...(typeof gm.activeActive === "boolean" ? { activeActive: String(gm.activeActive) } : {}),
      ...(typeof gm.enableBgp === "boolean" ? { enableBgp: String(gm.enableBgp) } : {}),
      ...(list.length ? { s2sCount: String(list.length) } : {}),
    };
    for (const c of list) {
      const siteId = `site-${shortId(c.connectionId)}`;
      if (diagramNodes.some((n) => n.id === siteId)) continue;
      diagramNodes.push({
        id: siteId,
        label: c.lng?.name ?? c.name,
        icon: "onPremSite" as DiagramIconKind,
        resourceKind: "onPremSite",
        azureResourceId: c.connectionId,
        position: { x: 0, y: 0 },
        bindings: {},
        metadata: {
          gatewayNodeId: gw.id,
          connectionName: c.name,
          // read with the topology (not live): shown as "at read time" in the panel, never as the card colour
          connectionStatus: c.status,
          ...(c.protocol ? { protocol: c.protocol } : {}),
          bgp: String(!!c.lng?.bgp),
          policyBased: String(c.policyBased),
          nat: String(c.nat),
          ...(c.lng ? { lng: JSON.stringify({ name: c.lng.name, prefixes: c.lng.prefixes, peerIp: c.lng.peerIp, fqdn: c.lng.fqdn }) } : {}),
          ...(c.tunnels ? { tunnels: JSON.stringify(c.tunnels) } : {}),
          ...(c.ingressBytes != null ? { ingressBytes: String(c.ingressBytes) } : {}),
          ...(c.egressBytes != null ? { egressBytes: String(c.egressBytes) } : {}),
          ...(c.dpd != null ? { dpd: String(c.dpd) } : {}),
          ...(c.connectionMode ? { connectionMode: c.connectionMode } : {}),
        },
      });
      const edge = makeEdge(gw.id, siteId, "vnetGateway", c.protocol ? `S2S · ${c.protocol}` : "S2S", c.protocol ?? undefined, "hybrid" as DiagramEdgeKind, undefined, "egress");
      diagramEdges.push(edge);
    }
  }

  // ── Subnet outbound path (shown as a chip on the subnet header; catalog SEC-07 default outbound access) ──
  // nat > LB outbound rule (SNAT) > default outbound (on / off) > unknown (property not reported; UDR not read yet)
  const snatSources = new Set(outboundSources.filter((s) => s.label === "LB SNAT").map((s) => s.id));
  const shortOfLower = new Map([...idMap].map(([orig, sid]) => [orig.toLowerCase(), sid] as const));
  for (const sub of diagramNodes) {
    if (sub.icon !== "subnet" || sub.nodeType !== "group") continue;
    const meta = (sub.metadata ??= {});
    // NET-09 (azure.ts subnetEgress): a 0.0.0.0/0 UDR to an appliance / the gateway, or one that drops, comes first —
    // an attached NAT gateway is then bypassed
    const origSub = [...idMap.entries()].find(([, sid]) => sid === sub.id)?.[0];
    const fx = origSub ? (graph.nodes.find((g) => g.id === origSub)?.metadata?.egress as { via?: string; targetId?: string; evidence?: string; natBypassed?: string } | undefined) : undefined;
    if (fx && (fx.via === "appliance" || fx.via === "gateway" || fx.via === "dropped" || (fx.via === "unknown" && fx.evidence === "udr"))) {
      meta.egressVia = fx.via === "unknown" ? "udr-unresolved" : fx.via;
      const tgt = fx.targetId ? graph.nodes.find((g) => g.id.toLowerCase() === fx.targetId!.toLowerCase()) : undefined;
      if (tgt) meta.egressName = tgt.name;
      const tShort = fx.targetId ? shortOfLower.get(fx.targetId.toLowerCase()) : undefined;
      if (tShort) meta.egressTargetId = tShort;
      if (fx.natBypassed) meta.egressNatBypassed = "true";
      continue;
    }
    if (meta.natGwBadgeId) {
      meta.egressVia = "nat";
      meta.egressName = meta.natGwBadgeLabel ?? "";
      continue;
    }
    const kids = diagramNodes.filter((c) => c.parentId === sub.id).map((c) => c.id);
    const viaSnat = diagramEdges.some((e) => e.flowType === "egress" && kids.includes(e.source) && snatSources.has(e.target));
    if (viaSnat) { meta.egressVia = "lb-snat"; continue; }
    const origId = [...idMap.entries()].find(([, sid]) => sid === sub.id)?.[0];
    const dflt = origId ? graph.nodes.find((g) => g.id === origId)?.metadata?.defaultOutboundAccess : undefined;
    meta.egressVia = dflt === "true" ? "default" : dflt === "false" ? "none" : "unknown";
  }

  // ── VNet peerings (shown as stubs on the VNet header — the remote VNet may not be in view) ──
  for (const vnet of vnetNodes) {
    const vShortId = idMap.get(vnet.id);
    const spec = vShortId ? diagramNodes.find((n) => n.id === vShortId) : undefined;
    if (!spec) continue;
    // This VNet's own side of each peering (azure.ts metadata.vnetPeerings): every peering, also to VNets the
    // graph cannot see (id null), with its flags; the remote side's gateway use is read from the remote VNet
    type Own = {
      name: string; remoteId: string | null; remoteName: string; state: string; sync: string | null; provisioning?: string | null;
      access: boolean | null; forwarded: boolean | null; gatewayTransit: boolean | null; useRemoteGateways: boolean | null;
      remoteSpace: string[]; remoteCurrentSpace?: string[] | null; complete?: boolean | null; localSubnets?: string[]; remoteSubnets?: string[];
    };
    let own = (Array.isArray(vnet.metadata?.vnetPeerings) ? vnet.metadata!.vnetPeerings : []) as Own[];
    // Graphs without the per-VNet list (sample data, an older cache): the peering edges, state only
    if (!own.length) {
      own = graph.edges.filter((e) => e.kind === "peering" && (e.source === vnet.id || e.target === vnet.id)).map((e) => {
        const remote = e.source === vnet.id ? e.target : e.source;
        return { name: "", remoteId: remote, remoteName: remote.split("/").pop() ?? remote, state: String(e.metadata?.peeringState ?? "Unknown"), sync: null, access: null, forwarded: null, gatewayTransit: null, useRemoteGateways: null, remoteSpace: [] };
      });
    }
    const byArm = new Map(graph.nodes.filter((g) => g.kind === "vnet").map((g) => [g.id, g]));
    const peers: LivePeering[] = own.map((p, i) => {
      const remote = p.remoteId ? byArm.get(p.remoteId) : undefined;
      const back = remote ? ((remote.metadata?.vnetPeerings ?? []) as Own[]).find((x) => x.remoteId === vnet.id) : undefined;
      const both = p.state === "Connected" && back?.state === "Connected";
      // Gateway transit only when the two sides agree (NET-37): one flag alone decides nothing
      const transit = both && p.useRemoteGateways === true && back?.gatewayTransit === true ? "uses"
        : both && p.gatewayTransit === true && back?.useRemoteGateways === true ? "provides" : null;
      return {
        // the link name is unique in a VNet; a graph without it keys by position (never by the remote name)
        key: p.name || `peer-${i}`, link: p.name,
        id: p.remoteId ? idMap.get(p.remoteId) ?? null : null,
        name: remote?.name ?? p.remoteName,
        state: p.state, sync: p.sync ?? null, provisioning: p.provisioning ?? null,
        access: p.access, forwarded: p.forwarded, gatewayTransit: p.gatewayTransit, useRemoteGateways: p.useRemoteGateways,
        remoteSpace: p.remoteSpace ?? [], remoteCurrentSpace: p.remoteCurrentSpace ?? null, complete: p.complete ?? null,
        ...(p.localSubnets ? { localSubnets: p.localSubnets } : {}), ...(p.remoteSubnets ? { remoteSubnets: p.remoteSubnets } : {}),
        ...(back ? { other: { state: back.state, sync: back.sync ?? null, access: back.access, forwarded: back.forwarded, gatewayTransit: back.gatewayTransit, useRemoteGateways: back.useRemoteGateways } } : {}),
        transit,
      };
    });
    const unique = [...new Map(peers.map((p) => [p.key, p])).values()];
    if (unique.length) spec.metadata = { ...spec.metadata, peerings: JSON.stringify(unique.slice(0, 50)), peeringCount: String(unique.length) };
  }

  // Build groups
  const groups = inferGroups(filteredNodes);

  // Apply ELK auto-layout if requested (repositions nodes + resizes containers)
  if (layoutMode === "elk") {
    await applyElkLayout(diagramNodes, diagramEdges);
  }

  // ── Post-ELK: reposition each per-VNet Internet node to the right of its VNet ──
  for (const [vnetId, internetNodeId] of internetNodeIds) {
    const internetSpec = diagramNodes.find((n) => n.id === internetNodeId);
    if (!internetSpec) continue;

    if (vnetId === "external") {
      // Position to the right of all root (non-internet) nodes
      const rootNodes = diagramNodes.filter((n) => !n.parentId && n.resourceKind !== "internet");
      const allMaxX = rootNodes.map((n) => (n.position?.x ?? 0) + (n.width ?? NODE_W));
      const allY = rootNodes.map((n) => n.position?.y ?? 0);
      internetSpec.position = {
        x: (allMaxX.length > 0 ? Math.max(...allMaxX) : 600) + 220,
        y: allY.length > 0 ? (Math.min(...allY) + Math.max(...allY)) / 2 : 300,
      };
    } else {
      // Position to the right of the specific VNet box
      const vnetSpec = diagramNodes.find((n) => n.id === vnetId);
      if (vnetSpec) {
        const vnetRight = (vnetSpec.position?.x ?? 0) + (vnetSpec.width ?? 400);
        const vnetCenterY = (vnetSpec.position?.y ?? 0) + (vnetSpec.height ?? 200) / 2;
        internetSpec.position = { x: vnetRight + 120, y: vnetCenterY - 65 };
      }
    }
  }

  // ── Checkpoint 1: Validate parentId references ──
  const specNodeIds = new Set(diagramNodes.map((n) => n.id));
  let validParentCount = 0;
  let brokenParentCount = 0;
  const groupNodesWithSize: string[] = [];

  for (const n of diagramNodes) {
    if (n.parentId) {
      if (specNodeIds.has(n.parentId)) {
        validParentCount++;
      } else {
        brokenParentCount++;
        console.error(`[CP1] BROKEN parentId: "${n.id}" → "${n.parentId}" (parent not found in spec)`);
        n.parentId = undefined; // Remove broken reference to prevent ReactFlow errors
      }
    }
    if (n.nodeType === "group") {
      groupNodesWithSize.push(`${n.id}(${n.width}x${n.height}, parent=${n.parentId ?? "ROOT"})`);
    }
  }

  debug(`[CP1] parentId validation: ${validParentCount} valid, ${brokenParentCount} broken (fixed)`);
  debug(`[CP1] Group nodes: ${groupNodesWithSize.join(", ")}`);

  // Sample parentId chain for debugging
  const sampleChildren = diagramNodes.filter((n) => n.parentId).slice(0, 8);
  if (sampleChildren.length > 0) {
    debug(`[CP1] Sample parentId chains:`);
    for (const c of sampleChildren) {
      const parent = diagramNodes.find((n) => n.id === c.parentId);
      debug(`  "${c.id}" (${c.nodeType ?? "leaf"}) → "${c.parentId}" (${parent?.nodeType ?? "??"})`);
    }
  }

  const specId = `auto-${subscriptionId.slice(0, 8)}`;

  return {
    spec: normalizeSpecBindings({
      version: "1.0",
      id: specId,
      name: `Azure Resources (${subscriptionId.slice(0, 8)}…)`,
      description: `Auto-generated from Azure Resource Graph at ${now}`,
      createdAt: now,
      updatedAt: now,
      nodes: diagramNodes,
      edges: diagramEdges,
      groups,
      settings: {
        refreshIntervalSec: 30,
        defaultTimeRange: "5m",
        layout: layoutMode,
      },
    }),
    containmentDiagnostics: containment.diagnostics,
  };
}

// ── Helpers ──

function isNetworkContainer(graph: ArchitectureGraph, nodeId: string): boolean {
  const node = graph.nodes.find((n) => n.id === nodeId);
  return node ? NETWORK_CONTAINER_KINDS.has(node.kind) : false;
}

function inferGroup(node: ArchitectureNode): string {
  const kind = node.kind;
  if (INGRESS_KINDS.has(kind)) return "ingress";
  if (COMPUTE_KINDS.has(kind)) return "compute";
  if (DATA_KINDS.has(kind) || kind === "privateEndpoint") return "data";
  if (kind === "vnet" || kind === "subnet") return "network";
  if (kind === "appInsights" || kind === "logAnalytics") return "monitoring";
  return "other";
}

function inferGroups(
  nodes: ArchitectureNode[],
): DiagramGroupSpec[] {
  const groupLabels: Record<string, string> = {
    ingress: "Ingress",
    compute: "Compute",
    data: "Data & Storage",
    network: "Networking",
    monitoring: "Monitoring",
    other: "Other",
  };

  const seen = new Set<string>();
  for (const node of nodes) {
    seen.add(inferGroup(node));
  }

  return Array.from(seen)
    .map((id) => ({
      id,
      label: groupLabels[id] ?? id,
      layout: "row" as const,
    }));
}
