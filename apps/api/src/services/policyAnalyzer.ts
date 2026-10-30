import type {
  HpaInfo,
  KubernetesPolicyResponse,
  NamespacePolicySummary,
  NetworkPolicyInfo,
  PdbInfo,
  PolicyCategory,
  PolicyCategoryScore,
  PolicyFinding,
  PolicyResourceRef,
  PolicySeverity,
  PsaLabels,
  PsaLevel,
  RbacBindingInfo,
  RbacRoleInfo,
  RbacSubject,
  VpaInfo,
  VpaUpdateMode,
  WorkloadPolicyCoverage,
} from "@aud/types";
import { L } from "../infra/lang.js";
import type { InvGitopsApp } from "./gitopsSource.js";
import { buildNetpolModel, cnpIsolates } from "./netpolModel.js";

// ──────────────────────────────────────────────────────────────
// Cluster policy analyzer (pure — no I/O)
//
// Evaluates a cluster inventory against the upstream recommendations:
//   - Pod Security Admission / Pod Security Standards
//   - NetworkPolicy default-deny guidance
//   - RBAC good practices (privilege-escalation paths)
//   - VPA / HPA / PDB and resource requests, quotas and limit ranges
// ──────────────────────────────────────────────────────────────

// ── Inventory (plain shapes, collected from the Kubernetes API) ──

export type LabelSelector = {
  matchLabels?: Record<string, string>;
  matchExpressions?: Array<{ key: string; operator: string; values?: string[] }>;
};

export type InvContainer = { name: string; requests?: Record<string, string>; limits?: Record<string, string> };

export type InvWorkload = {
  kind: "Deployment" | "StatefulSet" | "DaemonSet";
  namespace: string;
  name: string;
  replicas: number;
  podLabels: Record<string, string>;
  serviceAccountName?: string;
  automountServiceAccountToken?: boolean;
  containers: InvContainer[];
  /** Object labels (ownership: Helm, AKS add-on) */
  labels?: Record<string, string>;
  helmRelease?: string;
  /** Pod template security posture (policy insights) */
  security?: InvPodSecurity;
};

export type InvContainerSecurity = {
  name: string;
  image: string;
  init: boolean;
  privileged?: boolean;
  allowPrivilegeEscalation?: boolean;
  runAsNonRoot?: boolean;
  runAsUser?: number;
  capAdd: string[];
};

export type InvPodSecurity = {
  hostNetwork: boolean;
  hostPID: boolean;
  hostIPC: boolean;
  hostPaths: string[];
  /** Secret volume, projected secret, envFrom secretRef or env secretKeyRef */
  usesSecrets: boolean;
  runAsNonRoot?: boolean;
  runAsUser?: number;
  containers: InvContainerSecurity[];
};

export type InvService = {
  namespace: string;
  name: string;
  type: string;
  selector: Record<string, string>;
  internal: boolean;
  ports: string[];
};

export type InvRoute = { kind: "Ingress" | "HTTPRoute"; namespace: string; name: string; backends: string[] };

export type InvNode = {
  name: string;
  pool?: string;
  vmSize?: string;
  osImage?: string;
  kernel?: string;
  runtime?: string;
  kubelet?: string;
  nodeImage?: string;
};

export type InvRbacRule = {
  apiGroups?: string[];
  resources?: string[];
  verbs: string[];
  resourceNames?: string[];
  nonResourceURLs?: string[];
};

export type InvCiliumSpec = {
  endpointSelector?: LabelSelector;
  nodeSelector?: LabelSelector;
  ingress?: unknown[];
  ingressDeny?: unknown[];
  egress?: unknown[];
  egressDeny?: unknown[];
  /** Cilium: false for a direction = its rules add allows but don't put the selected endpoints in default-deny */
  enableDefaultDeny?: { ingress?: boolean; egress?: boolean };
};

export type PolicyInventory = {
  namespaces: Array<{ name: string; labels: Record<string, string> }>;
  pods: Array<{
    namespace: string; name: string; labels: Record<string, string>; phase?: string; hostNetwork?: boolean;
    /** Node the pod is scheduled on (node pool via nodes[].pool) */
    nodeName?: string;
    serviceAccountName?: string;
    /** Workload identity webhook traces: AZURE_FEDERATED_TOKEN_FILE present (name only), AZURE_CLIENT_ID / AZURE_TENANT_ID GUIDs */
    wi?: { tokenFile: boolean; clientId?: string; tenantId?: string };
  }>;
  workloads: InvWorkload[];
  networkPolicies: Array<{
    namespace: string;
    name: string;
    podSelector: LabelSelector;
    policyTypes?: string[];
    ingress?: unknown[];
    egress?: unknown[];
  }>;
  /** namespace undefined → CiliumClusterwideNetworkPolicy */
  ciliumPolicies: Array<{ namespace?: string; name: string; specs: InvCiliumSpec[] }>;
  roles: Array<{
    kind: "Role" | "ClusterRole";
    namespace?: string;
    name: string;
    labels: Record<string, string>;
    rules: InvRbacRule[];
    aggregated: boolean;
  }>;
  bindings: Array<{
    kind: "RoleBinding" | "ClusterRoleBinding";
    namespace?: string;
    name: string;
    labels: Record<string, string>;
    roleRef: { kind: string; name: string };
    subjects: RbacSubject[];
  }>;
  hpas: Array<{
    namespace: string;
    name: string;
    target: { kind: string; name: string };
    minReplicas: number;
    maxReplicas: number;
    currentReplicas?: number;
    metrics: Array<{ type: string; name: string; target?: string }>;
  }>;
  vpas: Array<{
    namespace: string;
    name: string;
    target: { kind: string; name: string };
    updateMode?: string;
    controlledResources?: string[];
    recommendations: Record<string, Record<string, string>>;
  }>;
  pdbs: Array<{
    namespace: string;
    name: string;
    selector: LabelSelector;
    minAvailable?: string;
    maxUnavailable?: string;
    disruptionsAllowed?: number;
  }>;
  resourceQuotas: Array<{ namespace: string; name: string }>;
  limitRanges: Array<{ namespace: string; name: string }>;
  capabilities: { vpaInstalled: boolean; ciliumInstalled: boolean; unavailable: string[] };
  /** Exposure and platform inventory used by policy insights only */
  services?: InvService[];
  routes?: InvRoute[];
  nodes?: InvNode[];
  /** Argo CD Applications (where each workload's manifests live); absent = not collected */
  gitops?: { state: "ok" | "notInstalled" | "forbidden" | "failed"; apps: InvGitopsApp[] };
};

// ── References ──

const REF = {
  psa: "https://kubernetes.io/docs/concepts/security/pod-security-admission/",
  pss: "https://kubernetes.io/docs/concepts/security/pod-security-standards/",
  netpolDefault: "https://kubernetes.io/docs/concepts/services-networking/network-policies/#default-policies",
  netpol: "https://kubernetes.io/docs/concepts/services-networking/network-policies/",
  rbac: "https://kubernetes.io/docs/concepts/security/rbac-good-practices/",
  rbacEscalation: "https://kubernetes.io/docs/concepts/security/rbac-good-practices/#privilege-escalation-risks",
  aksLocalAccounts: "https://learn.microsoft.com/azure/aks/manage-local-accounts-managed-azure-ad",
  saAutomount: "https://kubernetes.io/docs/tasks/configure-pod-container/configure-service-account/#opt-out-of-api-credential-automounting",
  vpa: "https://kubernetes.io/docs/concepts/workloads/autoscaling/vertical-pod-autoscale/",
  aksVpa: "https://learn.microsoft.com/azure/aks/vertical-pod-autoscaler",
  hpa: "https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/",
  pdb: "https://kubernetes.io/docs/concepts/workloads/pods/disruptions/",
  resources: "https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/",
  quota: "https://kubernetes.io/docs/concepts/policy/resource-quotas/",
  limitRange: "https://kubernetes.io/docs/concepts/policy/limit-range/",
} as const;

