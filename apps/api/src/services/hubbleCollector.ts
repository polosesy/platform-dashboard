import * as k8s from "@kubernetes/client-node";
import type { Env } from "../env";
import type {
  HubbleFlow,
  HubbleServiceMapResponse,
  HubbleServiceNode,
  HubbleServiceEdge,
  HubbleServiceType,
  HubbleK8sService,
  HubbleEndpointPod,
  HubbleNetworkSummary,
  HubbleSecuritySummary,
} from "@aud/types";
import { getHubbleFlows } from "./hubbleClient";
import { getKubeconfig } from "./kubernetes";
import { CacheManager, bearerKeyPrefix } from "../infra/cacheManager";

// ──────────────────────────────────────────────────────────────
// Hubble Collector
//
// 원시 Hubble 플로우를 수집하고
// Service Map / Network Summary / Security Summary 로 집계합니다.
// ──────────────────────────────────────────────────────────────

// ── Cilium Reserved Identities ──

const CILIUM_RESERVED: Record<number, HubbleServiceType> = {
  0: "init",       // identity unknown
  1: "host",       // local host
  2: "world",      // external traffic
  3: "unmanaged",  // unmanaged endpoints
  4: "dns",        // health (used for DNS sometimes)
  5: "init",       // init identity
  6: "kube-apiserver",
  7: "remote-node",
};

function resolveServiceType(identity: number, labels: Record<string, string>): HubbleServiceType {
  if (CILIUM_RESERVED[identity]) return CILIUM_RESERVED[identity];
  // reserved:world / reserved:host 라벨 확인
  const reserved = labels["reserved:world"] ?? labels["reserved:host"] ?? labels["reserved:kube-apiserver"];
  if (reserved !== undefined) {
    if (labels["reserved:world"] !== undefined) return "world";
    if (labels["reserved:host"] !== undefined) return "host";
    if (labels["reserved:kube-apiserver"] !== undefined) return "kube-apiserver";
  }
  // kube-dns / coredns 감지
  const app = labels["k8s:app"] ?? labels["k8s:k8s-app"] ?? "";
  if (app === "kube-dns" || app === "coredns") return "dns";
  return "workload";
}

// ── Service Dependency Map ──

