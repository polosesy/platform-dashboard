import type { Env } from "../env";
import type { ArgoAppSummary } from "../types";

type ArgoApplicationList = {
  items?: Array<{
    metadata?: { name?: string; namespace?: string };
    spec?: {
      project?: string;
      source?: { repoURL?: string; targetRevision?: string };
    };
    status?: {
      health?: { status?: string };
      sync?: { status?: string; revision?: string };
      operationState?: { finishedAt?: string };
    };
  }>;
};

export async function fetchArgoApps(env: Env): Promise<ArgoAppSummary[] | null> {
  if (!env.ARGOCD_BASE_URL || !env.ARGOCD_TOKEN) return null;

  const url = `${env.ARGOCD_BASE_URL.replace(/\/$/, "")}/api/v1/applications`;
  const res = await fetch(url, {
    headers: {
      authorization: `Bearer ${env.ARGOCD_TOKEN}`
    }
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ArgoCD HTTP ${res.status} ${res.statusText}${text ? `: ${text}` : ""}`);
  }

  const raw = (await res.json()) as ArgoApplicationList;
  const items = raw.items ?? [];
  const apps: ArgoAppSummary[] = items.flatMap((i) => {
    const name = i.metadata?.name;
    if (!name) return [];
    const app: ArgoAppSummary = {
      name,
      namespace: i.metadata?.namespace,
      project: i.spec?.project,
      health: i.status?.health?.status,
      sync: i.status?.sync?.status,
      repo: i.spec?.source?.repoURL,
      revision: i.status?.sync?.revision ?? i.spec?.source?.targetRevision,
      lastDeployedAt: i.status?.operationState?.finishedAt
    };
    return [app];
  });

  return apps;
}
