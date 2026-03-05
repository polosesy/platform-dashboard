import type { Env } from "../env";
import type {
  EdgeNetworkDetail,
  NicEndpointInfo,
  NsgInfo,
  NsgRuleEntry,
  UdrInfo,
  NetworkFlowRecord,
  FlowSummary,
  DiagramEdgeSpec,
  DiagramNodeSpec,
} from "@aud/types";
import { getDiagramSpec } from "./liveAggregator";
import { getArmFetcherAuto } from "../infra/azureClientFactory";
import { CacheManager, bearerKeyPrefix } from "../infra/cacheManager";

// ──────────────────────────────────────────────
// Cache: 30 seconds per bearer+edge combination
// ──────────────────────────────────────────────

const edgeDetailCache = new CacheManager<EdgeNetworkDetail>(50, 30_000);

// ──────────────────────────────────────────────
// RFC1918 / Azure-internal IP detection
// ──────────────────────────────────────────────

function isRfc1918(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4) return false;
  const [a, b] = parts;
  // 10.0.0.0/8
  if (a === 10) return true;
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // Azure platform: 168.63.129.16 / 169.254.169.254 (link-local)
  if (a === 168 && b === 63) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

// ──────────────────────────────────────────────
// NIC extraction from DiagramNodeSpec.subResources
// ──────────────────────────────────────────────

function extractNics(node: DiagramNodeSpec): NicEndpointInfo[] {
  const nics: NicEndpointInfo[] = [];
  for (const sr of node.subResources ?? []) {
    if (sr.kind === "nic") {
      nics.push({ name: sr.label, privateIp: sr.endpoint });
    } else if (sr.kind === "publicIP") {
      // Attach public IP to last NIC if available
      const last = nics[nics.length - 1];
      if (last) last.publicIp = sr.endpoint;
    } else if (sr.kind === "frontendIP") {
      nics.push({ name: sr.label, publicIp: sr.endpoint });
    }
  }
  // Fallback: use node endpoint as primary IP
  if (nics.length === 0 && node.endpoint) {
    nics.push({ name: node.label, privateIp: node.endpoint });
  }
  return nics;
}

// ──────────────────────────────────────────────
// ARM: Fetch NSG rules
// ──────────────────────────────────────────────

interface ArmNsgResponse {
  name?: string;
  properties?: {
    securityRules?: ArmNsgRule[];
    defaultSecurityRules?: ArmNsgRule[];
  };
}

interface ArmNsgRule {
  name: string;
  properties?: {
    priority?: number;
    direction?: string;
    access?: string;
    protocol?: string;
    sourcePortRange?: string;
    destinationPortRange?: string;
    sourceAddressPrefix?: string;
    destinationAddressPrefix?: string;
  };
}

async function fetchNsgInfo(env: Env, bearerToken: string | undefined, nsgId: string): Promise<NsgInfo | undefined> {
  try {
    const fetcher = await getArmFetcherAuto(env, bearerToken);
    const url = `https://management.azure.com${nsgId}?api-version=2024-05-01`;
    const data = await fetcher.fetchJson<ArmNsgResponse>(url);
    const allRules = [
      ...(data.properties?.securityRules ?? []),
      ...(data.properties?.defaultSecurityRules ?? []),
    ];
    const effectiveRules: NsgRuleEntry[] = allRules.map((r) => ({
      name: r.name,
      priority: r.properties?.priority ?? 65000,
      direction: (r.properties?.direction as "Inbound" | "Outbound") ?? "Inbound",
      access: (r.properties?.access as "Allow" | "Deny") ?? "Deny",
      protocol: r.properties?.protocol ?? "*",
      sourcePortRange: r.properties?.sourcePortRange ?? "*",
      destinationPortRange: r.properties?.destinationPortRange ?? "*",
      sourceAddressPrefix: r.properties?.sourceAddressPrefix ?? "*",
      destinationAddressPrefix: r.properties?.destinationAddressPrefix ?? "*",
    }));
    return { name: data.name ?? nsgId.split("/").pop() ?? "nsg", resourceId: nsgId, effectiveRules };
  } catch {
    return undefined;
  }
}

// ──────────────────────────────────────────────
// ARM: Fetch UDR (Route Table)
// ──────────────────────────────────────────────

interface ArmRouteTableResponse {
  name?: string;
  properties?: {
    routes?: Array<{
      name: string;
      properties?: {
        addressPrefix?: string;
        nextHopType?: string;
        nextHopIpAddress?: string;
      };
    }>;
  };
}

