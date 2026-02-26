import { ResourceGraphClient } from "@azure/arm-resourcegraph";
import type { Env } from "../env";
import { getOBOCredential, getArmToken, getLogAnalyticsToken } from "./oboTokenPool";

export function getResourceGraphClient(env: Env, bearerToken: string): ResourceGraphClient {
  const credential = getOBOCredential(env, bearerToken);
  return new ResourceGraphClient(credential);
}

export type ArmFetcher = {
  armToken: string;
  fetchJson: <T>(url: string) => Promise<T>;
};

export async function getArmFetcher(env: Env, bearerToken: string): Promise<ArmFetcher> {
  const armToken = await getArmToken(env, bearerToken);
  return {
    armToken,
    async fetchJson<T>(url: string): Promise<T> {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${armToken}`, "Content-Type": "application/json" },
      });
      if (!res.ok) throw new Error(`ARM ${res.status}: ${await res.text()}`);
      return res.json() as Promise<T>;
    },
  };
}

export type LogAnalyticsFetcher = {
  token: string;
  query: (workspaceId: string, kql: string) => Promise<unknown>;
};

export async function getLogAnalyticsFetcher(env: Env, bearerToken: string): Promise<LogAnalyticsFetcher> {
  const token = await getLogAnalyticsToken(env, bearerToken);
  return {
    token,
    async query(workspaceId: string, kql: string): Promise<unknown> {
      const url = `https://api.loganalytics.io/v1/workspaces/${workspaceId}/query`;
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query: kql }),
      });
      if (!res.ok) throw new Error(`LogAnalytics ${res.status}: ${await res.text()}`);
      return res.json();
    },
  };
}
