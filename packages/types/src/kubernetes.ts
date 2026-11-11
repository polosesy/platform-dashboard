export type KubernetesClusterInfo = {
  id: string; // Azure resource ID (lowercase)
  name: string;
  resourceGroup: string;
  subscriptionId: string;
  location: string;
  kubernetesVersion: string;
  nodeCount: number;
  powerState: string;
  fqdn: string;
  /** How the platform can reach and sign in to this cluster (from the cluster's ARM properties) */
  access?: KubernetesClusterAccess;
};

/**
 * private        the API server has no public address — the platform API must run in a network that resolves
 *                and reaches its private endpoint (docs/integrations/azure/aks.md)
 * entra          Entra ID integration: the platform signs in with a short-lived Entra token (no kubelogin)
 * localAccounts  static cluster certificates are enabled (with no Entra integration they are cluster-admin)
 * azureRbac      Kubernetes authorization through Azure role assignments
 */
export type KubernetesClusterAccess = {
  private: boolean;
  entra: boolean;
  localAccounts: boolean;
  azureRbac: boolean;
};

export type KubernetesClustersResponse = {
  generatedAt: string;
  clusters: KubernetesClusterInfo[];
  note?: string;
};

export type KubernetesObjectKind =
  | "Node"
  | "Namespace"
  | "Pod"
  | "Deployment"
  | "ReplicaSet"
  | "StatefulSet"
  | "DaemonSet"
  | "Service"
  | "Ingress"
  | "ConfigMap"
  | "Secret"
  | "PersistentVolumeClaim"
  | "Job"
  | "CronJob";

export type KubernetesObject = {
  kind: KubernetesObjectKind;
  name: string;
  namespace: string;
  status: string;
  createdAt: string;
  ready?: string; // "3/3" for pods/deployments
  restarts?: number;
  replicas?: string; // "3/3" for deployments
  /** Service: its ports ("80/TCP → 8080") — configuration, as kubectl shows it */
  ports?: string[];
  /** Service with a selector: the pods it selects now and the workloads that own them (none = selects nothing) */
  targets?: { pods: number; workloads: string[] };
};

export type KubernetesClusterOverview = {
  generatedAt: string;
  cluster: KubernetesClusterInfo;
  summary: {
    namespaceCount: number;
    nodeCount: number;
    podTotal: number;
    podRunning: number;
    podPending: number;
    podFailed: number;
    deploymentCount: number;
    serviceCount: number;
  };
  objects: KubernetesObject[];
  note?: string;
};

// ── Cluster configuration (AKS 클러스터 › 클러스터 구성 — services/aksClusterConfig.ts) ──
// What Azure says the cluster is set to (ARM managedClusters + upgradeProfiles + maintenanceConfigurations) — read with
// the cluster's connection, no Kubernetes call, so it answers for a private cluster the platform cannot reach.
// null = the property is absent from the ARM answer (never guessed); a part that could not be read is in `gaps`.

export type AksConfigPool = {
  name: string;
  mode: string | null;
  vmSize: string | null;
  count: number | null;
  /** Cluster autoscaler bounds; null = autoscaling off */
  autoscale: { min: number; max: number } | null;
  osType: string | null;
  osSku: string | null;
  zones: string[];
  /** The pool's Kubernetes version (can trail the control plane during an upgrade) */
  version: string | null;
  nodeImageVersion: string | null;
  powerState: string | null;
  spot: boolean;
};
export type AksConfigWindow = {
  name: string;
  schedule: { kind: "weekly" | "absoluteMonthly" | "relativeMonthly" | "daily" | "other"; interval: number; dayOfWeek?: string; dayOfMonth?: number; weekIndex?: string };
  startTime: string | null;
  durationHours: number | null;
  utcOffset: string | null;
  next: string | null;
};
export type AksAddonId = "monitoring" | "managedPrometheus" | "defender" | "azurePolicy" | "keyVaultCsi" | "acns" | "keda" | "vpa" | "imageCleaner" | "appRouting";
export type AksClusterConfigResponse = {
  clusterId: string;
  generatedAt: string;
  source?: "mock";
  note?: string;
  name: string;
  location: string | null;
  powerState: string | null;
  provisioningState: string | null;
  version: {
    current: string | null;
    /** Versions the control plane can be upgraded to (ARM upgradeProfiles) — null = not read */
    upgrades: { version: string; preview: boolean }[] | null;
    upgradeChannel: string | null;
    nodeOsChannel: string | null;
    tier: string | null;
    supportPlan: string | null;
  };
  pools: AksConfigPool[];
  network: {
    plugin: string | null;
    pluginMode: string | null;
    dataplane: string | null;
    policy: string | null;
    podCidr: string | null;
    serviceCidr: string | null;
    outboundType: string | null;
    loadBalancerSku: string | null;
    privateCluster: boolean | null;
    /** Authorized IP ranges on a public API server: how many (the ranges themselves are not sent) */
    authorizedIpRanges: number | null;
  };
  identity: {
    entra: boolean | null;
    azureRbac: boolean | null;
    localAccounts: boolean | null;
    oidcIssuer: boolean | null;
    workloadIdentity: boolean | null;
  };
  /** Add-ons and profiles: on / off / null (absent from the answer) */
  addons: { id: AksAddonId; on: boolean | null }[];
  /** Planned-maintenance windows; null = not read */
  windows: AksConfigWindow[] | null;
  gaps: ("upgrades" | "windows")[];
};