// ── System object detection ──

const SYSTEM_NAMESPACES = new Set([
  "kube-system",
  "kube-public",
  "kube-node-lease",
  "gatekeeper-system",
  "calico-system",
  "tigera-operator",
  "app-routing-system",
  "aks-command",
  "azure-alb-system",
]);

export function isSystemNamespace(ns: string | undefined): boolean {
  return !!ns && (SYSTEM_NAMESPACES.has(ns) || ns.startsWith("kube-"));
}

function isSystemRbacObject(name: string, labels: Record<string, string>, namespace?: string): boolean {
  return (
    name.startsWith("system:") ||
    labels["kubernetes.io/bootstrapping"] === "rbac-defaults" ||
    "addonmanager.kubernetes.io/mode" in labels ||
    "kubernetes.azure.com/managedby" in labels ||
    labels["app.kubernetes.io/actually-managed-by"] === "Eno" || // AKS add-on deployer

    isSystemNamespace(namespace)
  );
}

// ── Label selector evaluation ──

/** Cilium label keys may carry a source prefix ("k8s:app"); the pod namespace is a pseudo-label. */
function labelValue(labels: Record<string, string>, namespace: string, key: string): string | undefined {
  const k = key.replace(/^(k8s|any):/, "");
  if (k === "io.kubernetes.pod.namespace") return namespace;
  return labels[k];
}

export function selectorIsEmpty(sel: LabelSelector | undefined): boolean {
  return !sel || (Object.keys(sel.matchLabels ?? {}).length === 0 && (sel.matchExpressions ?? []).length === 0);
}

export function selectorMatches(sel: LabelSelector | undefined, labels: Record<string, string>, namespace = ""): boolean {
  if (!sel) return true;
  for (const [k, v] of Object.entries(sel.matchLabels ?? {})) {
    if (labelValue(labels, namespace, k) !== v) return false;
  }
  for (const expr of sel.matchExpressions ?? []) {
    const val = labelValue(labels, namespace, expr.key);
    const values = expr.values ?? [];
    switch (expr.operator) {
      case "In":
        if (val === undefined || !values.includes(val)) return false;
        break;
      case "NotIn":
        if (val !== undefined && values.includes(val)) return false;
        break;
      case "Exists":
        if (val === undefined) return false;
        break;
      case "DoesNotExist":
        if (val !== undefined) return false;
        break;
      default:
        return false; // unknown operator → match nothing (safe for coverage)
    }
  }
  return true;
}

export function formatSelector(sel: LabelSelector | undefined): string {
  if (selectorIsEmpty(sel)) return L("{} (모든 파드)", "{} (all pods)");
  const parts = Object.entries(sel!.matchLabels ?? {}).map(([k, v]) => `${k}=${v}`);
  for (const e of sel!.matchExpressions ?? []) {
    parts.push(e.values?.length ? `${e.key} ${e.operator} (${e.values.join(",")})` : `${e.key} ${e.operator}`);
  }
  return parts.join(", ");
}

// ── Findings builder ──

const SEVERITY_WEIGHT: Record<PolicySeverity, number> = { high: 10, medium: 4, low: 1, info: 0 };
const CATEGORIES: PolicyCategory[] = ["psa", "networkPolicy", "rbac", "autoscaling", "resources"];

function emptyCounts(): Record<PolicySeverity, number> {
  return { high: 0, medium: 0, low: 0, info: 0 };
}

class FindingList {
  readonly items: PolicyFinding[] = [];
  private readonly seen = new Set<string>();

  add(f: Omit<PolicyFinding, "id">): void {
    const res = f.resource ? `${f.resource.kind}/${f.resource.namespace ?? ""}/${f.resource.name}` : f.namespace ?? "cluster";
    let id = `${f.ruleId}:${res}`;
    for (let n = 2; this.seen.has(id); n++) id = `${f.ruleId}:${res}#${n}`;
    this.seen.add(id);
    this.items.push({ ...f, id });
  }
}

// ── RBAC rule analysis ──

type RbacRisk = { code: string; label: string; severity: PolicySeverity };

function has(list: string[] | undefined, ...values: string[]): boolean {
  return !!list && (list.includes("*") || values.some((v) => list.includes(v)));
}

/** Rule grants any of `verbs` on any of `resources` (wildcards honoured; resourceNames-scoped rules skipped). */
function grants(rule: InvRbacRule, resources: string[], verbs: string[]): boolean {
  if (rule.resourceNames?.length) return false;
  return has(rule.resources, ...resources) && has(rule.verbs, ...verbs);
}

export function analyzeRbacRules(rules: InvRbacRule[]): RbacRisk[] {
  const risks = new Map<string, RbacRisk>();
  const add = (r: RbacRisk) => {
    if (!risks.has(r.code)) risks.set(r.code, r);
  };

  for (const rule of rules) {
    if (!rule.resources?.length) continue; // nonResourceURLs only
    const allVerbs = rule.verbs.includes("*");
    const allResources = rule.resources.includes("*");
    if (allVerbs && allResources && (rule.apiGroups ?? []).includes("*")) {
      add({ code: "wildcard-all", label: L("모든 API 그룹·리소스에 모든 권한 (*/*/*)", "All permissions on every API group and resource (*/*/*)"), severity: "high" });
    } else if (allVerbs && allResources) {
      add({ code: "wildcard-all", label: L("API 그룹 내 모든 리소스에 모든 권한 (*/*)", "All permissions on every resource in an API group (*/*)"), severity: "high" });
    } else if (allVerbs) {
      add({ code: "wildcard-verbs", label: `verbs: * (${rule.resources.join(", ")})`, severity: "medium" });
    } else if (allResources) {
      add({ code: "wildcard-resources", label: `resources: * (${rule.verbs.join(", ")})`, severity: "medium" });
    }

    if (grants(rule, ["roles", "clusterroles"], ["escalate"])) add({ code: "escalate", label: L("escalate (권한 상승)", "escalate (privilege escalation)"), severity: "high" });
    if (grants(rule, ["roles", "clusterroles"], ["bind"])) add({ code: "bind", label: L("bind (임의 역할 바인딩)", "bind (bind any role)"), severity: "high" });
    if (grants(rule, ["users", "groups", "serviceaccounts", "uids", "userextras/scopes"], ["impersonate"])) {
      add({ code: "impersonate", label: L("impersonate (다른 사용자 가장)", "impersonate (act as another user)"), severity: "high" });
    }
    if (grants(rule, ["validatingwebhookconfigurations", "mutatingwebhookconfigurations"], ["create", "update", "patch", "delete"])) {
      add({ code: "webhook", label: L("Admission webhook 구성 변경", "Admission webhook configuration changes"), severity: "high" });
    }
    if (grants(rule, ["nodes/proxy"], ["get", "create"])) add({ code: "nodes-proxy", label: L("nodes/proxy (kubelet API 직접 접근)", "nodes/proxy (direct kubelet API access)"), severity: "high" });
    if (grants(rule, ["secrets"], ["get", "list", "watch"])) add({ code: "secrets-read", label: L("Secret 조회 (get/list/watch)", "Secret read (get/list/watch)"), severity: "medium" });
    if (grants(rule, ["pods/exec", "pods/attach"], ["create", "get"])) add({ code: "pod-exec", label: L("pods/exec·attach (컨테이너 셸 접근)", "pods/exec·attach (container shell access)"), severity: "medium" });
    if (grants(rule, ["serviceaccounts/token"], ["create"])) add({ code: "sa-token", label: L("serviceaccounts/token 발급", "serviceaccounts/token creation"), severity: "medium" });
    if (grants(rule, ["certificatesigningrequests/approval"], ["update", "patch"])) add({ code: "csr-approve", label: L("CSR 승인 (클라이언트 인증서 발급)", "CSR approval (issues client certificates)"), severity: "medium" });
    if (grants(rule, ["persistentvolumes"], ["create"])) add({ code: "pv-create", label: L("PersistentVolume 생성 (hostPath 노출 가능)", "PersistentVolume creation (can expose hostPath)"), severity: "medium" });
    if (grants(rule, ["namespaces"], ["patch", "update"])) add({ code: "ns-modify", label: L("Namespace 수정 (PSA 라벨 변경 가능)", "Namespace changes (can change PSA labels)"), severity: "medium" });
  }
  return [...risks.values()];
}

