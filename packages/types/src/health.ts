export type ResourceHealthStatus = {
  resourceId: string;
  resourceName: string;
  resourceType: string;
  resourceGroup: string;
  availabilityState: "Available" | "Degraded" | "Unavailable" | "Unknown";
  summary?: string;
  occurredTime?: string;
};

export type HealthSummary = {
  generatedAt: string;
  available: number;
  degraded: number;
  unavailable: number;
  unknown: number;
  resources: ResourceHealthStatus[];
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
};
