import * as k8s from "@kubernetes/client-node";
import { Writable } from "stream";
import type { Env } from "../env";
import type { HubbleFlow, HubbleEndpoint } from "@aud/types";
import { CacheManager, bearerKeyPrefix } from "../infra/cacheManager";
import { getKubeconfig } from "./kubernetes";

// ──────────────────────────────────────────────────────────────
// Hubble Client
//
// Cilium Hubble에서 네트워크 플로우를 수집하는 클라이언트.
// 여러 전략을 순차적으로 시도하여 안정적으로 동작합니다:
//
// Strategy 1: hubble-relay pod에서 직접 exec (로컬 연결)
// Strategy 2: cilium-agent pod에서 --server 플래그로 relay 연결
// Strategy 3: K8s API proxy를 통한 hubble-relay HTTP 접근
// ──────────────────────────────────────────────────────────────

const flowsCache = new CacheManager<HubbleFlow[]>(10, 30_000);
const statusCache = new CacheManager<HubbleStatusInfo>(10, 30_000);
const podDiscoveryCache = new CacheManager<DiscoveredPod>(10, 120_000);

type HubbleStatusInfo = {
  available: boolean;
  version: string;
  numFlows: number;
  maxFlows: number;
  uptimeNs: number;
  nodeCount: number;
  message: string;
};

type DiscoveredPod = {
  podName: string;
  namespace: string;
  container: string;
  strategy: "relay" | "agent";
};

// ── Pod Discovery — 여러 전략으로 Hubble 접근 가능한 pod 탐색 ──

const RELAY_LABEL_SELECTORS = [
  "k8s-app=hubble-relay",
  "app.kubernetes.io/name=hubble-relay",
  "app=hubble-relay",
];

const AGENT_LABEL_SELECTORS = [
  "k8s-app=cilium",
  "app.kubernetes.io/name=cilium-agent",
];

const RELAY_CONTAINER_NAMES = ["hubble-relay", "relay"];
const AGENT_CONTAINER_NAMES = ["cilium-agent", "cilium"];

async function discoverHubblePod(
  env: Env,
  bearerToken: string | undefined,
  azureResourceId: string,
): Promise<DiscoveredPod> {
  const prefix = bearerToken ? bearerKeyPrefix(bearerToken) : "sp";
  const cacheKey = `${prefix}:hubble-discovery:${azureResourceId}`;
  const cached = podDiscoveryCache.get(cacheKey);
  if (cached) return cached;

  const kubeconfigYaml = await getKubeconfig(env, bearerToken, azureResourceId);
  const kc = new k8s.KubeConfig();
  kc.loadFromString(kubeconfigYaml);
  const coreV1 = kc.makeApiClient(k8s.CoreV1Api);

  const relayNs = env.HUBBLE_RELAY_NAMESPACE;
  const searchNamespaces = [relayNs, "cilium", "cilium-system"];
  const uniqueNs = [...new Set(searchNamespaces)];

  // Strategy 1: hubble-relay pod 탐색
  for (const ns of uniqueNs) {
    for (const labelSelector of RELAY_LABEL_SELECTORS) {
      try {
        const podList = await coreV1.listNamespacedPod({ namespace: ns, labelSelector });
        const runningPod = podList.items.find((p) => p.status?.phase === "Running");
        if (runningPod?.metadata?.name) {
          const containers = runningPod.spec?.containers?.map((c) => c.name) ?? [];
          const container = RELAY_CONTAINER_NAMES.find((c) => containers.includes(c))
            ?? containers[0] ?? "hubble-relay";
          const result: DiscoveredPod = {
            podName: runningPod.metadata.name,
            namespace: ns,
            container,
            strategy: "relay",
          };
          console.log(`[hubble] discovered relay pod: ${ns}/${result.podName} (container: ${container})`);
          podDiscoveryCache.set(cacheKey, result);
          return result;
        }
      } catch {
        // 이 namespace/selector 조합은 실패 — 다음 시도
      }
    }
  }

  // Strategy 2: cilium-agent pod 탐색
  for (const ns of uniqueNs) {
    for (const labelSelector of AGENT_LABEL_SELECTORS) {
      try {
        const podList = await coreV1.listNamespacedPod({ namespace: ns, labelSelector });
        const runningPod = podList.items.find((p) => p.status?.phase === "Running");
        if (runningPod?.metadata?.name) {
          const containers = runningPod.spec?.containers?.map((c) => c.name) ?? [];
          const container = AGENT_CONTAINER_NAMES.find((c) => containers.includes(c))
            ?? containers[0] ?? "cilium-agent";
          const result: DiscoveredPod = {
            podName: runningPod.metadata.name,
            namespace: ns,
            container,
            strategy: "agent",
          };
          console.log(`[hubble] discovered agent pod: ${ns}/${result.podName} (container: ${container})`);
          podDiscoveryCache.set(cacheKey, result);
          return result;
        }
      } catch {
        // continue
      }
    }
  }

  throw new Error(
    `Hubble pod를 찾을 수 없습니다. ` +
    `검색 namespace: [${uniqueNs.join(", ")}], ` +
    `relay labels: [${RELAY_LABEL_SELECTORS.join(", ")}], ` +
    `agent labels: [${AGENT_LABEL_SELECTORS.join(", ")}]. ` +
    `Cilium이 설치되어 있고 Hubble이 활성화되어 있는지 확인하세요.`,
  );
}

