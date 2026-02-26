export type MonitorAlert = {
  id: string;
  name: string;
  severity: "Sev0" | "Sev1" | "Sev2" | "Sev3" | "Sev4";
  monitorCondition: "Fired" | "Resolved";
  targetResource: string;
  targetResourceType: string;
  firedAt: string;
  resolvedAt?: string;
  description?: string;
};

export type AlertSummary = {
  generatedAt: string;
  totalActive: number;
  bySeverity: { sev0: number; sev1: number; sev2: number; sev3: number; sev4: number };
  recentAlerts: MonitorAlert[];
  note?: string;
};

export type Incident = {
  id: string;
  title: string;
  severity: string;
  status: "Active" | "Mitigated" | "Resolved";
  startedAt: string;
  mitigatedAt?: string;
  resolvedAt?: string;
  impactedResources: string[];
};

export type AlertTimelineResponse = {
  generatedAt: string;
  alerts: MonitorAlert[];
  incidents: Incident[];
  note?: string;
};
