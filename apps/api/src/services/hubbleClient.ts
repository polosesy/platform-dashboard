import * as k8s from "@kubernetes/client-node";
import { Writable } from "stream";
import type { Env } from "../env";
import type { HubbleFlow, HubbleEndpoint } from "@aud/types";
import { CacheManager, bearerKeyPrefix } from "../infra/cacheManager";
import { getKubeconfig } from "./kubernetes";

// ──────────────────────────────────────────────────────────────
// Hubble Client
//
// K8s exec 기반으로 cilium-agent pod 내 hubble CLI를 호출하여
// Hubble Relay를 통해 클러스터 전체 네트워크 플로우를 조회합니다.
//
// 아키텍처:
//   API Server → K8s Exec API → cilium-agent pod → hubble observe
//     --server hubble-relay.<ns>.svc.cluster.local:<port>
// ──────────────────────────────────────────────────────────────

const flowsCache = new CacheManager<HubbleFlow[]>(10, 30_000);
const statusCache = new CacheManager<HubbleStatusInfo>(10, 30_000);
const ciliumPodCache = new CacheManager<string>(10, 60_000);

type HubbleStatusInfo = {
  available: boolean;
  version: string;
  numFlows: number;
  maxFlows: number;
  uptimeNs: number;
  nodeCount: number;
  message: string;
};

// ── Find a running cilium-agent pod ──

async function findCiliumAgentPod(
  env: Env,
  bearerToken: string | undefined,
  azureResourceId: string,
): Promise<string> {
  const prefix = bearerToken ? bearerKeyPrefix(bearerToken) : "sp";
  const cacheKey = `${prefix}:cilium-pod:${azureResourceId}`;
  const cached = ciliumPodCache.get(cacheKey);
  if (cached) return cached;

  const kubeconfigYaml = await getKubeconfig(env, bearerToken, azureResourceId);
  const kc = new k8s.KubeConfig();
  kc.loadFromString(kubeconfigYaml);
  const coreV1 = kc.makeApiClient(k8s.CoreV1Api);

  const ns = env.HUBBLE_RELAY_NAMESPACE;
  const podList = await coreV1.listNamespacedPod({
    namespace: ns,
    labelSelector: "k8s-app=cilium",
  });

  const runningPod = podList.items.find(
    (p) => p.status?.phase === "Running",
  );
  if (!runningPod?.metadata?.name) {
    throw new Error(`cilium-agent pod를 찾을 수 없습니다 (namespace: ${ns})`);
  }

  const podName = runningPod.metadata.name;
  ciliumPodCache.set(cacheKey, podName);
  return podName;
}

// ── Execute command in pod and collect output ──

