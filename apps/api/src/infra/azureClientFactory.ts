import { ResourceGraphClient } from "@azure/arm-resourcegraph";
import { ClientSecretCredential } from "@azure/identity";
import type { Env } from "../env.js";
import { getOBOCredential, getArmToken, getLogAnalyticsToken, getPrometheusToken } from "./oboTokenPool.js";

const ARM_SCOPE = "https://management.azure.com/.default";
const LOG_ANALYTICS_SCOPE = "https://api.loganalytics.io/.default";
const PROMETHEUS_SCOPE = "https://prometheus.monitor.azure.com/.default";

/** Default request timeout for Azure ARM / Log Analytics calls (ms).
 *  Resource Health availability statuses can be slow (15s+), so we
 *  allow 30s per individual request.  Per-operation timeouts in
 *  callers (e.g. HEALTH_SUMMARY_TIMEOUT_MS) still act as the hard ceiling. */
const ARM_FETCH_TIMEOUT_MS = 30_000;

/** Timeout for Azure AD token acquisition (ms). */
const TOKEN_ACQUIRE_TIMEOUT_MS = 10_000;

export function getResourceGraphClient(env: Env, bearerToken: string): ResourceGraphClient {
  return new ResourceGraphClient(getOBOCredential(env, bearerToken));
}

export type ArmFetcher = {
  armToken: string;
  fetchJson: <T>(url: string, opts?: { timeoutMs?: number }) => Promise<T>;
  postJson: <T>(url: string, body: unknown, opts?: { timeoutMs?: number }) => Promise<T>;
};

export type LogAnalyticsFetcher = {
  token: string;
  query: (workspaceId: string, kql: string) => Promise<unknown>;
};

export type PrometheusFetcher = {
  token: string;
  query: (endpoint: string, promql: string, time?: string) => Promise<unknown>;
  queryRange: (endpoint: string, promql: string, start: string, end: string, step: string) => Promise<unknown>;
};

// ────────────────────────────────────────────
// OBO (user bearer token) variants
// ────────────────────────────────────────────

export async function getArmFetcher(env: Env, bearerToken: string): Promise<ArmFetcher> {
  return buildArmFetcher(await withTokenTimeout(getArmToken(env, bearerToken), "OBO ARM"));
}

export async function getLogAnalyticsFetcher(env: Env, bearerToken: string): Promise<LogAnalyticsFetcher> {
  return buildLogFetcher(await withTokenTimeout(getLogAnalyticsToken(env, bearerToken), "OBO LogAnalytics"));
}

