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
  | "exposure" | "vuln" | "root" | "privEsc" | "host" | "automount" | "highRbac"
  | "secret" | "noIngress" | "noEgress" | "extEgress" | "psa";

// ── Image vulnerabilities (the entry point of an attack path) ──

export type VulnSeverity = "critical" | "high" | "medium" | "low" | "unknown";
/**
 * Unresolved vulnerabilities of one running image. `source`: Defender for Containers (registry / running-image
 * assessment) or the SBOM path (a known open-source image at its exact tag → OSV, CVE.org, CISA KEV). Images that
 * neither source covers have no entry — "not scanned", never "clean".
 */
export type ImageVuln = {
  image: string;
  source: "defender" | "sbom";
  /** How the scan result was tied to this pod's image: digest, tag, or the SBOM module version */
  basis: "digest" | "tag" | "version";
  counts: Record<Exclude<VulnSeverity, "unknown">, number>;
  /** Strongest exploitation signal: CISA KEV > CVE.org SSVC active > proof of concept / Defender exploit published */
  exploited: "kev" | "active" | "poc" | null;
  /** Findings with a fixed version */
  fixable: number;
  /** Worst first, at most 5 */
  top: Array<{ id: string; cve: string | null; severity: VulnSeverity; exploited: "kev" | "active" | "poc" | null; pkg: string; version: string; fixed: string | null; url: string | null }>;
};
export type VulnCoverage = {
  /** Distinct images running in the cluster */
  images: number;
  /** Images with a result from either source */
  scanned: number;
  defender: "ok" | "noData" | "failed";
  /** Images the SBOM path could map to a known project at an exact version */
  sbomMapped: number;
  sbom: "ok" | "disabled" | "failed";
  /** Lookups still running — the next load fills them */
  pending: number;
};

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

/**
 * `azureService` = a Microsoft service's public endpoint named by an official service tag (Entra ID, ARM, Azure
 * Monitor …) — not a resource of this tenant. `private` = a private address outside the cluster that matched no
 * Azure resource (another VNet, peering, VPN / on-premises) — not the Internet.
 */
export type NetNodeKind = "workload" | "paas" | "apiserver" | "internet" | "azureService" | "private" | "node" | "probe" | "platform" | "unknown";
export type NetEdgeClass = "eastwest" | "cloud" | "private" | "internet" | "control" | "platform";

/** Which address the cluster actually reached: a private IP (Private Endpoint, VNet) or the public endpoint — observed */
export type PaasPath = "private" | "public" | "mixed";

/**
 * Who can reach the resource from the Internet — configuration, independent of the cluster's own path:
 * closed (public access off) · restricted (public on, default deny + allow-lists) · open (public on, no IP filter)
 * · unknown (the network rules could not be read)
 */
export type PaasExposure = "closed" | "restricted" | "open" | "unknown";

export type PaasNetworkRules = {
  /** Allow = every address that reaches the endpoint; Deny = only the lists below */
  defaultAction: "Allow" | "Deny" | null;
  ipRules: number | null;
  /** Allowed VNet subnets as `vnet/subnet` (max 10) — check for subnets of another environment */
  vnetRules: string[] | null;
  /** The type has no IP firewall at all (Azure Managed Redis): public access on = open to every address */
  noIpFirewall?: boolean;
  /** Where the facts came from (resource property or child resource) */
  source: string;
};

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
  /** Private IPs of this resource's Private Endpoints (ARM network interfaces) */
  peIps?: string[];
  /** Destination IPs the cluster used for this node (observed) */
  observedIps?: string[];
  path?: PaasPath;
  /** How the destination was identified: Private Endpoint NIC IP · DNS name seen by Cilium · DNS lookup of the host · service tag */
  matchedBy?: Array<"peIp" | "dnsName" | "dnsLookup" | "serviceTag">;
  exposure?: PaasExposure;
  network?: PaasNetworkRules | null;
  /** Key / shared-key / local authentication: on = a leaked key works from wherever the network allows */
  keyAuth?: "on" | "off" | null;
  /** azureService only: the service tag (e.g. AzureActiveDirectory) and the most specific matching prefix */
  serviceTag?: string;
  prefix?: string;
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

/** `count` = all connection attempts, `dropped` = of those, denied by policy (did not leave) */
export type ExternalIpDetail = { ip: string; ports: number[]; count: number; dropped: number; from: string[]; names?: string[] };

export type NetworkInsight = {
  available: boolean;
  /** Why the network view is empty or partial */
  reason?: string;
  coverage: HubbleCoverage | null;
  nodes: NetNode[];
  edges: NetEdge[];
  /** Public world destinations that matched no Azure resource and no service tag */
  unmatchedExternal: ExternalIpDetail[];
  /** Private addresses outside the cluster that matched no Azure resource (VNet · peering · VPN) */
  privateExternal: ExternalIpDetail[];
  /** Azure resources could be listed and matched by IP */
  azureMatched: boolean;
  /** Service tags could be read (null = not attempted) */
  serviceTagsMatched: boolean | null;
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
  /** Azure resources the cluster talks to (network node ids). `type` is a display label; `armType` the full ARM type
   *  ("microsoft.keyvault/vaults"), or only its last segment when unknown. `resourceGroup` is "" when the type + name pair is not unique. */
  resources: Array<{ id: string; name: string; type: string; armType: string; resourceGroup: string }>;
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
  /** Worst vulnerability result among this repo's running images (absent = not scanned) */
  vuln?: { counts: ImageVuln["counts"]; exploited: ImageVuln["exploited"]; source: ImageVuln["source"] };
};

export type Kbom = {
  platform: Array<{ label: string; value: string; note: string }>;
  items: KbomItem[];
  summary: {
    images: number; registries: string[]; drift: number; snapshot: number; publicPull: number; digestPinned: number;
    /** Repos with a critical/high or exploited finding — null when no vulnerability source was read */
    vulnerable?: number | null;
    /** Repos with any scan result */
    scanned?: number;
  };
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
  /**
   * Every workload the issue is about, riskiest first (grouped issues — standing privilege). The title stays one line;
   * the graph may fold the tail into a "+n" node, this list never does.
   */
  members?: Array<{ rowId: string; name: string; namespace: string; owner: string; grade: "crit" | "warn"; permissions: string[]; bindings: string[] }>;
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
  /** Image vulnerabilities by image reference + what was covered; null = not collected (feature off / failed) */
  vulns?: { byImage: ImageVuln[]; coverage: VulnCoverage } | null;
  /** Sources that could not be read — each degrades its section only */
  gaps: string[];
};
