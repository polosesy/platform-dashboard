// Feature × permission catalog — the single source of "which feature needs which minimum read permission" (the
// /settings/features page, the connection check, docs/integrations/azure/permissions.md). Tiers are a packaging
// proposal (one field per feature), not a price list; no licence is enforced yet. Pure; tested from
// apps/api/test/featureCatalog.test.ts (catalog ↔ doc ↔ menu ↔ i18n).
import type {
  ConnectionFeature,
  FeatureDef,
  FeatureReadiness,
  FeatureRollup,
  PermissionCell,
  PermissionDef,
  PermissionKey,
  PlanTier,
} from "@aud/types";

export const PLAN_TIERS: PlanTier[] = [
  { id: "core", includes: null },
  { id: "pro", includes: "core" },
  { id: "enterprise", includes: "pro" },
];

const azRole = (scope: string) => (role: string) => `az role assignment create --assignee <CONNECTION_IDENTITY_OBJECT_ID> --role "${role}" --scope ${scope}`;
const atSub = azRole("/subscriptions/<SUBSCRIPTION_ID>");
const kubectl = (manifest: string) => `kubectl apply -f docs/integrations/azure/templates/aks/${manifest}`;

/** Every permission the platform reads with — read-only; role definition ids are public Microsoft constants */
export const PERMISSIONS: PermissionDef[] = [
  { key: "inventory", plane: "azure", role: "Reader", roleDefinitionId: "acdd72a7-3385-48ef-bd42-f606fba81ae7", scope: { kind: "subscription" },
    probe: { action: "Microsoft.Resources/subscriptions/resourceGroups/read" }, docs: "permissions.md", grant: atSub("Reader") },
  { key: "metrics", plane: "azure", role: "Monitoring Reader", roleDefinitionId: "43d0d8ad-25c7-4714-9337-8ba259a9fe05", scope: { kind: "subscription" },
    probe: { action: "Microsoft.Insights/metrics/read" }, docs: "permissions.md", grant: atSub("Monitoring Reader") },
  { key: "logs", plane: "azure", role: "Log Analytics Reader", roleDefinitionId: "73c42c96-874c-492b-b04d-ab87d138a893", scope: { kind: "resource", armType: "microsoft.operationalinsights/workspaces" },
    probe: { action: "Microsoft.OperationalInsights/workspaces/query/AzureDiagnostics/read" }, docs: "permissions.md", grant: azRole("<WORKSPACE_RESOURCE_ID>")("Log Analytics Reader") },
  { key: "security", plane: "azure", role: "Security Reader", roleDefinitionId: "39bc4728-0917-49c7-9d2c-d95423bc2eb4", scope: { kind: "subscription" },
    probe: { action: "Microsoft.Security/assessments/read" }, docs: "permissions.md", grant: atSub("Security Reader") },
  { key: "cost", plane: "azure", role: "Cost Management Reader", roleDefinitionId: "72fafb9e-0641-4937-9268-a91bfd8191a3", scope: { kind: "subscription" },
    probe: { action: "Microsoft.CostManagement/query/read" }, docs: "permissions.md", grant: atSub("Cost Management Reader") },
  { key: "aksCredential", plane: "azure", role: "Azure Kubernetes Service Cluster User Role", roleDefinitionId: "4abbcc35-e782-43d8-92c5-2d3f1bd2253f", scope: { kind: "resource", armType: "microsoft.containerservice/managedclusters" },
    probe: { action: "Microsoft.ContainerService/managedClusters/listClusterUserCredential/action" }, docs: "aks.md", grant: azRole("<CLUSTER_RESOURCE_ID>")("Azure Kubernetes Service Cluster User Role") },
  { key: "flowLogBlobs", plane: "azure", role: "Storage Blob Data Reader", roleDefinitionId: "2a2b9908-6ea1-4ae2-8e65-a410df84e7d1", scope: { kind: "resource", armType: "microsoft.storage/storageaccounts" },
    probe: { action: "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read", data: true }, docs: "permissions.md", grant: azRole("<FLOW_LOG_STORAGE_ACCOUNT_RESOURCE_ID>")("Storage Blob Data Reader") },
  { key: "prometheus", plane: "azure", role: "Monitoring Data Reader", roleDefinitionId: "b0d8363b-8ddd-447d-831f-62ca05bff136", scope: { kind: "resource", armType: "microsoft.monitor/accounts" },
    probe: { action: "Microsoft.Monitor/accounts/data/metrics/read", data: true }, docs: "permissions.md", grant: azRole("<MONITOR_WORKSPACE_RESOURCE_ID>")("Monitoring Data Reader") },
  { key: "k8sRead", plane: "kubernetes", role: "aud-dashboard-reader (ClusterRole)", scope: { kind: "kubernetes", manifest: "aud-dashboard-reader.yaml" },
    docs: "aks.md", grant: kubectl("aud-dashboard-reader.yaml") },
  { key: "k8sPodLogs", plane: "kubernetes", role: "aud-dashboard-pod-logs (Role)", scope: { kind: "kubernetes", manifest: "aud-dashboard-pod-logs.yaml", namespace: "<NAMESPACE>" },
    gate: "podLogs", docs: "aks.md", grant: kubectl("aud-dashboard-pod-logs.yaml") },
  { key: "hubbleExec", plane: "kubernetes", role: "aud-dashboard-hubble-exec (Role)", scope: { kind: "kubernetes", manifest: "aud-dashboard-hubble-exec.yaml", namespace: "kube-system" },
    gate: "hubbleExec", docs: "aks.md", grant: kubectl("aud-dashboard-hubble-exec.yaml") },
];

