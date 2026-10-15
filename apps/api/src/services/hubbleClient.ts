import * as k8s from "@kubernetes/client-node";
import { Writable } from "stream";
import type { Env } from "../env.js";
import type { HubbleFlow, HubbleEndpoint, HubbleFlowSet } from "@aud/types";
import { CacheManager, cachePrefix } from "../infra/cacheManager.js";
import { HttpError } from "../infra/requestParams.js";
import { debug } from "../infra/logger.js";
import type { Lang } from "../infra/lang.js";

// Async code: pick the text directly (L() is only valid inside withLang)
const pick = (lang: Lang, ko: string, en: string) => (lang === "en" ? en : ko);
import { loadKubeConfig } from "./kubernetes.js";
import { assertHubbleExecAllowed } from "./aksAccess.js";
import { dedupeObservations, emptyCoverage, mergeAgentBatches, singleSourceCoverage, type AgentBatch } from "./hubbleMerge.js";

// ──────────────────────────────────────────────────────────────
// Hubble Client
//
// Cilium Hubble에서 네트워크 플로우를 수집하는 클라이언트.
// 각 cilium-agent는 자기 노드의 플로우만 보관하므로(링 버퍼),
// 모든 agent에서 읽어 병합해야 클러스터 전체가 보입니다.
//
// Strategy 1: 모든 cilium-agent pod에서 `hubble observe` (로컬 소켓) → 병합
// Strategy 2: cilium-agent pod에서 --server 플래그로 relay 연결
//             (AKS ACNS relay는 mTLS라 hubble CLI로는 실패 — 비 AKS용 폴백)
// Strategy 3: K8s API proxy를 통한 hubble-relay HTTP 접근
//
// 세 방법 모두 노드 수준 접근(권한 있는 파드에 exec, services/proxy)이라 `assertHubbleExecAllowed`
// (HUBBLE_EXEC_ENABLED + 홈 연결 또는 aks.hubbleExec) 뒤에서만 실행한다 — docs/integrations/azure/aks.md
// ──────────────────────────────────────────────────────────────

const flowsCache = new CacheManager<HubbleFlowSet>(10, 30_000);
const statusCache = new CacheManager<HubbleStatusInfo>(10, 30_000);
const agentDiscoveryCache = new CacheManager<AgentDiscovery>(10, 120_000);
const bufferStatusCache = new CacheManager<BufferStatus>(100, 60_000);

type HubbleStatusInfo = {
  available: boolean;
  version: string;
  numFlows: number;
  maxFlows: number;
  uptimeNs: number;
  nodeCount: number;
  nodesTotal: number;
  message: string;
};

type AgentPod = {
  podName: string;
  namespace: string;
  container: string;
  nodeName: string;
};

type AgentDiscovery = {
  /** Running agents — one per node */
  agents: AgentPod[];
  /** All agent pods found, including ones not Running */
  total: number;
};

type BufferStatus = {
  version: string;
  numFlows: number;
  maxFlows: number;
  uptimeNs: number;
};

const AGENT_LABEL_SELECTORS = [
  "k8s-app=cilium",
  "app.kubernetes.io/name=cilium-agent",
];
const AGENT_CONTAINER_NAMES = ["cilium-agent", "cilium"];

/** Concurrent `kubectl exec` sessions per request — large clusters have hundreds of nodes. */
const AGENT_EXEC_CONCURRENCY = 8;

/** Ring buffer size Cilium uses when `hubble status` is unavailable (hubble-event-buffer-capacity default). */
const DEFAULT_BUFFER_CAPACITY = 4095;

// ── Agent discovery — every cilium-agent pod (one per node) ──