export async function collectServiceMap(
  env: Env,
  bearerToken: string | undefined,
  clusterId: string,
  opts?: { timeWindowMinutes?: number; namespace?: string },
): Promise<HubbleServiceMapResponse> {
  const timeWindowMinutes = opts?.timeWindowMinutes ?? 5;
  const nsFilter = opts?.namespace ?? "";

  const flows = await getHubbleFlows(env, bearerToken, clusterId, {
    last: Math.min(env.HUBBLE_FLOW_LIMIT, 10_000),
    ...(nsFilter ? { namespace: nsFilter } : {}),
  });

  // reply 플로우 제외 (중복 방지)
  const filtered = flows.filter((f) => !f.isReply);

  // 타임스탬프 범위 (flowsPerSecond 계산용)
  let minTime = Infinity;
  let maxTime = -Infinity;
  for (const f of filtered) {
    const t = new Date(f.time).getTime();
    if (t < minTime) minTime = t;
    if (t > maxTime) maxTime = t;
  }
  const timeRangeSec = Math.max(1, (maxTime - minTime) / 1000);

  // ── 노드 집계 ──
  type NodeAcc = {
    namespace: string;
    workloadName: string;
    identity: number;
    serviceType: HubbleServiceType;
    labels: Record<string, string>;
    pods: Set<string>;
    connectedTo: Set<string>;
    totalFlows: number;
    forwardedFlows: number;
    droppedFlows: number;
    httpRequests: number;
    httpErrors: number;
    latencySum: number;
    latencyCount: number;
    dnsQueryCount: number;
    dnsErrorCount: number;
  };
  const nodeMap = new Map<string, NodeAcc>();

  function ensureNode(ep: HubbleFlow["source"]): NodeAcc {
    const id = `${ep.namespace}/${ep.workloadName}`;
    if (!nodeMap.has(id)) {
      nodeMap.set(id, {
        namespace: ep.namespace,
        workloadName: ep.workloadName,
        identity: ep.identity,
        serviceType: resolveServiceType(ep.identity, ep.labels),
        labels: ep.labels,
        pods: new Set(),
        connectedTo: new Set(),
        totalFlows: 0,
        forwardedFlows: 0,
        droppedFlows: 0,
        httpRequests: 0,
        httpErrors: 0,
        latencySum: 0,
        latencyCount: 0,
        dnsQueryCount: 0,
        dnsErrorCount: 0,
      });
    }
    const n = nodeMap.get(id)!;
    if (ep.podName) n.pods.add(ep.podName);
    return n;
  }

  // ── 엣지 집계 (양방향 병합 키: sorted pair) ──
  type EdgeAcc = {
    sourceId: string;
    destId: string;
    protocol: string;
    port: number;
    flowCount: number;
    droppedCount: number;
    httpRequestCount: number;
    httpErrorCount: number;
    latencySum: number;
    latencyCount: number;
    verdictCounts: Map<string, number>;
    reverseFlowCount: number;
    httpMethods: Set<string>;
    topUrls: Map<string, number>;
    dnsQueries: Map<string, number>;
  };
  const edgeMap = new Map<string, EdgeAcc>();

  // 양방향 감지를 위한 방향별 플로우 카운트
  const directionMap = new Map<string, number>(); // "A->B" => count

  for (const flow of filtered) {
    const srcId = `${flow.source.namespace}/${flow.source.workloadName}`;
    const dstId = `${flow.destination.namespace}/${flow.destination.workloadName}`;

    // 자기 자신 플로우 스킵 (health check 등)
    if (srcId === dstId) continue;

    const srcNode = ensureNode(flow.source);
    const dstNode = ensureNode(flow.destination);

    srcNode.connectedTo.add(dstId);
    dstNode.connectedTo.add(srcId);

    srcNode.totalFlows++;
    dstNode.totalFlows++;
    if (flow.verdict === "FORWARDED") {
      srcNode.forwardedFlows++;
      dstNode.forwardedFlows++;
    } else if (flow.verdict === "DROPPED") {
      srcNode.droppedFlows++;
      dstNode.droppedFlows++;
    }

    // HTTP L7 집계
    if (flow.l7?.http) {
      const code = flow.l7.http.code;
      srcNode.httpRequests++;
      dstNode.httpRequests++;
      if (code >= 400) {
        srcNode.httpErrors++;
        dstNode.httpErrors++;
      }
      if (flow.l7.http.latencyNs > 0) {
        const latMs = flow.l7.http.latencyNs / 1_000_000;
        srcNode.latencySum += latMs;
        srcNode.latencyCount++;
        dstNode.latencySum += latMs;
        dstNode.latencyCount++;
      }
    }

    // DNS 집계
    if (flow.l7?.dns) {
      dstNode.dnsQueryCount++;
      if (flow.l7.dns.rcode !== 0) dstNode.dnsErrorCount++;
    }

    // 방향 카운트 (양방향 감지용)
    const fwdKey = `${srcId}->${dstId}`;
    directionMap.set(fwdKey, (directionMap.get(fwdKey) ?? 0) + 1);

    // 엣지 — 정규화된 키 (src,dst 정렬하여 A→B와 B→A 병합)
    const protocol = flow.l7?.type === "HTTP" ? "HTTP"
      : flow.l7?.type === "DNS" ? "DNS"
      : flow.l4Protocol;
    const canonicalSrc = srcId < dstId ? srcId : dstId;
    const canonicalDst = srcId < dstId ? dstId : srcId;
    const isForward = srcId === canonicalSrc;
    const edgeKey = `${canonicalSrc}<->${canonicalDst}:${flow.destinationPort}`;

    if (!edgeMap.has(edgeKey)) {
      edgeMap.set(edgeKey, {
        sourceId: canonicalSrc,
        destId: canonicalDst,
        protocol,
        port: flow.destinationPort,
        flowCount: 0,
        droppedCount: 0,
        httpRequestCount: 0,
        httpErrorCount: 0,
        latencySum: 0,
        latencyCount: 0,
        verdictCounts: new Map(),
        reverseFlowCount: 0,
        httpMethods: new Set(),
        topUrls: new Map(),
        dnsQueries: new Map(),
      });
    }
    const edge = edgeMap.get(edgeKey)!;
    edge.flowCount++;
    if (!isForward) edge.reverseFlowCount++;
    if (flow.verdict === "DROPPED") edge.droppedCount++;
    edge.verdictCounts.set(flow.verdict, (edge.verdictCounts.get(flow.verdict) ?? 0) + 1);

    if (flow.l7?.http) {
      edge.httpRequestCount++;
      if (flow.l7.http.code >= 400) edge.httpErrorCount++;
      if (flow.l7.http.latencyNs > 0) {
        edge.latencySum += flow.l7.http.latencyNs / 1_000_000;
        edge.latencyCount++;
      }
      if (flow.l7.http.method) edge.httpMethods.add(flow.l7.http.method);
      if (flow.l7.http.url) {
        const url = flow.l7.http.url;
        edge.topUrls.set(url, (edge.topUrls.get(url) ?? 0) + 1);
      }
    }
    if (flow.l7?.dns?.query) {
      const q = flow.l7.dns.query;
      edge.dnsQueries.set(q, (edge.dnsQueries.get(q) ?? 0) + 1);
    }
  }

  // ── Build response ──
  const allNamespaces = new Set<string>();

  const nodes: HubbleServiceNode[] = Array.from(nodeMap.entries()).map(([id, n]) => {
    if (n.namespace) allNamespaces.add(n.namespace);
    // 주요 라벨만 추출 (표시용)
    const displayLabels: Record<string, string> = {};
    for (const key of ["k8s:app", "k8s:app.kubernetes.io/name", "k8s:k8s-app", "app", "component"]) {
      if (n.labels[key]) displayLabels[key] = n.labels[key];
    }
    return {
      id,
      namespace: n.namespace,
      workloadName: n.workloadName,
      identity: n.identity,
      podCount: n.pods.size,
      serviceType: n.serviceType,
      labels: displayLabels,
      connectedTo: Array.from(n.connectedTo),
      metrics: {
        totalFlows: n.totalFlows,
        forwardedFlows: n.forwardedFlows,
        droppedFlows: n.droppedFlows,
        httpRequestsTotal: n.httpRequests,
        httpErrorCount: n.httpErrors,
        avgLatencyMs: n.latencyCount > 0 ? Math.round(n.latencySum / n.latencyCount) : null,
        dnsQueryCount: n.dnsQueryCount,
        dnsErrorCount: n.dnsErrorCount,
      },
    };
  });

  const edges: HubbleServiceEdge[] = Array.from(edgeMap.entries()).map(([_key, e]) => {
    // 가장 많은 verdict 선정
    let topVerdict: HubbleFlow["verdict"] = "FORWARDED";
    let topCount = 0;
    for (const [v, c] of e.verdictCounts) {
      if (c > topCount) { topVerdict = v as HubbleFlow["verdict"]; topCount = c; }
    }

    // 양방향 여부: 역방향 플로우가 전체의 10% 이상
    const bidirectional = e.reverseFlowCount > e.flowCount * 0.1;

    // L7 summary
    const l7Summary: HubbleServiceEdge["l7Summary"] = {};
    if (e.httpMethods.size > 0) l7Summary.httpMethods = Array.from(e.httpMethods);
    if (e.topUrls.size > 0) {
      l7Summary.topUrls = Array.from(e.topUrls.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([url]) => url);
    }
    if (e.dnsQueries.size > 0) {
      l7Summary.dnsQueries = Array.from(e.dnsQueries.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([q]) => q);
    }

    // 원래 방향 복원 (canonical에서 실제 주요 방향으로)
    const fwdCount = directionMap.get(`${e.sourceId}->${e.destId}`) ?? 0;
    const revCount = directionMap.get(`${e.destId}->${e.sourceId}`) ?? 0;
    const actualSrc = fwdCount >= revCount ? e.sourceId : e.destId;
    const actualDst = fwdCount >= revCount ? e.destId : e.sourceId;

    return {
      id: `${actualSrc}->${actualDst}:${e.port}`,
      sourceId: actualSrc,
      destinationId: actualDst,
      protocol: e.protocol,
      port: e.port,
      bidirectional,
      metrics: {
        flowCount: e.flowCount,
        droppedCount: e.droppedCount,
        httpRequestCount: e.httpRequestCount,
        httpErrorRate: e.httpRequestCount > 0 ? e.httpErrorCount / e.httpRequestCount : 0,
        avgLatencyMs: e.latencyCount > 0 ? Math.round(e.latencySum / e.latencyCount) : null,
        flowsPerSecond: timeRangeSec > 1 ? Math.round((e.flowCount / timeRangeSec) * 100) / 100 : null,
      },
      verdict: topVerdict,
      ...(Object.keys(l7Summary).length > 0 ? { l7Summary } : {}),
    };
  });

  // ── K8s Service enrichment ──
  try {
    const svcMap = await fetchK8sServiceMap(env, bearerToken, clusterId, Array.from(allNamespaces));
    for (const node of nodes) {
      if (!node.namespace || node.serviceType !== "workload") continue;
      const services = svcMap.get(node.namespace);
      if (!services) continue;
      // selector 라벨 매칭: Service.spec.selector의 모든 키/값이 노드 라벨에 포함
      const matched = services.filter((svc) =>
        Object.entries(svc.selector).every(([k, v]) => {
          // k8s: prefix 제거하여 비교 (Hubble 라벨은 k8s:app 형태)
          const nodeVal = node.labels[`k8s:${k}`] ?? node.labels[k];
          return nodeVal === v;
        }),
      );
      if (matched.length > 0) {
        node.k8sServices = matched;
      }
    }
  } catch (e) {
    console.warn("[hubble] K8s Service enrichment failed:", (e as Error).message);
  }

  return {
    clusterId,
    generatedAt: new Date().toISOString(),
    timeWindowMinutes,
    nodes: nodes.sort((a, b) => b.metrics.totalFlows - a.metrics.totalFlows),
    edges: edges.sort((a, b) => b.metrics.flowCount - a.metrics.flowCount),
    totalFlowsAnalyzed: filtered.length,
    namespaces: Array.from(allNamespaces).sort(),
  };
}

