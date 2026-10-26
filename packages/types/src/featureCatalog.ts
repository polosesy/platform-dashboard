// Feature × permission catalog — which feature needs which minimum read permission, grouped by package (a packaging
// proposal, not a price list). The data lives in the API (apps/api/src/services/featureCatalog.ts): it runs the
// checks, and a future licence gate must be enforced on the server. Types only here.
import type { ConnectionFeature, PlatformRole } from "./connection.js";

export type PlanTierId = "core" | "pro" | "enterprise";
/** `includes` = the tier whose features come with this one ("기본의 모든 기능, 그리고:") */
export type PlanTier = { id: PlanTierId; includes: PlanTierId | null };

/** Azure (subscription / resource scope) and in-cluster Kubernetes permissions */
export type PermissionKey = ConnectionFeature | "k8sRead" | "k8sPodLogs" | "hubbleExec";

export type PermissionScope =
  | { kind: "subscription" }
  /** granted on the resource (or inherited from its subscription / resource group) — checked on samples */
  | { kind: "resource"; armType: string }
  /** a Kubernetes Role / ClusterRole binding inside the cluster (docs/integrations/azure/templates/aks/<manifest>) */
  | { kind: "kubernetes"; manifest: string; namespace?: string };

export type PermissionDef = {
  key: PermissionKey;
  plane: "azure" | "kubernetes";
  /** the built-in Azure role, or the Kubernetes role the templates create (names are proper nouns — not translated) */
  role: string;
  /** public Microsoft built-in role definition id (not tenant data) */
  roleDefinitionId?: string;
  scope: PermissionScope;
  /** the one operation the check tests */
  probe?: { action: string; data?: boolean };
  /** off unless switched on: Hubble exec (deployment + connection), pod logs (connection namespaces) */
  gate?: "hubbleExec" | "podLogs";
  docs: string;
  /** copyable grant command with placeholders — the dashboard never runs it */
  grant: string;
};

export type FeatureId =
  | "inventoryDiagram" | "liveDiagram" | "resourceHealth" | "costManagement"
  | "vnetTraffic" | "privateLinkUsage" | "defenderPosture" | "aksClusters" | "aksMonitoring"
  | "aksSecurityCheck" | "integratedRisk" | "urgentVulnerabilities" | "podTraffic" | "multiTenantConnections";

export type FeatureDef = {
  id: FeatureId;
  tier: PlanTierId;
  /** screens (nav hrefs) */
  routes: string[];
  requires: PermissionKey[];
  optional: PermissionKey[];
  preconditions?: Array<"entraCluster" | "clusterReachable">;
  /** a platform role beyond viewer for part of it (pod logs = operator) */
  platformRole?: PlatformRole;
};

/** GET /api/azure/feature-catalog — static, no Azure call */
export type FeatureCatalogResponse = { tiers: PlanTier[]; permissions: PermissionDef[]; features: FeatureDef[] };

/**
 * One permission for one connection: ok / missing / partial (some subscriptions or sampled resources) / unknown
 * (not checked, or the check failed) / notApplicable (no such resource) / optInOff (a switch that is off on purpose)
 */
export type PermissionCellStatus = "ok" | "missing" | "partial" | "unknown" | "notApplicable" | "optInOff";
export type PermissionCell = {
  status: PermissionCellStatus;
  at: "subscription" | "resource" | "cluster";
  /** subscriptions or resources looked at: allowed / checked / existing */
  sampled?: { ok: number; checked: number; total: number };
  reason?: "inherited" | "noResource" | "sampleLimit" | "readFailed" | "clusterNotChecked" | "gateOff";
};

export type FeatureReadiness = "ready" | "partial" | "blocked" | "unknown";
export type FeatureRollup = {
  id: FeatureId;
  tier: PlanTierId;
  readiness: FeatureReadiness;
  missingRequired: PermissionKey[];
  missingOptional: PermissionKey[];
  unknown: PermissionKey[];
};

/**
 * AKS integration readiness — from Azure facts only, so it answers when the API server is unreachable (private).
 * tier 0 = Azure only, tier 1 = inside the cluster. `ask` = what to request from the customer (snippets in the
 * response), `detail` = why, for the sentence.
 */
export type AksReadinessKey = "defender" | "policyAddon" | "prometheus" | "containerInsights" | "entra" | "localAccounts" | "authz" | "clusterUserRole" | "reach" | "credential";
export type AksAskKind = "clusterUserRole" | "clusterRoleBinding" | "azureRbacRole" | "amwDataReader" | "privateEndpoint" | "allowedIp" | "federation";
export type AksReadinessItem = {
  key: AksReadinessKey;
  tier: 0 | 1;
  state: "ok" | "missing" | "unknown" | "info";
  ask?: AksAskKind;
  detail?: string;
};

/** Kubernetes over-privilege seen by the cluster check — reported, never blocked */
export type ClusterPrivilegeWarning = "k8s_secrets_read" | "k8s_exec" | "k8s_wildcard";

/** GET /api/azure/connections/:key/cluster-check?resourceId= (admin) — SelfSubjectAccessReview, nothing stored */
export type ClusterCheckResponse = {
  generatedAt: string;
  cluster: string;
  /** how the platform signs in, or why it cannot */
  access: "entra" | "localAccount" | "localAccountRefused" | "unreachable" | "credentialForbidden" | "failed";
  code?: string;
  permissions: Partial<Record<"k8sRead" | "k8sPodLogs" | "hubbleExec", PermissionCell>>;
  /** read rules the role lacks (apiGroup/resource) */
  missingRules: string[];
  warnings: ClusterPrivilegeWarning[];
  /** Azure-side readiness (before any Kubernetes call) and the copy-ready requests it names */
  readiness?: AksReadinessItem[];
  snippets?: Partial<Record<AksAskKind, string>>;
};
