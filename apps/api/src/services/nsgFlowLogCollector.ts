import { BlobServiceClient } from "@azure/storage-blob";
import type { Env } from "../env";
import type { DiagramNodeSpec, DiagramEdgeSpec } from "@aud/types";
import { CacheManager } from "../infra/cacheManager";
import { getSPCredential } from "../infra/azureClientFactory";
import { buildIpResourceMap, resolveIpsToNodes, type IpResourceMap } from "./ipResourceMapper";

// ────────────────────────────────────────────
// NSG Flow Log Collector
//
// Reads raw NSG Flow Log JSON from Azure Blob Storage,
// parses flow tuples, aggregates by source/target IP,
// then maps to diagram edges using IP→Resource mapper.
// ────────────────────────────────────────────

export type NsgFlowEdgeData = {
  edgeId: string;
  totalBytes: number;
  allowedFlows: number;
  deniedFlows: number;
  throughputBps: number;
};

const nsgFlowCache = new CacheManager<NsgFlowEdgeData[]>(10, 120_000);

// NSG Flow Log JSON structure (Version 2)
type NsgFlowLogFile = {
  records: NsgFlowRecord[];
};

type NsgFlowRecord = {
  time: string;
  systemId: string;
  macAddress: string;
  category: string;
  resourceId: string;
  operationName: string;
  properties: {
    Version: number;
    flows: NsgFlowRuleGroup[];
  };
};

type NsgFlowRuleGroup = {
  rule: string;
  flows: NsgFlowGroup[];
};

type NsgFlowGroup = {
  mac: string;
  flowTuples: string[];
};

// Parsed flow tuple
type FlowTuple = {
  timestamp: number;
  srcIp: string;
  destIp: string;
  srcPort: number;
  destPort: number;
  protocol: "T" | "U"; // TCP or UDP
  direction: "I" | "O"; // Inbound or Outbound
  action: "A" | "D";    // Allow or Deny
  // Version 2 fields
  flowState?: string;    // B(egin), C(ontinue), E(nd)
  packetsSrcToDest?: number;
  bytesSrcToDest?: number;
  packetsDestToSrc?: number;
  bytesDestToSrc?: number;
};

/**
 * Collect NSG Flow Logs from Azure Blob Storage and map to diagram edges.
 */
