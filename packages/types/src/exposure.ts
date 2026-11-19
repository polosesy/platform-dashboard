// 노출 관리 (CTEM — Gartner Continuous Threat Exposure Management: scoping → discovery → prioritization → validation →
// mobilization). Wiz's Exposure Management dashboard counts the five stages over its own scanners; this platform counts
// them over what Azure and the clusters already hold. Every number here is a count of rows of one Resource Graph table
// (its KQL is in `queries`); null = could not be read (never 0). Prioritization, validation and remediation are counted
// on the page from the issue list (the same function), so they match it by construction.

/** Asset classes (Scoping) — Azure types counted in each; null coverage = no Defender plan covers the class */
export type ExposureAssetClass =
  | "subscriptions" | "kubernetesClusters" | "virtualMachines" | "containerRegistries" | "dataStores"
  | "keyVaults" | "identities" | "applicationEndpoints" | "aiWorkloads" | "onPremServers";

/** Sources Wiz reads that this platform has no connection to (shown as such — never a 0) */
export type ExposureNotConnected = "codeRepositories" | "workstations" | "saas" | "penTests";

export type ExposureAsset = {
  id: ExposureAssetClass;
  total: number | null;
  /** Assets a Defender plan covers (subscription plan Standard, or a resource-level plan); null = no plan covers this class */
  covered: number | null;
  /** Assets of a kind some plan covers — the denominator of `covered` (a public IP has no plan; an App Service has one) */
  coverable: number | null;
  /** The Defender plans that cover the class */
  plans: string[];
};

/** Finding classes (Discovery) — Defender for Cloud assessments, split by what they are about */
export type ExposureFindingClass =
  | "vulnImages" | "vulnContainers" | "vulnHosts" | "cloudConfig" | "containerConfig" | "identity" | "secrets" | "endOfLife" | "threats";

export type ExposureFinding = {
  id: ExposureFindingClass;
  /** Unhealthy assessments (a resource once per recommendation) / active alerts / end-of-support software rows */
  count: number | null;
  /** Distinct resources they are on */
  resources: number | null;
  /** By Defender severity (High · Medium · Low) — alerts: High · Medium · Low · Informational */
  bySeverity?: Record<string, number>;
  /** Why null, or what limits it (e.g. secrets: only subscriptions with Defender CSPM scan for them) */
  note?: "noPlan" | "someSubscriptions" | "noInventory";
};

/** Mitigating controls in place (Validation) */
export type ExposureControlId =
  | "wafPrevention" | "wafDetection" | "appGatewayNoWaf" | "azureFirewalls" | "ddosPlans"
  | "aksPolicyAddon" | "aksDefenderSensor" | "storageDenyByDefault" | "keyVaultPrivate";

export type ExposureControl = {
  id: ExposureControlId;
  count: number | null;
  /** Out of (e.g. clusters, storage accounts) — absent when the count stands alone */
  of?: number | null;
};

export type ExposureResponse = {
  subscriptionIds: string[];
  generatedAt: string;
  assets: ExposureAsset[];
  notConnected: ExposureNotConnected[];
  findings: ExposureFinding[];
  /** Defender CSPM's own contextual risk on findings (Defender's prioritization — a second opinion) */
  defenderRisk: { high: number; medium: number; low: number } | null;
  controls: ExposureControl[];
  /** The KQL behind each number (section → query) */
  queries: Record<string, string>;
  gaps: Array<{ section: "assets" | "plans" | "findings" | "inventory" | "alerts" | "controls"; message: string }>;
};

/** First and last time the dashboard saw an issue (the issue list reports what it computed) — SLA ages start here */
export type IssueSighting = { first: string; last: string; sev: "critical" | "high" | "medium" | "low" };

export type IssueSightingsResponse = {
  sightings: Record<string, IssueSighting>;
  durable: boolean;
};