// ── Main analysis ──

const PSA_LEVELS = new Set<PsaLevel>(["privileged", "baseline", "restricted"]);
const HPA_RESOURCE_METRICS = new Set(["cpu", "memory"]);

function asPsaLevel(v: string | undefined): PsaLevel | undefined {
  return v && PSA_LEVELS.has(v as PsaLevel) ? (v as PsaLevel) : undefined;
}

function normalizeVpaMode(mode: string | undefined): VpaUpdateMode {
  const known: VpaUpdateMode[] = ["Off", "Initial", "Recreate", "InPlaceOrRecreate", "InPlace", "Auto"];
  return known.find((m) => m === mode) ?? "Auto"; // unset → API default "Auto"
}

/** Quantity "0", "0%", or the full replica count → no voluntary disruption allowed. */
function pdbBlocksEviction(pdb: PolicyInventory["pdbs"][number], replicas: number): boolean {
  if (pdb.maxUnavailable !== undefined) return pdb.maxUnavailable === "0" || pdb.maxUnavailable === "0%";
  if (pdb.minAvailable !== undefined) {
    if (pdb.minAvailable === "100%") return true;
    const n = Number(pdb.minAvailable);
    return Number.isFinite(n) && replicas > 0 && n >= replicas;
  }
  return false;
}

