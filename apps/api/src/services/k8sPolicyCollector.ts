import { withLang, type Lang } from "../infra/lang.js";
import { k8sFailureReason, withK8sRetry } from "../infra/k8sRetry.js";
import * as k8s from "@kubernetes/client-node";
import type { Env } from "../env.js";
import type { KubernetesPolicyResponse } from "@aud/types";
import { CacheManager, cachePrefix } from "../infra/cacheManager.js";
import { debug } from "../infra/logger.js";
import { loadKubeConfig } from "./kubernetes.js";
import { parseArgoApplications } from "./gitopsSource.js";
import { k8sError } from "./aksAccess.js";
import { HttpError } from "../infra/requestParams.js";
import {
  analyzePolicies,
  type InvCiliumSpec,
  type InvContainer,
  type InvContainerSecurity,
  type InvPodSecurity,
  type InvWorkload,
  type LabelSelector,
  type PolicyInventory,
} from "./policyAnalyzer.js";

// ──────────────────────────────────────────────────────────────
// Cluster policy inventory collector
//
// Lists the policy-relevant objects through the Kubernetes API and hands them
// to the pure analyzer. Every list is independent: a missing CRD (VPA, Cilium)
// or a forbidden resource degrades that section instead of failing the page.
// ──────────────────────────────────────────────────────────────

const policyCache = new CacheManager<KubernetesPolicyResponse>(10, 60_000);
const inventoryCache = new CacheManager<PolicyInventory>(10, 60_000);

type CustomList = { items?: Array<Record<string, unknown>> };

/** HTTP status of a client-node error (v1 ApiException exposes `code`). */
function statusOf(e: unknown): number | undefined {
  if (e && typeof e === "object") {
    const o = e as { code?: unknown; statusCode?: unknown };
    if (typeof o.code === "number") return o.code;
    if (typeof o.statusCode === "number") return o.statusCode;
  }
  return undefined;
}

function str(v: unknown): string | undefined {
  return v === undefined || v === null ? undefined : String(v);
}

function labelsOf(meta: { labels?: Record<string, string> } | undefined): Record<string, string> {
  return meta?.labels ?? {};
}

function toSelector(sel: { matchLabels?: Record<string, string>; matchExpressions?: Array<{ key: string; operator: string; values?: string[] }> } | undefined): LabelSelector {
  return {
    matchLabels: sel?.matchLabels ?? {},
    matchExpressions: (sel?.matchExpressions ?? []).map((e) => ({ key: e.key, operator: e.operator, values: e.values })),
  };
}

function quantities(map: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map ?? {})) out[k] = String(v);
  return out;
}

function toContainers(spec: k8s.V1PodSpec | undefined): InvContainer[] {
  return (spec?.containers ?? []).map((c) => ({
    name: c.name,
    requests: quantities(c.resources?.requests as Record<string, unknown> | undefined),
    limits: quantities(c.resources?.limits as Record<string, unknown> | undefined),
  }));
}

function toContainerSecurity(c: k8s.V1Container, init: boolean): InvContainerSecurity {
  const sc = c.securityContext;
  return {
    name: c.name,
    image: c.image ?? "",
    init,
    privileged: sc?.privileged,
    allowPrivilegeEscalation: sc?.allowPrivilegeEscalation,
    runAsNonRoot: sc?.runAsNonRoot,
    runAsUser: sc?.runAsUser,
    capAdd: sc?.capabilities?.add ?? [],
  };
}