async function discoverAgents(
  env: Env,
  kc: k8s.KubeConfig,
  bearerToken: string | undefined,
  azureResourceId: string,
  lang: Lang = "ko",
): Promise<AgentDiscovery> {
  const cacheKey = `${cachePrefix(bearerToken)}:hubble-agents:${azureResourceId}`;
  const cached = agentDiscoveryCache.get(cacheKey);
  if (cached) return cached;

  const coreV1 = kc.makeApiClient(k8s.CoreV1Api);
  const namespaces = [...new Set(["kube-system", env.HUBBLE_RELAY_NAMESPACE, "cilium", "cilium-system"])];

  for (const namespace of namespaces) {
    for (const labelSelector of AGENT_LABEL_SELECTORS) {
      try {
        const items = (await coreV1.listNamespacedPod({ namespace, labelSelector })).items;
        if (items.length === 0) continue;
        const agents = items
          .filter((p) => p.status?.phase === "Running" && p.metadata?.name)
          .map((p) => {
            const containers = p.spec?.containers?.map((c) => c.name) ?? [];
            return {
              podName: p.metadata!.name!,
              namespace,
              container: AGENT_CONTAINER_NAMES.find((c) => containers.includes(c)) ?? containers[0] ?? "cilium-agent",
              nodeName: p.spec?.nodeName ?? "",
            };
          })
          .sort((a, b) => a.nodeName.localeCompare(b.nodeName));
        const result = { agents, total: items.length };
        debug(`[hubble] discovered ${agents.length}/${items.length} running cilium agents in ${namespace} (${labelSelector})`);
        agentDiscoveryCache.set(cacheKey, result);
        return result;
      } catch {
        // 이 namespace/selector 조합은 실패 — 다음 시도
      }
    }
  }

  throw new Error(
    pick(lang,
      `cilium-agent pod를 찾을 수 없습니다. 검색 namespace: [${namespaces.join(", ")}], labels: [${AGENT_LABEL_SELECTORS.join(", ")}]. Cilium이 설치되어 있고 Hubble이 활성화되어 있는지 확인하세요.`,
      `No cilium-agent pod found. Namespaces searched: [${namespaces.join(", ")}], labels: [${AGENT_LABEL_SELECTORS.join(", ")}]. Check that Cilium is installed and Hubble is enabled.`,
    ),
  );
}

/** Run `fn` over `items` with at most `limit` in flight, preserving order. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
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
        debug(`[hubble] discovered relay service: ${fqdn}`);
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

/** Hard cap on captured stdout (10k JSON flows is roughly 15 MB). */
const MAX_EXEC_OUTPUT_BYTES = 32 * 1024 * 1024;

// Values passed as `hubble observe` arguments — must not look like flags.
const K8S_NAME_RE = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;
const VERDICTS = new Set(["FORWARDED", "DROPPED", "AUDIT", "ERROR", "REDIRECTED", "TRACED", "TRANSLATED"]);
const FLOW_TYPES = new Set(["l7", "trace", "drop", "capture", "policy-verdict", "debug", "sock", "trace-sock"]);

function validateObserveFilters(opts: { namespace?: string; verdict?: string; type?: string } | undefined) {
  if (opts?.namespace && !K8S_NAME_RE.test(opts.namespace)) {
    throw new HttpError(400, "invalid_namespace", "namespace must be a valid Kubernetes name");
  }
  if (opts?.verdict && !VERDICTS.has(opts.verdict.toUpperCase())) {
    throw new HttpError(400, "invalid_verdict", `verdict must be one of ${[...VERDICTS].join(", ")}`);
  }
  if (opts?.type && !FLOW_TYPES.has(opts.type.toLowerCase())) {
    throw new HttpError(400, "invalid_type", `type must be one of ${[...FLOW_TYPES].join(", ")}`);
  }
}

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
    let settled = false;
    let socket: { close: () => void } | undefined;

    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Close the exec websocket so the remote process does not keep streaming
      try { socket?.close(); } catch { /* already closed */ }
      resolve({ stdout, stderr, exitCode });
    };

    const outStream = new Writable({
      write(chunk, _enc, cb) {
        if (stdout.length < MAX_EXEC_OUTPUT_BYTES) stdout += chunk.toString();
        cb();
      },
    });

    const errStream = new Writable({
      write(chunk, _enc, cb) {
        if (stderr.length < 64 * 1024) stderr += chunk.toString();
        cb();
      },
    });

    // On timeout keep partial output (hubble may still be streaming) — 124 like coreutils `timeout`
    const timer = setTimeout(() => finish(stdout ? 0 : 124), timeoutMs);

    exec
      .exec(namespace, podName, container, command, outStream, errStream, null, false, (status) => {
        finish(status?.status === "Success" ? 0 : 1);
      })
      .then((ws) => {
        socket = ws;
        if (settled) ws.close();
      })
      .catch((err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
  });
}

// ── Hubble observe: get flows ──

type ObserveFilters = { ns: string; verdict: string; type?: string };

