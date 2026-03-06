import { ResourceGraphClient } from "@azure/arm-resourcegraph";
import { ClientSecretCredential } from "@azure/identity";
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
  const armToken = await withTokenTimeout(getArmToken(env, bearerToken), "OBO ARM");
  return buildFetcher(armToken);
}

export type LogAnalyticsFetcher = {
  token: string;
  query: (workspaceId: string, kql: string) => Promise<unknown>;
};

export async function getLogAnalyticsFetcher(env: Env, bearerToken: string): Promise<LogAnalyticsFetcher> {
  const token = await withTokenTimeout(getLogAnalyticsToken(env, bearerToken), "OBO LogAnalytics");
  return buildLogFetcher(token);
}

// ────────────────────────────────────────────
// SP Fallback variants — no user bearer token required
// Uses ClientSecretCredential directly.
// ────────────────────────────────────────────

function ensureSPConfig(env: Env): { tenantId: string; clientId: string; clientSecret: string } {
  const tenantId = env.AZURE_AD_TENANT_ID;
  const clientId = env.AZURE_AD_CLIENT_ID;
  const clientSecret = env.AZURE_AD_CLIENT_SECRET;
  if (!tenantId || !clientId || !clientSecret) {
    throw new Error("SP not configured: AZURE_AD_TENANT_ID, CLIENT_ID, CLIENT_SECRET required");
  }
  return { tenantId, clientId, clientSecret };
}

let _spCredential: ClientSecretCredential | undefined;

async function getSPToken(env: Env, scope: string): Promise<string> {
  if (!_spCredential) {
    const { tenantId, clientId, clientSecret } = ensureSPConfig(env);
    _spCredential = new ClientSecretCredential(tenantId, clientId, clientSecret);
  }
  const result = await withTokenTimeout(_spCredential.getToken(scope), "SP");
  return result.token;
}

export async function getArmFetcherSP(env: Env): Promise<ArmFetcher> {
  const armToken = await getSPToken(env, "https://management.azure.com/.default");
  return buildFetcher(armToken);
}

export async function getLogAnalyticsFetcherSP(env: Env): Promise<LogAnalyticsFetcher> {
  const token = await getSPToken(env, "https://api.loganalytics.io/.default");
  return buildLogFetcher(token);
}

/**
 * Smart ARM fetcher — tries OBO if bearer token available, falls back to SP.
 */
export async function getArmFetcherAuto(env: Env, bearerToken: string | undefined): Promise<ArmFetcher> {
  if (bearerToken) {
    try {
      return await getArmFetcher(env, bearerToken);
    } catch {
      // OBO failed, fall through to SP
    }
  }
  return getArmFetcherSP(env);
}

/**
 * Smart Log Analytics fetcher — tries OBO if bearer token available, falls back to SP.
 */
export async function getLogAnalyticsFetcherAuto(env: Env, bearerToken: string | undefined): Promise<LogAnalyticsFetcher> {
  if (bearerToken) {
    try {
      return await getLogAnalyticsFetcher(env, bearerToken);
    } catch {
      // OBO failed, fall through to SP
    }
  }
  return getLogAnalyticsFetcherSP(env);
}

/** Get a ClientSecretCredential instance (for SDK clients like Storage). */
export function getSPCredential(env: Env): ClientSecretCredential {
  const { tenantId, clientId, clientSecret } = ensureSPConfig(env);
  return new ClientSecretCredential(tenantId, clientId, clientSecret);
}

// ── Internal helpers ──

/** Default request timeout for Azure ARM / Log Analytics calls (ms).
 *  Resource Health availability statuses can be slow (15s+), so we
 *  allow 30s per individual request.  Per-operation timeouts in
 *  callers (e.g. HEALTH_SUMMARY_TIMEOUT_MS) still act as the hard ceiling. */
const ARM_FETCH_TIMEOUT_MS = 30_000;

/** Timeout for Azure AD token acquisition (ms). */
const TOKEN_ACQUIRE_TIMEOUT_MS = 10_000;

/** Wrap a token-acquisition promise with a hard timeout. */
async function withTokenTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: token acquisition timed out (${TOKEN_ACQUIRE_TIMEOUT_MS}ms)`)), TOKEN_ACQUIRE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

function buildFetcher(armToken: string): ArmFetcher {
  return {
    armToken,
    async fetchJson<T>(url: string): Promise<T> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ARM_FETCH_TIMEOUT_MS);
      try {
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${armToken}`, "Content-Type": "application/json" },
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`ARM ${res.status}: ${await res.text()}`);
        return res.json() as Promise<T>;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function buildLogFetcher(token: string): LogAnalyticsFetcher {
  return {
    token,
    async query(workspaceId: string, kql: string): Promise<unknown> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ARM_FETCH_TIMEOUT_MS);
      const url = `https://api.loganalytics.io/v1/workspaces/${workspaceId}/query`;
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ query: kql }),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`LogAnalytics ${res.status}: ${await res.text()}`);
        return res.json();
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
