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