function observeArgs(outputFmt: "jsonpb" | "json", limit: number, f: ObserveFilters, server?: string): string[] {
  const args = ["hubble", "observe", "--output", outputFmt, "--last", String(limit)];
  if (server) args.push("--server", server);
  if (f.ns) args.push("--namespace", f.ns);
  if (f.verdict) args.push("--verdict", f.verdict);
  if (f.type) args.push("--type", f.type);
  return args;
}

/**
 * Flows from every node, merged newest first and de-duplicated, with a
 * description of which nodes and time span they cover.
 */
export async function getHubbleFlows(
  env: Env,
  bearerToken: string | undefined,
  azureResourceId: string,
  opts?: {
    namespace?: string;
    last?: number;
    verdict?: string;
    type?: string;
    /** Language of error messages */
    lang?: Lang;
  },
): Promise<HubbleFlowSet> {
  if (!env.HUBBLE_ENABLED) return { flows: [], coverage: emptyCoverage() };
  validateObserveFilters(opts);

  const prefix = cachePrefix(bearerToken);
  const filters: ObserveFilters = {
    ns: opts?.namespace ?? "",
    verdict: opts?.verdict?.toUpperCase() ?? "",
    type: opts?.type?.toLowerCase(),
  };
  const limit = opts?.last ?? Math.min(env.HUBBLE_FLOW_LIMIT, 10_000);
  assertHubbleExecAllowed(env, azureResourceId);
  // Every filter that changes the hubble query must be part of the key
  const cacheKey = `${prefix}:hubble-flows:${azureResourceId}:${filters.ns}:${filters.verdict}:${filters.type ?? ""}:${limit}`;
  const cached = flowsCache.get(cacheKey);
  if (cached) return cached;

  const kc = await loadKubeConfig(env, bearerToken, azureResourceId);
  const discovery = await discoverAgents(env, kc, bearerToken, azureResourceId, opts?.lang);
  const result = await tryGetFlows(kc, env, discovery, azureResourceId, prefix, limit, filters);

  if (result.set) {
    flowsCache.set(cacheKey, result.set, env.HUBBLE_CACHE_TTL_MS);
    return result.set;
  }
  console.warn(`[hubble] flows collection warning: ${result.error}`);
  return { flows: [], coverage: emptyCoverage(discovery.total) };
}