function toPodSecurity(pod: k8s.V1PodSpec | undefined): InvPodSecurity {
  const all = [...(pod?.containers ?? []), ...(pod?.initContainers ?? [])];
  const usesSecrets =
    (pod?.volumes ?? []).some((v) => v.secret || v.projected?.sources?.some((s) => s.secret)) ||
    all.some((c) => (c.envFrom ?? []).some((e) => e.secretRef) || (c.env ?? []).some((e) => e.valueFrom?.secretKeyRef));
  return {
    hostNetwork: pod?.hostNetwork === true,
    hostPID: pod?.hostPID === true,
    hostIPC: pod?.hostIPC === true,
    hostPaths: (pod?.volumes ?? []).filter((v) => v.hostPath).map((v) => v.hostPath!.path),
    usesSecrets,
    runAsNonRoot: pod?.securityContext?.runAsNonRoot,
    runAsUser: pod?.securityContext?.runAsUser,
    containers: [
      ...(pod?.containers ?? []).map((c) => toContainerSecurity(c, false)),
      ...(pod?.initContainers ?? []).map((c) => toContainerSecurity(c, true)),
    ],
  };
}

function toWorkload(
  kind: InvWorkload["kind"],
  obj: { metadata?: k8s.V1ObjectMeta; spec?: { replicas?: number; template?: k8s.V1PodTemplateSpec } },
  replicasOverride?: number,
): InvWorkload {
  const pod = obj.spec?.template?.spec;
  return {
    kind,
    namespace: obj.metadata?.namespace ?? "",
    name: obj.metadata?.name ?? "",
    replicas: replicasOverride ?? obj.spec?.replicas ?? 1,
    podLabels: obj.spec?.template?.metadata?.labels ?? {},
    serviceAccountName: pod?.serviceAccountName,
    automountServiceAccountToken: pod?.automountServiceAccountToken,
    containers: toContainers(pod),
    labels: labelsOf(obj.metadata),
    helmRelease: obj.metadata?.annotations?.["meta.helm.sh/release-name"],
    security: toPodSecurity(pod),
  };
}

/** Backend Service names of an Ingress or Gateway API HTTPRoute. */
function ingressBackends(ing: k8s.V1Ingress): string[] {
  const names = (ing.spec?.rules ?? []).flatMap((r) => (r.http?.paths ?? []).map((p) => p.backend.service?.name));
  if (ing.spec?.defaultBackend?.service?.name) names.push(ing.spec.defaultBackend.service.name);
  return [...new Set(names.filter((n): n is string => !!n))];
}

function routeBackends(route: Record<string, unknown>): string[] {
  const rules = ((route.spec as { rules?: Array<{ backendRefs?: Array<{ name?: string; kind?: string }> }> } | undefined)?.rules) ?? [];
  return [...new Set(rules.flatMap((r) => (r.backendRefs ?? []).filter((b) => !b.kind || b.kind === "Service").map((b) => b.name)).filter((n): n is string => !!n))];
}

function hpaMetricTarget(target: k8s.V2MetricTarget | undefined): string | undefined {
  if (!target) return undefined;
  if (target.averageUtilization !== undefined) return `${target.averageUtilization}%`;
  return str(target.averageValue ?? target.value);
}

function ciliumSpecs(obj: Record<string, unknown>): InvCiliumSpec[] {
  const specs: unknown[] = [];
  if (obj.spec) specs.push(obj.spec);
  if (Array.isArray(obj.specs)) specs.push(...obj.specs);
  return specs.filter((s): s is Record<string, unknown> => !!s && typeof s === "object").map((s) => ({
    endpointSelector: s.endpointSelector ? toSelector(s.endpointSelector as LabelSelector) : undefined,
    nodeSelector: s.nodeSelector ? toSelector(s.nodeSelector as LabelSelector) : undefined,
    ingress: Array.isArray(s.ingress) ? s.ingress : undefined,
    ingressDeny: Array.isArray(s.ingressDeny) ? s.ingressDeny : undefined,
    egress: Array.isArray(s.egress) ? s.egress : undefined,
    egressDeny: Array.isArray(s.egressDeny) ? s.egressDeny : undefined,
  }));
}

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * What the azure-workload-identity webhook injected into a running pod — only the token file variable's name and the
 * client / tenant GUIDs are kept; no other environment variable (names or values) leaves this function.
 */