async function fetchUdrInfo(env: Env, bearerToken: string | undefined, routeTableId: string): Promise<UdrInfo | undefined> {
  try {
    const fetcher = await getArmFetcherAuto(env, bearerToken);
    const url = `https://management.azure.com${routeTableId}?api-version=2024-05-01`;
    const data = await fetcher.fetchJson<ArmRouteTableResponse>(url);
    const routes = (data.properties?.routes ?? []).map((r) => ({
      name: r.name,
      addressPrefix: r.properties?.addressPrefix ?? "0.0.0.0/0",
      nextHopType: (r.properties?.nextHopType as UdrInfo["routes"][0]["nextHopType"]) ?? "Internet",
      nextHopIpAddress: r.properties?.nextHopIpAddress,
    }));
    return { name: data.name ?? "route-table", routes };
  } catch {
    return undefined;
  }
}

// ──────────────────────────────────────────────
// Flow summary calculation
// ──────────────────────────────────────────────

function summarizeFlows(flows: NetworkFlowRecord[], direction: "Inbound" | "Outbound"): FlowSummary {
  const dirFlows = flows.filter((f) => f.direction === direction);
  const portMap = new Map<string, number>();
  let totalBytes = 0;
  let externalCount = 0;

  for (const f of dirFlows) {
    const key = `${f.destPort}/${f.protocol}`;
    portMap.set(key, (portMap.get(key) ?? 0) + 1);
    totalBytes += (f.bytesSrcToDest ?? 0) + (f.bytesDestToSrc ?? 0);
    if (f.isExternalSrc || f.isExternalDest) externalCount++;
  }

  const topPorts = [...portMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([k, count]) => {
      const [portStr, protocol] = k.split("/");
      return { port: parseInt(portStr, 10), protocol: protocol ?? "TCP", flowCount: count };
    });

  return {
    flowCount: dirFlows.length,
    totalBytesBps: Math.round(totalBytes / 300), // 5-min window → bps
    topPorts,
    externalSourceCount: externalCount,
  };
}

// ──────────────────────────────────────────────
// Mock data generator
// ──────────────────────────────────────────────

