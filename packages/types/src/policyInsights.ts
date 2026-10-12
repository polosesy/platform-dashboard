// ─────────────────────────────────────────────────────────────
// Cluster policy insights — risk combinations over policy, RBAC,
// pod security, observed traffic (Hubble) and Azure context.
// Every value carries how it is known: observed, permission,
// configuration, or unknown.
// ─────────────────────────────────────────────────────────────

import type { HubbleCoverage } from "./hubble.js";

/** How a fact is known. `unk` is never colored as risk. */
export type EvidenceKind = "obs" | "perm" | "cfg" | "unk";
export type RiskWeight = "crit" | "warn" | "low";

export type RiskFactorKey =
  | "exposure" | "root" | "privEsc" | "host" | "automount" | "highRbac"
  | "secret" | "noIngress" | "noEgress" | "extEgress" | "psa";

export type RiskFactorDef = {
  key: RiskFactorKey;
  label: string;
  group: string;
  ev: EvidenceKind;
  weight: RiskWeight;
  desc: string;
};

export type ComboType = "exfil" | "takeover" | "standing" | "vnet";

export type WorkloadRiskRow = {
  /** `${namespace}/${name}` */
  id: string;
  namespace: string;
  name: string;
  kind: "Deployment" | "StatefulSet" | "DaemonSet";
  pods: number;
  /** Managed by AKS (addon labels) — shown only on request, never "fix this" */
  managed: boolean;
  owner: string;
  serviceAccount: string;
  /** Factor → evidence text; missing key = factor absent */
  cells: Partial<Record<RiskFactorKey, string>>;
  weights: Partial<Record<RiskFactorKey, RiskWeight>>;
  combos: Array<{ type: ComboType; keys: RiskFactorKey[]; issueId: string | null }>;
  score: number;
  images: string[];
  /** RBAC bindings that give this workload's service account its risky permissions */
  bindings: string[];
};

export type RbacRiskKey =
  | "clusterAdmin" | "escalate" | "impersonate" | "webhook" | "nodesProxy"
  | "wildcard" | "secrets" | "exec" | "token" | "csr" | "pv" | "ns";

export type RbacRiskDef = { key: RbacRiskKey; label: string; raw: string; grade: "crit" | "warn" };

export type RbacMatrixRow = {
  binding: string;
  kind: "ClusterRoleBinding" | "RoleBinding";
  namespace?: string;
  role: string;
  subjects: string[];
  /** Heatmap row of the service account subject, when it runs a workload */
  workloadId: string | null;
  keys: RbacRiskKey[];
  /** Granted only through a weaker verb (e.g. pods/exec via get) — not confirmed */
  conditional: RbacRiskKey[];
  /** `resources:verbs` of the rules behind `keys` */
  rules: string[];
};

// ── Network (Hubble flows at workload granularity) ──

export type NetNodeKind = "workload" | "paas" | "apiserver" | "internet" | "node" | "probe" | "platform" | "unknown";
export type NetEdgeClass = "eastwest" | "cloud" | "internet" | "control" | "platform";

export type NetNode = {
  id: string;
  kind: NetNodeKind;
  label: string;
  sub: string;
  namespace?: string;
  managed?: boolean;
  combos?: ComboType[];
  /** Azure PaaS only */
  azureType?: string;
  publicAccess?: string | null;
  host?: string;
  ips?: string[];
  /** Other resources answering on the same front-end IP — identification uncertain */
  sharedIpWith?: string[];
};

export type NetEdge = {
  from: string;
  to: string;
  ports: string[];
  /** Connection-initiating events (replies excluded), summed over each node's retained window */
  count: number;
  dropped: number;
  cls: NetEdgeClass;
  note?: string;
};

export type ExternalIpDetail = { ip: string; ports: number[]; count: number; from: string[] };

export type NetworkInsight = {
  available: boolean;
  /** Why the network view is empty or partial */
  reason?: string;
  coverage: HubbleCoverage | null;
  nodes: NetNode[];
  edges: NetEdge[];
  /** World destinations that matched no Azure resource */
  unmatchedExternal: ExternalIpDetail[];
  /** Azure resources could be listed and matched by IP */
  azureMatched: boolean;
};

export type ClusterContainment = {
  subscription: string | null;
  resourceGroup: string;
  cluster: {
    name: string;
    location: string;
    k8sVersion: string;
    nodes: number;
    privateCluster: boolean | null;
    authorizedIpRanges: number | null;
    localAccounts: boolean | null;
    entraIntegrated: boolean | null;
    azureRbac: boolean | null;
    outboundType: string | null;
  };
  /** Azure resources the cluster talks to (network node ids) */
  resources: Array<{ id: string; name: string; type: string; resourceGroup: string }>;
};

// ── KBOM ──

export type KbomItem = {
  tech: string;
  repo: string;
  registry: string;
  versions: string[];
  workloads: string[];
  managed: boolean;
  category: string;
  flags: Array<{ key: "drift" | "snapshot" | "public"; label: string }>;
};

export type Kbom = {
  platform: Array<{ label: string; value: string; note: string }>;
  items: KbomItem[];
  summary: { images: number; registries: string[]; drift: number; snapshot: number; publicPull: number; digestPinned: number };
};

// ── Risk combinations (issues) with an evidence-graded attack path ──

export type FactRow = { k: string; v: string; ev?: EvidenceKind; src?: string; mono?: boolean };

export type AttackNodeType = "network" | "workload" | "secret" | "identity" | "permission" | "azure" | "node" | "credential" | "impact";

export type AttackNode = {
  id: string;
  /** 0 진입 · 1 워크로드 · 2 신원·비밀 · 3 권한·채널 · 4 영향 */
  col: 0 | 1 | 2 | 3 | 4;
  row: number;
  type: AttackNodeType;
  label: string;
  sub: string;
  unk?: boolean;
  badges?: Array<{ n: number; what: string }>;
  /** Things to confirm (shown as callouts, never as risk) */
  notes?: string[];
  facts: FactRow[];
  /** Heatmap row ids / network node ids this node stands for */
  refs: string[];
  /** Read-only verification command */
  cmd?: string;
};

export type AttackEdge = { from: string; to: string; ev: EvidenceKind; label: string; cut?: string; why?: string };

export type RemediationAction = {
  id: string;
  title: string;
  desc: string;
  risk: "ok" | "warn" | "crit";
  riskLabel: string;
  /** Finding ids this action resolves */
  closes: string[];
  /** Attack edges (`from>to`) this action removes */
  cuts: string[];
  effect: "closed" | "reduced" | "exception";
  /** Plain text; lines starting with "+ " / "- " / "# " are rendered as add / delete / comment */
  code: string;
};

export type RiskIssue = {
  id: string;
  sev: "crit" | "warn";
  kind: ComboType | "local";
  title: string;
  owner: string;
  ownerGroup: "mine" | "addon" | "azure";
  findingIds: string[];
  /** Evidence chips that are not edge counts (e.g. "Azure 리소스 매칭 2", "? 진입 미확인") */
  extraEvidence: Array<[EvidenceKind, string]>;
  confNote?: string;
  nodes: AttackNode[];
  edges: AttackEdge[];
  actions: RemediationAction[];
};

export type PolicyInsightsResponse = {
  clusterId: string;
  generatedAt: string;
  factors: RiskFactorDef[];
  rows: WorkloadRiskRow[];
  riskDict: RbacRiskDef[];
  matrix: RbacMatrixRow[];
  issues: RiskIssue[];
  network: NetworkInsight;
  containment: ClusterContainment;
  kbom: Kbom;
  /** Sources that could not be read — each degrades its section only */
  gaps: string[];
};
