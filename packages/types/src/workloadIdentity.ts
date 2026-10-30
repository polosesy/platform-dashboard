// Workload identity map (/api/kubernetes/policies/workload-identity — services/workloadIdentity.ts):
// pods → ServiceAccount → federated identity credential → user-assigned managed identity → Azure roles.
// No subscription ID, principal ID, ARM ID or full GUID ever appears here — client/tenant IDs as the last 4
// characters, issuers masked, node ids opaque hashes; matches are decided server-side on the original values.

import type { EvidenceKind, RbacRiskKey } from "./policyInsights.js";

export type WiRuleId =
  | "WI-01" | "WI-02" | "WI-03" | "WI-04" | "WI-05" | "WI-06" | "WI-07" | "WI-08"
  | "WI-09" | "WI-10" | "WI-11" | "WI-12" | "WI-13" | "WI-14" | "WI-15" | "WI-16" | "WI-17";
export type WiSeverity = "crit" | "warn" | "low" | "info";
export type WiScopeLevel = "root" | "managementGroup" | "subscription" | "resourceGroup" | "resource";
/** Display only — never an ARM id or a subscription GUID */
export type WiScope = { level: WiScopeLevel; label: string; resourceType?: string };
/** byte-exact, or how a near miss differs (never counted as a match — the token exchange compares case-sensitively) */
export type WiMatch = "exact" | "case" | "trailingSlash" | "whitespace" | "other";

export type WiWorkload = {
  id: string;
  namespace: string;
  name: string;
  kind: string;
  pods: number;
  managed: boolean;
  saId: string;
  /** Pod template carries azure.workload.identity/use: "true" */
  useLabel: boolean;
  /** Running pods carry AZURE_FEDERATED_TOKEN_FILE (the webhook mutated them) */
  injected: "yes" | "no" | "mixed" | "noRunningPods";
  injectedClientIdTail?: string;
};

export type WiK8sBinding = {
  kind: "RoleBinding" | "ClusterRoleBinding";
  name: string;
  namespace?: string;
  role: string;
  via: "serviceAccount" | "group";
  group?: string;
  keys: RbacRiskKey[];
  conditional: RbacRiskKey[];
};

export type WiServiceAccount = {
  id: string;
  namespace: string;
  name: string;
  /** null = the ServiceAccount list was not readable */
  exists: boolean | null;
  managed: boolean;
  clientIdTail?: string;
  clientIdSource?: "annotation" | "podEnv";
  tenantIdTail?: string;
  tenantMatch: boolean | null;
  identityId: string | null;
  ficIds: string[];
  k8sRbac: WiK8sBinding[];
  /** Subjects that can run code as this SA (exec / token create in its namespace) — and so use its Azure identity */
  canUseIdentity: Array<{ subject: string; binding: string; keys: RbacRiskKey[] }>;
};

export type WiFic = {
  id: string;
  identityId: string;
  name: string;
  issuerMasked: string;
  issuerMatch: WiMatch;
  subject: string;
  subjectMatch: WiMatch | null;
  audiences: string[];
  audienceOk: boolean;
  identityBindingAudience: boolean;
  /** SA this credential federates (exact issuer + subject match only) */
  saId: string | null;
  /** Trusts this cluster but its ServiceAccount does not exist — null when the SA list was not readable */
  dangling: boolean | null;
};

export type WiRoleAssignment = {
  id: string;
  roleName: string;
  builtIn: boolean | null;
  privileged: "owner" | "uaa" | "rbacAdmin" | "contributor" | null;
  wildcardActions: boolean;
  conditional: boolean;
  scope: WiScope;
};

