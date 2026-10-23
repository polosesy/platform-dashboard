import type { TokenCredential } from "@azure/identity";
import { decodeJwt } from "jose";
import type { Env } from "../env.js";
import { HttpError, maskGuids } from "./requestParams.js";
import {
  connectionForSubscription,
  connectionForWorkspace,
  credentialGroup,
  homeConnection,
  type AzureConnection,
} from "./connectionRegistry.js";
import { credentials, mapCredentialError, signinRequiredError } from "./connectionCredentials.js";
import { accessibleConnections, callerOf, canUse, connectionForbidden } from "./platformAccess.js";

const ARM_SCOPE = "https://management.azure.com/.default";
const LOG_ANALYTICS_SCOPE = "https://api.loganalytics.io/.default";
const PROMETHEUS_SCOPE = "https://prometheus.monitor.azure.com/.default";

/** Default request timeout for Azure ARM / Log Analytics calls (ms).
 *  Resource Health availability statuses can be slow (15s+), so we
 *  allow 30s per individual request.  Per-operation timeouts in
 *  callers (e.g. HEALTH_SUMMARY_TIMEOUT_MS) still act as the hard ceiling. */
const ARM_FETCH_TIMEOUT_MS = 30_000;

// ────────────────────────────────────────────
// Whose identity reads Azure
//
//   signed-in user → the CONNECTION of the data being read (infra/connectionRegistry.ts): the subscription in the
//                    URL / Resource Graph body / resource id, or the workspace. Its credential is the platform's own
//                    identity (platform · lighthouse), the customer's service principal, or — only for a "delegated"
//                    connection — the user's OBO token. The user's platform role must be allowed on that connection
//                    (403 connection_forbidden before any request). Failures are coded (connection_* / OBO codes),
//                    and a connection never falls back to another credential.
//   anonymous      → the platform credential only with AUD_ANONYMOUS_SP=true (local development, loopback bind
//                    enforced in env.ts); otherwise 401 signin_required — routes with sample data answer with it.
// ────────────────────────────────────────────

/** Anonymous reads may use the platform credential (master switch, and the feature's own opt-in when it has one) */
export function anonymousSpAllowed(env: Env, featureFlag = true): boolean {
  return env.AUD_ANONYMOUS_SP && featureFlag;
}

export const signinRequired = signinRequiredError;

export type ArmFetcher = {
  /** `language` = Accept-Language (e.g. "ko-KR") — some providers localise their text (Resource Health summaries) */
  fetchJson: <T>(url: string, opts?: { timeoutMs?: number; language?: string }) => Promise<T>;
  postJson: <T>(url: string, body: unknown, opts?: { timeoutMs?: number }) => Promise<T>;
};

export type LogAnalyticsFetcher = {
  query: (workspaceId: string, kql: string) => Promise<unknown>;
  /**
   * Resource-centric query: the logs one Azure resource sent to any workspace (or a workspace by its ARM id).
   * A resource with no diagnostic setting answers with 0 rows, not an error.
   */
  queryResource: (armId: string, kql: string, timespan: string) => Promise<unknown>;
};

export type PrometheusFetcher = {
  query: (endpoint: string, promql: string, time?: string) => Promise<unknown>;
  queryRange: (endpoint: string, promql: string, start: string, end: string, step: string) => Promise<unknown>;
};

// ── Connection routing ──

const SUB_IN_PATH = /\/subscriptions\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=[/?]|$)/i;
export const subscriptionInPath = (s: string): string | undefined => SUB_IN_PATH.exec(s)?.[1]?.toLowerCase();

/** The connection that owns a subscription; a subscription outside the registry is read by the home connection */
function connectionFor(env: Env, subscriptionId: string | undefined): AzureConnection {
  return (subscriptionId && connectionForSubscription(env, subscriptionId)) || homeConnection(env);
}

function assertCanUse(env: Env, bearerToken: string, c: AzureConnection): void {
  const role = callerOf(env, bearerToken)?.role ?? null;
  if (!role) throw new HttpError(403, "no_platform_role", "No platform role");
  if (!canUse(c, role)) throw connectionForbidden();
}

const tokenCache = new Map<string, { token: string; until: number }>();

/** A connection's token for a scope, after the caller's role was checked on it (non-delegated tokens shared briefly) */
export async function connectionToken(env: Env, bearerToken: string, c: AzureConnection, scope: string): Promise<string> {
  assertCanUse(env, bearerToken, c);
  const group = credentialGroup(env, c);
  if (group === "delegated") return credentials().token(env, c, scope, bearerToken);
  const key = `${group}|${scope}`;
  const hit = tokenCache.get(key);
  if (hit && hit.until > Date.now()) return hit.token;
  const token = await credentials().token(env, c, scope);
  let exp = Date.now() + 10 * 60_000;
  try { exp = Number(decodeJwt(token).exp ?? 0) * 1000 || exp; } catch { /* keep the default */ }
  tokenCache.set(key, { token, until: exp - 5 * 60_000 });
  return token;
}

