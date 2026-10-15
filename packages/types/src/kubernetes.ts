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