export function wiTraces(containers: Array<{ env?: Array<{ name: string; value?: string }> }>): { wi?: { tokenFile: boolean; clientId?: string; tenantId?: string } } {
  let tokenFile = false;
  let clientId: string | undefined, tenantId: string | undefined;
  for (const c of containers) {
    for (const e of c.env ?? []) {
      if (e.name === "AZURE_FEDERATED_TOKEN_FILE") tokenFile = true;
      else if (e.name === "AZURE_CLIENT_ID" && e.value && GUID_RE.test(e.value)) clientId ??= e.value.toLowerCase();
      else if (e.name === "AZURE_TENANT_ID" && e.value && GUID_RE.test(e.value)) tenantId ??= e.value.toLowerCase();
    }
  }
  return tokenFile || clientId ? { wi: { tokenFile, ...(clientId ? { clientId } : {}), ...(tenantId ? { tenantId } : {}) } } : {};
}

export async function collectClusterPolicies(
  env: Env,
  bearerToken: string | undefined,
  clusterId: string,
  lang: Lang = "ko",
): Promise<KubernetesPolicyResponse> {
  const cacheKey = `${cachePrefix(bearerToken)}:k8s-policies:${clusterId.toLowerCase()}:${lang}`;
  const cached = policyCache.get(cacheKey);
  if (cached) return cached;

  const inventory = await collectPolicyInventory(env, bearerToken, clusterId, lang);
  const result = withLang(lang, () => analyzePolicies(inventory, clusterId));
  debug(`[k8s-policy] ${clusterId}: ${result.findings.length} findings, score ${result.summary.score}`);
  policyCache.set(cacheKey, result);
  return result;
}

/**
 * Raw policy inventory, shared by the policy check and policy insights.
 * Cached per user so both endpoints read the cluster once per minute.
 */
