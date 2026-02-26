export type PipelineRun = {
  id: string;
  pipelineName: string;
  status: "succeeded" | "failed" | "running" | "canceled" | "queued";
  result?: "succeeded" | "failed" | "canceled";
  sourceBranch: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  triggeredBy?: string;
};

export type PipelinesResponse = {
  generatedAt: string;
  runs: PipelineRun[];
  note?: string;
};

export type DeploymentEvent = {
  id: string;
  environment: string;
  releaseName: string;
  status: "succeeded" | "failed" | "inProgress" | "canceled";
  deployedAt: string;
  deployedBy?: string;
};

export type DeploymentHistoryResponse = {
  generatedAt: string;
  deployments: DeploymentEvent[];
  note?: string;
};
