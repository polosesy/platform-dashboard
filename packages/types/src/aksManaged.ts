// AKS 보안 점검 › 인벤토리 › AKS 관리 부품 — vulnerabilities in the parts Microsoft builds and patches (ama-logs ·
// ama-metrics · Cilium/CNS · CSI · Defender · Azure Policy · CoreDNS …) and when the fix reaches this cluster's region.
// Sources: the AKS Vulnerability Data API (cve-api.prod-aks.azure.com — Microsoft's own scan of each image, trivy) and the
// AKS release tracker (releases.aks.azure.com — the release each region runs). The customer can't patch these images;
// the view says what Microsoft has fixed already (in a newer tag / release) and what it has not.

export type AksManagedFamily = "amaLogs" | "amaMetrics" | "networking" | "csi" | "defender" | "policy" | "kubernetes" | "agc" | "other";

/**
 * Per CVE on the running image: fixedInLatest = the newest tag Microsoft ships for this component no longer has it (it
 * reaches the cluster with the next AKS release / add-on update) · pendingMs = the newest tag still has it (Microsoft has
 * not fixed it yet — waiting on a vendor fix, or not yet rebuilt) · unknown = no scan of a newer tag to compare with
 */
export type AksCveStatus = "fixedInLatest" | "pendingMs" | "unknown";

export type AksManagedCve = {
  id: string;
  status: AksCveStatus;
  /** CISA KEV — exploited in the wild */
  kev: boolean;
  /** CVE.org (CNA, then CISA ADP) — null = not read yet / no score */
  severity: string | null;
  score: number | null;
};

export type AksManagedComponent = {
  family: AksManagedFamily;
  /** Image without tag (mcr.microsoft.com/…) */
  image: string;
  tag: string;
  /** Where it runs: namespace · container names · pod count */
  where: { namespace: string; containers: string[]; pods: number }[];
  /** scanned = Microsoft has a scan report for this exact tag · notScanned = no report (a build newer than the last scan, or not tracked) */
  scan: "scanned" | "notScanned" | "failed";
  cves: AksManagedCve[];
  /**
   * The tag compared against: the newest tag Microsoft ships for this image (AKS release / Kubernetes version reports)
   * that has a scan, newer than ours · same = ours is the newest known (its CVEs are all unfixed) · null = not in those
   * reports (an add-on updated outside the AKS release, e.g. ama-*)
   */
  latest: { tag: string; same: boolean; scan: "scanned" | "notScanned" | "failed"; cves: number | null } | null;
  /** Release notes / changelog of this part */
  notes: string;
};

export type AksNodeImageVulns = {
  /** Node label kubernetes.azure.com/node-image-version */
  image: string;
  nodes: number;
  /** The VHD report path (distro/version) — null = not a known image name */
  report: string | null;
  state: "ok" | "notFound" | "unmapped" | "failed";
  packages: number;
  withCves: number;
  /** Distinct CVE IDs over all OS packages */
  cves: number;
  /** Of them, in the kernel packages (linux-*) — the kernel matches most kernel CVEs regardless of the configuration */
  kernelCves: number;
  top: { name: string; version: string; cves: number }[];
  /** Newest node image of this distro in the region (release tracker) */
  regionCurrent: string | null;
};

export type AksManagedSource = { id: "cveApi" | "releaseTracker" | "kev" | "cveOrg"; state: "ok" | "failed" | "disabled"; checkedAt: string | null; url?: string; detail?: string };

export type AksManagedVulnsResponse = {
  clusterId: string;
  generatedAt: string;
  location: string | null;
  k8sVersion: string | null;
  sources: AksManagedSource[];
  release: {
    /** Newest AKS release with a CVE report */
    latest: string | null;
    /** The AKS release this region runs now (release tracker), when it arrived, its notes, the releases before it */
    region: { current: string; since: string | null; notes: string | null; inProgress: boolean; recent: { version: string; date: string | null }[] } | null;
    /** Releases newer than the region's — not here yet */
    notYetInRegion: string[];
  };
  components: AksManagedComponent[];
  nodeImages: AksNodeImageVulns[];
  totals: { components: number; scanned: number; cves: number; fixedInLatest: number; pendingMs: number; unknown: number; kev: number };
  /** CVE.org details still being read (shown next load) */
  pending: number;
};