export async function collectPolicyInventory(
  env: Env,
  bearerToken: string | undefined,
  clusterId: string,
  lang: Lang = "ko",
): Promise<PolicyInventory> {
  const cacheKey = `${cachePrefix(bearerToken)}:k8s-policy-inventory:${clusterId.toLowerCase()}`;
  const cached = inventoryCache.get(cacheKey);
  if (cached) return cached;

  const kc = await loadKubeConfig(env, bearerToken, clusterId);
  const core = kc.makeApiClient(k8s.CoreV1Api);
  const apps = kc.makeApiClient(k8s.AppsV1Api);
  const net = kc.makeApiClient(k8s.NetworkingV1Api);
  const rbac = kc.makeApiClient(k8s.RbacAuthorizationV1Api);
  const autoscaling = kc.makeApiClient(k8s.AutoscalingV2Api);
  const policy = kc.makeApiClient(k8s.PolicyV1Api);
  const custom = kc.makeApiClient(k8s.CustomObjectsApi);

  const unavailable: string[] = [];
  let namespaceError: unknown;
  /** List one resource kind; failures are recorded instead of thrown. `missingOk` = 404 means "not installed". */
  async function list<T>(label: string, fn: () => Promise<{ items?: T[] }>, missingOk = false): Promise<{ items: T[]; ok: boolean }> {
    try {
      // One retry for a transient failure: a blip must not turn into an empty list (missing issues)
      const r = await withK8sRetry(fn);
      return { items: r.items ?? [], ok: true };
    } catch (e) {
      const status = statusOf(e);
      if (label === "Namespace") namespaceError = e;
      if (!(missingOk && status === 404)) {
        unavailable.push(`${label} (${k8sFailureReason(e)})`);
        console.warn(`[k8s-policy] ${label} list failed:`, status ?? (e instanceof Error ? e.message : e));
      }
      return { items: [], ok: false };
    }
  }

  const [
    namespaces, pods, deployments, statefulSets, daemonSets, netpols,
    roles, clusterRoles, roleBindings, clusterRoleBindings,
    hpas, pdbs, quotas, limitRanges, vpas, cnps, ccnps,
    services, ingresses, httpRoutes, nodes, argoApps,
  ] = await Promise.all([
    list("Namespace", () => core.listNamespace()),
    list("Pod", () => core.listPodForAllNamespaces()),
    list("Deployment", () => apps.listDeploymentForAllNamespaces()),
    list("StatefulSet", () => apps.listStatefulSetForAllNamespaces()),
    list("DaemonSet", () => apps.listDaemonSetForAllNamespaces()),
    list("NetworkPolicy", () => net.listNetworkPolicyForAllNamespaces()),
    list("Role", () => rbac.listRoleForAllNamespaces()),
    list("ClusterRole", () => rbac.listClusterRole()),
    list("RoleBinding", () => rbac.listRoleBindingForAllNamespaces()),
    list("ClusterRoleBinding", () => rbac.listClusterRoleBinding()),
    list("HorizontalPodAutoscaler", () => autoscaling.listHorizontalPodAutoscalerForAllNamespaces()),
    list("PodDisruptionBudget", () => policy.listPodDisruptionBudgetForAllNamespaces()),
    list("ResourceQuota", () => core.listResourceQuotaForAllNamespaces()),
    list("LimitRange", () => core.listLimitRangeForAllNamespaces()),
    list<Record<string, unknown>>("VerticalPodAutoscaler", () =>
      custom.listClusterCustomObject({ group: "autoscaling.k8s.io", version: "v1", plural: "verticalpodautoscalers" }) as Promise<CustomList>, true),
    list<Record<string, unknown>>("CiliumNetworkPolicy", () =>
      custom.listClusterCustomObject({ group: "cilium.io", version: "v2", plural: "ciliumnetworkpolicies" }) as Promise<CustomList>, true),
    list<Record<string, unknown>>("CiliumClusterwideNetworkPolicy", () =>
      custom.listClusterCustomObject({ group: "cilium.io", version: "v2", plural: "ciliumclusterwidenetworkpolicies" }) as Promise<CustomList>, true),
    list("Service", () => core.listServiceForAllNamespaces()),
    list("Ingress", () => net.listIngressForAllNamespaces()),
    list<Record<string, unknown>>("HTTPRoute", () =>
      custom.listClusterCustomObject({ group: "gateway.networking.k8s.io", version: "v1", plural: "httproutes" }) as Promise<CustomList>, true),
    list("Node", () => core.listNode()),
    list<Record<string, unknown>>("ArgoApplication", () =>
      custom.listClusterCustomObject({ group: "argoproj.io", version: "v1alpha1", plural: "applications" }) as Promise<CustomList>, true),
  ]);

  if (!namespaces.ok) {
    // No Kubernetes role / out of reach → the coded error (the web explains what to bind or where to run)
    const coded = k8sError(namespaceError);
    if (coded instanceof HttpError) throw coded;
    throw new Error(lang === "en" ? "Could not list namespaces — check cluster read permissions." : "Namespace 목록을 조회할 수 없습니다 — 클러스터 읽기 권한을 확인하세요.");
  }

  const inventory: PolicyInventory = {
    namespaces: namespaces.items.map((n) => ({ name: n.metadata?.name ?? "", labels: labelsOf(n.metadata) })),
    pods: pods.items.map((p) => ({
      namespace: p.metadata?.namespace ?? "",
      name: p.metadata?.name ?? "",
      labels: labelsOf(p.metadata),
      phase: p.status?.phase,
      hostNetwork: p.spec?.hostNetwork === true,
      ...(p.spec?.nodeName ? { nodeName: p.spec.nodeName } : {}),
      ...(p.spec?.serviceAccountName ? { serviceAccountName: p.spec.serviceAccountName } : {}),
      ...wiTraces(p.spec?.containers ?? []),
    })),
    workloads: [
      ...deployments.items.map((d) => toWorkload("Deployment", d)),
      ...statefulSets.items.map((s) => toWorkload("StatefulSet", s)),
      ...daemonSets.items.map((d) => toWorkload("DaemonSet", d, d.status?.desiredNumberScheduled ?? 0)),
    ],
    networkPolicies: netpols.items.map((np) => ({
      namespace: np.metadata?.namespace ?? "",
      name: np.metadata?.name ?? "",
      podSelector: toSelector(np.spec?.podSelector),
      policyTypes: np.spec?.policyTypes,
      ingress: np.spec?.ingress,
      egress: np.spec?.egress,
    })),
    ciliumPolicies: [
      ...cnps.items.map((p) => {
        const meta = p.metadata as k8s.V1ObjectMeta | undefined;
        return { namespace: meta?.namespace ?? "", name: meta?.name ?? "", specs: ciliumSpecs(p) };
      }),
      ...ccnps.items.map((p) => {
        const meta = p.metadata as k8s.V1ObjectMeta | undefined;
        return { name: meta?.name ?? "", specs: ciliumSpecs(p) };
      }),
    ],
    roles: [
      ...roles.items.map((r) => ({
        kind: "Role" as const,
        namespace: r.metadata?.namespace,
        name: r.metadata?.name ?? "",
        labels: labelsOf(r.metadata),
        rules: (r.rules ?? []).map((x) => ({ apiGroups: x.apiGroups, resources: x.resources, verbs: x.verbs, resourceNames: x.resourceNames, nonResourceURLs: x.nonResourceURLs })),
        aggregated: false,
      })),
      ...clusterRoles.items.map((r) => ({
        kind: "ClusterRole" as const,
        name: r.metadata?.name ?? "",
        labels: labelsOf(r.metadata),
        rules: (r.rules ?? []).map((x) => ({ apiGroups: x.apiGroups, resources: x.resources, verbs: x.verbs, resourceNames: x.resourceNames, nonResourceURLs: x.nonResourceURLs })),
        aggregated: !!r.aggregationRule,
      })),
    ],
    bindings: [
      ...roleBindings.items.map((b) => ({
        kind: "RoleBinding" as const,
        namespace: b.metadata?.namespace,
        name: b.metadata?.name ?? "",
        labels: labelsOf(b.metadata),
        roleRef: { kind: b.roleRef.kind, name: b.roleRef.name },
        subjects: (b.subjects ?? []).map((s) => ({ kind: s.kind, name: s.name, namespace: s.namespace })),
      })),
      ...clusterRoleBindings.items.map((b) => ({
        kind: "ClusterRoleBinding" as const,
        name: b.metadata?.name ?? "",
        labels: labelsOf(b.metadata),
        roleRef: { kind: b.roleRef.kind, name: b.roleRef.name },
        subjects: (b.subjects ?? []).map((s) => ({ kind: s.kind, name: s.name, namespace: s.namespace })),
      })),
    ],
    hpas: hpas.items.map((h) => ({
      namespace: h.metadata?.namespace ?? "",
      name: h.metadata?.name ?? "",
      target: { kind: h.spec?.scaleTargetRef.kind ?? "", name: h.spec?.scaleTargetRef.name ?? "" },
      minReplicas: h.spec?.minReplicas ?? 1,
      maxReplicas: h.spec?.maxReplicas ?? 1,
      currentReplicas: h.status?.currentReplicas,
      metrics: (h.spec?.metrics ?? []).map((m) => {
        switch (m.type) {
          case "Resource":
            return { type: m.type, name: m.resource?.name ?? "", target: hpaMetricTarget(m.resource?.target) };
          case "ContainerResource":
            return { type: m.type, name: m.containerResource?.name ?? "", target: hpaMetricTarget(m.containerResource?.target) };
          case "Pods":
            return { type: m.type, name: m.pods?.metric.name ?? "", target: hpaMetricTarget(m.pods?.target) };
          case "Object":
            return { type: m.type, name: m.object?.metric.name ?? "", target: hpaMetricTarget(m.object?.target) };
          case "External":
            return { type: m.type, name: m.external?.metric.name ?? "", target: hpaMetricTarget(m.external?.target) };
          default:
            return { type: m.type, name: "" };
        }
      }),
    })),
    vpas: vpas.items.map((v) => {
      const meta = v.metadata as k8s.V1ObjectMeta | undefined;
      const spec = (v.spec ?? {}) as {
        targetRef?: { kind?: string; name?: string };
        updatePolicy?: { updateMode?: string };
        resourcePolicy?: { containerPolicies?: Array<{ controlledResources?: string[] }> };
      };
      const status = (v.status ?? {}) as {
        recommendation?: { containerRecommendations?: Array<{ containerName?: string; target?: Record<string, unknown> }> };
      };
      const recommendations: Record<string, Record<string, string>> = {};
      for (const r of status.recommendation?.containerRecommendations ?? []) {
        if (r.containerName) recommendations[r.containerName] = quantities(r.target);
      }
      const controlled = spec.resourcePolicy?.containerPolicies?.flatMap((p) => p.controlledResources ?? []);
      return {
        namespace: meta?.namespace ?? "",
        name: meta?.name ?? "",
        target: { kind: spec.targetRef?.kind ?? "", name: spec.targetRef?.name ?? "" },
        updateMode: spec.updatePolicy?.updateMode,
        controlledResources: controlled?.length ? [...new Set(controlled)] : undefined,
        recommendations,
      };
    }),
    pdbs: pdbs.items.map((p) => ({
      namespace: p.metadata?.namespace ?? "",
      name: p.metadata?.name ?? "",
      selector: toSelector(p.spec?.selector),
      minAvailable: str(p.spec?.minAvailable),
      maxUnavailable: str(p.spec?.maxUnavailable),
      disruptionsAllowed: p.status?.disruptionsAllowed,
    })),
    resourceQuotas: quotas.items.map((q) => ({ namespace: q.metadata?.namespace ?? "", name: q.metadata?.name ?? "" })),
    limitRanges: limitRanges.items.map((l) => ({ namespace: l.metadata?.namespace ?? "", name: l.metadata?.name ?? "" })),
    capabilities: { vpaInstalled: vpas.ok, ciliumInstalled: cnps.ok || ccnps.ok, unavailable },
    // 404 = Argo CD not installed (not a failure); 403 = the read role has no applications.argoproj.io yet
    gitops: argoApps.ok
      ? { state: "ok", apps: parseArgoApplications(argoApps.items) }
      : { state: unavailable.some((u) => u.startsWith("ArgoApplication") && /forbid|403/i.test(u)) ? "forbidden" : unavailable.some((u) => u.startsWith("ArgoApplication")) ? "failed" : "notInstalled", apps: [] },
    services: services.items.map((s) => ({
      namespace: s.metadata?.namespace ?? "",
      name: s.metadata?.name ?? "",
      type: s.spec?.type ?? "ClusterIP",
      selector: s.spec?.selector ?? {},
      internal: s.metadata?.annotations?.["service.beta.kubernetes.io/azure-load-balancer-internal"] === "true",
      ports: (s.spec?.ports ?? []).map((p) => `${p.port}/${p.protocol ?? "TCP"}`),
    })),
    routes: [
      ...ingresses.items.map((i) => ({ kind: "Ingress" as const, namespace: i.metadata?.namespace ?? "", name: i.metadata?.name ?? "", backends: ingressBackends(i) })),
      ...httpRoutes.items.map((r) => {
        const meta = r.metadata as k8s.V1ObjectMeta | undefined;
        return { kind: "HTTPRoute" as const, namespace: meta?.namespace ?? "", name: meta?.name ?? "", backends: routeBackends(r) };
      }),
    ],
    nodes: nodes.items.map((n) => ({
      name: n.metadata?.name ?? "",
      pool: n.metadata?.labels?.["kubernetes.azure.com/agentpool"],
      vmSize: n.metadata?.labels?.["node.kubernetes.io/instance-type"],
      osImage: n.status?.nodeInfo?.osImage,
      kernel: n.status?.nodeInfo?.kernelVersion,
      runtime: n.status?.nodeInfo?.containerRuntimeVersion,
      kubelet: n.status?.nodeInfo?.kubeletVersion,
      nodeImage: n.metadata?.labels?.["kubernetes.azure.com/node-image-version"],
    })),
  };

  inventoryCache.set(cacheKey, inventory);
  return inventory;
}
