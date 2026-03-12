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
  BackendPoolInfo,
  BackendPoolMember,
  AksPlaneDetail,
  AksControlPlaneInfo,
  AksNodePoolInfo,
  AksExposurePathInfo,
  AksExposureResource,
  AksVmssInstance,
} from "@aud/types";
import { getDiagramSpec } from "./liveAggregator";
import { getArmFetcherAuto } from "../infra/azureClientFactory";
import { CacheManager, bearerKeyPrefix } from "../infra/cacheManager";
import { fetchAksNodeInfoMap } from "./kubernetes";

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

export async function fetchNsgInfo(env: Env, bearerToken: string | undefined, nsgId: string): Promise<NsgInfo | undefined> {
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

// ──────────────────────────────────────────────
// Backend Pool Info (LB / Application Gateway)
// ──────────────────────────────────────────────

const backendPoolCache = new CacheManager<BackendPoolInfo[]>(50, 60_000);

interface ArmLbResponse {
  properties?: {
    backendAddressPools?: Array<{
      name?: string;
      id?: string;
      properties?: {
        loadBalancingRules?: Array<{ id?: string }>;
        loadBalancerBackendAddresses?: Array<{
          name?: string;
          properties?: { ipAddress?: string };
        }>;
        backendIPConfigurations?: Array<{ id?: string }>;
      };
    }>;
    probes?: Array<{
      name?: string;
      properties?: {
        protocol?: string;
        port?: number;
        requestPath?: string;
        intervalInSeconds?: number;
        numberOfProbes?: number;
      };
    }>;
  };
}

interface ArmAgwResponse {
  properties?: {
    backendAddressPools?: Array<{
      name?: string;
      id?: string;
      properties?: {
        backendAddresses?: Array<{ ipAddress?: string; fqdn?: string }>;
      };
    }>;
    probes?: Array<{
      name?: string;
      properties?: {
        protocol?: string;
        path?: string;
        interval?: number;
        unhealthyThreshold?: number;
        port?: number;
      };
    }>;
  };
}

function mockBackendPools(resourceKind: string): BackendPoolInfo[] {
  if (resourceKind === "lb") {
    return [
      {
        name: "backendPool-web",
        loadBalancingRules: ["HTTP-Rule-80", "HTTPS-Rule-443"],
        members: [
          { name: "vm-web-01", ipAddress: "10.0.1.4", port: 80, state: "Healthy", kind: "ip" },
          { name: "vm-web-02", ipAddress: "10.0.1.5", port: 80, state: "Healthy", kind: "ip" },
          { name: "vm-web-03", ipAddress: "10.0.1.6", port: 80, state: "Unhealthy", kind: "ip" },
        ],
        probe: { name: "http-probe", protocol: "Http", port: 80, path: "/health", intervalSec: 15, unhealthyThreshold: 2 },
        note: "mock",
      },
    ];
  }
  // appGateway
  return [
    {
      name: "appGwBackendPool",
      members: [
        { name: "app-01", ipAddress: "10.0.2.10", state: "Healthy", kind: "ip" },
        { name: "app-svc", fqdn: "myapp.azurewebsites.net", state: "Healthy", kind: "fqdn" },
      ],
      probe: { name: "http-probe", protocol: "Http", port: 80, path: "/healthz", intervalSec: 30, unhealthyThreshold: 3 },
      note: "mock",
    },
  ];
}

export async function fetchBackendPoolInfo(
  env: Env,
  bearerToken: string | undefined,
  resourceId: string,
  resourceKind: string,
): Promise<BackendPoolInfo[]> {
  const cacheKey = `${bearerToken ? bearerKeyPrefix(bearerToken) : "anon"}:backend-pool:${resourceId}`;
  const cached = backendPoolCache.get(cacheKey);
  if (cached) return cached;

  if (!env.AZURE_LIVE_DIAGRAM_ENABLED) {
    const result = mockBackendPools(resourceKind);
    backendPoolCache.set(cacheKey, result);
    return result;
  }

  try {
    const fetcher = await getArmFetcherAuto(env, bearerToken);
    const url = `https://management.azure.com${resourceId}?api-version=2024-05-01`;

    if (resourceKind === "lb") {
      const data = await fetcher.fetchJson<ArmLbResponse>(url);
      const pools = data.properties?.backendAddressPools ?? [];
      const firstProbe = data.properties?.probes?.[0];
      const probe = firstProbe ? {
        name: firstProbe.name ?? "probe",
        protocol: firstProbe.properties?.protocol ?? "Http",
        port: firstProbe.properties?.port ?? 80,
        path: firstProbe.properties?.requestPath,
        intervalSec: firstProbe.properties?.intervalInSeconds ?? 15,
        unhealthyThreshold: firstProbe.properties?.numberOfProbes ?? 2,
      } : undefined;

      const result: BackendPoolInfo[] = pools.map((pool) => {
        const members: BackendPoolMember[] = (pool.properties?.loadBalancerBackendAddresses ?? []).map((addr) => ({
          name: addr.name ?? "member",
          ipAddress: addr.properties?.ipAddress,
          state: "Unknown" as const,
          kind: "ip" as const,
        }));
        const rules = (pool.properties?.loadBalancingRules ?? [])
          .map((r) => r.id?.split("/").pop())
          .filter((r): r is string => !!r);
        return { name: pool.name ?? "pool", resourceId: pool.id, loadBalancingRules: rules, members, probe };
      });
      backendPoolCache.set(cacheKey, result);
      return result;
    }

    // appGateway
    const data = await fetcher.fetchJson<ArmAgwResponse>(url);
    const pools = data.properties?.backendAddressPools ?? [];
    const firstProbe = data.properties?.probes?.[0];
    const probe = firstProbe ? {
      name: firstProbe.name ?? "probe",
      protocol: firstProbe.properties?.protocol ?? "Http",
      port: firstProbe.properties?.port ?? 80,
      path: firstProbe.properties?.path,
      intervalSec: firstProbe.properties?.interval ?? 30,
      unhealthyThreshold: firstProbe.properties?.unhealthyThreshold ?? 3,
    } : undefined;

    const result: BackendPoolInfo[] = pools.map((pool) => {
      const members: BackendPoolMember[] = (pool.properties?.backendAddresses ?? []).map((addr, i) => ({
        name: addr.fqdn ?? addr.ipAddress ?? `member-${i}`,
        ipAddress: addr.ipAddress,
        fqdn: addr.fqdn,
        state: "Unknown" as const,
        kind: addr.fqdn ? "fqdn" as const : "ip" as const,
      }));
      return { name: pool.name ?? "pool", resourceId: pool.id, members, probe };
    });
    backendPoolCache.set(cacheKey, result);
    return result;
  } catch {
    const result = mockBackendPools(resourceKind);
    backendPoolCache.set(cacheKey, result);
    return result;
  }
}

// ══════════════════════════════════════════════════════════════
// AKS Plane Detail (접속면 / 실행면 / 노출면)
// On-demand detail for AKS cluster resource
// ══════════════════════════════════════════════════════════════

const aksPlaneCache = new CacheManager<AksPlaneDetail>(20, 60_000);
const vmssInstanceCache = new CacheManager<AksVmssInstance[]>(30, 60_000);

/**
 * Fetch VMSS instances for an AKS node pool VMSS.
 * Returns instance list with computerName, powerState, privateIp.
 */
export async function fetchVmssInstances(
  env: Env,
  bearerToken: string | undefined,
  vmssResourceId: string,
  aksClusterArmId?: string,
): Promise<AksVmssInstance[]> {
  const cacheKey = `${bearerKeyPrefix(bearerToken ?? "")}vmss-inst:${vmssResourceId}`;
  const cached = vmssInstanceCache.get(cacheKey);
  if (cached) return cached;

  try {
    const arm = await getArmFetcherAuto(env, bearerToken);

    // Fetch ARM VMs (power state), ARM NICs (fallback IP), and optionally K8s nodes (real IP + conditions) in parallel.
    const [data, nicsData, k8sNodes] = await Promise.all([
      arm.fetchJson<Record<string, unknown>>(
        `https://management.azure.com${vmssResourceId}/virtualMachines?api-version=2024-03-01&$expand=instanceView`,
      ),
      arm.fetchJson<Record<string, unknown>>(
        `https://management.azure.com${vmssResourceId}/networkInterfaces?api-version=2018-10-01`,
      ).catch(() => null),
      aksClusterArmId
        ? fetchAksNodeInfoMap(env, bearerToken, aksClusterArmId).catch(() => null)
        : Promise.resolve(null),
    ]);
    const instances = ((data?.value ?? []) as Array<Record<string, unknown>>).slice(0, 50);

    // Build instanceId → privateIp map from ARM NIC API (fallback when K8s unavailable)
    const instanceIpMap = new Map<string, string>();
    for (const nic of ((nicsData?.value ?? []) as Array<Record<string, unknown>>)) {
      const nicProps = (nic.properties ?? {}) as Record<string, unknown>;
      const vmRef = (nicProps.virtualMachine ?? {}) as Record<string, unknown>;
      const instanceId = String(vmRef.id ?? "").split("/").pop() ?? "";
      const ipConfigs = (nicProps.ipConfigurations ?? []) as Array<Record<string, unknown>>;
      const ip = String(((ipConfigs[0]?.properties ?? {}) as Record<string, unknown>).privateIPAddress ?? "");
      if (instanceId && ip) instanceIpMap.set(instanceId, ip);
    }

    // Parse pool name once (same for all instances)
    const vmssShortName = String(vmssResourceId.split("/").pop() ?? "");
    const poolNameMatch = vmssShortName.replace(/^aks-/, "").replace(/-[0-9a-f]+-vmss$/i, "");
    const nodePoolName = poolNameMatch || undefined;

    const result: AksVmssInstance[] = instances.map((inst) => {
      const instProps = (inst.properties ?? {}) as Record<string, unknown>;
      const osProfile = (instProps.osProfile ?? {}) as Record<string, unknown>;
      const instanceId = String(inst.instanceId ?? inst.name ?? "");
      const computerName = String(osProfile.computerName ?? inst.name ?? "");

      // Power state from ARM instance view statuses
      const statuses = ((instProps.instanceView as Record<string, unknown>)?.statuses ?? []) as Array<Record<string, unknown>>;
      const powerStatus = statuses.find((s) => String(s.code ?? "").startsWith("PowerState/"));
      const powerState = powerStatus ? String(powerStatus.code).replace("PowerState/", "") : "unknown";

      // Prefer K8s node data (accurate IP, nodeImageVersion, real conditions) over ARM
      const k8sNode = k8sNodes?.[computerName];

      return {
        instanceId,
        computerName,
        provisioningState: String(instProps.provisioningState ?? "Succeeded"),
        powerState,
        privateIp: k8sNode?.privateIp || instanceIpMap.get(instanceId) || undefined,
        nodePoolName,
        nodeImageVersion: k8sNode?.nodeImageVersion,
        conditions: k8sNode?.conditions,
      };
    });

    vmssInstanceCache.set(cacheKey, result);
    return result;
  } catch (err) {
    console.error(`[vmss-instances] Failed for ${vmssResourceId}:`, err);
    // Return mock instances
    const result = mockVmssInstances(vmssResourceId);
    vmssInstanceCache.set(cacheKey, result);
    return result;
  }
}

function mockVmssInstances(vmssResourceId: string): AksVmssInstance[] {
  const name = vmssResourceId.split("/").pop() ?? "vmss";
  return Array.from({ length: 3 }, (_, i) => ({
    instanceId: String(i),
    computerName: `${name}00000${i}`,
    provisioningState: "Succeeded",
    powerState: "running",
    privateIp: `10.0.1.${4 + i}`,
  }));
}

/**
 * Fetch AKS plane detail: control plane, node pools, exposure paths.
 * Uses ARM API to get full cluster properties + VMSS instances on demand.
 */
export async function fetchAksPlaneDetail(
  env: Env,
  bearerToken: string | undefined,
  resourceId: string,
): Promise<AksPlaneDetail> {
  const cacheKey = `${bearerKeyPrefix(bearerToken ?? "")}aks-plane:${resourceId}`;
  const cached = aksPlaneCache.get(cacheKey);
  if (cached) return cached;

  try {
    const arm = await getArmFetcherAuto(env, bearerToken);

    // Fetch AKS cluster properties via ARM
    const clusterData = await arm.fetchJson<Record<string, unknown>>(`https://management.azure.com${resourceId}?api-version=2024-02-01`);
    const props = (clusterData?.properties ?? {}) as Record<string, unknown>;
    const clusterName = String(clusterData?.name ?? resourceId.split("/").pop() ?? "aks");

    // ── 접속면 (Control Plane) ──
    const accessProfile = (props.apiServerAccessProfile ?? {}) as Record<string, unknown>;
    const isPrivate = !!accessProfile.enablePrivateCluster;
    const fqdn = String(props.fqdn ?? "");
    const privateFqdn = String(props.privateFQDN ?? "");

    let accessPath: AksControlPlaneInfo["accessPath"] = "internet";
    if (isPrivate) {
      if (accessProfile.privateDNSZone as string) accessPath = "private-link";
      else accessPath = "vnet-integration";
    }

    const controlPlane: AksControlPlaneInfo = {
      fqdn,
      privateFqdn: privateFqdn || undefined,
      isPrivateCluster: isPrivate,
      apiServerEndpoint: isPrivate ? (privateFqdn || fqdn) : fqdn,
      authorizedIpRanges: (accessProfile.authorizedIPRanges as string[] | undefined) ?? undefined,
      enablePrivateClusterPublicFqdn: (accessProfile.enablePrivateClusterPublicFQDN as boolean | undefined) ?? undefined,
      privateDnsZone: (accessProfile.privateDNSZone as string | undefined) ?? undefined,
      accessPath,
    };

    // ── 실행면 (Node Pools) ──
    const agentPools = (props.agentPoolProfiles ?? []) as Array<Record<string, unknown>>;
    const nodeResourceGroup = (props.nodeResourceGroup ?? "") as string;
    const subscriptionId = resourceId.split("/")[2] ?? "";

    const nodePools: AksNodePoolInfo[] = agentPools.map((ap) => {
      const poolName = String(ap.name ?? "");
      // Construct VMSS resource ID from convention: MC_rg_cluster_region / aks-{poolname}-{hash}-vmss
      const vmssId = nodeResourceGroup
        ? `/subscriptions/${subscriptionId}/resourceGroups/${nodeResourceGroup}/providers/Microsoft.Compute/virtualMachineScaleSets/aks-${poolName}-00000000-vmss`
        : undefined;

      return {
        name: poolName,
        mode: (String(ap.mode ?? "User") as "System" | "User"),
        vmSize: String(ap.vmSize ?? ""),
        nodeCount: typeof ap.count === "number" ? ap.count : 0,
        minCount: typeof ap.minCount === "number" ? ap.minCount : undefined,
        maxCount: typeof ap.maxCount === "number" ? ap.maxCount : undefined,
        enableAutoScaling: !!ap.enableAutoScaling,
        osType: String(ap.osType ?? "Linux"),
        osSKU: ap.osSKU ? String(ap.osSKU) : undefined,
        orchestratorVersion: ap.orchestratorVersion ? String(ap.orchestratorVersion) : undefined,
        nodeImageVersion: ap.nodeImageVersion ? String(ap.nodeImageVersion) : undefined,
        powerState: String((ap.powerState as Record<string, unknown>)?.code ?? "Running"),
        provisioningState: String(ap.provisioningState ?? "Succeeded"),
        availabilityZones: Array.isArray(ap.availabilityZones) ? ap.availabilityZones.map(String) : undefined,
        vnetSubnetId: ap.vnetSubnetID ? String(ap.vnetSubnetID) : undefined,
        vmssResourceId: vmssId,
      };
    });

    // Try to fetch VMSS instances for each node pool (best-effort)
    if (nodeResourceGroup) {
      for (const pool of nodePools) {
        try {
          // List VMSS in MC_* RG and match by pool name
          const vmssListUrl = `https://management.azure.com/subscriptions/${subscriptionId}/resourceGroups/${nodeResourceGroup}/providers/Microsoft.Compute/virtualMachineScaleSets?api-version=2024-03-01`;
          const vmssList = await arm.fetchJson<Record<string, unknown>>(vmssListUrl);
          const vmssArr = (vmssList?.value ?? []) as Array<Record<string, unknown>>;
          const matchedVmss = vmssArr.find((v) => {
            const name = String(v.name ?? "").toLowerCase();
            return name.includes(pool.name.toLowerCase());
          });

          if (matchedVmss) {
            const vmssId = String(matchedVmss.id ?? "");
            pool.vmssResourceId = vmssId || pool.vmssResourceId;
            // Fetch instances + NICs in parallel
            try {
              const [instancesData, nicsData] = await Promise.all([
                arm.fetchJson<Record<string, unknown>>(
                  `https://management.azure.com${vmssId}/virtualMachines?api-version=2024-03-01&$expand=instanceView`,
                ),
                arm.fetchJson<Record<string, unknown>>(
                  `https://management.azure.com${vmssId}/networkInterfaces?api-version=2018-10-01`,
                ).catch(() => null),
              ]);
              const instances = (instancesData?.value ?? []) as Array<Record<string, unknown>>;

              // Build instanceId → privateIp map
              const instanceIpMap = new Map<string, string>();
              for (const nic of ((nicsData?.value ?? []) as Array<Record<string, unknown>>)) {
                const nicProps = (nic.properties ?? {}) as Record<string, unknown>;
                const vmRef = (nicProps.virtualMachine ?? {}) as Record<string, unknown>;
                const instanceId = String(vmRef.id ?? "").split("/").pop() ?? "";
                const ipConfigs = (nicProps.ipConfigurations ?? []) as Array<Record<string, unknown>>;
                const ip = String(((ipConfigs[0]?.properties ?? {}) as Record<string, unknown>).privateIPAddress ?? "");
                if (instanceId && ip) instanceIpMap.set(instanceId, ip);
              }

              pool.vmssInstances = instances.slice(0, 20).map((inst) => {
                const instProps = (inst.properties ?? {}) as Record<string, unknown>;
                const osProfile = (instProps.osProfile ?? {}) as Record<string, unknown>;
                const instanceId = String(inst.instanceId ?? inst.name ?? "");
                const statuses = ((instProps.instanceView as Record<string, unknown>)?.statuses ?? []) as Array<Record<string, unknown>>;
                const powerStatus = statuses.find((s) => String(s.code ?? "").startsWith("PowerState/"));
                const powerState = powerStatus ? String(powerStatus.code).replace("PowerState/", "") : "unknown";

                return {
                  instanceId,
                  computerName: String(osProfile.computerName ?? inst.name ?? ""),
                  provisioningState: String(instProps.provisioningState ?? "Succeeded"),
                  powerState,
                  privateIp: instanceIpMap.get(instanceId) || undefined,
                  nodePoolName: pool.name,
                  nodeImageVersion: pool.nodeImageVersion,
                };
              });
            } catch {
              // VMSS instance fetch failed — leave empty
            }
          }
        } catch {
          // VMSS list fetch failed — leave empty
        }
      }
    }

    // ── 노출면 (Exposure Paths) ──
    const exposurePaths: AksExposurePathInfo[] = [];
    const netProfile = (props.networkProfile ?? {}) as Record<string, unknown>;
    const outboundType = String(netProfile.outboundType ?? "loadBalancer");
    const lbSku = String(netProfile.loadBalancerSku ?? "standard");

    // Ingress: detect LB or AppGW from the diagram spec if available
    const diagramSpec = getDiagramSpec(`auto-${subscriptionId.slice(0, 8)}`);
    if (diagramSpec) {
      const aksArchGroupPrefix = `aks-${clusterName.toLowerCase().replace(/[^a-z0-9-]/g, "")}`;
      const ingressResources: AksExposureResource[] = [];
      const egressResources: AksExposureResource[] = [];

      for (const node of diagramSpec.nodes) {
        const archRole = node.metadata?.archRole;
        const archGroup = node.metadata?.archGroupId;
        if (!archGroup || !archGroup.startsWith(aksArchGroupPrefix)) continue;

        if (archRole === "aks-ingress") {
          ingressResources.push({
            role: node.resourceKind === "appGateway" ? "app-gateway" : "lb",
            name: node.label,
            azureResourceId: node.azureResourceId,
            endpoint: node.endpoint,
            sku: lbSku,
          });
        } else if (archRole === "aks-egress") {
          egressResources.push({
            role: "firewall",
            name: node.label,
            azureResourceId: node.azureResourceId,
            endpoint: node.endpoint,
          });
        }
      }

      if (ingressResources.length > 0) {
        exposurePaths.push({
          direction: "ingress",
          label: `인터넷 → ${ingressResources.map((r) => r.name).join(" → ")} → AKS`,
          resources: ingressResources,
        });
      }

      // Egress path based on outboundType
      if (outboundType === "userDefinedRouting" && egressResources.length > 0) {
        exposurePaths.push({
          direction: "egress",
          label: `AKS → ${egressResources.map((r) => r.name).join(" → ")} → 인터넷`,
          resources: egressResources,
        });
      } else if (outboundType === "loadBalancer") {
        exposurePaths.push({
          direction: "egress",
          label: "AKS → Load Balancer (SNAT) → 인터넷",
          resources: [{ role: "lb", name: "AKS Standard LB", sku: lbSku }],
        });
      } else if (outboundType === "managedNATGateway") {
        exposurePaths.push({
          direction: "egress",
          label: "AKS → NAT Gateway → 인터넷",
          resources: [{ role: "nat-gateway", name: "Managed NAT Gateway" }],
        });
      }
    }

    // Fallback: always include LB egress if no paths found
    if (exposurePaths.length === 0) {
      exposurePaths.push({
        direction: "egress",
        label: `AKS → ${outboundType === "userDefinedRouting" ? "UDR (Firewall)" : outboundType} → 인터넷`,
        resources: [{
          role: outboundType === "managedNATGateway" ? "nat-gateway" : "lb",
          name: outboundType === "userDefinedRouting" ? "Firewall (UDR)" : `AKS ${lbSku} LB`,
          sku: lbSku,
        }],
      });
    }

    const result: AksPlaneDetail = {
      clusterId: resourceId,
      clusterName,
      generatedAt: new Date().toISOString(),
      controlPlane,
      nodePools,
      exposurePaths,
      networkProfile: {
        networkPlugin: String(netProfile.networkPlugin ?? "azure"),
        networkPolicy: netProfile.networkPolicy ? String(netProfile.networkPolicy) : undefined,
        serviceCidr: netProfile.serviceCidr ? String(netProfile.serviceCidr) : undefined,
        dnsServiceIp: netProfile.dnsServiceIP ? String(netProfile.dnsServiceIP) : undefined,
        podCidr: netProfile.podCidr ? String(netProfile.podCidr) : undefined,
        outboundType,
        loadBalancerSku: lbSku,
      },
    };

    aksPlaneCache.set(cacheKey, result);
    return result;
  } catch (err) {
    console.error(`[aks-plane-detail] Failed for ${resourceId}:`, err);
    // Return mock/minimal data
    const result = mockAksPlaneDetail(resourceId);
    aksPlaneCache.set(cacheKey, result);
    return result;
  }
}

/** Mock AKS plane detail for dev/demo mode */
function mockAksPlaneDetail(resourceId: string): AksPlaneDetail {
  const clusterName = resourceId.split("/").pop() ?? "aks-cluster";
  return {
    clusterId: resourceId,
    clusterName,
    generatedAt: new Date().toISOString(),
    controlPlane: {
      fqdn: `${clusterName}-dns-abcd1234.hcp.koreacentral.azmk8s.io`,
      isPrivateCluster: false,
      apiServerEndpoint: `${clusterName}-dns-abcd1234.hcp.koreacentral.azmk8s.io`,
      accessPath: "internet",
    },
    nodePools: [
      {
        name: "systempool",
        mode: "System",
        vmSize: "Standard_D4s_v5",
        nodeCount: 3,
        minCount: 3,
        maxCount: 5,
        enableAutoScaling: true,
        osType: "Linux",
        osSKU: "AzureLinux",
        orchestratorVersion: "1.29.2",
        powerState: "Running",
        provisioningState: "Succeeded",
        availabilityZones: ["1", "2", "3"],
        vmssInstances: [
          { instanceId: "0", computerName: "aks-systempool-00000-vmss000000", provisioningState: "Succeeded", powerState: "running", privateIp: "10.0.1.4" },
          { instanceId: "1", computerName: "aks-systempool-00000-vmss000001", provisioningState: "Succeeded", powerState: "running", privateIp: "10.0.1.5" },
          { instanceId: "2", computerName: "aks-systempool-00000-vmss000002", provisioningState: "Succeeded", powerState: "running", privateIp: "10.0.1.6" },
        ],
      },
      {
        name: "userpool",
        mode: "User",
        vmSize: "Standard_D8s_v5",
        nodeCount: 5,
        minCount: 2,
        maxCount: 10,
        enableAutoScaling: true,
        osType: "Linux",
        osSKU: "AzureLinux",
        orchestratorVersion: "1.29.2",
        powerState: "Running",
        provisioningState: "Succeeded",
        availabilityZones: ["1", "2", "3"],
        vmssInstances: [
          { instanceId: "0", computerName: "aks-userpool-00000-vmss000000", provisioningState: "Succeeded", powerState: "running", privateIp: "10.0.2.4" },
          { instanceId: "1", computerName: "aks-userpool-00000-vmss000001", provisioningState: "Succeeded", powerState: "running", privateIp: "10.0.2.5" },
          { instanceId: "2", computerName: "aks-userpool-00000-vmss000002", provisioningState: "Succeeded", powerState: "running", privateIp: "10.0.2.6" },
          { instanceId: "3", computerName: "aks-userpool-00000-vmss000003", provisioningState: "Succeeded", powerState: "running", privateIp: "10.0.2.7" },
          { instanceId: "4", computerName: "aks-userpool-00000-vmss000004", provisioningState: "Succeeded", powerState: "running", privateIp: "10.0.2.8" },
        ],
      },
    ],
    exposurePaths: [
      {
        direction: "ingress",
        label: "인터넷 → Application Gateway → AKS",
        resources: [
          { role: "app-gateway", name: "appgw-aks-prod", endpoint: "20.200.100.50", sku: "WAF_v2" },
        ],
      },
      {
        direction: "egress",
        label: "AKS → Load Balancer (SNAT) → 인터넷",
        resources: [
          { role: "lb", name: "kubernetes", sku: "standard" },
        ],
      },
    ],
    networkProfile: {
      networkPlugin: "azure",
      networkPolicy: "calico",
      serviceCidr: "10.0.0.0/16",
      dnsServiceIp: "10.0.0.10",
      podCidr: "10.244.0.0/16",
      outboundType: "loadBalancer",
      loadBalancerSku: "standard",
    },
  };
}
