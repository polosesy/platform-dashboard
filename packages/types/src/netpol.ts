// AKS 보안 점검 › 네트워크 노출 › 정책 시뮬레이션 — Kubernetes NetworkPolicy and Cilium (Clusterwide)NetworkPolicy
// normalized into one rule model, so the web can replay observed connections against the deployed policies and against
// a changed set (a policy off, an audit policy enforced, a virtual default-deny …) without asking the API again.

export type NetpolSelector = {
  matchLabels?: Record<string, string>;
  matchExpressions?: Array<{ key: string; operator: string; values?: string[] }>;
};

/**
 * One peer of a rule. `pods`: Kubernetes podSelector / namespaceSelector — `ns` "same" = the policy's namespace, "all" =
 * every namespace, or a namespace label selector; `pods` null = every pod there. `endpoints`: a Cilium endpoint selector
 * (may name the namespace with `k8s:io.kubernetes.pod.namespace` or namespace labels); `clusterwide` = not limited to the
 * policy's namespace. `cidr`: ipBlock / toCIDR / toCIDRSet. `entity`: Cilium entities (world, cluster, host, …).
 * `fqdn`: toFQDNs matchName / matchPattern. `any`: no peer field — every source / destination.
 */
export type NetpolPeer =
  | { kind: "pods"; ns: "same" | "all" | NetpolSelector; pods: NetpolSelector | null }
  | { kind: "endpoints"; selector: NetpolSelector; clusterwide: boolean }
  | { kind: "cidr"; cidr: string; except?: string[] }
  | { kind: "entity"; entity: string }
  | { kind: "fqdn"; name?: string; pattern?: string }
  | { kind: "any" };

/** `port` "53", "8080" or a named port ("http" — can't be told from observed numbers); empty list = every port */
export type NetpolPort = { protocol: "TCP" | "UDP" | "SCTP" | "ANY"; port?: string; endPort?: number };

export type NetpolRule = {
  peers: NetpolPeer[];
  ports: NetpolPort[];
  /** Cilium ingressDeny / egressDeny — wins over every allow */
  deny?: boolean;
  /** L7 rules (HTTP / DNS / Kafka) on these ports — allowed at L4, filtered further at L7 */
  l7?: boolean;
  /** Rule fields this model does not evaluate (toServices, toGroups, fromRequires, icmps, …) — the rule answers "unknown" */
  unsupported?: string[];
};

export type NetpolDirection = {
  /** The policy puts its selected pods in default-deny for this direction (Cilium enableDefaultDeny false = no) */
  isolates: boolean;
  rules: NetpolRule[];
};

export type NetpolPolicy = {
  /** "<source>:<namespace>/<name>[#i]" — stable within one response */
  id: string;
  source: "kubernetes" | "cilium" | "cilium-clusterwide";
  name: string;
  /** "" for cluster-wide policies */
  namespace: string;
  selector: NetpolSelector;
  ingress: NetpolDirection | null;
  egress: NetpolDirection | null;
};

export type NetpolModel = {
  namespaces: Array<{ name: string; labels: Record<string, string>; system: boolean }>;
  /** Pod-template labels per workload ("namespace/name" — the policy insights row id) */
  workloads: Array<{ id: string; namespace: string; name: string; kind: string; labels: Record<string, string>; serviceAccount?: string; system: boolean }>;
  policies: NetpolPolicy[];
};