// ── Network Monitoring Summary ──

export async function collectNetworkSummary(
  env: Env,
  bearerToken: string | undefined,
  clusterId: string,
  timeWindowMinutes = 5,
): Promise<HubbleNetworkSummary> {
  const flows = await getHubbleFlows(env, bearerToken, clusterId, {
    last: Math.min(env.HUBBLE_FLOW_LIMIT, 10_000),
  });

  const forwarded = flows.filter((f) => f.verdict === "FORWARDED").length;
  const dropped = flows.filter((f) => f.verdict === "DROPPED").length;

  // Top dropped
  const dropMap = new Map<string, { count: number; reason: string }>();
  for (const f of flows) {
    if (f.verdict !== "DROPPED") continue;
    const key = `${f.source.namespace}/${f.source.workloadName}→${f.destination.namespace}/${f.destination.workloadName}`;
    const entry = dropMap.get(key) ?? { count: 0, reason: f.dropReasonDesc };
    entry.count++;
    dropMap.set(key, entry);
  }
  const topDropped = Array.from(dropMap.entries())
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 10)
    .map(([key, val]) => {
      const [source, destination] = key.split("→");
      return { source: source!, destination: destination!, count: val.count, dropReason: val.reason };
    });

  // DNS errors
  const dnsErrorMap = new Map<string, { rcode: number; count: number }>();
  for (const f of flows) {
    if (!f.l7?.dns || f.l7.dns.rcode === 0) continue;
    const key = `${f.l7.dns.query}:${f.l7.dns.rcode}`;
    const entry = dnsErrorMap.get(key) ?? { rcode: f.l7.dns.rcode, count: 0 };
    entry.count++;
    dnsErrorMap.set(key, entry);
  }
  const dnsErrors = Array.from(dnsErrorMap.entries())
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 10)
    .map(([key, val]) => ({
      query: key.split(":")[0]!,
      rcode: val.rcode,
      count: val.count,
    }));

  // Protocol breakdown
  const protoMap = new Map<string, number>();
  for (const f of flows) {
    const proto = f.l7?.type === "HTTP" ? "HTTP" : f.l7?.type === "DNS" ? "DNS" : f.l4Protocol;
    protoMap.set(proto, (protoMap.get(proto) ?? 0) + 1);
  }
  const protocolBreakdown = Array.from(protoMap.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([protocol, count]) => ({ protocol, count }));

  // Namespace traffic
  const nsMap = new Map<string, { inbound: number; outbound: number; dropped: number }>();
  for (const f of flows) {
    const srcNs = f.source.namespace || "external";
    const dstNs = f.destination.namespace || "external";

    if (!nsMap.has(srcNs)) nsMap.set(srcNs, { inbound: 0, outbound: 0, dropped: 0 });
    if (!nsMap.has(dstNs)) nsMap.set(dstNs, { inbound: 0, outbound: 0, dropped: 0 });

    nsMap.get(srcNs)!.outbound++;
    nsMap.get(dstNs)!.inbound++;
    if (f.verdict === "DROPPED") {
      nsMap.get(dstNs)!.dropped++;
    }
  }
  const namespaceTraffic = Array.from(nsMap.entries())
    .sort((a, b) => (b[1].inbound + b[1].outbound) - (a[1].inbound + a[1].outbound))
    .map(([namespace, val]) => ({ namespace, ...val }));

  return {
    clusterId,
    generatedAt: new Date().toISOString(),
    timeWindowMinutes,
    totalFlows: flows.length,
    forwardedFlows: forwarded,
    droppedFlows: dropped,
    topDropped,
    dnsErrors,
    protocolBreakdown,
    namespaceTraffic,
  };
}

