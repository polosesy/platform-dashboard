// What the platform reads inside an AKS cluster — the single source of the Kubernetes roles customers bind
// (docs/integrations/azure/templates/aks/*.yaml are generated from here). apps/api/test/k8sReadSurface.test.ts
// scans every @kubernetes/client-node call in src/ and fails when one is missing here, and when a generated file
// is stale — the role a customer reviews is exactly what the code can do.
//
// Verbs are `list` only (the code never gets or watches a single object), except the per-namespace pod-log grant.
// Never granted: secrets · configmaps (ArgoCD and others keep passwords there) · exec/attach/portforward · proxies.

export type ReadRule = {
  apiGroup: string;
  resource: string;
  verbs: Array<"list" | "get" | "create">;
  /** Typed client methods (CoreV1Api …) that read it — the static scan's allow-list */
  methods: string[];
  /** CustomObjectsApi: read through listClusterCustomObject (404 = CRD not installed, that area is skipped) */
  custom?: true;
};

const r = (apiGroup: string, resource: string, methods: string[], custom?: true): ReadRule =>
  ({ apiGroup, resource, verbs: ["list"], methods, ...(custom ? { custom } : {}) });

export const K8S_READ_SURFACE: ReadRule[] = [
  r("", "namespaces", ["listNamespace"]),
  r("", "nodes", ["listNode"]),
  // Workload identity map: only the azure.workload.identity/* annotations are kept (never other annotations or secrets)
  r("", "serviceaccounts", ["listServiceAccountForAllNamespaces"]),
  r("", "pods", ["listPodForAllNamespaces", "listNamespacedPod"]),
  r("", "services", ["listServiceForAllNamespaces", "listNamespacedService"]),
  r("", "endpoints", ["listNamespacedEndpoints"]),
  r("", "resourcequotas", ["listResourceQuotaForAllNamespaces"]),
  r("", "limitranges", ["listLimitRangeForAllNamespaces"]),
  // Warning events of a workload (AKS keeps ~1 h): type · reason · object · count — the message goes to operators only
  r("", "events", ["listEventForAllNamespaces", "listNamespacedEvent"]),
  r("apps", "deployments", ["listDeploymentForAllNamespaces"]),
  r("apps", "statefulsets", ["listStatefulSetForAllNamespaces"]),
  r("apps", "daemonsets", ["listDaemonSetForAllNamespaces"]),
  r("batch", "jobs", ["listJobForAllNamespaces"]),
  r("batch", "cronjobs", ["listCronJobForAllNamespaces"]),
  r("networking.k8s.io", "networkpolicies", ["listNetworkPolicyForAllNamespaces"]),
  r("networking.k8s.io", "ingresses", ["listIngressForAllNamespaces"]),
  r("rbac.authorization.k8s.io", "roles", ["listRoleForAllNamespaces"]),
  r("rbac.authorization.k8s.io", "clusterroles", ["listClusterRole"]),
  r("rbac.authorization.k8s.io", "rolebindings", ["listRoleBindingForAllNamespaces"]),
  r("rbac.authorization.k8s.io", "clusterrolebindings", ["listClusterRoleBinding"]),
  r("autoscaling", "horizontalpodautoscalers", ["listHorizontalPodAutoscalerForAllNamespaces"]),
  r("policy", "poddisruptionbudgets", ["listPodDisruptionBudgetForAllNamespaces"]),
  r("autoscaling.k8s.io", "verticalpodautoscalers", [], true),
  r("cilium.io", "ciliumnetworkpolicies", [], true),
  r("cilium.io", "ciliumclusterwidenetworkpolicies", [], true),
  r("gateway.networking.k8s.io", "httproutes", [], true),
];

/** Pod logs — a namespaced Role per allowed namespace (connections file `aks.podLogNamespaces`), never cluster-wide */
export const POD_LOG_RULE: ReadRule = { apiGroup: "", resource: "pods/log", verbs: ["get"], methods: ["readNamespacedPodLog"] };

/**
 * Hubble exec — opt-in for the home cluster (or `aks.hubbleExec`), never part of the reader role. exec into the
 * privileged cilium-agent is node access; the service proxy reaches hubble-relay. Only in kube-system.
 */
export const HUBBLE_EXEC_RULES: ReadRule[] = [
  // exec is a WebSocket upgrade: `create` (Kubernetes ≥ 1.30), `get` for older API servers
  { apiGroup: "", resource: "pods/exec", verbs: ["create", "get"], methods: [] },
  { apiGroup: "", resource: "services/proxy", verbs: ["get"], methods: [] },
];

/**
 * The connection check asks the API server what the platform's identity may do (SelfSubjectAccessReview): a create
 * that stores nothing, allowed to every signed-in identity by the built-in system:basic-user role. Never put it in
 * a generated role — it needs no grant.
 */
export const SELF_REVIEW_RULE: ReadRule = { apiGroup: "authorization.k8s.io", resource: "selfsubjectaccessreviews", verbs: ["create"], methods: ["createSelfSubjectAccessReview"] };

