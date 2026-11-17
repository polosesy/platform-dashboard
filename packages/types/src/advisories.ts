// 보안 › 긴급 취약점 (/api/security/advisories — services/advisories.ts): urgent vulnerability news from official
// sources (CISA KEV, NVD, Node.js and PHP security releases, Microsoft Defender for Cloud container findings),
// matched against what this platform runs: the dashboard's own runtime, the selected cluster's images, and the
// images Defender scanned. A version is "fixed" only against the vendor's own security release for that line —
// never against a bundled library's version number (Node.js patches its bundled Brotli without renaming it).

export type AdvisoryProduct = "nodejs" | "php";
export type AdvisorySourceId = "cveorg" | "kev" | "nvd" | "osv" | "nodejs" | "php" | "defender" | "cluster" | "platform";
/** ok · failed (network/HTTP) · disabled (AUD_ADVISORY_FEEDS=false) · signin (needs a signed-in user) · noData (nothing to read — e.g. no Defender container findings) */
export type AdvisorySourceState = "ok" | "failed" | "disabled" | "signin" | "noData";

export type AdvisorySource = {
  id: AdvisorySourceId;
  state: AdvisorySourceState;
  checkedAt: string | null;
  /** Official URL the data comes from (fixed allow-list) */
  url?: string;
  detail?: string;
};

export type AdvisoryCve = {
  id: string;
  /** From the CVE.org record (CVE Services): the CNA's title and short name */
  title?: string | null;
  cna?: string | null;
  /** CISA ADP SSVC "Exploitation" on the CVE.org record (none · poc · active) */
  exploitation?: "none" | "poc" | "active" | null;
  /** Where the score came from: the CVE.org record (CNA or CISA ADP) or NVD */
  scoreSource?: "cveorg" | "nvd" | null;
  /** NVD CVSS (v4.0 preferred, else v3.1) — null when NVD wasn't read or has no score yet */
  cvss: { score: number; version: string; severity: string } | null;
  description: string | null;
  published: string | null;
  /** On the CISA Known Exploited Vulnerabilities catalog = exploited in the wild */
  kev: { dateAdded: string; dueDate: string; ransomware: boolean; requiredAction: string } | null;
};

/** A fixed (security) release per supported line, from the vendor's own release index */
export type AdvisoryFix = { line: string; version: string; date: string };

export type ExposureStatus = "affected" | "fixed" | "unknown" | "eol";
export type ExposureEvidence = "runtime" | "imageTag" | "defender";

export type ExposureTarget = {
  id: string;
  evidence: ExposureEvidence;
  product: AdvisoryProduct | null;
  /** "이 대시보드" or "<namespace>/<workload>" … */
  where: string;
  image: string | null;
  workloads: string[];
  /** Package for Defender findings (e.g. openssl, php8.3-cli) */
  pkg: string | null;
  current: string | null;
  fixed: string | null;
  status: ExposureStatus;
  /** Why unknown / which CVEs apply */
  note: string | null;
  cves: string[];
};

/** affected = at least one target needs the update · clear = checked, nothing affected · notDetected = no target of this product found by tag (app images need Defender) · unknown = a source needed to decide failed */
export type AdvisoryStatus = "affected" | "clear" | "notDetected" | "unknown";

export type AdvisoryItem = {
  key: string;
  kind: "vendor" | "kev" | "watch";
  product: AdvisoryProduct | null;
  title: string;
  date: string | null;
  url: string | null;
  cves: AdvisoryCve[];
  fixes: AdvisoryFix[];
  /** Lines with no security release after this advisory — end of life, move to a supported line */
  eolLines: string[];
  targets: ExposureTarget[];
  status: AdvisoryStatus;
  /** Recommended actions (localized), most important first */
  actions: string[];
};

// ── What we run (SBOM) × official advisory databases (OSV: GitHub Advisory DB · Go vulndb · Debian) ──

export type ComponentKind = "npm" | "os" | "k8s" | "image";
export type FindingSeverity = "critical" | "high" | "medium" | "low" | "unknown";

/** One advisory that applies to one package version we run */
export type DependencyFinding = {
  /** OSV id (GHSA-…, GO-…, DEBIAN-CVE-…) */
  id: string;
  cves: string[];
  summary: string | null;
  severity: FindingSeverity;
  cvss: { score: number; version: string } | null;
  /** kev = on CISA KEV · active / poc = CISA ADP SSVC on the CVE.org record */
  exploited: "kev" | "active" | "poc" | null;
  kind: ComponentKind;
  ecosystem: string;
  pkg: string;
  version: string;
  /** Smallest fixed version above ours in the advisory (null = no fix published yet) */
  fixed: string | null;
  where: "platform" | "cluster";
  /** API · 웹 · OS, or <namespace>/<workload> */
  components: string[];
  image: string | null;
  url: string;
};

