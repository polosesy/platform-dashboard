import type { NetpolModel } from "./netpol.js";
// ──────────────────────────────────────────────────────────────
// Kubernetes cluster policy posture
// (Pod Security Admission, NetworkPolicy, RBAC, autoscaling / resource governance)
// ──────────────────────────────────────────────────────────────

export type PolicySeverity = "high" | "medium" | "low" | "info";
export type PolicyCategory = "psa" | "networkPolicy" | "rbac" | "autoscaling" | "resources";
export type PsaLevel = "privileged" | "baseline" | "restricted";

export type PolicyResourceRef = {
  kind: string;
  name: string;
  namespace?: string;
};

/** One rule violation, with the standard it comes from. */
export type PolicyFinding = {
  /** Stable per (rule, resource) — usable as a React key. */
  id: string;
  ruleId: string;
  category: PolicyCategory;
  severity: PolicySeverity;
  title: string;
  detail: string;
  recommendation: string;
  reference: string;
  namespace?: string;
  resource?: PolicyResourceRef;
  /** Raised on a Kubernetes / AKS managed object (system namespace, system: role, add-on). */
  system: boolean;
};

export type PsaLabels = {
  enforce?: PsaLevel;
  audit?: PsaLevel;
  warn?: PsaLevel;
  enforceVersion?: string;
};

export type NamespacePolicySummary = {
  name: string;
  system: boolean;
  podCount: number;
  workloadCount: number;
  psa: PsaLabels;
  /** Effective enforce level: labelled level, or "privileged" when unlabelled (PSA default). */
  psaEffectiveEnforce: PsaLevel;
  networkPolicy: {
    k8sPolicies: number;
    ciliumPolicies: number;
    /** Pods (non-hostNetwork) selected by at least one ingress / egress policy. */
    ingressIsolatedPods: number;
    egressIsolatedPods: number;
    eligiblePods: number;
    defaultDenyIngress: boolean;
    defaultDenyEgress: boolean;
  };
  rbac: { roles: number; roleBindings: number };
  autoscaling: { vpa: number; hpa: number; pdb: number };
  quota: { resourceQuotas: number; limitRanges: number };
  findings: Record<PolicySeverity, number>;
};

export type NetworkPolicySource = "kubernetes" | "cilium" | "cilium-clusterwide";

export type NetworkPolicyInfo = {
  source: NetworkPolicySource;
  name: string;
  /** Empty for cluster-wide Cilium policies. */
  namespace: string;
  podSelector: string;
  selectedPods: number;
  policyTypes: Array<"Ingress" | "Egress">;
  ingressRules: number;
  egressRules: number;
  allowsAllIngress: boolean;
  allowsAllEgress: boolean;
  /** Selects every pod in the namespace with no allow rules for that direction. */
  defaultDenyIngress: boolean;
  defaultDenyEgress: boolean;
  /** Cilium: rules for these directions but `enableDefaultDeny: false` — adds allows, isolates (blocks) nothing */
  nonEnforcing?: Array<"Ingress" | "Egress">;
};

export type RbacSubject = { kind: string; name: string; namespace?: string };

export type RbacRoleInfo = {
  kind: "ClusterRole" | "Role";
  name: string;
  namespace?: string;
  system: boolean;
  ruleCount: number;
  /** Escalation-relevant permissions found in the rules (human readable). */
  risks: string[];
  bindingCount: number;
  aggregated: boolean;
};

export type RbacBindingInfo = {
  kind: "ClusterRoleBinding" | "RoleBinding";
  name: string;
  namespace?: string;
  roleRef: { kind: string; name: string };
  subjects: RbacSubject[];
  system: boolean;
  risks: string[];
  roleFound: boolean;
};

export type VpaUpdateMode = "Off" | "Initial" | "Recreate" | "InPlaceOrRecreate" | "InPlace" | "Auto";

export type VpaInfo = {
  namespace: string;
  name: string;
  target: PolicyResourceRef;
  updateMode: VpaUpdateMode;
  controlledResources: string[];
  /** Per-container target recommendation, e.g. { app: { cpu: "250m", memory: "512Mi" } }. */
  recommendations: Record<string, Record<string, string>>;
  targetFound: boolean;
};

export type HpaInfo = {
  namespace: string;
  name: string;
  target: PolicyResourceRef;
  minReplicas: number;
  maxReplicas: number;
  currentReplicas?: number;
  /** e.g. ["cpu 70%", "memory 80%", "pods/http_requests"]. */
  metrics: string[];
  resourceMetrics: string[];
  targetFound: boolean;
};

export type PdbInfo = {
  namespace: string;
  name: string;
  minAvailable?: string;
  maxUnavailable?: string;
  matchedWorkloads: string[];
  disruptionsAllowed?: number;
};

export type WorkloadPolicyCoverage = {
  namespace: string;
  kind: "Deployment" | "StatefulSet" | "DaemonSet";
  name: string;
  replicas: number;
  system: boolean;
  serviceAccount: string;
  automountToken: boolean;
  containers: number;
  containersWithoutRequests: number;
  containersWithoutMemoryLimit: number;
  vpa?: { name: string; updateMode: VpaUpdateMode };
  hpa?: { name: string; resourceMetrics: string[] };
  pdb?: string;
};

export type PolicyCategoryScore = {
  category: PolicyCategory;
  /** 0–100, higher is better. */
  score: number;
  findings: Record<PolicySeverity, number>;
};

export type KubernetesPolicyResponse = {
  clusterId: string;
  generatedAt: string;
  capabilities: {
    vpaInstalled: boolean;
    ciliumInstalled: boolean;
    /** Resource kinds that could not be listed (missing RBAC permission or API). */
    unavailable: string[];
  };
  summary: {
    score: number;
    categories: PolicyCategoryScore[];
    findings: Record<PolicySeverity, number>;
    namespaces: number;
    workloads: number;
  };
  namespaces: NamespacePolicySummary[];
  networkPolicies: NetworkPolicyInfo[];
  rbac: { roles: RbacRoleInfo[]; bindings: RbacBindingInfo[] };
  autoscaling: { vpas: VpaInfo[]; hpas: HpaInfo[]; pdbs: PdbInfo[] };
  workloads: WorkloadPolicyCoverage[];
  findings: PolicyFinding[];
  /** Every network policy as one rule model + workload / namespace labels — the web replays observed flows against it */
  netpol?: NetpolModel;
};