// ── Security Observability Summary ──

export async function collectSecuritySummary(
  env: Env,
  bearerToken: string | undefined,
  clusterId: string,
  timeWindowMinutes = 5,
): Promise<HubbleSecuritySummary> {
  const flows = await getHubbleFlows(env, bearerToken, clusterId, {
    last: Math.min(env.HUBBLE_FLOW_LIMIT, 10_000),
  });

  const allowed = flows.filter((f) => f.verdict === "FORWARDED").length;
  const denied = flows.filter((f) => f.verdict === "DROPPED").length;
  const audit = flows.filter((f) => f.verdict === "AUDIT").length;

  // Top denied
  const denyMap = new Map<string, {
    source: string; destination: string;
    port: number; protocol: string;
    count: number; direction: HubbleFlow["trafficDirection"];
  }>();
  for (const f of flows) {
    if (f.verdict !== "DROPPED") continue;
    const src = `${f.source.namespace}/${f.source.workloadName}`;
    const dst = `${f.destination.namespace}/${f.destination.workloadName}`;
    const key = `${src}→${dst}:${f.destinationPort}`;
    if (!denyMap.has(key)) {
      denyMap.set(key, {
        source: src,
        destination: dst,
        port: f.destinationPort,
        protocol: f.l4Protocol,
        count: 0,
        direction: f.trafficDirection,
      });
    }
    denyMap.get(key)!.count++;
  }
  const topDenied = Array.from(denyMap.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);

  // Identity-based flow matrix
  const idMap = new Map<string, {
    sourceIdentity: number; sourceLabel: string;
    destIdentity: number; destLabel: string;
    allowed: number; denied: number;
  }>();
  for (const f of flows) {
    const sId = f.source.identity;
    const dId = f.destination.identity;
    const key = `${sId}→${dId}`;
    if (!idMap.has(key)) {
      const sLabel = f.source.labels["k8s:app"] ?? f.source.workloadName;
      const dLabel = f.destination.labels["k8s:app"] ?? f.destination.workloadName;
      idMap.set(key, {
        sourceIdentity: sId, sourceLabel: sLabel,
        destIdentity: dId, destLabel: dLabel,
        allowed: 0, denied: 0,
      });
    }
    const entry = idMap.get(key)!;
    if (f.verdict === "FORWARDED") entry.allowed++;
    else if (f.verdict === "DROPPED") entry.denied++;
  }
  const identityFlows = Array.from(idMap.values())
    .filter((e) => e.denied > 0 || e.allowed > 10) // 의미 있는 항목만
    .sort((a, b) => b.denied - a.denied || b.allowed - a.allowed)
    .slice(0, 30);

  return {
    clusterId,
    generatedAt: new Date().toISOString(),
    timeWindowMinutes,
    policyVerdicts: { allowed, denied, audit },
    topDenied,
    identityFlows,
  };
}