export async function getPrometheusFetcher(env: Env, bearerToken: string): Promise<PrometheusFetcher> {
  return buildPrometheusFetcher(await withTokenTimeout(getPrometheusToken(env, bearerToken), "OBO Prometheus"));
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

/** Shared ClientSecretCredential (for SDK clients like Storage / Resource Graph). */
export function getSPCredential(env: Env): ClientSecretCredential {
  if (!_spCredential) {
    const { tenantId, clientId, clientSecret } = ensureSPConfig(env);
    _spCredential = new ClientSecretCredential(tenantId, clientId, clientSecret);
  }
  return _spCredential;
}

async function getSPToken(env: Env, scope: string): Promise<string> {
  const result = await withTokenTimeout(getSPCredential(env).getToken(scope), "SP");
  return result.token;
}

export async function getArmFetcherSP(env: Env): Promise<ArmFetcher> {
  return buildArmFetcher(await getSPToken(env, ARM_SCOPE));
}

export async function getLogAnalyticsFetcherSP(env: Env): Promise<LogAnalyticsFetcher> {
  return buildLogFetcher(await getSPToken(env, LOG_ANALYTICS_SCOPE));
}

export async function getPrometheusFetcherSP(env: Env): Promise<PrometheusFetcher> {
  return buildPrometheusFetcher(await getSPToken(env, PROMETHEUS_SCOPE));
}

// ────────────────────────────────────────────
// Auto — tries OBO if a bearer token is available, falls back to SP.
// ────────────────────────────────────────────

async function withSpFallback<T>(
  label: string,
  bearerToken: string | undefined,
  obo: (token: string) => Promise<T>,
  sp: () => Promise<T>,
): Promise<T> {
  if (bearerToken) {
    try {
      return await obo(bearerToken);
    } catch (e) {
      console.warn(`[auth] ${label} OBO failed, falling back to service principal:`, e instanceof Error ? e.message : e);
    }
  }
  return sp();
}

export function getArmFetcherAuto(env: Env, bearerToken: string | undefined): Promise<ArmFetcher> {
  return withSpFallback("ARM", bearerToken, (t) => getArmFetcher(env, t), () => getArmFetcherSP(env));
}

export function getLogAnalyticsFetcherAuto(env: Env, bearerToken: string | undefined): Promise<LogAnalyticsFetcher> {
  return withSpFallback("LogAnalytics", bearerToken, (t) => getLogAnalyticsFetcher(env, t), () => getLogAnalyticsFetcherSP(env));
}

export function getPrometheusFetcherAuto(env: Env, bearerToken: string | undefined): Promise<PrometheusFetcher> {
  return withSpFallback("Prometheus", bearerToken, (t) => getPrometheusFetcher(env, t), () => getPrometheusFetcherSP(env));
}

// ── Internal helpers ──

/** Wrap a token-acquisition promise with a hard timeout. */
async function withTokenTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: token acquisition timed out (${TOKEN_ACQUIRE_TIMEOUT_MS}ms)`)), TOKEN_ACQUIRE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** fetch → JSON with an abort timeout; non-2xx responses throw `<label> <status>: <body>`. */
async function fetchJsonWithTimeout<T>(
  label: string,
  url: string,
  init: RequestInit,
  timeoutMs = ARM_FETCH_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) throw new Error(`${label} ${res.status}: ${await res.text()}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

function buildArmFetcher(armToken: string): ArmFetcher {
  const headers = { Authorization: `Bearer ${armToken}`, "Content-Type": "application/json" };
  return {
    armToken,
    fetchJson: <T>(url: string, opts?: { timeoutMs?: number }) =>
      fetchJsonWithTimeout<T>("ARM", url, { headers }, opts?.timeoutMs),
    postJson: <T>(url: string, body: unknown, opts?: { timeoutMs?: number }) =>
      fetchJsonWithTimeout<T>("ARM", url, { method: "POST", headers, body: JSON.stringify(body) }, opts?.timeoutMs),
  };
}

function buildPrometheusFetcher(token: string): PrometheusFetcher {
  const headers = { Authorization: `Bearer ${token}` };
  return {
    token,
    query(endpoint: string, promql: string, time?: string): Promise<unknown> {
      const params = new URLSearchParams({ query: promql });
      if (time) params.set("time", time);
      return fetchJsonWithTimeout("Prometheus", `${endpoint}/api/v1/query?${params}`, { headers });
    },
    queryRange(endpoint: string, promql: string, start: string, end: string, step: string): Promise<unknown> {
      const params = new URLSearchParams({ query: promql, start, end, step });
      return fetchJsonWithTimeout("Prometheus", `${endpoint}/api/v1/query_range?${params}`, { headers });
    },
  };
}

function buildLogFetcher(token: string): LogAnalyticsFetcher {
  return {
    token,
    query(workspaceId: string, kql: string): Promise<unknown> {
      return fetchJsonWithTimeout("LogAnalytics", `https://api.loganalytics.io/v1/workspaces/${encodeURIComponent(workspaceId)}/query`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query: kql }),
      });
    },
  };
}

// ── Log Analytics result helpers ──

export type LogAnalyticsTable = {
  name: string;
  columns: Array<{ name: string; type: string }>;
  rows: unknown[][];
};

export type LogAnalyticsResponse = {
  tables?: LogAnalyticsTable[];
  error?: { message?: string; code?: string };
};

/** Convert a Log Analytics result table into row objects keyed by column name. */
export function tableToObjects(table: LogAnalyticsTable): Record<string, unknown>[] {
  const cols = table.columns.map((c) => c.name);
  return table.rows.map((row) => {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < cols.length; i++) obj[cols[i]!] = row[i];
    return obj;
  });
}