/** Tests: forget shared connection tokens */
export const clearConnectionTokens = () => tokenCache.clear();

/** SDK clients (Resource Graph, Blob): the credential of the connection(s) behind these subscriptions, one per group */
export function connectionCredentialGroups(
  env: Env,
  bearerToken: string,
  subscriptionIds: string[],
): Array<{ credential: TokenCredential; subscriptions: string[] }> {
  const groups = new Map<string, { credential: TokenCredential; subscriptions: string[] }>();
  for (const sub of subscriptionIds) {
    const c = connectionFor(env, sub);
    assertCanUse(env, bearerToken, c);
    const g = credentialGroup(env, c);
    let entry = groups.get(g);
    if (!entry) groups.set(g, (entry = { credential: credentials().credential(env, c, bearerToken), subscriptions: [] }));
    entry.subscriptions.push(sub);
  }
  return [...groups.values()];
}

/** The home connection's credential (deployment-level resources such as the configured flow-log storage account) */
export function homeConnectionCredential(env: Env, bearerToken: string): TokenCredential {
  const c = homeConnection(env);
  assertCanUse(env, bearerToken, c);
  return credentials().credential(env, c, bearerToken);
}

/** The managed subscriptions a caller may read: the allow-list narrowed by the caller's role (anonymous: home) */
export function callerSubscriptions(env: Env, bearerToken: string | undefined): string[] {
  if (!bearerToken) return homeConnection(env).subscriptions;
  const role = callerOf(env, bearerToken)?.role ?? null;
  return accessibleConnections(env, role).flatMap((c) => c.subscriptions);
}

type ArgBody = { subscriptions?: string[]; managementGroups?: string[]; options?: Record<string, unknown> };
type ArgPage = { data?: unknown[]; $skipToken?: string };
const isResourceGraph = (url: string) => /\/providers\/Microsoft\.ResourceGraph\/resources\b/i.test(url);
const jsonHeaders = (t: string, language?: string) => ({
  Authorization: `Bearer ${t}`, "Content-Type": "application/json",
  ...(language && /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(language) ? { "Accept-Language": language } : {}),
});

function userArmFetcher(env: Env, bearerToken: string): ArmFetcher {
  const viaUrl = async <T>(url: string, init: RequestInit, timeoutMs?: number, language?: string) => {
    const t = await connectionToken(env, bearerToken, connectionFor(env, subscriptionInPath(url)), ARM_SCOPE);
    return fetchJsonWithTimeout<T>("ARM", url, { ...init, headers: jsonHeaders(t, language) }, timeoutMs);
  };
  return {
    fetchJson: <T>(url: string, opts?: { timeoutMs?: number; language?: string }) => viaUrl<T>(url, {}, opts?.timeoutMs, opts?.language),
    postJson: async <T>(url: string, body: unknown, opts?: { timeoutMs?: number }): Promise<T> => {
      const b = (body ?? {}) as ArgBody;
      if (!isResourceGraph(url) || b.managementGroups) return viaUrl<T>(url, { method: "POST", body: JSON.stringify(body) }, opts?.timeoutMs);
      // Resource Graph: the body's subscriptions (or every one the caller may read), split by credential
      const subs = (b.subscriptions?.length ? b.subscriptions : callerSubscriptions(env, bearerToken)).map((s) => s.toLowerCase());
      const groups = new Map<string, { conn: AzureConnection; subs: string[] }>();
      for (const s of subs) {
        const c = connectionFor(env, s);
        assertCanUse(env, bearerToken, c);
        const g = credentialGroup(env, c);
        const e = groups.get(g) ?? { conn: c, subs: [] };
        e.subs.push(s);
        groups.set(g, e);
      }
      const post = async (g: { conn: AzureConnection; subs: string[] }, options?: Record<string, unknown>) => {
        const t = await connectionToken(env, bearerToken, g.conn, ARM_SCOPE);
        const payload = { ...(body as object), subscriptions: g.subs, ...(options ? { options } : {}) };
        return fetchJsonWithTimeout<ArgPage>("ARM", url, { method: "POST", headers: jsonHeaders(t), body: JSON.stringify(payload) }, opts?.timeoutMs);
      };
      const list = [...groups.values()];
      if (list.length <= 1) return (await post(list[0] ?? { conn: homeConnection(env), subs })) as T;
      // Several credentials: drain each one's pages (bounded) and concatenate
      const data: unknown[] = [];
      for (const g of list) {
        let options = b.options;
        for (let page = 0; page < 10; page++) {
          const r = await post(g, options);
          data.push(...(r.data ?? []));
          if (!r.$skipToken) break;
          options = { ...(b.options ?? {}), $skipToken: r.$skipToken };
        }
      }
      return { data, totalRecords: data.length, count: data.length } as T;
    },
  };
}