export type WiIdentity = {
  id: string;
  kind: "userAssigned" | "unresolved";
  name?: string;
  resourceGroup?: string;
  /** Subscription display name only */
  subscription?: string;
  location?: string;
  clientIdTail: string;
  tenantIdTail?: string;
  unresolvedReason?: "notFoundInConnectedSubscriptions" | "lookupFailed";
  fic: {
    status: "ok" | "forbidden" | "throttled" | "error" | "notListed";
    /** null = not listed */
    count: number | null;
    limit: 20;
    ids: string[];
    /** Credentials that trust another issuer (another cluster, GitHub …) */
    otherIssuers: number;
    regionUnsupported: boolean;
  };
  roles: WiRoleAssignment[];
  rolesStatus: "ok" | "error" | "notListed";
  /** annotated = an SA or pod names it · subscriptionScan = found by the optional scan · nodePool = only attached to a node pool's VMSS */
  scanned: "annotated" | "subscriptionScan" | "nodePool";
  /** Node pools (WiNodePool ids) whose scale set carries this identity — reachable through IMDS without workload identity */
  pools?: string[];
};

/**
 * A node pool's scale set and the user-assigned identities attached to it. Any pod on those nodes that can reach IMDS
 * (169.254.169.254) can get a token for any of them by client ID — configuration ("can"), not observed use.
 */
export type WiNodePool = {
  id: string;
  name: string;
  identityIds: string[];
  nodes: number;
  /** Non-terminated workloads with pods on this pool (hostNetwork pods reach IMDS even with the restriction on) */
  workloads: number;
  /** …of which run without workload identity (no use label, no token injected) */
  withoutWi: number;
  namespaces: Array<{ namespace: string; workloads: number; withoutWi: number }>;
};

/** Can pods reach IMDS? Cluster setting (AKS networkProfile.podLinkLocalAccess, preview API) + explicit allow policies */
export type WiImds = {
  /** allowed = podLinkLocalAccess IMDS (the default) · restricted = None · null = not readable */
  podAccess: "allowed" | "restricted" | null;
  /** Enabled add-ons that the IMDS restriction (preview) doesn't support — it can't be turned on while they are */
  restrictionBlockedBy: string[];
  /** Network policies that explicitly allow egress to 169.254.169.254 */
  allowPolicies: Array<{ kind: "NetworkPolicy" | "CiliumNetworkPolicy" | "CiliumClusterwideNetworkPolicy"; namespace?: string; name: string; selectsAll: boolean }>;
  /** Node pool scale sets (Resource Graph, node resource group) */
  pools: "ok" | "forbidden" | "error" | "notRead";
};

/** A workload that doesn't use workload identity (shown so a namespace's silence is explained, never guessed) */
export type WiOtherWorkload = {
  id: string;
  namespace: string;
  name: string;
  kind: string;
  pods: number;
  managed: boolean;
  serviceAccount: string;
  /** Node pools its running pods are on (WiNodePool ids) */
  pools: string[];
  hostNetwork: boolean;
  /** Pod template references a Secret (volume, envFrom, secretKeyRef) — names never collected */
  usesSecrets: boolean;
};

export type WiFinding = {
  id: string;
  rule: WiRuleId;
  sev: WiSeverity;
  ev: EvidenceKind;
  title: string;
  detail: string;
  remediation: string;
  code?: string;
  docUrl: string;
  docQuote: string;
  /** Graph node ids this finding is about */
  refs: string[];
};

export type WorkloadIdentityResponse = {
  clusterId: string;
  generatedAt: string;
  cluster: { oidcIssuerEnabled: boolean | null; workloadIdentityEnabled: boolean | null; issuerMasked: string | null };
  workloads: WiWorkload[];
  serviceAccounts: WiServiceAccount[];
  fics: WiFic[];
  identities: WiIdentity[];
  findings: WiFinding[];
  nodePools: WiNodePool[];
  imds: WiImds;
  otherWorkloads: WiOtherWorkload[];
  coverage: {
    serviceAccounts: "ok" | "forbidden" | "error";
    identitiesResolved: number;
    identitiesUnresolved: number;
    ficListed: number;
    ficFailed: number;
    roleAssignments: "ok" | "error" | "notListed";
    pimEligibleIncluded: false;
    identityBindings: "notCollected";
    subscriptionScan: { requested: boolean; scanned: number; total: number | null; cap: number };
  };
  gaps: string[];
};