export function analyzePolicies(inv: PolicyInventory, clusterId: string, now = new Date()): KubernetesPolicyResponse {
  const findings = new FindingList();
  const workloadKey = (kind: string, ns: string, name: string) => `${kind}/${ns}/${name}`;
  const workloadByKey = new Map(inv.workloads.map((w) => [workloadKey(w.kind, w.namespace, w.name), w]));

  // ── Network policies (Kubernetes + Cilium) ──
  const eligiblePods = inv.pods.filter((p) => !p.hostNetwork && p.phase !== "Succeeded" && p.phase !== "Failed");
  const ingressIsolated = new Set<string>();
  const egressIsolated = new Set<string>();
  const podKey = (p: { namespace: string; name: string }) => `${p.namespace}/${p.name}`;
  const networkPolicies: NetworkPolicyInfo[] = [];

  for (const np of inv.networkPolicies) {
    const types = np.policyTypes?.length
      ? np.policyTypes
      : ["Ingress", ...(np.egress?.length ? ["Egress"] : [])];
    const isolatesIngress = types.includes("Ingress");
    const isolatesEgress = types.includes("Egress");
    const selected = eligiblePods.filter((p) => p.namespace === np.namespace && selectorMatches(np.podSelector, p.labels));
    for (const p of selected) {
      if (isolatesIngress) ingressIsolated.add(podKey(p));
      if (isolatesEgress) egressIsolated.add(podKey(p));
    }
    const ingress = np.ingress ?? [];
    const egress = np.egress ?? [];
    const isEmptyRule = (r: unknown) => !!r && typeof r === "object" && Object.keys(r as object).length === 0;
    networkPolicies.push({
      source: "kubernetes",
      name: np.name,
      namespace: np.namespace,
      podSelector: formatSelector(np.podSelector),
      selectedPods: selected.length,
      policyTypes: types.filter((t): t is "Ingress" | "Egress" => t === "Ingress" || t === "Egress"),
      ingressRules: ingress.length,
      egressRules: egress.length,
      allowsAllIngress: isolatesIngress && ingress.some(isEmptyRule),
      allowsAllEgress: isolatesEgress && egress.some(isEmptyRule),
      defaultDenyIngress: isolatesIngress && selectorIsEmpty(np.podSelector) && ingress.length === 0,
      defaultDenyEgress: isolatesEgress && selectorIsEmpty(np.podSelector) && egress.length === 0,
    });
  }

  for (const cp of inv.ciliumPolicies) {
    for (const [i, spec] of cp.specs.entries()) {
      if (!spec.endpointSelector) continue; // host (nodeSelector) policies don't select pods
      // enableDefaultDeny: false = audit / observe-only — rules present, nothing isolated (blocked)
      const isolatesIngress = cnpIsolates(spec, "ingress");
      const isolatesEgress = cnpIsolates(spec, "egress");
      const nonEnforcing = [
        ...(spec.ingress !== undefined && !isolatesIngress ? ["Ingress" as const] : []),
        ...(spec.egress !== undefined && !isolatesEgress ? ["Egress" as const] : []),
      ];
      const selected = eligiblePods.filter(
        (p) => (cp.namespace === undefined || p.namespace === cp.namespace) && selectorMatches(spec.endpointSelector, p.labels, p.namespace),
      );
      for (const p of selected) {
        if (isolatesIngress) ingressIsolated.add(podKey(p));
        if (isolatesEgress) egressIsolated.add(podKey(p));
      }
      const allowsAll = (rules: unknown[] | undefined, entityKey: string) =>
        (rules ?? []).some((r) => {
          if (!r || typeof r !== "object") return false;
          if (Object.keys(r).length === 0) return true;
          const entities = (r as Record<string, unknown>)[entityKey];
          return Array.isArray(entities) && entities.includes("all");
        });
      networkPolicies.push({
        source: cp.namespace === undefined ? "cilium-clusterwide" : "cilium",
        name: cp.specs.length > 1 ? `${cp.name}[${i}]` : cp.name,
        namespace: cp.namespace ?? "",
        podSelector: formatSelector(spec.endpointSelector),
        selectedPods: selected.length,
        policyTypes: [...(isolatesIngress ? ["Ingress" as const] : []), ...(isolatesEgress ? ["Egress" as const] : [])],
        ingressRules: (spec.ingress?.length ?? 0) + (spec.ingressDeny?.length ?? 0),
        egressRules: (spec.egress?.length ?? 0) + (spec.egressDeny?.length ?? 0),
        allowsAllIngress: allowsAll(spec.ingress, "fromEntities"),
        allowsAllEgress: allowsAll(spec.egress, "toEntities"),
        defaultDenyIngress: isolatesIngress && selectorIsEmpty(spec.endpointSelector) && (spec.ingress?.length ?? 0) === 0,
        defaultDenyEgress: isolatesEgress && selectorIsEmpty(spec.endpointSelector) && (spec.egress?.length ?? 0) === 0,
        ...(nonEnforcing.length ? { nonEnforcing } : {}),
      });
    }
  }

  for (const np of networkPolicies) {
    const system = isSystemNamespace(np.namespace);
    const resource: PolicyResourceRef = {
      kind: np.source === "kubernetes" ? "NetworkPolicy" : np.source === "cilium" ? "CiliumNetworkPolicy" : "CiliumClusterwideNetworkPolicy",
      name: np.name,
      namespace: np.namespace || undefined,
    };
    if (np.allowsAllIngress) {
      findings.add({
        ruleId: "NET-004", category: "networkPolicy", severity: "medium", system, namespace: np.namespace || undefined, resource,
        title: L("모든 소스의 수신을 허용하는 규칙", "Rule allows ingress from any source"),
        detail: L(`${resource.kind} '${np.name}'에 빈 ingress 규칙({}) 또는 fromEntities: all이 있어 선택된 파드(${np.selectedPods}개)의 수신 격리가 무효화됩니다.`, `${resource.kind} '${np.name}' has an empty ingress rule ({}) or fromEntities: all, which voids ingress isolation for the ${np.selectedPods} selected pods.`),
        recommendation: L("허용할 출처를 podSelector / namespaceSelector / ipBlock으로 명시하세요.", "Name the allowed sources with podSelector / namespaceSelector / ipBlock."),
        reference: REF.netpol,
      });
    }
    if (np.allowsAllEgress) {
      findings.add({
        ruleId: "NET-004", category: "networkPolicy", severity: "low", system, namespace: np.namespace || undefined, resource,
        title: L("모든 목적지로의 송신을 허용하는 규칙", "Rule allows egress to any destination"),
        detail: L(`${resource.kind} '${np.name}'에 빈 egress 규칙({}) 또는 toEntities: all이 있습니다.`, `${resource.kind} '${np.name}' has an empty egress rule ({}) or toEntities: all.`),
        recommendation: L("필요한 목적지(DNS, 의존 서비스, 외부 엔드포인트)만 허용하세요.", "Allow only the destinations you need (DNS, dependent services, external endpoints)."),
        reference: REF.netpol,
      });
    }
    if (np.selectedPods === 0 && np.source !== "cilium-clusterwide") {
      findings.add({
        ruleId: "NET-005", category: "networkPolicy", severity: "info", system, namespace: np.namespace || undefined, resource,
        title: L("파드를 선택하지 않는 정책", "Policy selects no pods"),
        detail: L(`셀렉터 '${np.podSelector}'와 일치하는 실행 중 파드가 없어 현재 효과가 없습니다.`, `No running pod matches selector '${np.podSelector}', so the policy has no effect today.`),
        recommendation: L("라벨 오타 또는 삭제된 워크로드용 정책인지 확인하세요.", "Check for a label typo or a policy for a deleted workload."),
        reference: REF.netpol,
      });
    }
  }

  // ── Autoscaling objects ──
  const vpaByTarget = new Map<string, VpaInfo>();
  const vpas: VpaInfo[] = inv.vpas.map((v) => {
    const info: VpaInfo = {
      namespace: v.namespace,
      name: v.name,
      target: { kind: v.target.kind, name: v.target.name, namespace: v.namespace },
      updateMode: normalizeVpaMode(v.updateMode),
      controlledResources: v.controlledResources?.length ? v.controlledResources : ["cpu", "memory"],
      recommendations: v.recommendations,
      targetFound: workloadByKey.has(workloadKey(v.target.kind, v.namespace, v.target.name)),
    };
    vpaByTarget.set(workloadKey(v.target.kind, v.namespace, v.target.name), info);
    return info;
  });

  const hpaByTarget = new Map<string, HpaInfo>();
  const hpas: HpaInfo[] = inv.hpas.map((h) => {
    const resourceMetrics = h.metrics
      .filter((m) => (m.type === "Resource" || m.type === "ContainerResource") && HPA_RESOURCE_METRICS.has(m.name))
      .map((m) => m.name);
    const info: HpaInfo = {
      namespace: h.namespace,
      name: h.name,
      target: { kind: h.target.kind, name: h.target.name, namespace: h.namespace },
      minReplicas: h.minReplicas,
      maxReplicas: h.maxReplicas,
      currentReplicas: h.currentReplicas,
      metrics: h.metrics.map((m) => (m.target ? `${m.name} ${m.target}` : `${m.type.toLowerCase()}/${m.name}`)),
      resourceMetrics: [...new Set(resourceMetrics)],
      targetFound: workloadByKey.has(workloadKey(h.target.kind, h.namespace, h.target.name)),
    };
    hpaByTarget.set(workloadKey(h.target.kind, h.namespace, h.target.name), info);
    return info;
  });

  const pdbs: PdbInfo[] = inv.pdbs.map((p) => {
    const matched = inv.workloads.filter((w) => w.namespace === p.namespace && !selectorIsEmpty(p.selector) && selectorMatches(p.selector, w.podLabels));
    return {
      namespace: p.namespace,
      name: p.name,
      minAvailable: p.minAvailable,
      maxUnavailable: p.maxUnavailable,
      matchedWorkloads: matched.map((w) => `${w.kind}/${w.name}`),
      disruptionsAllowed: p.disruptionsAllowed,
    };
  });

  if (!inv.capabilities.vpaInstalled) {
    findings.add({
      ruleId: "VPA-001", category: "autoscaling", severity: "info", system: false,
      title: L("Vertical Pod Autoscaler 미설치", "Vertical Pod Autoscaler not installed"),
      detail: L("autoscaling.k8s.io/v1 VerticalPodAutoscaler CRD가 없어 리소스 요청값 추천을 받을 수 없습니다.", "The autoscaling.k8s.io/v1 VerticalPodAutoscaler CRD is missing, so no request recommendations are available."),
      recommendation: L("AKS Standard: `az aks update --enable-vpa`로 VPA를 활성화한 뒤 updateMode \"Off\"(추천 전용)로 시작하세요.", "AKS Standard: enable VPA with `az aks update --enable-vpa`, then start with updateMode \"Off\" (recommendations only)."),
      reference: REF.aksVpa,
    });
  }

  for (const v of vpas) {
    const system = isSystemNamespace(v.namespace);
    const resource: PolicyResourceRef = { kind: "VerticalPodAutoscaler", name: v.name, namespace: v.namespace };
    if (!v.targetFound) {
      findings.add({
        ruleId: "VPA-004", category: "autoscaling", severity: "medium", system, namespace: v.namespace, resource,
        title: L("대상 워크로드가 없는 VPA", "VPA with no target workload"),
        detail: L(`targetRef ${v.target.kind}/${v.target.name}을(를) 찾을 수 없습니다.`, `targetRef ${v.target.kind}/${v.target.name} not found.`),
        recommendation: L("targetRef를 수정하거나 사용하지 않는 VPA를 삭제하세요.", "Fix targetRef or delete the unused VPA."),
        reference: REF.vpa,
      });
    }
    if (v.updateMode === "Auto") {
      findings.add({
        ruleId: "VPA-003", category: "autoscaling", severity: "low", system, namespace: v.namespace, resource,
        title: L("deprecated된 updateMode \"Auto\"", "Deprecated updateMode \"Auto\""),
        detail: L("Auto는 VPA 1.4.0부터 deprecated이며 Recreate의 별칭입니다 (updateMode 미지정 시 기본값).", "Auto is deprecated since VPA 1.4.0 and is an alias of Recreate (the default when updateMode is not set)."),
        recommendation: L("updateMode를 \"Recreate\" 또는 \"InPlaceOrRecreate\"(AKS 1.34+)로 명시하세요.", "Set updateMode explicitly to \"Recreate\" or \"InPlaceOrRecreate\" (AKS 1.34+)."),
        reference: REF.aksVpa,
      });
    }
    const hpa = hpaByTarget.get(workloadKey(v.target.kind, v.namespace, v.target.name));
    const overlap = hpa?.resourceMetrics.filter((m) => v.controlledResources.includes(m)) ?? [];
    if (hpa && v.updateMode !== "Off" && overlap.length > 0) {
      findings.add({
        ruleId: "VPA-002", category: "autoscaling", severity: v.updateMode === "Initial" ? "medium" : "high", system, namespace: v.namespace, resource,
        title: L("VPA와 HPA가 같은 리소스 지표로 충돌", "VPA and HPA conflict on the same resource metric"),
        detail: L(`${v.target.kind}/${v.target.name}에 VPA(${v.updateMode})와 HPA '${hpa.name}'(${overlap.join(", ")})가 함께 적용되어 서로의 조정을 상쇄합니다.`, `${v.target.kind}/${v.target.name} has VPA (${v.updateMode}) and HPA '${hpa.name}' (${overlap.join(", ")}) together, so they cancel each other's adjustments.`),
        recommendation: L("VPA를 updateMode \"Off\"로 두거나, HPA를 사용자 정의/외부 지표로 전환하세요.", "Keep VPA at updateMode \"Off\", or move HPA to custom/external metrics."),
        reference: REF.aksVpa,
      });
    }
  }

  for (const h of hpas) {
    const system = isSystemNamespace(h.namespace);
    const resource: PolicyResourceRef = { kind: "HorizontalPodAutoscaler", name: h.name, namespace: h.namespace };
    const target = workloadByKey.get(workloadKey(h.target.kind, h.namespace, h.target.name));
    if (!target) {
      findings.add({
        ruleId: "HPA-002", category: "autoscaling", severity: "medium", system, namespace: h.namespace, resource,
        title: L("대상 워크로드가 없는 HPA", "HPA with no target workload"),
        detail: L(`scaleTargetRef ${h.target.kind}/${h.target.name}을(를) 찾을 수 없습니다.`, `scaleTargetRef ${h.target.kind}/${h.target.name} not found.`),
        recommendation: L("scaleTargetRef를 수정하거나 사용하지 않는 HPA를 삭제하세요.", "Fix scaleTargetRef or delete the unused HPA."),
        reference: REF.hpa,
      });
      continue;
    }
    const missing = h.resourceMetrics.filter((m) => target.containers.some((c) => !c.requests?.[m]));
    if (missing.length > 0) {
      findings.add({
        ruleId: "HPA-001", category: "autoscaling", severity: "medium", system, namespace: h.namespace, resource,
        title: L("HPA 지표에 필요한 requests 누락", "Requests missing for HPA metrics"),
        detail: L(`${h.target.kind}/${h.target.name}의 일부 컨테이너에 ${missing.join(", ")} requests가 없어 사용률 기반 스케일링이 계산되지 않습니다.`, `Some containers of ${h.target.kind}/${h.target.name} have no ${missing.join(", ")} requests, so utilization-based scaling cannot be computed.`),
        recommendation: L("대상 컨테이너 모두에 해당 리소스 requests를 설정하세요.", "Set requests for that resource on every target container."),
        reference: REF.hpa,
      });
    }
  }

  for (const p of inv.pdbs) {
    const info = pdbs.find((x) => x.namespace === p.namespace && x.name === p.name)!;
    const system = isSystemNamespace(p.namespace);
    const resource: PolicyResourceRef = { kind: "PodDisruptionBudget", name: p.name, namespace: p.namespace };
    if (info.matchedWorkloads.length === 0) {
      findings.add({
        ruleId: "PDB-003", category: "autoscaling", severity: "info", system, namespace: p.namespace, resource,
        title: L("워크로드를 선택하지 않는 PDB", "PDB selects no workload"),
        detail: L(`셀렉터 '${formatSelector(p.selector)}'와 일치하는 워크로드가 없습니다.`, `No workload matches selector '${formatSelector(p.selector)}'.`),
        recommendation: L("셀렉터를 확인하거나 사용하지 않는 PDB를 삭제하세요.", "Check the selector or delete the unused PDB."),
        reference: REF.pdb,
      });
      continue;
    }
    const replicas = inv.workloads
      .filter((w) => w.namespace === p.namespace && selectorMatches(p.selector, w.podLabels))
      .reduce((n, w) => n + w.replicas, 0);
    if (pdbBlocksEviction(p, replicas)) {
      findings.add({
        ruleId: "PDB-002", category: "autoscaling", severity: "medium", system, namespace: p.namespace, resource,
        title: L("자발적 중단을 허용하지 않는 PDB", "PDB allows no voluntary disruption"),
        detail: L(`minAvailable=${p.minAvailable ?? "-"}, maxUnavailable=${p.maxUnavailable ?? "-"} (대상 replicas ${replicas}) — 노드 드레인/업그레이드가 멈춥니다.`, `minAvailable=${p.minAvailable ?? "-"}, maxUnavailable=${p.maxUnavailable ?? "-"} (target replicas ${replicas}) — node drains and upgrades will block.`),
        recommendation: L("최소 1개 파드의 중단을 허용하도록 maxUnavailable: 1 등으로 조정하세요.", "Allow at least one pod to be disrupted, e.g. maxUnavailable: 1."),
        reference: REF.pdb,
      });
    }
  }

  // ── Workloads (requests/limits, service account, PDB coverage) ──
  const workloads: WorkloadPolicyCoverage[] = inv.workloads.map((w) => {
    const key = workloadKey(w.kind, w.namespace, w.name);
    const vpa = vpaByTarget.get(key);
    const hpa = hpaByTarget.get(key);
    const pdb = inv.pdbs.find((p) => p.namespace === w.namespace && !selectorIsEmpty(p.selector) && selectorMatches(p.selector, w.podLabels));
    const serviceAccount = w.serviceAccountName || "default";
    return {
      namespace: w.namespace,
      kind: w.kind,
      name: w.name,
      replicas: w.replicas,
      system: isSystemNamespace(w.namespace),
      serviceAccount,
      automountToken: w.automountServiceAccountToken !== false,
      containers: w.containers.length,
      containersWithoutRequests: w.containers.filter((c) => !c.requests?.cpu || !c.requests?.memory).length,
      containersWithoutMemoryLimit: w.containers.filter((c) => !c.limits?.memory).length,
      ...(vpa ? { vpa: { name: vpa.name, updateMode: vpa.updateMode } } : {}),
      ...(hpa ? { hpa: { name: hpa.name, resourceMetrics: hpa.resourceMetrics } } : {}),
      ...(pdb ? { pdb: pdb.name } : {}),
    };
  });

  for (const w of workloads) {
    const resource: PolicyResourceRef = { kind: w.kind, name: w.name, namespace: w.namespace };
    const base = { system: w.system, namespace: w.namespace, resource };
    if (w.containersWithoutRequests > 0) {
      findings.add({
        ...base, ruleId: "RES-001", category: "resources", severity: "medium",
        title: L("CPU/메모리 requests 누락", "CPU/memory requests missing"),
        detail: L(`${w.containers}개 컨테이너 중 ${w.containersWithoutRequests}개에 cpu 또는 memory requests가 없어 스케줄링과 QoS(BestEffort)가 불안정합니다.`, `${w.containersWithoutRequests} of ${w.containers} containers have no cpu or memory requests, making scheduling and QoS (BestEffort) unstable.`),
        recommendation: L("모든 컨테이너에 cpu·memory requests를 설정하세요 (VPA \"Off\" 추천값 활용).", "Set cpu and memory requests on every container (use VPA \"Off\" recommendations)."),
        reference: REF.resources,
      });
    }
    if (w.containersWithoutMemoryLimit > 0) {
      findings.add({
        ...base, ruleId: "RES-002", category: "resources", severity: "low",
        title: L("메모리 limits 누락", "Memory limits missing"),
        detail: L(`${w.containersWithoutMemoryLimit}개 컨테이너에 memory limit이 없어 노드 메모리 고갈 시 다른 파드에 영향을 줄 수 있습니다.`, `${w.containersWithoutMemoryLimit} containers have no memory limit and can affect other pods when node memory runs out.`),
        recommendation: L("memory limits를 설정하거나 네임스페이스 LimitRange로 기본값을 지정하세요.", "Set memory limits, or defaults with a namespace LimitRange."),
        reference: REF.resources,
      });
    }
    if (w.serviceAccount === "default" && w.automountToken) {
      findings.add({
        ...base, ruleId: "SA-001", category: "rbac", severity: "low",
        title: L("default ServiceAccount 토큰 자동 마운트", "default ServiceAccount token auto-mounted"),
        detail: L("전용 ServiceAccount 없이 default SA 토큰이 파드에 마운트됩니다.", "The default SA token is mounted into pods without a dedicated ServiceAccount."),
        recommendation: L("API 접근이 필요 없으면 automountServiceAccountToken: false, 필요하면 전용 ServiceAccount를 사용하세요.", "Use automountServiceAccountToken: false when no API access is needed, otherwise a dedicated ServiceAccount."),
        reference: REF.saAutomount,
      });
    }
    if ((w.kind === "Deployment" || w.kind === "StatefulSet") && w.replicas > 1 && !w.pdb) {
      findings.add({
        ...base, ruleId: "PDB-001", category: "autoscaling", severity: "low",
        title: L("다중 레플리카 워크로드에 PDB 없음", "No PDB on a multi-replica workload"),
        detail: L(`replicas ${w.replicas}개 워크로드가 노드 드레인 시 동시에 중단될 수 있습니다.`, `A workload with ${w.replicas} replicas can be stopped all at once during a node drain.`),
        recommendation: L("maxUnavailable: 1 등의 PodDisruptionBudget을 추가하세요.", "Add a PodDisruptionBudget, e.g. maxUnavailable: 1."),
        reference: REF.pdb,
      });
    }
  }

  // ── RBAC ──
  const roleKey = (kind: string, ns: string | undefined, name: string) => `${kind}/${kind === "ClusterRole" ? "" : ns ?? ""}/${name}`;
  const roleRisks = new Map<string, RbacRisk[]>();
  const bindingCounts = new Map<string, number>();
  for (const r of inv.roles) roleRisks.set(roleKey(r.kind, r.namespace, r.name), analyzeRbacRules(r.rules));
  for (const b of inv.bindings) {
    const k = roleKey(b.roleRef.kind, b.roleRef.kind === "ClusterRole" ? undefined : b.namespace, b.roleRef.name);
    bindingCounts.set(k, (bindingCounts.get(k) ?? 0) + 1);
  }

  const roles: RbacRoleInfo[] = inv.roles.map((r) => {
    const k = roleKey(r.kind, r.namespace, r.name);
    return {
      kind: r.kind,
      name: r.name,
      namespace: r.namespace,
      system: isSystemRbacObject(r.name, r.labels, r.namespace),
      ruleCount: r.rules.length,
      risks: (roleRisks.get(k) ?? []).map((x) => x.label),
      bindingCount: bindingCounts.get(k) ?? 0,
      aggregated: r.aggregated,
    };
  });

  const bindings: RbacBindingInfo[] = [];
  for (const b of inv.bindings) {
    const k = roleKey(b.roleRef.kind, b.roleRef.kind === "ClusterRole" ? undefined : b.namespace, b.roleRef.name);
    const roleFound = roleRisks.has(k);
    const risks = roleRisks.get(k) ?? [];
    // AKS local-account admin binding is AKS-managed but actionable (disable local accounts) — always surface it
    const aksLocalAdmin = b.name === "aks-cluster-admin-binding";
    const system = !aksLocalAdmin && isSystemRbacObject(b.name, b.labels, b.namespace);
    const clusterScope = b.kind === "ClusterRoleBinding";
    const scopeText = clusterScope ? L("클러스터 전체", "whole cluster") : L(`네임스페이스 '${b.namespace}'`, `namespace '${b.namespace}'`);
    const subjects = b.subjects.map((s) => `${s.kind}:${s.namespace ? `${s.namespace}/` : ""}${s.name}`).join(", ") || L("(없음)", "(none)");
    const resource: PolicyResourceRef = { kind: b.kind, name: b.name, namespace: b.namespace };
    const base = { category: "rbac" as const, system, namespace: b.namespace, resource };
    const bindingRisks: string[] = [];

    if (b.roleRef.kind === "ClusterRole" && b.roleRef.name === "cluster-admin") {
      const onlyMasters = b.subjects.every((s) => s.kind === "Group" && s.name === "system:masters");
      if (!onlyMasters) {
        bindingRisks.push("cluster-admin");
        findings.add({
          ...base, ruleId: "RBAC-001", severity: clusterScope ? "high" : "medium",
          title: L(`cluster-admin 권한 부여 (${scopeText})`, `cluster-admin granted (${scopeText})`),
          detail: L(`${subjects}에게 cluster-admin이 바인딩되어 있습니다.${aksLocalAdmin ? " AKS 로컬 계정(clusterAdmin/clusterUser) 바인딩으로, 로컬 kubeconfig를 가진 누구나 클러스터 관리자 권한을 가집니다." : ""}`, `cluster-admin is bound to ${subjects}.${aksLocalAdmin ? " This is the AKS local account binding (clusterAdmin/clusterUser): anyone with the local kubeconfig is a cluster administrator." : ""}`),
          recommendation: aksLocalAdmin
            ? L("Microsoft Entra ID 통합 후 로컬 계정을 비활성화(--disable-local-accounts)하고 Azure RBAC/그룹 단위로 권한을 부여하세요.", "Integrate Microsoft Entra ID, disable local accounts (--disable-local-accounts) and grant access with Azure RBAC / groups.")
            : L("필요한 리소스·동사만 가진 Role/ClusterRole로 대체하고 RoleBinding으로 네임스페이스 범위로 제한하세요.", "Replace it with a Role/ClusterRole that has only the needed resources and verbs, and limit it to a namespace with a RoleBinding."),
          reference: aksLocalAdmin ? REF.aksLocalAccounts : REF.rbac,
        });
      }
    } else if (risks.length > 0) {
      bindingRisks.push(...risks.map((r) => r.label));
      // One finding per binding at its worst risk; namespaced bindings confine the blast radius one step
      const worst = risks.reduce((a, r) => (SEVERITY_WEIGHT[r.severity] > SEVERITY_WEIGHT[a.severity] ? r : a));
      const severity: PolicySeverity = clusterScope ? worst.severity : worst.severity === "high" ? "medium" : "low";
      findings.add({
        ...base, ruleId: "RBAC-002", severity,
        title: risks.length === 1 ? L(`위험 권한: ${worst.label}`, `Risky permission: ${worst.label}`) : L(`위험 권한 ${risks.length}개 (${worst.label} 등)`, `${risks.length} risky permissions (${worst.label}, …)`),
        detail: L(`${b.kind} '${b.name}' → ${b.roleRef.kind} '${b.roleRef.name}'가 ${subjects}에게 ${scopeText} 범위로 다음 권한을 부여합니다: ${risks.map((r) => r.label).join(" · ")}`, `${b.kind} '${b.name}' → ${b.roleRef.kind} '${b.roleRef.name}' grants ${subjects} the following on ${scopeText}: ${risks.map((r) => r.label).join(" · ")}`),
        recommendation: L("권한 상승 경로가 되는 동사/리소스를 제거하거나 resourceNames로 범위를 좁히고, 가능하면 RoleBinding으로 네임스페이스 범위로 제한하세요.", "Remove the verbs/resources that open an escalation path or narrow them with resourceNames, and prefer a namespace-scoped RoleBinding."),
        reference: REF.rbacEscalation,
      });
    }

    const anonymous = b.subjects.filter((s) => (s.kind === "Group" && s.name === "system:unauthenticated") || (s.kind === "User" && s.name === "system:anonymous"));
    if (anonymous.length > 0 && !system) {
      bindingRisks.push(L("익명 접근", "anonymous access"));
      findings.add({
        ...base, ruleId: "RBAC-003", severity: "high",
        title: L("인증되지 않은 사용자에게 권한 부여", "Permissions granted to unauthenticated users"),
        detail: L(`${b.name}이(가) system:unauthenticated / system:anonymous에 '${b.roleRef.name}'을(를) 바인딩합니다. API 서버에 도달 가능한 누구나 사용할 수 있습니다.`, `${b.name} binds '${b.roleRef.name}' to system:unauthenticated / system:anonymous. Anyone who can reach the API server can use it.`),
        recommendation: L("익명 바인딩을 제거하세요.", "Remove the anonymous binding."),
        reference: REF.rbac,
      });
    }
    if (!system && b.subjects.some((s) => s.kind === "Group" && s.name === "system:authenticated")) {
      bindingRisks.push(L("모든 인증 사용자", "all authenticated users"));
      findings.add({
        ...base, ruleId: "RBAC-004", severity: "medium",
        title: L("모든 인증 사용자(system:authenticated)에게 권한 부여", "Permissions granted to all authenticated users (system:authenticated)"),
        detail: L(`${b.name}이(가) 클러스터에 인증된 모든 주체에게 '${b.roleRef.name}'을(를) 부여합니다.`, `${b.name} grants '${b.roleRef.name}' to every principal authenticated to the cluster.`),
        recommendation: L("특정 그룹/ServiceAccount로 대상을 좁히세요.", "Narrow it to specific groups / ServiceAccounts."),
        reference: REF.rbac,
      });
    }
    if (!system && b.subjects.some((s) => s.kind === "ServiceAccount" && s.name === "default")) {
      bindingRisks.push("default SA");
      findings.add({
        ...base, ruleId: "RBAC-005", severity: "low",
        title: L("default ServiceAccount에 역할 바인딩", "Role bound to the default ServiceAccount"),
        detail: L(`${b.name}이(가) default ServiceAccount에 권한을 부여해 해당 네임스페이스의 모든 파드가 이 권한을 갖게 됩니다.`, `${b.name} grants permissions to the default ServiceAccount, so every pod in the namespace has them.`),
        recommendation: L("워크로드 전용 ServiceAccount를 만들어 바인딩하세요.", "Create a dedicated ServiceAccount for the workload and bind that."),
        reference: REF.rbac,
      });
    }
    if (!roleFound && !system) {
      findings.add({
        ...base, ruleId: "RBAC-006", severity: "info",
        title: L("존재하지 않는 역할을 참조하는 바인딩", "Binding refers to a role that does not exist"),
        detail: L(`${b.roleRef.kind} '${b.roleRef.name}'이(가) 없습니다. 같은 이름의 역할이 나중에 생성되면 의도치 않게 권한이 부여됩니다.`, `${b.roleRef.kind} '${b.roleRef.name}' does not exist. If a role with that name is created later, it is granted unintentionally.`),
        recommendation: L("불필요한 바인딩을 삭제하세요.", "Delete the unneeded binding."),
        reference: REF.rbac,
      });
    }

    bindings.push({
      kind: b.kind,
      name: b.name,
      namespace: b.namespace,
      roleRef: b.roleRef,
      subjects: b.subjects,
      system,
      risks: bindingRisks,
      roleFound,
    });
  }

  // ── Namespaces (PSA, coverage) ──
  const namespaces: NamespacePolicySummary[] = inv.namespaces.map((n) => {
    const labels = n.labels;
    const psa: PsaLabels = {
      enforce: asPsaLevel(labels["pod-security.kubernetes.io/enforce"]),
      audit: asPsaLevel(labels["pod-security.kubernetes.io/audit"]),
      warn: asPsaLevel(labels["pod-security.kubernetes.io/warn"]),
      enforceVersion: labels["pod-security.kubernetes.io/enforce-version"],
    };
    const system = isSystemNamespace(n.name);
    const nsPods = eligiblePods.filter((p) => p.namespace === n.name);
    const nsWorkloads = inv.workloads.filter((w) => w.namespace === n.name);
    const nsPolicies = networkPolicies.filter((p) => p.namespace === n.name);
    const clusterwide = networkPolicies.filter((p) => p.source === "cilium-clusterwide");
    const quotas = inv.resourceQuotas.filter((q) => q.namespace === n.name).length;
    const limitRanges = inv.limitRanges.filter((l) => l.namespace === n.name).length;
    const ingressIso = nsPods.filter((p) => ingressIsolated.has(podKey(p))).length;
    const egressIso = nsPods.filter((p) => egressIsolated.has(podKey(p))).length;
    const resource: PolicyResourceRef = { kind: "Namespace", name: n.name };
    const base = { system, namespace: n.name, resource };

    // PSA
    if (!psa.enforce) {
      findings.add({
        ...base, ruleId: "PSA-001", category: "psa", severity: "high",
        title: L("Pod Security enforce 라벨 없음", "No Pod Security enforce label"),
        detail: L("pod-security.kubernetes.io/enforce 라벨이 없어 기본값(privileged)이 적용됩니다 — 특권 컨테이너, hostPath, hostNetwork 등이 모두 허용됩니다.", "Without a pod-security.kubernetes.io/enforce label the default (privileged) applies — privileged containers, hostPath, hostNetwork and so on are all allowed."),
        recommendation: L("pod-security.kubernetes.io/enforce: baseline(가능하면 restricted)과 enforce-version을 설정하세요. 먼저 warn/audit=restricted로 위반을 확인하는 것을 권장합니다.", "Set pod-security.kubernetes.io/enforce: baseline (restricted if possible) and enforce-version. Check violations with warn/audit=restricted first."),
        reference: REF.psa,
      });
    } else if (psa.enforce === "privileged") {
      findings.add({
        ...base, ruleId: "PSA-002", category: "psa", severity: "medium",
        title: "Pod Security enforce=privileged",
        detail: L("privileged 레벨은 제한이 없어 노드 수준 권한 상승이 가능합니다.", "The privileged level has no restrictions, so node-level privilege escalation is possible."),
        recommendation: L("꼭 필요한 워크로드만 별도 네임스페이스로 분리하고, 나머지는 baseline 이상으로 강화하세요.", "Move only the workloads that need it to a separate namespace and raise the rest to baseline or higher."),
        reference: REF.pss,
      });
    }
    if (psa.enforce && psa.enforce !== "restricted" && psa.warn !== "restricted" && psa.audit !== "restricted") {
      findings.add({
        ...base, ruleId: "PSA-003", category: "psa", severity: "low",
        title: L("restricted 위반 가시성 없음 (warn/audit)", "No visibility of restricted violations (warn/audit)"),
        detail: L(`enforce=${psa.enforce}이지만 warn/audit=restricted가 없어 restricted 전환 시 영향도를 알 수 없습니다.`, `enforce=${psa.enforce}, but without warn/audit=restricted the impact of moving to restricted is unknown.`),
        recommendation: L("pod-security.kubernetes.io/warn: restricted, audit: restricted를 추가하세요.", "Add pod-security.kubernetes.io/warn: restricted and audit: restricted."),
        reference: REF.psa,
      });
    }
    if (psa.enforce && !psa.enforceVersion) {
      findings.add({
        ...base, ruleId: "PSA-004", category: "psa", severity: "info",
        title: L("enforce-version 미고정", "enforce-version not pinned"),
        detail: L("버전을 고정하지 않으면 클러스터 업그레이드 시 정책 기준이 바뀔 수 있습니다.", "Without a pinned version the policy baseline can change on cluster upgrades."),
        recommendation: L("pod-security.kubernetes.io/enforce-version: v1.xx 로 고정하세요.", "Pin it with pod-security.kubernetes.io/enforce-version: v1.xx."),
        reference: REF.psa,
      });
    }

    // NetworkPolicy coverage (only meaningful where pods run)
    if (nsPods.length > 0) {
      if (ingressIso === 0) {
        findings.add({
          ...base, ruleId: "NET-001", category: "networkPolicy", severity: "high",
          title: L("수신(ingress) 네트워크 격리 없음", "No ingress network isolation"),
          detail: L(`실행 중 파드 ${nsPods.length}개 모두 어떤 NetworkPolicy에도 선택되지 않아 클러스터 내 모든 파드로부터 수신이 허용됩니다.`, `None of the ${nsPods.length} running pods is selected by any NetworkPolicy, so ingress from every pod in the cluster is allowed.`),
          recommendation: L("podSelector: {} + policyTypes: [Ingress]의 default-deny 정책을 추가한 뒤 필요한 트래픽만 허용하세요.", "Add a default-deny policy (podSelector: {} + policyTypes: [Ingress]) and allow only the traffic you need."),
          reference: REF.netpolDefault,
        });
      } else if (ingressIso < nsPods.length) {
        findings.add({
          ...base, ruleId: "NET-002", category: "networkPolicy", severity: "medium",
          title: L("일부 파드만 수신 격리됨", "Only some pods are ingress-isolated"),
          detail: L(`파드 ${nsPods.length}개 중 ${ingressIso}개만 ingress 정책에 선택되어 있습니다.`, `Only ${ingressIso} of ${nsPods.length} pods are selected by an ingress policy.`),
          recommendation: L("네임스페이스 default-deny ingress 정책으로 나머지 파드도 격리하세요.", "Isolate the rest with a namespace default-deny ingress policy."),
          reference: REF.netpolDefault,
        });
      }
      if (egressIso === 0) {
        findings.add({
          ...base, ruleId: "NET-003", category: "networkPolicy", severity: "low",
          title: L("송신(egress) 네트워크 격리 없음", "No egress network isolation"),
          detail: L("파드가 클러스터 내·외부 어디로든 연결할 수 있습니다.", "Pods can connect anywhere inside or outside the cluster."),
          recommendation: L("default-deny egress 후 DNS(kube-dns 53/UDP·TCP)와 필요한 목적지만 허용하세요.", "After default-deny egress, allow only DNS (kube-dns 53/UDP·TCP) and the destinations you need."),
          reference: REF.netpolDefault,
        });
      }
    }

    // Resource governance
    if (nsWorkloads.length > 0 && (quotas === 0 || limitRanges === 0)) {
      findings.add({
        ...base, ruleId: "RES-003", category: "resources", severity: "low",
        title: L(`${[quotas === 0 ? "ResourceQuota" : "", limitRanges === 0 ? "LimitRange" : ""].filter(Boolean).join("·")} 없음`, `No ${[quotas === 0 ? "ResourceQuota" : "", limitRanges === 0 ? "LimitRange" : ""].filter(Boolean).join("·")}`),
        detail: L("네임스페이스 단위 리소스 총량 제한 또는 컨테이너 기본 requests/limits가 없습니다.", "No namespace resource quota or default container requests/limits."),
        recommendation: L("ResourceQuota로 총량을, LimitRange로 기본 requests/limits를 지정하세요.", "Set totals with ResourceQuota and default requests/limits with LimitRange."),
        reference: quotas === 0 ? REF.quota : REF.limitRange,
      });
    }

    return {
      name: n.name,
      system,
      podCount: nsPods.length,
      workloadCount: nsWorkloads.length,
      psa,
      psaEffectiveEnforce: psa.enforce ?? "privileged",
      networkPolicy: {
        k8sPolicies: nsPolicies.filter((p) => p.source === "kubernetes").length,
        ciliumPolicies: nsPolicies.filter((p) => p.source === "cilium").length + clusterwide.filter((p) => p.selectedPods > 0).length,
        ingressIsolatedPods: ingressIso,
        egressIsolatedPods: egressIso,
        eligiblePods: nsPods.length,
        defaultDenyIngress: nsPolicies.some((p) => p.defaultDenyIngress),
        defaultDenyEgress: nsPolicies.some((p) => p.defaultDenyEgress),
      },
      rbac: {
        roles: inv.roles.filter((r) => r.kind === "Role" && r.namespace === n.name).length,
        roleBindings: inv.bindings.filter((b) => b.kind === "RoleBinding" && b.namespace === n.name).length,
      },
      autoscaling: {
        vpa: vpas.filter((v) => v.namespace === n.name).length,
        hpa: hpas.filter((h) => h.namespace === n.name).length,
        pdb: pdbs.filter((p) => p.namespace === n.name).length,
      },
      quota: { resourceQuotas: quotas, limitRanges },
      findings: emptyCounts(), // filled below
    };
  });

  // ── Severity counts + scores (system objects excluded from scoring) ──
  const nsByName = new Map(namespaces.map((n) => [n.name, n]));
  const totals = emptyCounts();
  const penalty = new Map<PolicyCategory, number>(CATEGORIES.map((c) => [c, 0]));
  const perCategory = new Map<PolicyCategory, Record<PolicySeverity, number>>(CATEGORIES.map((c) => [c, emptyCounts()]));
  for (const f of findings.items) {
    if (f.namespace) {
      const ns = nsByName.get(f.namespace);
      if (ns) ns.findings[f.severity]++;
    }
    if (f.system) continue;
    totals[f.severity]++;
    perCategory.get(f.category)![f.severity]++;
    penalty.set(f.category, penalty.get(f.category)! + SEVERITY_WEIGHT[f.severity]);
  }
  const categories: PolicyCategoryScore[] = CATEGORIES.map((category) => ({
    category,
    score: Math.max(0, 100 - penalty.get(category)!),
    findings: perCategory.get(category)!,
  }));
  const score = Math.round(categories.reduce((s, c) => s + c.score, 0) / categories.length);

  const severityOrder: Record<PolicySeverity, number> = { high: 0, medium: 1, low: 2, info: 3 };
  findings.items.sort(
    (a, b) =>
      Number(a.system) - Number(b.system) ||
      severityOrder[a.severity] - severityOrder[b.severity] ||
      a.ruleId.localeCompare(b.ruleId) ||
      (a.namespace ?? "").localeCompare(b.namespace ?? ""),
  );

  return {
    clusterId,
    generatedAt: now.toISOString(),
    capabilities: inv.capabilities,
    summary: {
      score,
      categories,
      findings: totals,
      namespaces: namespaces.length,
      workloads: workloads.length,
    },
    namespaces: namespaces.sort((a, b) => Number(a.system) - Number(b.system) || a.name.localeCompare(b.name)),
    networkPolicies,
    rbac: {
      roles: roles.sort((a, b) => b.risks.length - a.risks.length || a.name.localeCompare(b.name)),
      bindings: bindings.sort((a, b) => b.risks.length - a.risks.length || a.name.localeCompare(b.name)),
    },
    autoscaling: { vpas, hpas, pdbs },
    workloads,
    findings: findings.items,
    netpol: buildNetpolModel(inv, (ns) => isSystemNamespace(ns)),
  };
}