// ── K8s Service + Endpoint 조회 ──

const k8sSvcCache = new CacheManager<Map<string, HubbleK8sService[]>>(10, 60_000);

async function fetchK8sServiceMap(
  env: Env,
  bearerToken: string | undefined,
  clusterId: string,
  namespaces: string[],
): Promise<Map<string, HubbleK8sService[]>> {
  const prefix = bearerToken ? bearerKeyPrefix(bearerToken) : "sp";
  const cacheKey = `${prefix}:hubble-k8s-svc:${clusterId}`;
  const cached = k8sSvcCache.get(cacheKey);
  if (cached) return cached;

  const kubeconfigYaml = await getKubeconfig(env, bearerToken, clusterId);
  const kc = new k8s.KubeConfig();
  kc.loadFromString(kubeconfigYaml);
  const coreV1 = kc.makeApiClient(k8s.CoreV1Api);

  const result = new Map<string, HubbleK8sService[]>();

  for (const ns of namespaces) {
    try {
      const [svcList, epList] = await Promise.all([
        coreV1.listNamespacedService({ namespace: ns }),
        coreV1.listNamespacedEndpoints({ namespace: ns }),
      ]);

      // EndpointSlice → pod 엔드포인트 맵 (serviceName → pods)
      const endpointMap = new Map<string, HubbleEndpointPod[]>();
      for (const ep of epList.items) {
        const svcName = ep.metadata?.name ?? "";
        const pods: HubbleEndpointPod[] = [];
        for (const subset of ep.subsets ?? []) {
          for (const addr of [...(subset.addresses ?? []), ...(subset.notReadyAddresses ?? [])]) {
            pods.push({
              podName: addr.targetRef?.name ?? addr.ip ?? "",
              podIP: addr.ip ?? "",
              ready: (subset.addresses ?? []).includes(addr),
              nodeName: addr.nodeName ?? "",
            });
          }
        }
        endpointMap.set(svcName, pods);
      }

      const services: HubbleK8sService[] = [];
      for (const svc of svcList.items) {
        const name = svc.metadata?.name ?? "";
        const selector = svc.spec?.selector ?? {};
        // selector가 없는 Service (ExternalName 등) 제외
        if (Object.keys(selector).length === 0) continue;

        const ports = (svc.spec?.ports ?? []).map((p) => ({
          port: p.port ?? 0,
          targetPort: (p.targetPort ?? p.port ?? 0) as number | string,
          protocol: p.protocol ?? "TCP",
          name: p.name,
        }));

        services.push({
          serviceName: name,
          clusterIP: svc.spec?.clusterIP ?? "",
          type: (svc.spec?.type ?? "ClusterIP") as HubbleK8sService["type"],
          ports,
          selector,
          endpoints: endpointMap.get(name) ?? [],
        });
      }

      if (services.length > 0) {
        result.set(ns, services);
      }
    } catch (e) {
      console.warn(`[hubble] K8s service fetch failed for ns=${ns}:`, (e as Error).message);
    }
  }

  k8sSvcCache.set(cacheKey, result);
  return result;
}