const AKS_PRE: FeatureDef["preconditions"] = ["entraCluster", "clusterReachable"];

/** Every screen, its package and what it reads with (required = it does not work without; optional = less) */
export const FEATURES: FeatureDef[] = [
  { id: "inventoryDiagram", tier: "core", routes: ["/architecture"], requires: ["inventory"], optional: ["logs"] },
  { id: "liveDiagram", tier: "core", routes: ["/live-diagram"], requires: ["inventory", "metrics"], optional: ["logs", "flowLogBlobs"] },
  { id: "resourceHealth", tier: "core", routes: ["/health"], requires: ["inventory"], optional: [] },
  { id: "costManagement", tier: "core", routes: ["/cost"], requires: ["cost"], optional: [] },
  { id: "vnetTraffic", tier: "pro", routes: ["/network"], requires: ["inventory", "logs"], optional: [] },
  { id: "privateLinkUsage", tier: "pro", routes: ["/live-diagram"], requires: ["inventory", "logs"], optional: [] },
  { id: "defenderPosture", tier: "pro", routes: ["/security", "/security/findings", "/security/identity", "/security/threats", "/security/compliance"], requires: ["security"], optional: [] },
  { id: "aksClusters", tier: "pro", routes: ["/kubernetes"], requires: ["aksCredential", "k8sRead"], optional: ["inventory"], preconditions: AKS_PRE },
  { id: "aksMonitoring", tier: "pro", routes: ["/observability"], requires: ["aksCredential", "k8sRead"], optional: ["logs", "prometheus", "k8sPodLogs"], preconditions: AKS_PRE, platformRole: "operator" },
  { id: "aksSecurityCheck", tier: "enterprise", routes: ["/policies"], requires: ["aksCredential", "k8sRead"], optional: ["inventory", "hubbleExec"], preconditions: AKS_PRE },
  { id: "integratedRisk", tier: "enterprise", routes: ["/security/risk"], requires: ["security", "inventory", "aksCredential", "k8sRead"], optional: [] },
  { id: "podTraffic", tier: "enterprise", routes: ["/hubble"], requires: ["aksCredential", "hubbleExec"], optional: [], preconditions: AKS_PRE },
  { id: "multiTenantConnections", tier: "enterprise", routes: ["/settings/connections"], requires: [], optional: [] },
];

export const permissionDef = (key: PermissionKey) => PERMISSIONS.find((p) => p.key === key)!;

/** The subscription-scope check's one operation per Azure permission (connectionCheck featureCoverage) */
export const AZURE_PROBES = Object.fromEntries(
  PERMISSIONS.filter((p) => p.plane === "azure" && p.probe).map((p) => [p.key, { action: p.probe!.action, ...(p.probe!.data ? { data: true } : {}), ...(p.scope.kind === "resource" ? { scopedBelow: true } : {}) }]),
) as Record<ConnectionFeature, { action: string; data?: boolean; scopedBelow?: boolean }>;

const BLOCKS = new Set<PermissionCell["status"]>(["missing"]);
const SOFT = new Set<PermissionCell["status"]>(["optInOff", "notApplicable"]);

/**
 * Feature readiness from its permission cells: a required one missing → blocked; partial → partial; not known →
 * unknown; otherwise an optional one missing / partial → partial; else ready. Opt-in switches that are off and
 * resources that do not exist never degrade an optional permission.
 */
export function rollupFeature(def: FeatureDef, cells: Partial<Record<PermissionKey, PermissionCell>>): FeatureRollup {
  const st = (k: PermissionKey) => cells[k]?.status ?? "unknown";
  const missingRequired = def.requires.filter((k) => BLOCKS.has(st(k)) || st(k) === "optInOff");
  const partialRequired = def.requires.filter((k) => st(k) === "partial");
  const unknown = def.requires.filter((k) => st(k) === "unknown");
  const missingOptional = def.optional.filter((k) => !SOFT.has(st(k)) && (st(k) === "missing" || st(k) === "partial"));
  let readiness: FeatureReadiness = "ready";
  if (missingRequired.length) readiness = "blocked";
  else if (partialRequired.length) readiness = "partial";
  else if (unknown.length) readiness = "unknown";
  else if (missingOptional.length) readiness = "partial";
  return { id: def.id, tier: def.tier, readiness, missingRequired: [...missingRequired, ...partialRequired], missingOptional, unknown };
}

/** ok / missing / partial from allowed-of-checked counts (0 checked = unknown, nothing exists = notApplicable) */
export function cellFrom(at: PermissionCell["at"], ok: number, checked: number, total: number, reason?: PermissionCell["reason"]): PermissionCell {
  if (total === 0) return { status: "notApplicable", at, reason: "noResource" };
  if (checked === 0) return { status: "unknown", at, sampled: { ok, checked, total }, reason: reason ?? "readFailed" };
  const status = ok === checked ? "ok" : ok === 0 ? "missing" : "partial";
  return { status, at, sampled: { ok, checked, total }, ...(reason ? { reason } : checked < total ? { reason: "sampleLimit" as const } : {}) };
}
