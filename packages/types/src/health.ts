export type ResourceHealthStatus = {
  resourceId: string;
  resourceName: string;
  resourceType: string;
  resourceGroup: string;
  subscriptionId: string;
  location?: string;
  availabilityState: "Available" | "Degraded" | "Unavailable" | "Unknown";
  summary?: string;
  reasonType?: string;
  reasonChronicity?: string;
  occurredTime?: string;
  reportedTime?: string;
};

export type HealthSummary = {
  generatedAt: string;
  available: number;
  degraded: number;
  unavailable: number;
  unknown: number;
  resources: ResourceHealthStatus[];
  subscriptions: string[];
  note?: string;
};

// ── Tab 1: Global Region Health (Azure Status RSS) ──

export type GlobalStatusIncidentStatus = "Active" | "Investigating" | "Mitigated" | "Resolved";

export type GlobalStatusIncident = {
  id: string;
  title: string;
  description: string;
  pubDate: string;
  link: string;
  affectedRegions: string[];
  affectedServices: string[];
  status: GlobalStatusIncidentStatus;
};

export type GlobalStatusResponse = {
  generatedAt: string;
  activeIncidents: number;
  incidents: GlobalStatusIncident[];
  note?: string;
};

// ── Tab 3: Service Status (Azure Service Health Events) ──

export type ServiceHealthEventType =
  | "ServiceIssue"
  | "PlannedMaintenance"
  | "HealthAdvisory"
  | "SecurityAdvisory";

export type ServiceHealthEvent = {
  id: string;
  eventType: ServiceHealthEventType;
  title: string;
  summary: string;
  status: string;
  level: "Warning" | "Error" | "Informational";
  impactStartTime?: string;
  impactMitigationTime?: string;
  lastUpdateTime?: string;
  affectedServices: string[];
  affectedRegions: string[];
  isResolved: boolean;
};

export type ServiceHealthEventsResponse = {
  generatedAt: string;
  totalEvents: number;
  byType: {
    serviceIssue: number;
    plannedMaintenance: number;
    healthAdvisory: number;
    securityAdvisory: number;
  };
  events: ServiceHealthEvent[];
  note?: string;
  tenantId?: string;
};

// ── Regional Status (user's deployed regions × service health) ──

export type RegionHealthStatus = {
  name: string;         // Azure internal name e.g. "eastus", "koreacentral"
  displayName: string;  // Human-readable e.g. "East US", "Korea Central"
  hasActiveIssues: boolean;
  serviceIssueCount: number;
  maintenanceCount: number;
  affectedServices: string[];
  events: ServiceHealthEvent[];
};

export type RegionalStatusResponse = {
  generatedAt: string;
  regions: RegionHealthStatus[];
  totalAffected: number;
  note?: string;
};

// ── Tab 2 supplement: what Resource Health covers (GET /api/health/coverage) ──

/**
 * noStatusListed    on Microsoft's supported list, but Azure returned no status for it
 * noStatusUnlisted  not on the supported list, and no status returned
 * statusUnlisted    not on the list, yet Azure returned a status (seen: metric alerts, backup vaults — as Unknown)
 */
export type HealthCoverageBucket = "noStatusListed" | "noStatusUnlisted" | "statusUnlisted";
export type HealthCoverageType = { type: string; count: number; bucket: HealthCoverageBucket };

/** Counts by resource type only — no names, ids or subscriptions */
export type HealthCoverage = {
  generatedAt: string;
  /** Microsoft Learn "Supported Resource Types through Azure Resource Health" — the snapshot's source and ms.date */
  doc: { url: string; date: string };
  /** Resources in the inventory (Resource Graph) / of them, with no Resource Health status */
  inventoryResources: number;
  noStatusResources: number;
  types: HealthCoverageType[];
  /** What Azure checks, per type with a status (Learn "Executed Checks", in the request language) */
  checks: Record<string, string[]>;
  /** A part that could not be read — its numbers are left out, never guessed */
  gaps: ("inventory" | "health")[];
  note?: string;
};