async function tryGetFlows(
  kc: k8s.KubeConfig,
  env: Env,
  discovery: AgentDiscovery,
  azureResourceId: string,
  prefix: string,
  limit: number,
  filters: ObserveFilters,
): Promise<{ set?: HubbleFlowSet; error?: string }> {
  const errors: string[] = [];
  const { agents } = discovery;

  // ── Strategy 1: 모든 cilium agent에서 `hubble observe` (로컬 소켓) → 병합 ──
  // Cilium 1.17+: hubble 바이너리가 별도 존재, 로컬 소켓(/var/run/cilium/hubble.sock)으로 접근
  if (agents.length > 0) {
    debug(`[hubble] Strategy 1: hubble observe on ${agents.length} agents`);
    const batches = await mapWithConcurrency(agents, AGENT_EXEC_CONCURRENCY, (a) => readAgentFlows(kc, a, limit, filters));
    const answered = batches.filter((b) => !b.error);
    // Success once any node answered — an empty but successful read is a real "no traffic"
    if (answered.length > 0) {
      const set = mergeAgentBatches(batches, discovery.total, limit);
      debug(
        `[hubble] Strategy 1: ${answered.length}/${discovery.total} nodes, ` +
        `${set.coverage.rawEvents} events → ${set.flows.length} after de-dup, ` +
        `common window ${set.coverage.commonWindowMinutes}min`,
      );
      return { set };
    }
    errors.push(...batches.map((b) => `hubble-local@${b.nodeName}: ${b.error}`));
  }

  // ── Strategy 2: cilium pod에서 `hubble observe --server relay` ──
  const agent = agents[0];
  if (agent) {
    const relayFqdn = await discoverRelayService(kc, env.HUBBLE_RELAY_NAMESPACE, `${prefix}:relay-svc:${azureResourceId}`)
      ?? `hubble-relay.${env.HUBBLE_RELAY_NAMESPACE}.svc.cluster.local:${env.HUBBLE_RELAY_PORT}`;
    debug(`[hubble] Strategy 2 (hubble observe --server): ${agent.namespace}/${agent.podName} → ${relayFqdn}`);
    try {
      const result = await execInPod(
        kc, agent.namespace, agent.podName, agent.container,
        observeArgs("json", limit, filters, relayFqdn), 30_000,
      );
      const flows = dedupeObservations(parseHubbleJsonOutput(result.stdout));
      if (flows.length > 0) {
        debug(`[hubble] Strategy 2 success: ${flows.length} flows`);
        return { set: { flows: flows.slice(0, limit), coverage: singleSourceCoverage("relay", flows) } };
      }
      errors.push(`hubble-relay: exitCode=${result.exitCode}, stderr=${result.stderr.slice(0, 200)}`);
    } catch (e) {
      errors.push(`hubble-relay: ${(e as Error).message}`);
    }
  }

  // ── Strategy 3: K8s API proxy → hubble-relay gRPC-web / HTTP ──
  debug(`[hubble] Strategy 3 (K8s API proxy): attempting...`);
  try {
    const flows = dedupeObservations(await getFlowsViaApiProxy(kc, env.HUBBLE_RELAY_NAMESPACE, env, limit, filters.ns));
    if (flows.length > 0) {
      debug(`[hubble] Strategy 3 success: ${flows.length} flows`);
      return { set: { flows: flows.slice(0, limit), coverage: singleSourceCoverage("api-proxy", flows) } };
    }
  } catch (e) {
    errors.push(`api-proxy: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { error: `All Hubble connection strategies failed. Tried:\n${errors.join("\n")}` };
}

/** `hubble observe` on one agent's local socket. Never throws — failures are reported in the batch. */
async function readAgentFlows(
  kc: k8s.KubeConfig,
  agent: AgentPod,
  limit: number,
  filters: ObserveFilters,
): Promise<AgentBatch> {
  const base = { nodeName: agent.nodeName, podName: agent.podName };
  const bufferPromise = getBufferStatus(kc, agent);
  let lastError = "no output";

  for (const outputFmt of ["jsonpb", "json"] as const) {
    try {
      const result = await execInPod(
        kc, agent.namespace, agent.podName, agent.container,
        observeArgs(outputFmt, limit, filters), 30_000,
      );
      const flows = parseHubbleJsonOutput(result.stdout);
      if (flows.length > 0 || (result.exitCode === 0 && !result.stderr.trim())) {
        const buffer = await bufferPromise;
        // Older history is gone when we hit our own --last or the ring buffer has wrapped
        const wrapped = buffer
          ? buffer.maxFlows > 0 && buffer.numFlows >= buffer.maxFlows
          : flows.length >= DEFAULT_BUFFER_CAPACITY;
        return { ...base, flows, truncated: flows.length >= limit || wrapped };
      }
      lastError = `exitCode=${result.exitCode}, stderr=${result.stderr.slice(0, 200)}`;
      debug(`[hubble] observe (${outputFmt}) failed on ${agent.podName}: ${lastError}`);
      // "not found" = hubble 바이너리 없음 → 다음 output format 시도 불필요
      if (/not found|no such file/i.test(result.stderr)) break;
    } catch (e) {
      lastError = (e as Error).message;
    }
  }
  return { ...base, flows: [], truncated: false, error: lastError };
}

/** `hubble status` on one agent — tells whether its ring buffer has wrapped. Never throws. */
async function getBufferStatus(kc: k8s.KubeConfig, agent: AgentPod): Promise<BufferStatus | null> {
  const cacheKey = `${agent.namespace}/${agent.podName}`;
  const cached = bufferStatusCache.get(cacheKey);
  if (cached) return cached;

  try {
    const result = await execInPod(
      kc, agent.namespace, agent.podName, agent.container,
      ["hubble", "status", "--output", "json"], 10_000,
    );
    const parsed = safeJsonParse<Record<string, unknown>>(result.stdout);
    if (parsed) {
      const status = parseBufferStatus(parsed);
      bufferStatusCache.set(cacheKey, status);
      return status;
    }
  } catch { /* fall through */ }

  try {
    // "Hubble: Ok   Current/Max Flows: 4095/4095 (100.00%), Flows/s: 43.63"
    const result = await execInPod(
      kc, agent.namespace, agent.podName, agent.container,
      ["cilium-dbg", "status", "--brief"], 10_000,
    );
    const match = result.stdout.match(/Hubble:\s*Ok\s+Current\/Max Flows:\s*(\d+)\/(\d+)/);
    if (match) {
      const status = { version: "cilium-dbg", numFlows: Number(match[1]), maxFlows: Number(match[2]), uptimeNs: 0 };
      bufferStatusCache.set(cacheKey, status);
      return status;
    }
  } catch { /* unknown */ }
  return null;
}

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

/** Ring-buffer status summed over every node's agent. */
export async function getHubbleStatus(
  env: Env,
  bearerToken: string | undefined,
  azureResourceId: string,
  lang: Lang = "ko",
): Promise<HubbleStatusInfo> {
  const off = { version: "", numFlows: 0, maxFlows: 0, uptimeNs: 0, nodeCount: 0, nodesTotal: 0 };
  if (!env.HUBBLE_ENABLED) return { available: false, ...off, message: "HUBBLE_ENABLED=false" };
  assertHubbleExecAllowed(env, azureResourceId);

  const prefix = cachePrefix(bearerToken);
  const cacheKey = `${prefix}:hubble-status:${azureResourceId}:${lang}`;
  const cached = statusCache.get(cacheKey);
  if (cached) return cached;

  try {
    const kc = await loadKubeConfig(env, bearerToken, azureResourceId);
    const { agents, total } = await discoverAgents(env, kc, bearerToken, azureResourceId, lang);
    const statuses = (await mapWithConcurrency(agents, AGENT_EXEC_CONCURRENCY, (a) => getBufferStatus(kc, a)))
      .filter((s): s is BufferStatus => s !== null);

    if (statuses.length === 0) {
      return {
        available: false,
        ...off,
        nodesTotal: total,
        message: pick(lang, `cilium agent ${agents.length}개 발견, hubble status 조회 실패 (hubble 바이너리/소켓 확인 필요)`, `${agents.length} cilium agents found, but hubble status failed (check the hubble binary / socket)`),
      };
    }

    const info: HubbleStatusInfo = {
      available: true,
      version: statuses.find((s) => s.version && s.version !== "cilium-dbg")?.version ?? statuses[0]!.version,
      numFlows: statuses.reduce((sum, s) => sum + s.numFlows, 0),
      maxFlows: statuses.reduce((sum, s) => sum + s.maxFlows, 0),
      uptimeNs: Math.min(...statuses.map((s) => s.uptimeNs)),
      nodeCount: statuses.length,
      nodesTotal: total,
      message: statuses.length < total ? pick(lang, `${total - statuses.length}개 노드 응답 없음`, `${total - statuses.length} nodes did not respond`) : "connected",
    };
    statusCache.set(cacheKey, info, env.HUBBLE_CACHE_TTL_MS);
    return info;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("[hubble] status check failed:", msg);
    return { available: false, ...off, message: msg };
  }
}

function parseBufferStatus(parsed: Record<string, unknown>): BufferStatus {
  return {
    version: String(parsed.version ?? ""),
    numFlows: Number(parsed.num_flows ?? parsed.numFlows ?? parsed.current_flows ?? 0),
    maxFlows: Number(parsed.max_flows ?? parsed.maxFlows ?? 0),
    uptimeNs: Number(parsed.uptime_ns ?? parsed.uptimeNs ?? 0),
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
export function parseHubbleJsonOutput(raw: string): HubbleFlow[] {
  if (!raw || !raw.trim()) return [];

  const lines = raw.split("\n").filter((l) => l.trim());
  const flows: HubbleFlow[] = [];

  debug(`[hubble] parseHubbleJsonOutput: ${lines.length} lines`);

  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;

      // wrapped format: {"flow":{...}} 또는 flat format: {"source":{...},"destination":{...},...}
      const flow = (obj.flow as Record<string, unknown> | undefined)
        ?? (obj.source && obj.destination ? obj : undefined) as Record<string, unknown> | undefined;
      if (!flow) continue;

      const source = parseEndpoint(flow.source as Record<string, unknown> | undefined);
      const destination = parseEndpoint(flow.destination as Record<string, unknown> | undefined);

      const ip = flow.IP as Record<string, unknown> | undefined;
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
        sourceIp: ip?.source ? String(ip.source) : undefined,
        destinationIp: ip?.destination ? String(ip.destination) : undefined,
        tcpFlags: tcp?.flags ? Object.keys(tcp.flags as Record<string, unknown>).sort().join(",") : undefined,
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

  // Post-SNAT copies drop namespace/pod_name but keep the identity's labels
  const namespace = String(raw.namespace || labelMap["k8s:io.kubernetes.pod.namespace"] || "");
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