function userLogFetcher(env: Env, bearerToken: string): LogAnalyticsFetcher {
  return buildLogFetcher(
    (workspaceId) => connectionToken(env, bearerToken, connectionForWorkspace(env, workspaceId), LOG_ANALYTICS_SCOPE),
    (armId) => connectionToken(env, bearerToken, connectionFor(env, subscriptionInPath(armId)), LOG_ANALYTICS_SCOPE),
  );
}

/**
 * A cluster's Azure Monitor workspace is read with the cluster's connection (its subscription) — a customer cluster's
 * workspace with the customer identity, never the home one (no fallback to another connection). No cluster: home.
 */
function userPrometheusFetcher(env: Env, bearerToken: string, clusterArmId?: string): PrometheusFetcher {
  const connection = clusterArmId ? connectionFor(env, subscriptionInPath(clusterArmId)) : homeConnection(env);
  return buildPrometheusFetcher(() => connectionToken(env, bearerToken, connection, PROMETHEUS_SCOPE));
}

// ── Signed-in user (verified token) ──

export async function getArmFetcher(env: Env, bearerToken: string): Promise<ArmFetcher> {
  return userArmFetcher(env, bearerToken);
}

export async function getLogAnalyticsFetcher(env: Env, bearerToken: string): Promise<LogAnalyticsFetcher> {
  return userLogFetcher(env, bearerToken);
}

export async function getPrometheusFetcher(env: Env, bearerToken: string, clusterArmId?: string): Promise<PrometheusFetcher> {
  return userPrometheusFetcher(env, bearerToken, clusterArmId);
}

// ── Anonymous (dev switch only) — the platform credential ──

async function anonymousToken(env: Env, scope: string): Promise<string> {
  try {
    const t = await credentials().platformCredential(env).getToken(scope);
    if (!t?.token) throw new Error("no token");
    return t.token;
  } catch (e) {
    throw mapCredentialError(e);
  }
}

/** Anonymous callers with the dev switch on (throws signin_required otherwise) */
export function getAnonymousSPCredential(env: Env, featureFlag = true): TokenCredential {
  if (!anonymousSpAllowed(env, featureFlag)) throw signinRequired();
  return credentials().platformCredential(env);
}
export async function getAnonymousArmFetcher(env: Env, featureFlag = true): Promise<ArmFetcher> {
  if (!anonymousSpAllowed(env, featureFlag)) throw signinRequired();
  return buildArmFetcher(() => anonymousToken(env, ARM_SCOPE));
}
export async function getAnonymousLogFetcher(env: Env, featureFlag = true): Promise<LogAnalyticsFetcher> {
  if (!anonymousSpAllowed(env, featureFlag)) throw signinRequired();
  const t = () => anonymousToken(env, LOG_ANALYTICS_SCOPE);
  return buildLogFetcher(t, t);
}

// ── Auto: the caller's identity — the user's connections, or the platform credential for anonymous dev only ──

export async function getArmFetcherAuto(env: Env, bearerToken: string | undefined): Promise<ArmFetcher> {
  if (bearerToken) return userArmFetcher(env, bearerToken);
  return getAnonymousArmFetcher(env);
}

export async function getLogAnalyticsFetcherAuto(env: Env, bearerToken: string | undefined): Promise<LogAnalyticsFetcher> {
  if (bearerToken) return userLogFetcher(env, bearerToken);
  return getAnonymousLogFetcher(env);
}

/** `clusterArmId`: the cluster whose workspace is read — its connection's identity (pass it whenever there is one) */
export async function getPrometheusFetcherAuto(env: Env, bearerToken: string | undefined, clusterArmId?: string): Promise<PrometheusFetcher> {
  if (bearerToken) return userPrometheusFetcher(env, bearerToken, clusterArmId);
  if (!anonymousSpAllowed(env)) throw signinRequired();
  return buildPrometheusFetcher(() => anonymousToken(env, PROMETHEUS_SCOPE));
}

// ── AKS: an Entra token for the AKS server application — what kubelogin would fetch, with nothing run on the host ──

/** The AKS Entra server application — the same for every cluster (kubelogin `--server-id`) */
export const AKS_SERVER_APP_ID = "6dae42f8-4368-4678-94ff-3960e28e3630";
const AKS_SCOPE = `${AKS_SERVER_APP_ID}/.default`;