export type AdvisoriesResponse = {
  generatedAt: string;
  clusterId: string | null;
  sources: AdvisorySource[];
  /** What this platform runs that the feeds can be checked against */
  runtimes: Array<{ product: AdvisoryProduct; version: string; where: string; evidence: ExposureEvidence }>;
  items: AdvisoryItem[];
  summary: { affected: number; unknown: number; clear: number; kevRecent: number; findingsSevere: number };
  /** What was checked against OSV, by kind and place */
  components: { platform: number; cluster: number; byKind: Record<ComponentKind, number>; unmappedImages: number };
  findings: DependencyFinding[];
};

// ── 선제 감시 (early watch — GET /api/security/early-watch, services/earlyWatch.ts) ──
// The API polls the vendors' own pages on their published schedule — Oracle's Critical Patch Update / Critical Security
// Patch Update pre-release announcements (the Thursday before the third Tuesday) and advisories, Oracle Security
// Alerts, OpenJDK Vulnerability Group advisories, KISA 보호나라 보안공지 — and the team's watched CVE IDs on CVE.org
// (RESERVED → PUBLISHED). Something new = an event, kept with the time this dashboard first saw it, and sent to the
// alert center (and its outbound channels).

/** Oracle's Java SE part of one advisory page (pre-release or final) — only what the page says */
export type JavaSummary = {
  patches: number | null;
  /** "all" = every one remotely exploitable without authentication; a number = that many; null = not said */
  remoteUnauth: "all" | number | null;
  maxScore: number | null;
  /** "3.1" · "4.0" */
  scoreVersion: string | null;
  /** Oracle Java SE versions named affected, e.g. 8u511 · 11.0.33 · 21.0.13 (the newest affected per line) */
  versions: string[];
  /** CVE IDs in the Java SE risk matrix (final advisory only — a pre-release names none) */
  cves: string[];
};

export type OracleCycle = {
  /** cpu = quarterly Critical Patch Update · cspu = Critical Security Patch Update (the other months) */
  kind: "cpu" | "cspu";
  /** "2026-11" */
  month: string;
  /** 13:00 America/Los_Angeles on the third Tuesday (UTC ISO) */
  releaseAt: string;
  /** The Thursday before (date only — Oracle gives no time) */
  preReleaseDate: string;
  url: string;
  /** notYet = 404 · preRelease = the pre-release announcement is up · released = the advisory · failed = not read */
  state: "notYet" | "preRelease" | "released" | "failed" | "unchecked";
  /** Oracle's own page update time */
  updatedAt: string | null;
  /** When this dashboard first saw the current state */
  firstSeenAt: string | null;
  java: JavaSummary | null;
  checkedAt: string | null;
};

export type OpenJdkAdvisory = {
  date: string;
  url: string;
  /** "The affected versions are …, and earlier" — versions as written (e.g. 21.0.13.0.2 · 8u504) */
  affected: string[];
  cves: Array<{ id: string; score: number | null; lines: number[] }>;
};

export type EarlyWatchSourceId = "oracle" | "oracleAlerts" | "openjdk" | "kisa" | "cveorg";
export type EarlyWatchEvent = {
  key: string;
  source: EarlyWatchSourceId;
  kind: "preRelease" | "released" | "securityAlert" | "openjdkAdvisory" | "kisaNotice" | "cvePublished" | "cveRejected";
  title: string;
  url: string;
  /** When this dashboard first saw it */
  firstSeenAt: string;
  cves: string[];
  maxScore: number | null;
  /** Sent to the alert center (false = recorded quietly — the first check after a restart without a state file) */
  notified: boolean;
};

export type WatchedCve = {
  id: string;
  note?: string;
  addedBy?: string;
  addedAt: string;
  /** CVE.org's own state: RESERVED (number only) · PUBLISHED · REJECTED; unknown = not read yet / failed */
  state: "RESERVED" | "PUBLISHED" | "REJECTED" | "unknown";
  checkedAt: string | null;
  /** When this dashboard first saw it PUBLISHED */
  publishedSeenAt: string | null;
  title: string | null;
  cna: string | null;
  cvss: { score: number; version: string; severity: string } | null;
  published: string | null;
};

export type EarlyWatchResponse = {
  /** false = AUD_ADVISORY_FEEDS off or AUD_ADVISORY_WATCH_INTERVAL_SEC=0 */
  enabled: boolean;
  intervalSec: number;
  /** Faster around the vendors' release windows */
  fastIntervalSec: number;
  lastCheckAt: string | null;
  nextCheckAt: string | null;
  /** State kept on disk (AUD_ARRANGEMENT_DIR) — else in memory: a restart forgets first-seen times */
  durable: boolean;
  canWrite: boolean;
  rev: number;
  sources: Array<{ id: EarlyWatchSourceId; state: "ok" | "failed" | "disabled" | "unchecked"; checkedAt: string | null; url: string; detail?: string }>;
  oracle: { current: OracleCycle; next: OracleCycle; alerts: Array<{ id: string; url: string; firstSeenAt: string }> };
  openjdk: OpenJdkAdvisory | null;
  /** KISA notices whose title names a watched product (Java · Oracle · OpenJDK) or a watched CVE */
  kisa: Array<{ title: string; url: string; date: string | null; matched: string[] }>;
  kisaChecked: number;
  watch: WatchedCve[];
  events: EarlyWatchEvent[];
};