async function execInPod(
  kc: k8s.KubeConfig,
  namespace: string,
  podName: string,
  container: string,
  command: string[],
  timeoutMs = 30_000,
): Promise<string> {
  const exec = new k8s.Exec(kc);

  return new Promise<string>((resolve, reject) => {
    let stdout = "";
    let stderr = "";

    const outStream = new Writable({
      write(chunk, _enc, cb) {
        stdout += chunk.toString();
        cb();
      },
    });

    const errStream = new Writable({
      write(chunk, _enc, cb) {
        stderr += chunk.toString();
        cb();
      },
    });

    const timer = setTimeout(() => {
      resolve(stdout); // timeout 시 수집된 데이터 반환
    }, timeoutMs);

    exec
      .exec(namespace, podName, container, command, outStream, errStream, null, false, (status) => {
        clearTimeout(timer);
        // status.status === "Success" or "Failure"
        if (status?.status === "Failure" && !stdout) {
          reject(new Error(`exec failed: ${status.message ?? stderr}`));
        } else {
          resolve(stdout);
        }
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

// ── Hubble observe: get flows ──

export async function getHubbleFlows(
  env: Env,
  bearerToken: string | undefined,
  azureResourceId: string,
  opts?: {
    namespace?: string;
    last?: number;
    verdict?: string;
    type?: string;
  },
): Promise<HubbleFlow[]> {
  if (!env.HUBBLE_ENABLED) return [];

  const prefix = bearerToken ? bearerKeyPrefix(bearerToken) : "sp";
  const ns = opts?.namespace ?? "";
  const verdict = opts?.verdict ?? "";
  const cacheKey = `${prefix}:hubble-flows:${azureResourceId}:${ns}:${verdict}`;
  const cached = flowsCache.get(cacheKey);
  if (cached) return cached;

  const ciliumPod = await findCiliumAgentPod(env, bearerToken, azureResourceId);
  const kubeconfigYaml = await getKubeconfig(env, bearerToken, azureResourceId);
  const kc = new k8s.KubeConfig();
  kc.loadFromString(kubeconfigYaml);

  const relayNs = env.HUBBLE_RELAY_NAMESPACE;
  const relayPort = env.HUBBLE_RELAY_PORT;
  const limit = opts?.last ?? Math.min(env.HUBBLE_FLOW_LIMIT, 10_000);

  const args = [
    "hubble", "observe",
    "--server", `hubble-relay.${relayNs}.svc.cluster.local:${relayPort}`,
    "--output", "json",
    "--last", String(limit),
    "-f=false",  // --follow=false
  ];

  if (ns) {
    args.push("--namespace", ns);
  }
  if (verdict) {
    args.push("--verdict", verdict);
  }
  if (opts?.type) {
    args.push("--type", opts.type);
  }

  console.log(`[hubble] observe: exec into ${relayNs}/${ciliumPod} → last ${limit} flows`);

  const raw = await execInPod(kc, relayNs, ciliumPod, "cilium-agent", args, 30_000);
  const flows = parseHubbleJsonOutput(raw);

  console.log(`[hubble] observe: parsed ${flows.length} flows`);
  flowsCache.set(cacheKey, flows);
  return flows;
}

// ── Hubble status ──

export async function getHubbleStatus(
  env: Env,
  bearerToken: string | undefined,
  azureResourceId: string,
): Promise<HubbleStatusInfo> {
  if (!env.HUBBLE_ENABLED) {
    return { available: false, version: "", numFlows: 0, maxFlows: 0, uptimeNs: 0, nodeCount: 0, message: "HUBBLE_ENABLED=false" };
  }

  const prefix = bearerToken ? bearerKeyPrefix(bearerToken) : "sp";
  const cacheKey = `${prefix}:hubble-status:${azureResourceId}`;
  const cached = statusCache.get(cacheKey);
  if (cached) return cached;

  try {
    const ciliumPod = await findCiliumAgentPod(env, bearerToken, azureResourceId);
    const kubeconfigYaml = await getKubeconfig(env, bearerToken, azureResourceId);
    const kc = new k8s.KubeConfig();
    kc.loadFromString(kubeconfigYaml);

    const relayNs = env.HUBBLE_RELAY_NAMESPACE;
    const relayPort = env.HUBBLE_RELAY_PORT;

    const raw = await execInPod(
      kc, relayNs, ciliumPod, "cilium-agent",
      ["hubble", "status", "--server", `hubble-relay.${relayNs}.svc.cluster.local:${relayPort}`, "--output", "json"],
      10_000,
    );

    const parsed = safeJsonParse<Record<string, unknown>>(raw);
    const result: HubbleStatusInfo = {
      available: true,
      version: String(parsed?.version ?? ""),
      numFlows: Number(parsed?.num_flows ?? parsed?.numFlows ?? 0),
      maxFlows: Number(parsed?.max_flows ?? parsed?.maxFlows ?? 0),
      uptimeNs: Number(parsed?.uptime_ns ?? parsed?.uptimeNs ?? 0),
      nodeCount: Number(parsed?.num_connected_nodes ?? parsed?.nodeCount ?? 0),
      message: "connected",
    };
    statusCache.set(cacheKey, result);
    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("[hubble] status check failed:", msg);
    return { available: false, version: "", numFlows: 0, maxFlows: 0, uptimeNs: 0, nodeCount: 0, message: msg };
  }
}

// ── JSON 파싱 ──

function safeJsonParse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw.trim()) as T;
  } catch {
    return null;
  }
}

/**
 * hubble observe --output json 은 각 줄에 JSON 객체를 출력합니다.
 * 파싱 후 HubbleFlow 배열로 변환합니다.
 */
function parseHubbleJsonOutput(raw: string): HubbleFlow[] {
  if (!raw || !raw.trim()) return [];

  const lines = raw.split("\n").filter((l) => l.trim());
  const flows: HubbleFlow[] = [];

  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      const flow = obj.flow as Record<string, unknown> | undefined;
      if (!flow) continue;

      const source = parseEndpoint(flow.source as Record<string, unknown> | undefined);
      const destination = parseEndpoint(flow.destination as Record<string, unknown> | undefined);

      const l4 = flow.l4 as Record<string, unknown> | undefined;
      const tcp = l4?.TCP as Record<string, unknown> | undefined;
      const udp = l4?.UDP as Record<string, unknown> | undefined;
      const icmp = l4?.ICMPv4 ?? l4?.ICMPv6;

      let l4Protocol: HubbleFlow["l4Protocol"] = "UNKNOWN";
      let sourcePort = 0;
      let destinationPort = 0;
      if (tcp) {
        l4Protocol = "TCP";
        sourcePort = Number(tcp.source_port ?? 0);
        destinationPort = Number(tcp.destination_port ?? 0);
      } else if (udp) {
        l4Protocol = "UDP";
        sourcePort = Number(udp.source_port ?? 0);
        destinationPort = Number(udp.destination_port ?? 0);
      } else if (icmp) {
        l4Protocol = "ICMP";
      }

      // L7 정보
      const l7Raw = flow.l7 as Record<string, unknown> | undefined;
      let l7: HubbleFlow["l7"];
      if (l7Raw) {
        const l7Type = String(l7Raw.type ?? "UNKNOWN").toUpperCase() as HubbleFlow["l7"] extends { type: infer T } ? T : never;
        const http = l7Raw.http as Record<string, unknown> | undefined;
        const dns = l7Raw.dns as Record<string, unknown> | undefined;

        l7 = {
          type: l7Type as "HTTP" | "DNS" | "KAFKA" | "UNKNOWN",
          ...(http ? {
            http: {
              code: Number(http.code ?? 0),
              method: String(http.method ?? ""),
              url: String(http.url ?? ""),
              protocol: String(http.protocol ?? ""),
              latencyNs: Number(http.latency_ns ?? 0),
            },
          } : {}),
          ...(dns ? {
            dns: {
              query: String(dns.query ?? ""),
              rcode: Number(dns.rcode ?? 0),
              responseIps: Array.isArray(dns.ips) ? dns.ips.map(String) : [],
            },
          } : {}),
        };
      }

      flows.push({
        time: String(flow.time ?? obj.time ?? new Date().toISOString()),
        source,
        destination,
        verdict: normalizeVerdict(String(flow.verdict ?? "FORWARDED")),
        type: normalizeFlowType(String(flow.Type ?? flow.type ?? "UNKNOWN")),
        l4Protocol,
        sourcePort,
        destinationPort,
        l7,
        trafficDirection: normalizeDirection(String(flow.traffic_direction ?? "UNKNOWN")),
        dropReasonDesc: String(flow.drop_reason_desc ?? ""),
        isReply: Boolean(flow.is_reply ?? flow.IsReply),
        nodeName: String(flow.node_name ?? ""),
        summary: String(flow.Summary ?? flow.summary ?? ""),
      });
    } catch {
      // 파싱 실패 줄은 스킵
    }
  }

  return flows;
}

