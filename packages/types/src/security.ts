export type SecureScoreControl = {
  controlName: string;
  currentScore: number;
  maxScore: number;
  weight: number;
  healthyResourceCount: number;
  unhealthyResourceCount: number;
};

export type SecureScoreSummary = {
  generatedAt: string;
  currentScore: number;
  maxScore: number;
  percentage: number;
  controlScores: SecureScoreControl[];
  note?: string;
};

export type SecurityAlert = {
  id: string;
  alertName: string;
  severity: "High" | "Medium" | "Low" | "Informational";
  status: "Active" | "Dismissed" | "Resolved";
  compromisedEntity: string;
  description: string;
  detectedAt: string;
  tactics: string[];
};

export type SecurityAlertsResponse = {
  generatedAt: string;
  totalActive: number;
  bySeverity: { high: number; medium: number; low: number; informational: number };
  alerts: SecurityAlert[];
  note?: string;
};