function generateMockEdgeDetail(
  edgeSpec: DiagramEdgeSpec,
  sourceNode: DiagramNodeSpec,
  targetNode: DiagramNodeSpec,
): EdgeNetworkDetail {
  const now = new Date().toISOString();

  const sourceNics = extractNics(sourceNode);
  const targetNics = extractNics(targetNode);

  const sourceIp = sourceNics[0]?.privateIp ?? "10.0.0.4";
  const targetIp = targetNics[0]?.privateIp ?? "10.0.1.10";

  // Mock NSG rules
  const sourceNsg: NsgInfo = {
    name: `nsg-${sourceNode.id}`,
    effectiveRules: [
      { name: "Allow-HTTPS-In", priority: 100, direction: "Inbound", access: "Allow", protocol: "TCP", sourcePortRange: "*", destinationPortRange: "443", sourceAddressPrefix: "Internet", destinationAddressPrefix: sourceIp },
      { name: "Allow-HTTP-In", priority: 110, direction: "Inbound", access: "Allow", protocol: "TCP", sourcePortRange: "*", destinationPortRange: "80", sourceAddressPrefix: "Internet", destinationAddressPrefix: sourceIp },
      { name: "Allow-LB-Health", priority: 200, direction: "Inbound", access: "Allow", protocol: "*", sourcePortRange: "*", destinationPortRange: "*", sourceAddressPrefix: "AzureLoadBalancer", destinationAddressPrefix: "*" },
      { name: "Deny-All-In", priority: 65500, direction: "Inbound", access: "Deny", protocol: "*", sourcePortRange: "*", destinationPortRange: "*", sourceAddressPrefix: "*", destinationAddressPrefix: "*" },
      { name: "Allow-VNet-Out", priority: 100, direction: "Outbound", access: "Allow", protocol: "*", sourcePortRange: "*", destinationPortRange: "*", sourceAddressPrefix: "VirtualNetwork", destinationAddressPrefix: "VirtualNetwork" },
      { name: "Deny-All-Out", priority: 65500, direction: "Outbound", access: "Deny", protocol: "*", sourcePortRange: "*", destinationPortRange: "*", sourceAddressPrefix: "*", destinationAddressPrefix: "*" },
    ],
  };

  const targetNsg: NsgInfo = {
    name: `nsg-${targetNode.id}`,
    effectiveRules: [
      { name: "Allow-AppGW-In", priority: 100, direction: "Inbound", access: "Allow", protocol: "TCP", sourcePortRange: "*", destinationPortRange: "8080", sourceAddressPrefix: sourceIp, destinationAddressPrefix: targetIp },
      { name: "Allow-VNet-In", priority: 200, direction: "Inbound", access: "Allow", protocol: "*", sourcePortRange: "*", destinationPortRange: "*", sourceAddressPrefix: "VirtualNetwork", destinationAddressPrefix: "*" },
      { name: "Deny-Internet-In", priority: 300, direction: "Inbound", access: "Deny", protocol: "*", sourcePortRange: "*", destinationPortRange: "*", sourceAddressPrefix: "Internet", destinationAddressPrefix: "*" },
      { name: "Deny-All-In", priority: 65500, direction: "Inbound", access: "Deny", protocol: "*", sourcePortRange: "*", destinationPortRange: "*", sourceAddressPrefix: "*", destinationAddressPrefix: "*" },
    ],
  };

  // Mock UDR
  const udr: UdrInfo = {
    name: "udr-prod",
    routes: [
      { name: "Route-Internet", addressPrefix: "0.0.0.0/0", nextHopType: "VirtualAppliance", nextHopIpAddress: "10.0.2.4" },
      { name: "Route-VNet", addressPrefix: "10.0.0.0/16", nextHopType: "VnetLocal" },
      { name: "Route-OnPrem", addressPrefix: "172.16.0.0/12", nextHopType: "VirtualNetworkGateway" },
    ],
  };

  // Mock flow records: mix of internal and external IPs
  const inboundFlows: NetworkFlowRecord[] = [
    {
      srcIp: "203.0.113.5", destIp: sourceIp, srcPort: 54321, destPort: 443,
      protocol: "TCP", direction: "Inbound", action: "Allow",
      bytesSrcToDest: 8192, bytesDestToSrc: 1024,
      isExternalSrc: true, isExternalDest: false, flowState: "C",
    },
    {
      srcIp: "198.51.100.20", destIp: sourceIp, srcPort: 61234, destPort: 443,
      protocol: "TCP", direction: "Inbound", action: "Allow",
      bytesSrcToDest: 4096, bytesDestToSrc: 512,
      isExternalSrc: true, isExternalDest: false, flowState: "C",
    },
    {
      srcIp: "10.0.2.100", destIp: sourceIp, srcPort: 52100, destPort: 443,
      protocol: "TCP", direction: "Inbound", action: "Allow",
      bytesSrcToDest: 2048, bytesDestToSrc: 256,
      isExternalSrc: false, isExternalDest: false, flowState: "B",
    },
    {
      srcIp: "10.0.3.50", destIp: sourceIp, srcPort: 49152, destPort: 80,
      protocol: "TCP", direction: "Inbound", action: "Allow",
      bytesSrcToDest: 1024, bytesDestToSrc: 128,
      isExternalSrc: false, isExternalDest: false, flowState: "E",
    },
    {
      srcIp: "203.0.113.99", destIp: sourceIp, srcPort: 55001, destPort: 443,
      protocol: "TCP", direction: "Inbound", action: "Deny",
      bytesSrcToDest: 64, bytesDestToSrc: 0,
      isExternalSrc: true, isExternalDest: false, flowState: "D",
    },
  ];

  const outboundFlows: NetworkFlowRecord[] = [
    {
      srcIp: sourceIp, destIp: targetIp, srcPort: 12345, destPort: 8080,
      protocol: "TCP", direction: "Outbound", action: "Allow",
      bytesSrcToDest: 12288, bytesDestToSrc: 3072,
      isExternalSrc: false, isExternalDest: false, flowState: "C",
    },
    {
      srcIp: sourceIp, destIp: targetIp, srcPort: 23456, destPort: 8080,
      protocol: "TCP", direction: "Outbound", action: "Allow",
      bytesSrcToDest: 8192, bytesDestToSrc: 2048,
      isExternalSrc: false, isExternalDest: false, flowState: "C",
    },
    {
      srcIp: sourceIp, destIp: "10.0.1.20", srcPort: 34567, destPort: 9090,
      protocol: "TCP", direction: "Outbound", action: "Allow",
      bytesSrcToDest: 512, bytesDestToSrc: 64,
      isExternalSrc: false, isExternalDest: false, flowState: "B",
    },
  ];

  const allFlows = [...inboundFlows, ...outboundFlows];

  return {
    edgeId: edgeSpec.id,
    generatedAt: now,
    sourceNodeId: sourceNode.id,
    sourceNodeLabel: sourceNode.label,
    targetNodeId: targetNode.id,
    targetNodeLabel: targetNode.label,
    protocol: edgeSpec.protocol,
    edgeKind: edgeSpec.edgeKind,
    liveMetrics: {
      throughputBps: 12_500_000,
      latencyMs: 23,
      errorRate: 0.8,
    },
    sourceNics,
    targetNics,
    sourceNsg,
    targetNsg,
    udr,
    inboundFlows,
    outboundFlows,
    inboundSummary: summarizeFlows(allFlows, "Inbound"),
    outboundSummary: summarizeFlows(allFlows, "Outbound"),
    note: "mock",
  };
}

