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