export async function collectNsgFlowLogs(
  env: Env,
  bearerToken: string | undefined,
  nodes: DiagramNodeSpec[],
  edges: DiagramEdgeSpec[],
): Promise<NsgFlowEdgeData[]> {
  if (!env.AZURE_NSG_FLOW_LOG_STORAGE_ACCOUNT) return [];

  const cacheKey = `nsgflow:${env.AZURE_NSG_FLOW_LOG_STORAGE_ACCOUNT}:${edges.length}`;
  const cached = nsgFlowCache.get(cacheKey);
  if (cached) return cached;

  // Build IP→Resource map
  const ipMap = await buildIpResourceMap(env, bearerToken, nodes);

  // Connect to blob storage using SP credential
  const credential = getSPCredential(env);
  const blobServiceClient = new BlobServiceClient(
    `https://${env.AZURE_NSG_FLOW_LOG_STORAGE_ACCOUNT}.blob.core.windows.net`,
    credential,
  );

  const containerClient = blobServiceClient.getContainerClient(env.AZURE_NSG_FLOW_LOG_CONTAINER);

  // List recent blobs (last hour)
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 3600_000);
  const blobPrefix = buildBlobPrefix(oneHourAgo);

  // Aggregate flows per IP pair
  const ipPairTraffic = new Map<string, { totalBytes: number; allowed: number; denied: number }>();

  try {
    const blobIter = containerClient.listBlobsFlat({ prefix: blobPrefix });
    let blobCount = 0;

    for await (const blobItem of blobIter) {
      if (blobCount >= 10) break; // Limit to 10 most recent blobs
      if (!blobItem.name.endsWith(".json")) continue;

      try {
        const blobClient = containerClient.getBlobClient(blobItem.name);
        const downloadResponse = await blobClient.download(0);
        const bodyStr = await streamToString(downloadResponse.readableStreamBody);
        const flowLog = JSON.parse(bodyStr) as NsgFlowLogFile;

        for (const record of flowLog.records) {
          for (const ruleGroup of record.properties.flows) {
            for (const flowGroup of ruleGroup.flows) {
              for (const tupleStr of flowGroup.flowTuples) {
                const tuple = parseFlowTuple(tupleStr);
                if (!tuple) continue;

                const key = `${tuple.srcIp}→${tuple.destIp}`;
                const existing = ipPairTraffic.get(key) ?? { totalBytes: 0, allowed: 0, denied: 0 };

                const bytes = (tuple.bytesSrcToDest ?? 0) + (tuple.bytesDestToSrc ?? 0);
                existing.totalBytes += bytes;

                if (tuple.action === "A") existing.allowed++;
                else existing.denied++;

                ipPairTraffic.set(key, existing);
              }
            }
          }
        }

        blobCount++;
      } catch {
        // Skip malformed blobs
      }
    }
  } catch {
    // Storage access failed — return empty
    return [];
  }

  // Map IP pairs to diagram edges
  const edgeLookup = new Map<string, string>();
  for (const edge of edges) {
    edgeLookup.set(`${edge.source}→${edge.target}`, edge.id);
    edgeLookup.set(`${edge.target}→${edge.source}`, edge.id);
  }

  const edgeTraffic = new Map<string, { totalBytes: number; allowed: number; denied: number }>();

  for (const [key, data] of ipPairTraffic) {
    const [srcIp, destIp] = key.split("→");
    if (!srcIp || !destIp) continue;

    const { srcNodeId, destNodeId } = resolveIpsToNodes(ipMap, srcIp, destIp);
    if (!srcNodeId || !destNodeId || srcNodeId === destNodeId) continue;

    const edgeId = edgeLookup.get(`${srcNodeId}→${destNodeId}`);
    if (!edgeId) continue;

    const existing = edgeTraffic.get(edgeId) ?? { totalBytes: 0, allowed: 0, denied: 0 };
    existing.totalBytes += data.totalBytes;
    existing.allowed += data.allowed;
    existing.denied += data.denied;
    edgeTraffic.set(edgeId, existing);
  }

  // Convert to NsgFlowEdgeData[]
  const LOOKBACK_SECONDS = 3600; // 1 hour
  const result: NsgFlowEdgeData[] = [];

  for (const [edgeId, data] of edgeTraffic) {
    result.push({
      edgeId,
      totalBytes: data.totalBytes,
      allowedFlows: data.allowed,
      deniedFlows: data.denied,
      throughputBps: Math.round((data.totalBytes * 8) / LOOKBACK_SECONDS),
    });
  }

  nsgFlowCache.set(cacheKey, result);
  return result;
}

// ── Helpers ──

/**
 * Parse a NSG flow tuple string into structured data.
 * Format: timestamp,srcIP,destIP,srcPort,destPort,protocol,direction,action[,flowState,packets1,bytes1,packets2,bytes2]
 */
function parseFlowTuple(tupleStr: string): FlowTuple | null {
  const parts = tupleStr.split(",");
  if (parts.length < 8) return null;

  return {
    timestamp: parseInt(parts[0]!, 10),
    srcIp: parts[1]!,
    destIp: parts[2]!,
    srcPort: parseInt(parts[3]!, 10),
    destPort: parseInt(parts[4]!, 10),
    protocol: parts[5] as "T" | "U",
    direction: parts[6] as "I" | "O",
    action: parts[7] as "A" | "D",
    flowState: parts[8],
    packetsSrcToDest: parts[9] ? parseInt(parts[9], 10) : undefined,
    bytesSrcToDest: parts[10] ? parseInt(parts[10], 10) : undefined,
    packetsDestToSrc: parts[11] ? parseInt(parts[11], 10) : undefined,
    bytesDestToSrc: parts[12] ? parseInt(parts[12], 10) : undefined,
  };
}

/**
 * Build blob prefix for the given time window.
 * NSG Flow Logs use path: resourceId=.../y=YYYY/m=MM/d=DD/h=HH/...
 */
function buildBlobPrefix(since: Date): string {
  const y = since.getUTCFullYear();
  const m = String(since.getUTCMonth() + 1).padStart(2, "0");
  const d = String(since.getUTCDate()).padStart(2, "0");
  const h = String(since.getUTCHours()).padStart(2, "0");
  return `resourceId=/y=${y}/m=${m}/d=${d}/h=${h}/`;
}

/** Convert a ReadableStream to string. */
async function streamToString(stream: NodeJS.ReadableStream | undefined): Promise<string> {
  if (!stream) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as unknown as Uint8Array));
  }
  return Buffer.concat(chunks).toString("utf-8");
}
