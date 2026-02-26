export type ArgoAppSummary = {
  name: string;
  namespace?: string;
  project?: string;
  health?: string;
  sync?: string;
  repo?: string;
  revision?: string;
  lastDeployedAt?: string;
};

export type ArgoAppsResponse = {
  generatedAt: string;
  apps: ArgoAppSummary[];
  note?: string;
};