// ── Hubble Relay 서비스명 자동 탐색 ──

const relayServiceCache = new CacheManager<string>(10, 300_000);

async function discoverRelayService(
  kc: k8s.KubeConfig,
  namespace: string,
  cacheKey: string,
): Promise<string | null> {
  const cached = relayServiceCache.get(cacheKey);
  if (cached) return cached;

  const coreV1 = kc.makeApiClient(k8s.CoreV1Api);
  const serviceNames = ["hubble-relay", "hubble-relay-svc", "cilium-hubble-relay"];

  try {
    const svcList = await coreV1.listNamespacedService({ namespace });
    for (const svc of svcList.items) {
      const name = svc.metadata?.name ?? "";
      if (serviceNames.includes(name) || name.includes("hubble-relay")) {
        const port = svc.spec?.ports?.[0]?.port ?? 80;
        const fqdn = `${name}.${namespace}.svc.cluster.local:${port}`;
        console.log(`[hubble] discovered relay service: ${fqdn}`);
        relayServiceCache.set(cacheKey, fqdn);
        return fqdn;
      }
    }
  } catch {
    // service list 실패
  }

  return null;
}

// ── Execute command in pod and collect output ──

async function execInPod(
  kc: k8s.KubeConfig,
  namespace: string,
  podName: string,
  container: string,
  command: string[],
  timeoutMs = 30_000,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const exec = new k8s.Exec(kc);

  return new Promise((resolve, reject) => {
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
      resolve({ stdout, stderr, exitCode: stdout ? 0 : 124 }); // timeout
    }, timeoutMs);

    exec
      .exec(namespace, podName, container, command, outStream, errStream, null, false, (status) => {
        clearTimeout(timer);
        const exitCode = status?.status === "Success" ? 0 : 1;
        resolve({ stdout, stderr, exitCode });
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

  const discovered = await discoverHubblePod(env, bearerToken, azureResourceId);
  const kubeconfigYaml = await getKubeconfig(env, bearerToken, azureResourceId);
  const kc = new k8s.KubeConfig();
  kc.loadFromString(kubeconfigYaml);

  const limit = opts?.last ?? Math.min(env.HUBBLE_FLOW_LIMIT, 10_000);

  // 플로우 수집 시도 (여러 전략)
  const result = await tryGetFlows(kc, env, discovered, azureResourceId, prefix, limit, ns, verdict, opts?.type);

  if (result.flows.length > 0) {
    flowsCache.set(cacheKey, result.flows);
  } else if (result.error) {
    console.warn(`[hubble] flows collection warning: ${result.error}`);
  }

  return result.flows;
}

async function tryGetFlows(
  kc: k8s.KubeConfig,
  env: Env,
  discovered: DiscoveredPod,
  azureResourceId: string,
  prefix: string,
  limit: number,
  ns: string,
  verdict: string,
  type?: string,
): Promise<{ flows: HubbleFlow[]; error?: string }> {
  const errors: string[] = [];

  // cilium pod 찾기 (relay와 별도)
  const ciliumPod = await findCiliumPod(kc, discovered);

  // ── Strategy 1: cilium pod에서 `hubble observe` (로컬 소켓) ──
  // Cilium 1.17+: hubble 바이너리가 별도 존재, 로컬 소켓(/var/run/cilium/hubble.sock)으로 접근
  if (ciliumPod) {
    for (const outputFmt of ["jsonpb", "json"] as const) {
      const args = ["hubble", "observe", "--output", outputFmt, "--last", String(limit)];
      if (ns) args.push("--namespace", ns);
      if (verdict) args.push("--verdict", verdict);
      if (type) args.push("--type", type);

      console.log(`[hubble] Strategy 1 (hubble observe --output ${outputFmt}): ${ciliumPod.namespace}/${ciliumPod.podName}`);
      try {
        const result = await execInPod(
          kc, ciliumPod.namespace, ciliumPod.podName, ciliumPod.container,
          args, 30_000,
        );

        if (result.stdout.trim()) {
          const flows = parseHubbleJsonOutput(result.stdout);
          if (flows.length > 0) {
            console.log(`[hubble] Strategy 1 success (${outputFmt}): parsed ${flows.length} flows`);
            return { flows };
          }
        }
        const errMsg = result.stderr.slice(0, 200);
        console.log(`[hubble] Strategy 1 (${outputFmt}) failed: exitCode=${result.exitCode}, stderr=${errMsg}`);
        errors.push(`hubble-local-${outputFmt}: exitCode=${result.exitCode}, stderr=${errMsg}`);

        // "not found" = hubble 바이너리 없음 → 다음 output format 시도 불필요
        if (errMsg.includes("not found") || errMsg.includes("no such file")) break;
      } catch (e) {
        errors.push(`hubble-local-${outputFmt}: ${(e as Error).message}`);
      }
    }
  }

  // ── Strategy 2: cilium pod에서 `hubble observe --server relay` ──
  if (ciliumPod) {
    const relaySvcKey = `${prefix}:relay-svc:${azureResourceId}`;
    const relayFqdn = await discoverRelayService(kc, discovered.namespace, relaySvcKey)
      ?? `hubble-relay.${env.HUBBLE_RELAY_NAMESPACE}.svc.cluster.local:${env.HUBBLE_RELAY_PORT}`;

    const args = ["hubble", "observe", "--output", "json",
      "--last", String(limit), "--server", relayFqdn];
    if (ns) args.push("--namespace", ns);
    if (verdict) args.push("--verdict", verdict);
    if (type) args.push("--type", type);

    console.log(`[hubble] Strategy 2 (hubble observe --server): ${ciliumPod.namespace}/${ciliumPod.podName} → ${relayFqdn}`);
    try {
      const result = await execInPod(
        kc, ciliumPod.namespace, ciliumPod.podName, ciliumPod.container,
        args, 30_000,
      );

      if (result.stdout.trim()) {
        const flows = parseHubbleJsonOutput(result.stdout);
        if (flows.length > 0) {
          console.log(`[hubble] Strategy 2 success: parsed ${flows.length} flows`);
          return { flows };
        }
      }
      console.log(`[hubble] Strategy 2 failed: exitCode=${result.exitCode}, stderr=${result.stderr.slice(0, 200)}`);
      errors.push(`hubble-relay: exitCode=${result.exitCode}, stderr=${result.stderr.slice(0, 200)}`);
    } catch (e) {
      errors.push(`hubble-relay: ${(e as Error).message}`);
    }
  }

  // ── Strategy 3: cilium-dbg hubble-local ──
  // AKS Cilium 1.17: `cilium-dbg` 로 래핑, hubble-related 명령 확인
  if (ciliumPod) {
    const args = ["cilium-dbg", "bpf", "recorder", "list"];  // probe if cilium-dbg works
    console.log(`[hubble] Strategy 3 (cilium-dbg probe): ${ciliumPod.namespace}/${ciliumPod.podName}`);
    try {
      const probe = await execInPod(
        kc, ciliumPod.namespace, ciliumPod.podName, ciliumPod.container,
        ["cilium-dbg", "status", "--brief"], 10_000,
      );
      console.log(`[hubble] cilium-dbg probe: exitCode=${probe.exitCode}, stdout=${probe.stdout.slice(0, 100)}`);
    } catch {
      // just diagnostic
    }
  }

  // ── Strategy 4: K8s API proxy → hubble-relay gRPC-web / HTTP ──
  {
    console.log(`[hubble] Strategy 4 (K8s API proxy): attempting...`);
    try {
      const flows = await getFlowsViaApiProxy(kc, discovered.namespace, env, limit, ns);
      if (flows.length > 0) {
        console.log(`[hubble] Strategy 4 success: ${flows.length} flows`);
        return { flows };
      }
    } catch (e) {
      errors.push(`api-proxy: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return {
    flows: [],
    error: `모든 Hubble 연결 전략이 실패했습니다. 시도된 전략:\n${errors.join("\n")}`,
  };
}

/** cilium pod 탐색 (relay pod과 별도) */
async function findCiliumPod(
  kc: k8s.KubeConfig,
  discovered: DiscoveredPod,
): Promise<DiscoveredPod | null> {
  if (discovered.strategy === "agent") return discovered;

  const coreV1 = kc.makeApiClient(k8s.CoreV1Api);
  const searchNs = [discovered.namespace, "kube-system", "cilium", "cilium-system"];
  const uniqueNs = [...new Set(searchNs)];

  for (const nsName of uniqueNs) {
    for (const labelSelector of AGENT_LABEL_SELECTORS) {
      try {
        const podList = await coreV1.listNamespacedPod({ namespace: nsName, labelSelector });
        const running = podList.items.find((p) => p.status?.phase === "Running");
        if (running?.metadata?.name) {
          const containers = running.spec?.containers?.map((c) => c.name) ?? [];
          return {
            podName: running.metadata.name,
            namespace: nsName,
            container: AGENT_CONTAINER_NAMES.find((c) => containers.includes(c)) ?? containers[0] ?? "cilium-agent",
            strategy: "agent",
          };
        }
      } catch { /* continue */ }
    }
  }
  return null;
}

// buildObserveArgs는 더 이상 사용하지 않음 — tryGetFlows에서 직접 args 구성

// ── K8s API proxy를 통한 hubble-relay 접근 ──

async function getFlowsViaApiProxy(
  kc: k8s.KubeConfig,
  namespace: string,
  env: Env,
  limit: number,
  nsFilter: string,
): Promise<HubbleFlow[]> {
  const coreV1 = kc.makeApiClient(k8s.CoreV1Api);
  const port = env.HUBBLE_RELAY_PORT;
  const serviceNames = ["hubble-relay", "hubble-relay-svc", "cilium-hubble-relay"];

  // 서비스 존재 확인 및 proxy 시도
  for (const svcName of serviceNames) {
    try {
      // K8s service proxy: /api/v1/namespaces/{ns}/services/{svc}:{port}/proxy/v1/flows
      const proxyPath = `/api/v1/namespaces/${namespace}/services/${svcName}:${port}/proxy/v1/flows`;
      const reqOpts: { headers: Record<string, string> } = { headers: {} };
      await kc.applyToHTTPSOptions(reqOpts);

      const server = kc.getCurrentCluster()?.server;
      if (!server) continue;

      const url = new URL(proxyPath, server);
      url.searchParams.set("number", String(limit));
      if (nsFilter) url.searchParams.set("namespace", nsFilter);

      const resp = await fetch(url.toString(), {
        headers: reqOpts.headers,
        signal: AbortSignal.timeout(15_000),
      });

      if (!resp.ok) continue;
      const text = await resp.text();
      if (text.trim()) {
        return parseHubbleJsonOutput(text);
      }
    } catch {
      // 이 서비스명은 실패 — 다음
    }
  }

  return [];
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
    const discovered = await discoverHubblePod(env, bearerToken, azureResourceId);
    const kubeconfigYaml = await getKubeconfig(env, bearerToken, azureResourceId);
    const kc = new k8s.KubeConfig();
    kc.loadFromString(kubeconfigYaml);

    // cilium pod 찾기 (hubble 바이너리가 여기에 있음)
    const ciliumPod = await findCiliumPod(kc, discovered);
    const statusErrors: string[] = [];

    // Strategy 1: cilium pod에서 `hubble status` (로컬 소켓)
    if (ciliumPod) {
      const result = await execInPod(
        kc, ciliumPod.namespace, ciliumPod.podName, ciliumPod.container,
        ["hubble", "status", "--output", "json"],
        10_000,
      );
      if (result.stdout.trim()) {
        const parsed = safeJsonParse<Record<string, unknown>>(result.stdout);
        if (parsed) {
          const info = buildStatusInfo(parsed);
          statusCache.set(cacheKey, info);
          return info;
        }
      }
      statusErrors.push(result.stderr.slice(0, 200));
    }

    // Strategy 2: cilium pod에서 `hubble status --server relay`
    if (ciliumPod) {
      const relayFqdn = await discoverRelayService(kc, discovered.namespace, `${prefix}:relay-svc:${azureResourceId}`)
        ?? `hubble-relay.${env.HUBBLE_RELAY_NAMESPACE}.svc.cluster.local:${env.HUBBLE_RELAY_PORT}`;

      const result = await execInPod(
        kc, ciliumPod.namespace, ciliumPod.podName, ciliumPod.container,
        ["hubble", "status", "--server", relayFqdn, "--output", "json"],
        10_000,
      );
      if (result.stdout.trim()) {
        const parsed = safeJsonParse<Record<string, unknown>>(result.stdout);
        if (parsed) {
          const info = buildStatusInfo(parsed);
          statusCache.set(cacheKey, info);
          return info;
        }
      }
      statusErrors.push(result.stderr.slice(0, 200));
    }

    // Strategy 3: cilium-dbg status → hubble 상태 파싱
    if (ciliumPod) {
      const result = await execInPod(
        kc, ciliumPod.namespace, ciliumPod.podName, ciliumPod.container,
        ["cilium-dbg", "status", "--brief"],
        10_000,
      );
      if (result.stdout.includes("Hubble")) {
        // "Hubble: Ok   Current/Max Flows: 4095/4095 (100.00%), Flows/s: 43.63"
        const match = result.stdout.match(
          /Hubble:\s*(Ok|Disabled)\s+Current\/Max Flows:\s*(\d+)\/(\d+)/,
        );
        if (match) {
          const info: HubbleStatusInfo = {
            available: match[1] === "Ok",
            version: "cilium-dbg",
            numFlows: Number(match[2]),
            maxFlows: Number(match[3]),
            uptimeNs: 0,
            nodeCount: 0,
            message: match[1] === "Ok" ? "connected (via cilium-dbg)" : "disabled",
          };
          statusCache.set(cacheKey, info);
          return info;
        }
      }
      statusErrors.push(result.stderr.slice(0, 200));
    }

    // 모든 시도 실패 시 pod 발견 자체는 성공한 것이므로 부분 정보 반환
    const msg = statusErrors.filter(Boolean).join("; ").slice(0, 300);
    return {
      available: true,
      version: "unknown",
      numFlows: 0,
      maxFlows: 0,
      uptimeNs: 0,
      nodeCount: 0,
      message: `Hubble pod 발견됨 (${discovered.podName}), 상세 상태 조회 실패: ${msg || "unknown error"}`,
    };

  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("[hubble] status check failed:", msg);
    return { available: false, version: "", numFlows: 0, maxFlows: 0, uptimeNs: 0, nodeCount: 0, message: msg };
  }
}

function buildStatusInfo(parsed: Record<string, unknown>): HubbleStatusInfo {
  return {
    available: true,
    version: String(parsed.version ?? ""),
    numFlows: Number(parsed.num_flows ?? parsed.numFlows ?? parsed.current_flows ?? 0),
    maxFlows: Number(parsed.max_flows ?? parsed.maxFlows ?? 0),
    uptimeNs: Number(parsed.uptime_ns ?? parsed.uptimeNs ?? 0),
    nodeCount: Number(parsed.num_connected_nodes ?? parsed.nodeCount ?? parsed.nodes?.toString() ?? 0),
    message: "connected",
  };
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
 *
 * 두 가지 포맷을 처리합니다:
 * - wrapped: {"flow":{"time":"...","source":{...},...},"node_name":"...","time":"..."}
 * - flat:    {"time":"...","verdict":"FORWARDED","source":{...},...}
 *   (cilium hubble observe가 이 포맷을 사용할 수 있음)
 */
function parseHubbleJsonOutput(raw: string): HubbleFlow[] {
  if (!raw || !raw.trim()) return [];

  const lines = raw.split("\n").filter((l) => l.trim());
  const flows: HubbleFlow[] = [];

  // 디버그: 첫 줄 로깅 (파싱 이슈 진단용)
  if (lines.length > 0) {
    console.log(`[hubble] parseHubbleJsonOutput: ${lines.length} lines, first=${lines[0]!.slice(0, 200)}`);
  }

  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;

      // wrapped format: {"flow":{...}} 또는 flat format: {"source":{...},"destination":{...},...}
      const flow = (obj.flow as Record<string, unknown> | undefined)
        ?? (obj.source && obj.destination ? obj : undefined) as Record<string, unknown> | undefined;
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
        const l7Type = String(l7Raw.type ?? "UNKNOWN").toUpperCase() as "HTTP" | "DNS" | "KAFKA" | "UNKNOWN";
        const http = l7Raw.http as Record<string, unknown> | undefined;
        const dns = l7Raw.dns as Record<string, unknown> | undefined;

        l7 = {
          type: l7Type,
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
        trafficDirection: normalizeDirection(String(flow.traffic_direction ?? flow.trafficDirection ?? "UNKNOWN")),
        dropReasonDesc: String(flow.drop_reason_desc ?? flow.dropReasonDesc ?? ""),
        isReply: Boolean(flow.is_reply ?? flow.IsReply ?? flow.isReply),
        nodeName: String(flow.node_name ?? obj.node_name ?? flow.nodeName ?? ""),
        summary: String(flow.Summary ?? flow.summary ?? ""),
      });
    } catch (e) {
      // 파싱 실패 줄은 스킵 (최초 1건만 로깅)
      if (flows.length === 0) {
        console.warn(`[hubble] parse line failed:`, (e as Error).message, line.slice(0, 150));
      }
    }
  }

  return flows;
}

// Cilium reserved identity → 사람이 읽을 수 있는 이름 매핑
const RESERVED_IDENTITY_NAMES: Record<number, string> = {
  0: "init",
  1: "host",
  2: "world",
  3: "unmanaged",
  4: "health",
  5: "init",
  6: "kube-apiserver",
  7: "remote-node",
  8: "ingress",
};

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
  const identity = Number(raw.identity ?? 0);

  // workload 이름 추출 우선순위:
  // 1. k8s app 라벨
  // 2. workloads 배열 (Cilium 1.17+ flow에 포함)
  // 3. pod name에서 suffix 제거
  // 4. reserved identity 매핑
  let workloadName = labelMap["k8s:app.kubernetes.io/name"]
    ?? labelMap["k8s:app"]
    ?? labelMap["app.kubernetes.io/name"]
    ?? labelMap["app"]
    ?? "";

  // Cilium 1.17+ workloads 배열 활용: {"workloads":[{"name":"konnectivity-agent","kind":"Deployment"}]}
  if (!workloadName) {
    const workloads = raw.workloads as Array<{ name?: string; kind?: string }> | undefined;
    if (workloads?.[0]?.name) {
      workloadName = workloads[0].name;
    }
  }

  if (!workloadName && podName) {
    // pod-name-xxxx-yyyy → pod-name 패턴
    workloadName = podName.replace(/-[a-z0-9]{5,10}-[a-z0-9]{5}$/, "")
      .replace(/-[a-z0-9]{8,10}$/, "");
  }

  // reserved identity 처리 (namespace/podName 없는 경우)
  if (!workloadName && !podName && !namespace) {
    // reserved:* 라벨에서 이름 추출
    for (const key of Object.keys(labelMap)) {
      if (key.startsWith("reserved:")) {
        workloadName = key.replace("reserved:", "");
        break;
      }
    }
    // identity 숫자로 fallback
    if (!workloadName) {
      workloadName = RESERVED_IDENTITY_NAMES[identity] ?? `identity-${identity}`;
    }
  }

  return {
    namespace,
    podName,
    labels: labelMap,
    identity,
    workloadName: workloadName || podName || namespace || `identity-${identity}`,
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