/** Only a token FOR the AKS server application ever goes to an API server (never an ARM or other token) */
export function assertAksAudience(token: string): string {
  let aud: unknown;
  try { aud = decodeJwt(token).aud; } catch { /* not a JWT: refused below */ }
  const ok = (Array.isArray(aud) ? aud : [aud]).some((a) => typeof a === "string" && [AKS_SERVER_APP_ID, `api://${AKS_SERVER_APP_ID}`].includes(a.toLowerCase()));
  if (!ok) throw new HttpError(502, "aks_token_audience", "The Entra token is not for the AKS server application");
  return token;
}

/** The cluster's connection mints the token (role checked, shared tokens cached like any scope); anonymous = dev switches */
export async function aksApiToken(env: Env, bearerToken: string | undefined, clusterArmId: string): Promise<string> {
  if (!bearerToken) {
    if (!anonymousSpAllowed(env, env.AUD_ANONYMOUS_K8S)) throw signinRequired();
    return assertAksAudience(await anonymousToken(env, AKS_SCOPE));
  }
  return assertAksAudience(await connectionToken(env, bearerToken, connectionFor(env, subscriptionInPath(clusterArmId)), AKS_SCOPE));
}

/** The connection that reads a cluster, and the tenant its tokens come from (home for the platform identity and OBO) */
export function clusterConnection(env: Env, clusterArmId: string): { connection: AzureConnection; tokenTenantId: string } {
  const c = connectionFor(env, subscriptionInPath(clusterArmId));
  return { connection: c, tokenTenantId: credentialGroup(env, c).startsWith("sp:") ? c.tenantId : homeConnection(env).tenantId };
}

// ── Internal helpers ──

/**
 * fetch → JSON with an abort timeout. Non-2xx responses throw `<label> <status>: <code>: <message>` — the upstream
 * error code and message with GUIDs masked (callers match on " 400:" or the message text; never the raw body).
 */
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
    if (!res.ok) {
      const text = await res.text();
      let code = "error";
      let message = text;
      try {
        type E = { code?: string; message?: string; innererror?: E };
        const j = JSON.parse(text) as { error?: E };
        code = j.error?.code ?? code;
        message = [j.error?.message, j.error?.innererror?.message, j.error?.innererror?.innererror?.message].filter(Boolean).join(" · ") || text;
      } catch { /* not JSON */ }
      const err = new Error(`${label} ${res.status}: ${code}: ${maskGuids(message.replace(/\/subscriptions\/[^\s'",/]+/gi, "/subscriptions/[sub]")).slice(0, 400)}`);
      Object.defineProperty(err, "detail", { value: text, enumerable: false });
      throw err;
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

function buildArmFetcher(token: () => Promise<string>): ArmFetcher {
  return {
    fetchJson: async <T>(url: string, opts?: { timeoutMs?: number; language?: string }) =>
      fetchJsonWithTimeout<T>("ARM", url, { headers: jsonHeaders(await token(), opts?.language) }, opts?.timeoutMs),
    postJson: async <T>(url: string, body: unknown, opts?: { timeoutMs?: number }) =>
      fetchJsonWithTimeout<T>("ARM", url, { method: "POST", headers: jsonHeaders(await token()), body: JSON.stringify(body) }, opts?.timeoutMs),
  };
}

function buildPrometheusFetcher(token: () => Promise<string>): PrometheusFetcher {
  return {
    async query(endpoint: string, promql: string, time?: string): Promise<unknown> {
      const params = new URLSearchParams({ query: promql });
      if (time) params.set("time", time);
      return fetchJsonWithTimeout("Prometheus", `${endpoint}/api/v1/query?${params}`, { headers: { Authorization: `Bearer ${await token()}` } });
    },
    async queryRange(endpoint: string, promql: string, start: string, end: string, step: string): Promise<unknown> {
      const params = new URLSearchParams({ query: promql, start, end, step });
      return fetchJsonWithTimeout("Prometheus", `${endpoint}/api/v1/query_range?${params}`, { headers: { Authorization: `Bearer ${await token()}` } });
    },
  };
}

function buildLogFetcher(
  workspaceToken: (workspaceId: string) => Promise<string>,
  resourceToken: (armId: string) => Promise<string>,
): LogAnalyticsFetcher {
  return {
    async query(workspaceId: string, kql: string): Promise<unknown> {
      return fetchJsonWithTimeout("LogAnalytics", `https://api.loganalytics.io/v1/workspaces/${encodeURIComponent(workspaceId)}/query`, {
        method: "POST",
        headers: jsonHeaders(await workspaceToken(workspaceId)),
        body: JSON.stringify({ query: kql }),
      });
    },
    async queryResource(armId: string, kql: string, timespan: string): Promise<unknown> {
      return fetchJsonWithTimeout("LogAnalytics", `https://api.loganalytics.io/v1${armId}/query`, {
        method: "POST",
        headers: jsonHeaders(await resourceToken(armId)),
        body: JSON.stringify({ query: kql, timespan }),
      }, 30_000);
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