// ──────────────────────────────────────────────
// Main export
// ──────────────────────────────────────────────

export async function fetchEdgeNetworkDetail(
  env: Env,
  bearerToken: string | undefined,
  diagramId: string,
  edgeId: string,
): Promise<EdgeNetworkDetail> {
  const cacheKey = `${bearerToken ? bearerKeyPrefix(bearerToken) : "anon"}:edge-detail:${diagramId}:${edgeId}`;
  const cached = edgeDetailCache.get(cacheKey);
  if (cached) return cached;

  const spec = getDiagramSpec(diagramId);
  if (!spec) throw new Error(`Diagram not found: ${diagramId}`);

  const edgeSpec = spec.edges.find((e) => e.id === edgeId);
  if (!edgeSpec) throw new Error(`Edge not found: ${edgeId}`);

  const sourceNode = spec.nodes.find((n) => n.id === edgeSpec.source);
  const targetNode = spec.nodes.find((n) => n.id === edgeSpec.target);

  if (!sourceNode || !targetNode) {
    throw new Error(`Edge nodes not found: ${edgeSpec.source} → ${edgeSpec.target}`);
  }

  // Mock mode
  if (!env.AZURE_LIVE_DIAGRAM_ENABLED) {
    const result = generateMockEdgeDetail(edgeSpec, sourceNode, targetNode);
    edgeDetailCache.set(cacheKey, result);
    return result;
  }

  // Real mode: extract from ARM + node metadata
  const sourceNics = extractNics(sourceNode);
  const targetNics = extractNics(targetNode);

  // Parallel ARM fetches for NSG and UDR (optional, fail-safe)
  const [sourceNsg, targetNsg, udr] = await Promise.all([
    sourceNode.metadata?.nsgId
      ? fetchNsgInfo(env, bearerToken, sourceNode.metadata.nsgId)
      : Promise.resolve(undefined),
    targetNode.metadata?.nsgId
      ? fetchNsgInfo(env, bearerToken, targetNode.metadata.nsgId)
      : Promise.resolve(undefined),
    sourceNode.metadata?.routeTableId
      ? fetchUdrInfo(env, bearerToken, sourceNode.metadata.routeTableId)
      : targetNode.metadata?.routeTableId
        ? fetchUdrInfo(env, bearerToken, targetNode.metadata.routeTableId)
        : Promise.resolve(undefined),
  ]);

  // No flow log integration for real mode in this implementation —
  // NSG flow logs are aggregated at edge level in liveAggregator, not by IP pair.
  // Return empty flows with metadata from ARM.
  const result: EdgeNetworkDetail = {
    edgeId: edgeSpec.id,
    generatedAt: new Date().toISOString(),
    sourceNodeId: sourceNode.id,
    sourceNodeLabel: sourceNode.label,
    targetNodeId: targetNode.id,
    targetNodeLabel: targetNode.label,
    protocol: edgeSpec.protocol,
    edgeKind: edgeSpec.edgeKind,
    sourceNics,
    targetNics,
    sourceNsg,
    targetNsg,
    udr,
    inboundFlows: [],
    outboundFlows: [],
    inboundSummary: { flowCount: 0, totalBytesBps: 0, topPorts: [], externalSourceCount: 0 },
    outboundSummary: { flowCount: 0, totalBytesBps: 0, topPorts: [], externalSourceCount: 0 },
  };

  edgeDetailCache.set(cacheKey, result);
  return result;
}