function parseEndpoint(raw: Record<string, unknown> | undefined): HubbleEndpoint {
  if (!raw) return { namespace: "", podName: "", labels: {}, identity: 0, workloadName: "" };

  const labels = (raw.labels ?? []) as string[];
  const labelMap: Record<string, string> = {};
  for (const l of labels) {
    const [k, ...vParts] = l.split("=");
    if (k) labelMap[k] = vParts.join("=");
  }

  const namespace = String(raw.namespace ?? "");
  const podName = String(raw.pod_name ?? "");

  // workload 이름 추출: k8s:app 라벨 > pod name에서 suffix 제거
  let workloadName = labelMap["k8s:app.kubernetes.io/name"]
    ?? labelMap["k8s:app"]
    ?? labelMap["app.kubernetes.io/name"]
    ?? labelMap["app"]
    ?? "";

  if (!workloadName && podName) {
    // pod-name-xxxx-yyyy → pod-name 패턴
    workloadName = podName.replace(/-[a-z0-9]{5,10}-[a-z0-9]{5}$/, "")
      .replace(/-[a-z0-9]{8,10}$/, "");
  }

  return {
    namespace,
    podName,
    labels: labelMap,
    identity: Number(raw.identity ?? 0),
    workloadName: workloadName || podName || namespace || "unknown",
  };
}

function normalizeVerdict(v: string): HubbleFlow["verdict"] {
  const upper = v.toUpperCase();
  if (upper === "FORWARDED") return "FORWARDED";
  if (upper === "DROPPED") return "DROPPED";
  if (upper === "AUDIT") return "AUDIT";
  if (upper === "ERROR") return "ERROR";
  if (upper === "REDIRECTED") return "REDIRECTED";
  return "FORWARDED";
}

function normalizeFlowType(t: string): HubbleFlow["type"] {
  if (t === "1" || t.includes("L3_L4") || t === "L3_L4") return "L3_L4";
  if (t === "2" || t.includes("L7") || t === "L7") return "L7";
  return "UNKNOWN";
}

function normalizeDirection(d: string): HubbleFlow["trafficDirection"] {
  const upper = d.toUpperCase();
  if (upper === "INGRESS" || upper === "1") return "INGRESS";
  if (upper === "EGRESS" || upper === "2") return "EGRESS";
  return "UNKNOWN";
}
