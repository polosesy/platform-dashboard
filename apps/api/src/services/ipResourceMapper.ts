import type { Env } from "../env";
import type { DiagramNodeSpec } from "@aud/types";
import { CacheManager } from "../infra/cacheManager";
import { getArmFetcherAuto, type ArmFetcher } from "../infra/azureClientFactory";

// ────────────────────────────────────────────
// IP → Resource Reverse Mapper
//
// Queries Azure Resource Graph for NIC private IPs,
// then maps flow log / traffic analytics IP addresses
// to diagram node IDs.
// ────────────────────────────────────────────

export type IpResourceEntry = {
  privateIp: string;
  nicId: string;
  vmId?: string;
  nodeId: string;          // Diagram node ID
  azureResourceId: string; // Full ARM resource ID
};

export type IpResourceMap = Map<string, IpResourceEntry>;

const ipMapCache = new CacheManager<IpResourceMap>(20, 120_000);

type NicIpConfig = {
  id: string;
  name: string;
  properties: {
    ipConfigurations: Array<{
      properties: {
        privateIPAddress?: string;
        subnet?: { id: string };
      };
    }>;
    virtualMachine?: { id: string };
  };
};

type ArmListResponse<T> = {
  value?: T[];
  nextLink?: string;
};

/**
 * Build a reverse map of privateIP → diagram node.
 *
 * Strategy:
 * 1. Fetch all NICs in subscriptions that appear in the diagram
 * 2. Extract private IP → VM/resource mapping
 * 3. Match VM resource IDs to diagram node azureResourceId
 * 4. Also match AKS node pools by subnet membership
 */
export async function buildIpResourceMap(
  env: Env,
  bearerToken: string | undefined,
  nodes: DiagramNodeSpec[],
): Promise<IpResourceMap> {
  const cacheKey = `ipmap:${nodes.map((n) => n.id).sort().join(",")}`;
  const cached = ipMapCache.get(cacheKey);
  if (cached) return cached;

  const fetcher = await getArmFetcherAuto(env, bearerToken);

  // Extract unique subscription IDs from node resource IDs
  const subscriptionIds = new Set<string>();
  const resourceIdToNodeId = new Map<string, string>();

  for (const node of nodes) {
    if (!node.azureResourceId) continue;
    resourceIdToNodeId.set(node.azureResourceId.toLowerCase(), node.id);
    const match = node.azureResourceId.match(/\/subscriptions\/([^/]+)/i);
    if (match) subscriptionIds.add(match[1]!);
  }

  if (subscriptionIds.size === 0) return new Map();

  // Fetch NICs from each subscription
  const allNics: NicIpConfig[] = [];
  for (const subId of subscriptionIds) {
    try {
      const nics = await fetchSubscriptionNics(fetcher, subId);
      allNics.push(...nics);
    } catch {
      // Non-critical: skip failed subscriptions
    }
  }

  // Build IP → Node map
  const ipMap: IpResourceMap = new Map();

  // Also build subnet → nodeId map for AKS/VMSS
  const subnetToNodeIds = buildSubnetToNodeMap(nodes);

  for (const nic of allNics) {
    const vmId = nic.properties.virtualMachine?.id?.toLowerCase();

    for (const ipConfig of nic.properties.ipConfigurations) {
      const ip = ipConfig.properties.privateIPAddress;
      if (!ip) continue;

      // Direct VM match
      if (vmId) {
        const nodeId = resourceIdToNodeId.get(vmId);
        if (nodeId) {
          ipMap.set(ip, {
            privateIp: ip,
            nicId: nic.id,
            vmId: vmId,
            nodeId,
            azureResourceId: vmId,
          });
          continue;
        }
      }

      // Subnet-based match (for AKS, VMSS nodes)
      const subnetId = ipConfig.properties.subnet?.id?.toLowerCase();
      if (subnetId) {
        const subnetNodeIds = subnetToNodeIds.get(subnetId);
        if (subnetNodeIds && subnetNodeIds.length > 0) {
          ipMap.set(ip, {
            privateIp: ip,
            nicId: nic.id,
            vmId,
            nodeId: subnetNodeIds[0]!, // Map to first matching node in subnet
            azureResourceId: vmId ?? nic.id,
          });
        }
      }
    }
  }

  ipMapCache.set(cacheKey, ipMap);
  return ipMap;
}

/**
 * Fetch all NICs in a subscription via ARM API.
 */
async function fetchSubscriptionNics(fetcher: ArmFetcher, subscriptionId: string): Promise<NicIpConfig[]> {
  const nics: NicIpConfig[] = [];
  let url: string | undefined =
    `https://management.azure.com/subscriptions/${subscriptionId}` +
    `/providers/Microsoft.Network/networkInterfaces` +
    `?api-version=2023-11-01&$top=200`;

  while (url) {
    const resp: ArmListResponse<NicIpConfig> = await fetcher.fetchJson<ArmListResponse<NicIpConfig>>(url);
    if (resp.value) nics.push(...resp.value);
    url = resp.nextLink;
  }

  return nics;
}

/**
 * Build a map of subnet ID → diagram node IDs.
 * Used for AKS and VMSS resources where individual VMs
 * may not appear in the diagram but the parent cluster does.
 */
function buildSubnetToNodeMap(
  nodes: DiagramNodeSpec[],
): Map<string, string[]> {
  const map = new Map<string, string[]>();

  for (const node of nodes) {
    if (!node.azureResourceId) continue;
    // AKS managed clusters share subnets with their agent pools
    // Map the AKS resource to its subnet for reverse lookup
    const subnetMatch = node.azureResourceId.match(
      /\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.Network\/virtualNetworks\/[^/]+\/subnets\/[^/]+/i,
    );
    if (subnetMatch) {
      const subnetId = subnetMatch[0].toLowerCase();
      const arr = map.get(subnetId) ?? [];
      arr.push(node.id);
      map.set(subnetId, arr);
    }
  }

  return map;
}

/**
 * Resolve a set of IPs to diagram node IDs using the pre-built map.
 */
export function resolveIpsToNodes(
  ipMap: IpResourceMap,
  srcIp: string,
  destIp: string,
): { srcNodeId: string | null; destNodeId: string | null } {
  return {
    srcNodeId: ipMap.get(srcIp)?.nodeId ?? null,
    destNodeId: ipMap.get(destIp)?.nodeId ?? null,
  };
}