/** Never in any generated role */
export const NEVER_GRANTED = ["*", "secrets", "configmaps", "pods/exec", "pods/attach", "pods/portforward", "services/proxy", "nodes/proxy"];

const HEADER = "# Generated from apps/api/src/services/k8sReadSurface.ts — do not edit (npm test checks it)\n";
const LABELS = "  labels:\n    app.kubernetes.io/part-of: azure-unified-dashboard\n";
const quoteGroup = (g: string) => (g === "" ? '""' : g);

/** One YAML rule per (apiGroup, verbs) — resources sorted, order of first appearance */
function rulesYaml(rules: ReadRule[]): string {
  const groups = new Map<string, { group: string; resources: string[]; verbs: string[] }>();
  for (const rule of rules) {
    const verbs = [...rule.verbs].sort();
    const key = `${rule.apiGroup}|${verbs.join(",")}`;
    const g = groups.get(key) ?? { group: rule.apiGroup, resources: [], verbs };
    g.resources.push(rule.resource);
    groups.set(key, g);
  }
  return [...groups.values()].map((g) =>
    `  - apiGroups: [${quoteGroup(g.group)}]\n    resources: [${[...g.resources].sort().join(", ")}]\n    verbs: [${g.verbs.join(", ")}]\n`).join("");
}

const subjectYaml = (indent = "  ") =>
  `${indent}- kind: User\n${indent}  # The connection identity's OBJECT id (service principal / managed identity) — check with \`kubectl auth whoami\`\n` +
  `${indent}  name: "<CONNECTION_IDENTITY_OBJECT_ID>"\n${indent}  apiGroup: rbac.authorization.k8s.io\n`;

/** aud-dashboard-reader: ClusterRole (list on the read surface) + binding to the connection's identity */
export function readerManifest(): string {
  return HEADER +
    "# Read-only inventory for the Azure Unified Dashboard: list only — no secrets, configmaps, exec or proxy.\n" +
    "apiVersion: rbac.authorization.k8s.io/v1\nkind: ClusterRole\nmetadata:\n  name: aud-dashboard-reader\n" + LABELS +
    "rules:\n" + rulesYaml(K8S_READ_SURFACE) +
    "---\napiVersion: rbac.authorization.k8s.io/v1\nkind: ClusterRoleBinding\nmetadata:\n  name: aud-dashboard-reader\n" + LABELS +
    "subjects:\n" + subjectYaml() +
    "roleRef:\n  kind: ClusterRole\n  name: aud-dashboard-reader\n  apiGroup: rbac.authorization.k8s.io\n";
}

/** Pod logs for ONE namespace (copy per namespace listed in aks.podLogNamespaces) */
export function podLogManifest(): string {
  return HEADER +
    "# Optional: pod logs of one namespace (logs can carry secrets and personal data). Copy per namespace.\n" +
    "apiVersion: rbac.authorization.k8s.io/v1\nkind: Role\nmetadata:\n  name: aud-dashboard-pod-logs\n  namespace: <NAMESPACE>\n" + LABELS +
    "rules:\n" + rulesYaml([POD_LOG_RULE]) +
    "---\napiVersion: rbac.authorization.k8s.io/v1\nkind: RoleBinding\nmetadata:\n  name: aud-dashboard-pod-logs\n  namespace: <NAMESPACE>\n" + LABELS +
    "subjects:\n" + subjectYaml() +
    "roleRef:\n  kind: Role\n  name: aud-dashboard-pod-logs\n  apiGroup: rbac.authorization.k8s.io\n";
}

/** Hubble exec opt-in (kube-system only). NOT recommended for customer clusters — see docs/integrations/azure/aks.md */
export function hubbleExecManifest(): string {
  return HEADER +
    "# NOT RECOMMENDED for customer clusters: exec into the privileged cilium-agent is node-level access, and\n" +
    "# Defender for Containers alerts on it. Prefer Hubble metrics (Managed Prometheus) or ACNS flow logs.\n" +
    "# Needs HUBBLE_EXEC_ENABLED=true (production) and, for a customer connection, aks.hubbleExec: true.\n" +
    "apiVersion: rbac.authorization.k8s.io/v1\nkind: Role\nmetadata:\n  name: aud-dashboard-hubble-exec\n  namespace: kube-system\n" + LABELS +
    "rules:\n" + rulesYaml(HUBBLE_EXEC_RULES) +
    "---\napiVersion: rbac.authorization.k8s.io/v1\nkind: RoleBinding\nmetadata:\n  name: aud-dashboard-hubble-exec\n  namespace: kube-system\n" + LABELS +
    "subjects:\n" + subjectYaml() +
    "roleRef:\n  kind: Role\n  name: aud-dashboard-hubble-exec\n  apiGroup: rbac.authorization.k8s.io\n";
}

export const GENERATED_MANIFESTS: Record<string, () => string> = {
  "aud-dashboard-reader.yaml": readerManifest,
  "aud-dashboard-pod-logs.yaml": podLogManifest,
  "aud-dashboard-hubble-exec.yaml": hubbleExecManifest,
};
