import type { SecureScoreControl } from "./security.js";

/** Defender recommendation severity. */
export type PostureSeverity = "High" | "Medium" | "Low";

/** Wiz-style finding domain, mapped from Defender `metadata.categories`. */
export type PostureDomain = "identity" | "network" | "data" | "compute" | "container" | "appServices" | "other";

/** One affected resource — names only (no subscription IDs leave the API). */
export type PostureResourceRef = {
  name: string;
  type: string;
  resourceGroup: string;
  /** Full ARM type, lowercase ("microsoft.keyvault/vaults"); absent for non-ARM samples (Entra users, …) */
  armType?: string;
};

/** One Defender recommendation, aggregated over every resource it was assessed on. */
export type PostureRecommendation = {
  /** Assessment key (the same key for every resource the recommendation applies to). */
  key: string;
  title: string;
  severity: PostureSeverity;
  domain: PostureDomain;
  /** Defender threat categories, e.g. DataExfiltration, AccountBreach. */
  threats: string[];
  unhealthy: number;
  healthy: number;
  /** Up to 5 unhealthy resources. */
  samples: PostureResourceRef[];
  description?: string;
  remediation?: string;
  userImpact?: string;
  implementationEffort?: string;
  portalUrl: string;
};

export type PostureComplianceStandard = {
  name: string;
  state: string;
  passed: number;
  failed: number;
  skipped: number;
};

export type PostureDefenderPlan = { name: string; tier: string; subPlan?: string };

export type PostureAlert = {
  id: string;
  title: string;
  severity: "High" | "Medium" | "Low" | "Informational";
  status: string;
  /** Defender MITRE ATT&CK intent, e.g. PreAttack, InitialAccess. */
  intent?: string;
  detectedAt: string;
  description: string;
  /** Resource Graph masked the description ("****") and the Defender Alerts API did not return it — read it in the portal */
  descriptionHidden?: boolean;
  resources: PostureResourceRef[];
  /** Defender's remediation steps (plain text) */
  remediation?: string[];
  /** The entity Defender names as compromised (GUIDs masked) */
  entity?: string;
  /** Kubernetes entities of the alert */
  k8s?: { namespace?: string; pod?: string; container?: string };
  /** First activity (StartTimeUtc) — `detectedAt` is when it was generated */
  firstAt?: string;
  /** Defender portal link of this alert */
  portalUrl?: string;
};

export type PostureSection = "recommendations" | "affected" | "score" | "controls" | "compliance" | "plans" | "alerts";
export type PostureGap = { section: PostureSection; message: string };

export type SecurityPostureResponse = {
  generatedAt: string;
  source: "azure" | "mock";
  score: { current: number; max: number; percentage: number } | null;
  controls: SecureScoreControl[];
  recommendations: PostureRecommendation[];
  /**
   * Distinct unhealthy resources per severity (`dcount` of the resource id). The sum of `unhealthy` over
   * recommendations counts one resource once per recommendation — a container image with 40 CVE
   * recommendations counted 40 times. null = not read (gap) or sample data.
   */
  affected?: { High: number; Medium: number; Low: number } | null;
  compliance: PostureComplianceStandard[];
  plans: PostureDefenderPlan[];
  alerts: PostureAlert[];
  /** Per-section failures (messages have IDs masked); the rest of the response is still valid. */
  gaps: PostureGap[];
  note?: string;
};
