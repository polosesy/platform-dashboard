export type PolicyAssignment = {
  policyId: string;
  displayName: string;
  scope: string;
  complianceState: "Compliant" | "NonCompliant";
  nonCompliantResources: number;
};

export type PolicyComplianceResponse = {
  generatedAt: string;
  compliantResources: number;
  nonCompliantResources: number;
  exemptResources: number;
  compliancePercentage: number;
  policyAssignments: PolicyAssignment[];
  note?: string;
};

export type AdvisorRecommendation = {
  id: string;
  category: "Cost" | "Security" | "Reliability" | "OperationalExcellence" | "Performance";
  impact: "High" | "Medium" | "Low";
  impactedResource: string;
  shortDescription: string;
  extendedProperties?: Record<string, string>;
};

export type AdvisorResponse = {
  generatedAt: string;
  recommendations: AdvisorRecommendation[];
  byCategoryCount: Record<string, number>;
  note?: string;
};
