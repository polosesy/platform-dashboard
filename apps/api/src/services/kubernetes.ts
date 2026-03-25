import * as k8s from "@kubernetes/client-node";
import type { Env } from "../env";
import type {
  KubernetesClusterInfo,
  KubernetesClustersResponse,
  KubernetesObject,
  KubernetesClusterOverview,
  AksNodeCondition,
} from "@aud/types";
import { CacheManager, bearerKeyPrefix } from "../infra/cacheManager";
import { getArmFetcherAuto } from "../infra/azureClientFactory";

// ────────────────────────────────────────────
// Cache
// ────────────────────────────────────────────

const clustersCache = new CacheManager<KubernetesClustersResponse>(20, 60_000);
const overviewCache = new CacheManager<KubernetesClusterOverview>(20, 60_000);
const kubeconfigCache = new CacheManager<string>(10, 5 * 60_000);

// K8s node info: nodeName → { privateIp, nodeImageVersion, conditions }
export type K8sNodeInfo = {
  privateIp?: string;
  nodeImageVersion?: string;
  conditions: AksNodeCondition[];
};
const k8sNodeInfoCache = new CacheManager<Record<string, K8sNodeInfo>>(10, 60_000);

// ────────────────────────────────────────────
// 1. List AKS Clusters via Resource Graph
// ────────────────────────────────────────────

function parseSubscriptionIds(raw: string): string[] {
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

export async function listAksClusters(
  env: Env,
  bearerToken: string | undefined,
  opts?: { subscriptionId?: string },
): Promise<KubernetesClustersResponse> {
  const prefix = bearerToken ? bearerKeyPrefix(bearerToken) : "sp";
  const cacheKey = `${prefix}:clusters:${opts?.subscriptionId ?? "all"}`;
  const cached = clustersCache.get(cacheKey);
  if (cached) return cached;

  const fetcher = await getArmFetcherAuto(env, bearerToken);
  const subIds = opts?.subscriptionId
    ? [opts.subscriptionId]
    : parseSubscriptionIds(env.AZURE_SUBSCRIPTION_IDS ?? "");

  if (subIds.length === 0) {
    return { generatedAt: new Date().toISOString(), clusters: [], note: "no subscriptions configured" };
  }

  // Resource Graph query for AKS clusters
  const query = `resources | where type == "microsoft.containerservice/managedclusters" | project id, name, resourceGroup, subscriptionId, location, properties`;
  const body = {
    subscriptions: subIds,
    query,
    options: { resultFormat: "objectArray" as const },
  };

  const result = await fetcher.fetchJson<{ data?: Array<Record<string, unknown>> }>(
    `https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2021-03-01`,
  ).catch(() => null);

  // Use POST for Resource Graph
  const rgResult = await fetch(
    "https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2021-03-01",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fetcher.armToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );

  if (!rgResult.ok) {
    throw new Error(`Resource Graph HTTP ${rgResult.status}: ${await rgResult.text()}`);
  }

  const rgData = (await rgResult.json()) as { data?: Array<Record<string, unknown>> };
  const rows = rgData.data ?? [];

  const clusters: KubernetesClusterInfo[] = rows.map((r) => {
    const props = (r.properties ?? {}) as Record<string, unknown>;
    const agentPoolProfiles = (props.agentPoolProfiles ?? []) as Array<{ count?: number }>;
    const nodeCount = agentPoolProfiles.reduce((sum, p) => sum + (p.count ?? 0), 0);
    const powerStateObj = (props.powerState ?? {}) as { code?: string };

    return {
      id: String(r.id ?? "").toLowerCase(),
      name: String(r.name ?? ""),
      resourceGroup: String(r.resourceGroup ?? ""),
      subscriptionId: String(r.subscriptionId ?? ""),
      location: String(r.location ?? ""),
      kubernetesVersion: String(props.kubernetesVersion ?? ""),
      nodeCount,
      powerState: String(powerStateObj.code ?? "unknown"),
      fqdn: String(props.fqdn ?? ""),
    };
  });

  const response: KubernetesClustersResponse = {
    generatedAt: new Date().toISOString(),
    clusters,
  };

  clustersCache.set(cacheKey, response);
  return response;
}

// ────────────────────────────────────────────
// 2. Get kubeconfig via ARM API
// ────────────────────────────────────────────

export async function getKubeconfig(
  env: Env,
  bearerToken: string | undefined,
  azureResourceId: string,
): Promise<string> {
  const prefix = bearerToken ? bearerKeyPrefix(bearerToken) : "sp";
  const cacheKey = `${prefix}:kubeconfig:${azureResourceId}`;
  const cached = kubeconfigCache.get(cacheKey);
  if (cached) return cached;

  const fetcher = await getArmFetcherAuto(env, bearerToken);

  const url = `https://management.azure.com${azureResourceId}/listClusterUserCredential?api-version=2024-09-01`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${fetcher.armToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({}),
  });

  if (!res.ok) {
    throw new Error(`listClusterUserCredential HTTP ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as {
    kubeconfigs?: Array<{ name?: string; value?: string }>;
  };

  const b64 = data.kubeconfigs?.[0]?.value;
  if (!b64) throw new Error("No kubeconfig returned from ARM");

  const kubeconfig = Buffer.from(b64, "base64").toString("utf-8");
  kubeconfigCache.set(cacheKey, kubeconfig);
  return kubeconfig;
}

// ────────────────────────────────────────────
// 3. Fetch AKS node info map (nodeName → IP / imageVersion / conditions)
// ────────────────────────────────────────────

const K8S_MAIN_CONDITIONS = new Set(["Ready", "MemoryPressure", "DiskPressure", "PIDPressure", "NetworkUnavailable"]);

export async function fetchAksNodeInfoMap(
  env: Env,
  bearerToken: string | undefined,
  aksClusterArmId: string,
): Promise<Record<string, K8sNodeInfo>> {
  const prefix = bearerToken ? bearerKeyPrefix(bearerToken) : "sp";
  const cacheKey = `${prefix}:k8s-nodes:${aksClusterArmId}`;
  const cached = k8sNodeInfoCache.get(cacheKey);
  if (cached) return cached;

  const kubeconfigYaml = await getKubeconfig(env, bearerToken, aksClusterArmId);
  const kc = new k8s.KubeConfig();
  kc.loadFromString(kubeconfigYaml);
  const coreV1 = kc.makeApiClient(k8s.CoreV1Api);

  const nodeList = await coreV1.listNode();
  const result: Record<string, K8sNodeInfo> = {};

  for (const node of nodeList.items) {
    const name = node.metadata?.name;
    if (!name) continue;

    const privateIp = node.status?.addresses?.find((a) => a.type === "InternalIP")?.address;
    const nodeImageVersion = node.metadata?.labels?.["kubernetes.azure.com/node-image-version"];

    const conditions: AksNodeCondition[] = (node.status?.conditions ?? [])
      .filter((c) => K8S_MAIN_CONDITIONS.has(c.type))
      .map((c) => ({
        type: c.type,
        status: (c.status ?? "Unknown") as "True" | "False" | "Unknown",
        reason: c.reason ?? undefined,
        message: c.message ?? undefined,
      }));

    result[name] = { privateIp, nodeImageVersion, conditions };
  }

  k8sNodeInfoCache.set(cacheKey, result);
  return result;
}

// ────────────────────────────────────────────
// 4. Get Cluster Overview via K8s API
// ────────────────────────────────────────────

export async function getClusterOverview(
  env: Env,
  bearerToken: string | undefined,
  azureResourceId: string,
  clusterInfo: KubernetesClusterInfo,
): Promise<KubernetesClusterOverview> {
  const prefix = bearerToken ? bearerKeyPrefix(bearerToken) : "sp";
  const cacheKey = `${prefix}:overview:${azureResourceId}`;
  const cached = overviewCache.get(cacheKey);
  if (cached) return cached;

  const kubeconfigYaml = await getKubeconfig(env, bearerToken, azureResourceId);

  const kc = new k8s.KubeConfig();
  kc.loadFromString(kubeconfigYaml);

  const coreV1 = kc.makeApiClient(k8s.CoreV1Api);
  const appsV1 = kc.makeApiClient(k8s.AppsV1Api);
  const networkingV1 = kc.makeApiClient(k8s.NetworkingV1Api);
  const batchV1 = kc.makeApiClient(k8s.BatchV1Api);

  // Fetch all resources in parallel
  const [nodes, namespaces, pods, services, deployments, statefulSets, daemonSets, ingresses, jobs, cronJobs] =
    await Promise.allSettled([
      coreV1.listNode(),
      coreV1.listNamespace(),
      coreV1.listPodForAllNamespaces(),
      coreV1.listServiceForAllNamespaces(),
      appsV1.listDeploymentForAllNamespaces(),
      appsV1.listStatefulSetForAllNamespaces(),
      appsV1.listDaemonSetForAllNamespaces(),
      networkingV1.listIngressForAllNamespaces(),
      batchV1.listJobForAllNamespaces(),
      batchV1.listCronJobForAllNamespaces(),
    ]);

  const objects: KubernetesObject[] = [];

  // Nodes
  if (nodes.status === "fulfilled") {
    for (const n of nodes.value.items) {
      const conditions = n.status?.conditions ?? [];
      const ready = conditions.find((c) => c.type === "Ready");
      objects.push({
        kind: "Node",
        name: n.metadata?.name ?? "",
        namespace: "",
        status: ready?.status === "True" ? "Ready" : "NotReady",
        createdAt: n.metadata?.creationTimestamp?.toISOString() ?? "",
      });
    }
  }

  // Namespaces
  if (namespaces.status === "fulfilled") {
    for (const ns of namespaces.value.items) {
      objects.push({
        kind: "Namespace",
        name: ns.metadata?.name ?? "",
        namespace: "",
        status: String(ns.status?.phase ?? "Active"),
        createdAt: ns.metadata?.creationTimestamp?.toISOString() ?? "",
      });
    }
  }

  // Pods
  if (pods.status === "fulfilled") {
    for (const p of pods.value.items) {
      const containerStatuses = p.status?.containerStatuses ?? [];
      const readyCount = containerStatuses.filter((c) => c.ready).length;
      const totalCount = containerStatuses.length;
      const restarts = containerStatuses.reduce((sum, c) => sum + (c.restartCount ?? 0), 0);
      objects.push({
        kind: "Pod",
        name: p.metadata?.name ?? "",
        namespace: p.metadata?.namespace ?? "",
        status: String(p.status?.phase ?? "Unknown"),
        createdAt: p.metadata?.creationTimestamp?.toISOString() ?? "",
        ready: `${readyCount}/${totalCount}`,
        restarts,
      });
    }
  }

  // Services
  if (services.status === "fulfilled") {
    for (const s of services.value.items) {
      objects.push({
        kind: "Service",
        name: s.metadata?.name ?? "",
        namespace: s.metadata?.namespace ?? "",
        status: s.spec?.type ?? "ClusterIP",
        createdAt: s.metadata?.creationTimestamp?.toISOString() ?? "",
      });
    }
  }

  // Deployments
  if (deployments.status === "fulfilled") {
    for (const d of deployments.value.items) {
      const readyReplicas = d.status?.readyReplicas ?? 0;
      const desiredReplicas = d.spec?.replicas ?? 0;
      objects.push({
        kind: "Deployment",
        name: d.metadata?.name ?? "",
        namespace: d.metadata?.namespace ?? "",
        status: readyReplicas === desiredReplicas ? "Ready" : "Progressing",
        createdAt: d.metadata?.creationTimestamp?.toISOString() ?? "",
        replicas: `${readyReplicas}/${desiredReplicas}`,
      });
    }
  }

  // StatefulSets
  if (statefulSets.status === "fulfilled") {
    for (const ss of statefulSets.value.items) {
      const readyReplicas = ss.status?.readyReplicas ?? 0;
      const desiredReplicas = ss.spec?.replicas ?? 0;
      objects.push({
        kind: "StatefulSet",
        name: ss.metadata?.name ?? "",
        namespace: ss.metadata?.namespace ?? "",
        status: readyReplicas === desiredReplicas ? "Ready" : "Progressing",
        createdAt: ss.metadata?.creationTimestamp?.toISOString() ?? "",
        replicas: `${readyReplicas}/${desiredReplicas}`,
      });
    }
  }

  // DaemonSets
  if (daemonSets.status === "fulfilled") {
    for (const ds of daemonSets.value.items) {
      const ready = ds.status?.numberReady ?? 0;
      const desired = ds.status?.desiredNumberScheduled ?? 0;
      objects.push({
        kind: "DaemonSet",
        name: ds.metadata?.name ?? "",
        namespace: ds.metadata?.namespace ?? "",
        status: ready === desired ? "Ready" : "Progressing",
        createdAt: ds.metadata?.creationTimestamp?.toISOString() ?? "",
        replicas: `${ready}/${desired}`,
      });
    }
  }

  // Ingresses
  if (ingresses.status === "fulfilled") {
    for (const ing of ingresses.value.items) {
      objects.push({
        kind: "Ingress",
        name: ing.metadata?.name ?? "",
        namespace: ing.metadata?.namespace ?? "",
        status: (ing.status?.loadBalancer?.ingress?.length ?? 0) > 0 ? "Active" : "Pending",
        createdAt: ing.metadata?.creationTimestamp?.toISOString() ?? "",
      });
    }
  }

  // Jobs
  if (jobs.status === "fulfilled") {
    for (const j of jobs.value.items) {
      const succeeded = j.status?.succeeded ?? 0;
      const failed = j.status?.failed ?? 0;
      let status = "Running";
      if (succeeded > 0) status = "Complete";
      else if (failed > 0) status = "Failed";
      objects.push({
        kind: "Job",
        name: j.metadata?.name ?? "",
        namespace: j.metadata?.namespace ?? "",
        status,
        createdAt: j.metadata?.creationTimestamp?.toISOString() ?? "",
      });
    }
  }

  // CronJobs
  if (cronJobs.status === "fulfilled") {
    for (const cj of cronJobs.value.items) {
      objects.push({
        kind: "CronJob",
        name: cj.metadata?.name ?? "",
        namespace: cj.metadata?.namespace ?? "",
        status: cj.spec?.suspend ? "Suspended" : "Active",
        createdAt: cj.metadata?.creationTimestamp?.toISOString() ?? "",
      });
    }
  }

  // Compute summary
  const podItems = pods.status === "fulfilled" ? pods.value.items : [];
  const summary = {
    namespaceCount: namespaces.status === "fulfilled" ? namespaces.value.items.length : 0,
    nodeCount: nodes.status === "fulfilled" ? nodes.value.items.length : 0,
    podTotal: podItems.length,
    podRunning: podItems.filter((p) => p.status?.phase === "Running").length,
    podPending: podItems.filter((p) => p.status?.phase === "Pending").length,
    podFailed: podItems.filter((p) => p.status?.phase === "Failed").length,
    deploymentCount: deployments.status === "fulfilled" ? deployments.value.items.length : 0,
    serviceCount: services.status === "fulfilled" ? services.value.items.length : 0,
  };

  const overview: KubernetesClusterOverview = {
    generatedAt: new Date().toISOString(),
    cluster: clusterInfo,
    summary,
    objects,
  };

  overviewCache.set(cacheKey, overview);
  return overview;
}

// ────────────────────────────────────────────
// 5. List Namespaces + Pods via K8s API (for Logs tab)
//    — Container Insights 없이 실시간 감지
// ────────────────────────────────────────────

export type K8sPodInfo = {
  namespace: string;
  podName: string;
  status: string;
  containers: string[];
};

const nsPodK8sCache = new CacheManager<{ pods: K8sPodInfo[]; namespaces: K8sNamespaceInfo[] }>(20, 15_000);

export type K8sNamespaceInfo = {
  name: string;
  status: string;
};

export async function listAllNamespacePods(
  env: Env,
  bearerToken: string | undefined,
  azureResourceId: string,
): Promise<{ pods: K8sPodInfo[]; namespaces: K8sNamespaceInfo[] }> {
  const prefix = bearerToken ? bearerKeyPrefix(bearerToken) : "sp";
  const cacheKey = `${prefix}:k8s-nspods:${azureResourceId}`;
  const cached = nsPodK8sCache.get(cacheKey);
  if (cached) return cached;

  const kubeconfigYaml = await getKubeconfig(env, bearerToken, azureResourceId);
  const kc = new k8s.KubeConfig();
  kc.loadFromString(kubeconfigYaml);
  const coreV1 = kc.makeApiClient(k8s.CoreV1Api);

  // Pod 목록 + 네임스페이스 목록 병렬 조회
  const [podList, nsList] = await Promise.all([
    coreV1.listPodForAllNamespaces(),
    coreV1.listNamespace(),
  ]);

  const pods: K8sPodInfo[] = podList.items
    .filter((p) => {
      const phase = p.status?.phase;
      return phase !== "Succeeded" && phase !== "Failed";
    })
    .map((p) => ({
      namespace: p.metadata?.namespace ?? "",
      podName: p.metadata?.name ?? "",
      status: String(p.status?.phase ?? "Unknown"),
      containers: (p.spec?.containers ?? []).map((c) => c.name),
    }));

  const namespaces: K8sNamespaceInfo[] = nsList.items.map((ns) => ({
    name: ns.metadata?.name ?? "",
    status: String(ns.status?.phase ?? "Active"),
  }));

  console.log(`[k8s] listAllNamespacePods: ${podList.items.length} total → ${pods.length} active pods, ${namespaces.length} namespaces`);

  const result = { pods, namespaces };
  nsPodK8sCache.set(cacheKey, result);
  return result;
}

// ────────────────────────────────────────────
// 6. Pod Logs via K8s API (kubectl logs equivalent)
//    — ContainerLogV2 불필요, kubelet에서 직접 조회
// ────────────────────────────────────────────

export async function readPodLogs(
  env: Env,
  bearerToken: string | undefined,
  azureResourceId: string,
  namespace: string,
  podName: string,
  opts?: {
    container?: string;
    tailLines?: number;
    sinceSeconds?: number;
    previous?: boolean;
  },
): Promise<string> {
  const kubeconfigYaml = await getKubeconfig(env, bearerToken, azureResourceId);
  const kc = new k8s.KubeConfig();
  kc.loadFromString(kubeconfigYaml);
  const coreV1 = kc.makeApiClient(k8s.CoreV1Api);

  try {
    const logResp = await coreV1.readNamespacedPodLog({
      name: podName,
      namespace,
      container: opts?.container || undefined,
      tailLines: opts?.tailLines ?? 500,
      sinceSeconds: opts?.sinceSeconds ?? undefined,
      previous: opts?.previous ?? false,
      timestamps: true,
    });

    // readNamespacedPodLog returns string directly
    return typeof logResp === "string" ? logResp : String(logResp ?? "");
  } catch (err: unknown) {
    const errBody = err && typeof err === "object" && "body" in err ? String((err as Record<string, unknown>).body) : "";
    const statusCode = err && typeof err === "object" && "statusCode" in err ? (err as Record<string, unknown>).statusCode : undefined;

    // 404 = Pod가 삭제됨/교체됨 → 빈 로그 반환 (CI fallback 불필요)
    if (statusCode === 404 || errBody.includes('"code":404')) {
      console.warn(`[k8s] readPodLogs 404: ${namespace}/${podName} — Pod가 존재하지 않음 (삭제/교체)`);
      return "";
    }

    // 400 "a container name must be specified" → multi-container pod
    // 에러 메시지에서 컨테이너 목록 추출 후 첫 번째로 재시도
    if ((statusCode === 400 || errBody.includes('"code":400')) && errBody.includes("a container name must be specified")) {
      const containerMatch = errBody.match(/choose one of: \[([^\]]+)\]/);
      if (containerMatch) {
        const containers = containerMatch[1]!.split(/\s+/);
        const firstContainer = containers[0]!;
        console.log(`[k8s] readPodLogs: multi-container pod ${namespace}/${podName}, retrying with container=${firstContainer}`);
        try {
          const retryResp = await coreV1.readNamespacedPodLog({
            name: podName,
            namespace,
            container: firstContainer,
            tailLines: opts?.tailLines ?? 500,
            sinceSeconds: opts?.sinceSeconds ?? undefined,
            previous: opts?.previous ?? false,
            timestamps: true,
          });
          return typeof retryResp === "string" ? retryResp : String(retryResp ?? "");
        } catch (retryErr) {
          console.warn(`[k8s] readPodLogs retry failed for ${namespace}/${podName}/${firstContainer}:`, retryErr instanceof Error ? retryErr.message : retryErr);
          return "";
        }
      }
    }

    throw err; // 다른 에러는 CI fallback으로
  }
}

// ────────────────────────────────────────────
// 7. Workload Detail — per-pod breakdown + services + endpoints
// ────────────────────────────────────────────

import type {
  WorkloadDetailResponse,
  WorkloadPodDetail,
  WorkloadContainerDetail,
  WorkloadServiceInfo,
  WorkloadEndpointInfo,
} from "@aud/types";

const workloadDetailCache = new CacheManager<WorkloadDetailResponse>(30, 15_000);

export async function getWorkloadDetail(
  env: Env,
  bearerToken: string | undefined,
  azureResourceId: string,
  namespace: string,
  workloadName: string,
  kind: string,
): Promise<WorkloadDetailResponse> {
  const prefix = bearerToken ? bearerKeyPrefix(bearerToken) : "sp";
  const cacheKey = `${prefix}:wl-detail:${azureResourceId}:${namespace}/${workloadName}`;
  const cached = workloadDetailCache.get(cacheKey);
  if (cached) return cached;

  const kubeconfigYaml = await getKubeconfig(env, bearerToken, azureResourceId);
  const kc = new k8s.KubeConfig();
  kc.loadFromString(kubeconfigYaml);
  const coreV1 = kc.makeApiClient(k8s.CoreV1Api);

  // ── 1) 해당 네임스페이스의 Pods, Services, Endpoints 병렬 조회 ──
  const [podList, svcList, epList] = await Promise.allSettled([
    coreV1.listNamespacedPod({ namespace }),
    coreV1.listNamespacedService({ namespace }),
    coreV1.listNamespacedEndpoints({ namespace }),
  ]);

  // ── 2) 워크로드에 속하는 Pod 필터링 (ownerReference 기반) ──
  const allPods = podList.status === "fulfilled" ? podList.value.items : [];
  const matchedPods = allPods.filter((p) => {
    const owners = p.metadata?.ownerReferences ?? [];
    // Deployment → ReplicaSet → Pod 구조: ownerRef의 name이 workloadName으로 시작
    for (const owner of owners) {
      if (owner.kind === "ReplicaSet" && owner.name?.startsWith(workloadName + "-")) return true;
      if (owner.kind === "StatefulSet" && owner.name === workloadName) return true;
      if (owner.kind === "DaemonSet" && owner.name === workloadName) return true;
      if (owner.kind === "Job" && owner.name === workloadName) return true;
    }
    // standalone Pod 또는 직접 이름 매칭
    if (kind === "Pod" && p.metadata?.name === workloadName) return true;
    return false;
  });

  const pods: WorkloadPodDetail[] = matchedPods.map((p) => {
    const containers: WorkloadContainerDetail[] = (p.spec?.containers ?? []).map((c) => {
      const cs = (p.status?.containerStatuses ?? []).find((s) => s.name === c.name);
      let state: WorkloadContainerDetail["state"] = "unknown";
      let stateReason: string | undefined;
      if (cs?.state?.running) state = "running";
      else if (cs?.state?.waiting) { state = "waiting"; stateReason = cs.state.waiting.reason ?? undefined; }
      else if (cs?.state?.terminated) { state = "terminated"; stateReason = cs.state.terminated.reason ?? undefined; }

      return {
        name: c.name,
        image: c.image ?? "",
        ports: (c.ports ?? []).map((pt) => ({
          containerPort: pt.containerPort,
          protocol: pt.protocol ?? "TCP",
        })),
        resourceRequests: c.resources?.requests
          ? { cpu: String(c.resources.requests.cpu ?? ""), memory: String(c.resources.requests.memory ?? "") }
          : null,
        resourceLimits: c.resources?.limits
          ? { cpu: String(c.resources.limits.cpu ?? ""), memory: String(c.resources.limits.memory ?? "") }
          : null,
        ready: cs?.ready ?? false,
        restartCount: cs?.restartCount ?? 0,
        state,
        stateReason,
      };
    });

    return {
      name: p.metadata?.name ?? "",
      namespace: p.metadata?.namespace ?? namespace,
      status: String(p.status?.phase ?? "Unknown"),
      podIP: p.status?.podIP ?? "",
      nodeName: p.spec?.nodeName ?? "",
      startTime: p.status?.startTime?.toISOString?.() ?? p.metadata?.creationTimestamp?.toISOString?.() ?? "",
      containers,
    };
  });

  // ── 3) 매칭되는 Pod의 라벨 수집 (서비스 selector 매칭용) ──
  const podLabelsSet = new Map<string, string>();
  for (const p of matchedPods) {
    const labels = p.metadata?.labels ?? {};
    for (const [k, v] of Object.entries(labels)) {
      podLabelsSet.set(k, v);
    }
  }

  // ── 4) Service: selector가 Pod 라벨과 매칭되는 서비스 필터 ──
  const allSvcs = svcList.status === "fulfilled" ? svcList.value.items : [];
  const matchedSvcs = allSvcs.filter((svc) => {
    const selector = svc.spec?.selector ?? {};
    if (Object.keys(selector).length === 0) return false;
    // 서비스의 모든 selector 키가 Pod 라벨에 존재하고 값이 일치해야 함
    return Object.entries(selector).every(([k, v]) => podLabelsSet.get(k) === v);
  });

  const services: WorkloadServiceInfo[] = matchedSvcs.map((svc) => ({
    name: svc.metadata?.name ?? "",
    namespace: svc.metadata?.namespace ?? namespace,
    type: svc.spec?.type ?? "ClusterIP",
    clusterIP: svc.spec?.clusterIP ?? "",
    externalIP:
      svc.status?.loadBalancer?.ingress?.[0]?.ip ??
      svc.status?.loadBalancer?.ingress?.[0]?.hostname ??
      (svc.spec?.externalIPs?.[0] ?? null),
    ports: (svc.spec?.ports ?? []).map((pt) => ({
      port: pt.port,
      targetPort: pt.targetPort ?? pt.port,
      protocol: pt.protocol ?? "TCP",
      ...(pt.nodePort ? { nodePort: pt.nodePort } : {}),
    })),
    selector: svc.spec?.selector ?? {},
  }));

  // ── 5) Endpoints: 매칭된 서비스의 엔드포인트 ──
  const svcNames = new Set(matchedSvcs.map((s) => s.metadata?.name ?? ""));
  const allEps = epList.status === "fulfilled" ? epList.value.items : [];
  const matchedEps = allEps.filter((ep) => svcNames.has(ep.metadata?.name ?? ""));

  const endpoints: WorkloadEndpointInfo[] = matchedEps.map((ep) => ({
    serviceName: ep.metadata?.name ?? "",
    addresses: (ep.subsets ?? []).flatMap((sub) =>
      (sub.addresses ?? []).map((addr) => ({
        ip: addr.ip ?? "",
        nodeName: addr.nodeName ?? undefined,
        podName: addr.targetRef?.name ?? undefined,
      })),
    ),
    ports: (ep.subsets ?? []).flatMap((sub) =>
      (sub.ports ?? []).map((pt) => ({
        port: pt.port ?? 0,
        protocol: pt.protocol ?? "TCP",
        name: pt.name ?? undefined,
      })),
    ),
  }));

  const result: WorkloadDetailResponse = {
    clusterId: azureResourceId,
    generatedAt: new Date().toISOString(),
    workloadName,
    namespace,
    kind,
    pods,
    services,
    endpoints,
  };

  console.log(`[k8s] workloadDetail: ${namespace}/${workloadName} (${kind}) → ${pods.length} pods, ${services.length} svcs, ${endpoints.length} eps`);
  workloadDetailCache.set(cacheKey, result);
  return result;
}

// ────────────────────────────────────────────
// Mock data — used when K8s is unavailable
// ────────────────────────────────────────────

export const mockClusters: KubernetesClustersResponse = {
  generatedAt: new Date().toISOString(),
  clusters: [
    {
      id: "/subscriptions/00000000-0000-0000-0000-000000000000/resourcegroups/rg-core/providers/microsoft.containerservice/managedclusters/aks-platform",
      name: "aks-platform",
      resourceGroup: "rg-core",
      subscriptionId: "00000000-0000-0000-0000-000000000000",
      location: "koreacentral",
      kubernetesVersion: "1.29.2",
      nodeCount: 3,
      powerState: "Running",
      fqdn: "aks-platform-dns-abc123.hcp.koreacentral.azmk8s.io",
    },
    {
      id: "/subscriptions/00000000-0000-0000-0000-000000000000/resourcegroups/rg-staging/providers/microsoft.containerservice/managedclusters/aks-staging",
      name: "aks-staging",
      resourceGroup: "rg-staging",
      subscriptionId: "00000000-0000-0000-0000-000000000000",
      location: "koreacentral",
      kubernetesVersion: "1.28.5",
      nodeCount: 2,
      powerState: "Running",
      fqdn: "aks-staging-dns-xyz789.hcp.koreacentral.azmk8s.io",
    },
  ],
  note: "mock data",
};

export function mockClusterOverview(cluster: KubernetesClusterInfo): KubernetesClusterOverview {
  const now = new Date().toISOString();
  const ago = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

  const objects: KubernetesObject[] = [
    { kind: "Node", name: "aks-nodepool1-12345-vmss000000", namespace: "", status: "Ready", createdAt: ago(720) },
    { kind: "Node", name: "aks-nodepool1-12345-vmss000001", namespace: "", status: "Ready", createdAt: ago(720) },
    { kind: "Node", name: "aks-nodepool1-12345-vmss000002", namespace: "", status: "Ready", createdAt: ago(360) },
    { kind: "Namespace", name: "default", namespace: "", status: "Active", createdAt: ago(720) },
    { kind: "Namespace", name: "kube-system", namespace: "", status: "Active", createdAt: ago(720) },
    { kind: "Namespace", name: "app", namespace: "", status: "Active", createdAt: ago(168) },
    { kind: "Namespace", name: "monitoring", namespace: "", status: "Active", createdAt: ago(168) },
    { kind: "Pod", name: "api-server-7f8d6b5c4-abc12", namespace: "app", status: "Running", createdAt: ago(48), ready: "1/1", restarts: 0 },
    { kind: "Pod", name: "api-server-7f8d6b5c4-def34", namespace: "app", status: "Running", createdAt: ago(48), ready: "1/1", restarts: 0 },
    { kind: "Pod", name: "web-frontend-5d9f8c7b2-ghi56", namespace: "app", status: "Running", createdAt: ago(24), ready: "1/1", restarts: 1 },
    { kind: "Pod", name: "redis-master-0", namespace: "app", status: "Running", createdAt: ago(168), ready: "1/1", restarts: 0 },
    { kind: "Pod", name: "prometheus-0", namespace: "monitoring", status: "Running", createdAt: ago(168), ready: "2/2", restarts: 0 },
    { kind: "Pod", name: "grafana-6b8f7c9d5-jkl78", namespace: "monitoring", status: "Running", createdAt: ago(168), ready: "1/1", restarts: 0 },
    { kind: "Pod", name: "coredns-7d8f9b6c4-mno90", namespace: "kube-system", status: "Running", createdAt: ago(720), ready: "1/1", restarts: 2 },
    { kind: "Pod", name: "coredns-7d8f9b6c4-pqr12", namespace: "kube-system", status: "Running", createdAt: ago(720), ready: "1/1", restarts: 1 },
    { kind: "Deployment", name: "api-server", namespace: "app", status: "Ready", createdAt: ago(168), replicas: "2/2" },
    { kind: "Deployment", name: "web-frontend", namespace: "app", status: "Ready", createdAt: ago(168), replicas: "1/1" },
    { kind: "Deployment", name: "grafana", namespace: "monitoring", status: "Ready", createdAt: ago(168), replicas: "1/1" },
    { kind: "Deployment", name: "coredns", namespace: "kube-system", status: "Ready", createdAt: ago(720), replicas: "2/2" },
    { kind: "StatefulSet", name: "redis-master", namespace: "app", status: "Ready", createdAt: ago(168), replicas: "1/1" },
    { kind: "StatefulSet", name: "prometheus", namespace: "monitoring", status: "Ready", createdAt: ago(168), replicas: "1/1" },
    { kind: "Service", name: "api-server", namespace: "app", status: "ClusterIP", createdAt: ago(168) },
    { kind: "Service", name: "web-frontend", namespace: "app", status: "LoadBalancer", createdAt: ago(168) },
    { kind: "Service", name: "redis-master", namespace: "app", status: "ClusterIP", createdAt: ago(168) },
    { kind: "Service", name: "prometheus", namespace: "monitoring", status: "ClusterIP", createdAt: ago(168) },
    { kind: "Service", name: "grafana", namespace: "monitoring", status: "LoadBalancer", createdAt: ago(168) },
    { kind: "Ingress", name: "web-ingress", namespace: "app", status: "Active", createdAt: ago(120) },
    { kind: "CronJob", name: "backup-job", namespace: "app", status: "Active", createdAt: ago(168) },
  ];

  return {
    generatedAt: now,
    cluster,
    summary: {
      namespaceCount: 4,
      nodeCount: 3,
      podTotal: 8,
      podRunning: 8,
      podPending: 0,
      podFailed: 0,
      deploymentCount: 4,
      serviceCount: 5,
    },
    objects,
    note: "mock data",
  };
}
