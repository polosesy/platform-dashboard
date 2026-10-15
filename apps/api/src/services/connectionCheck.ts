// "Does this connection work, and what can it read?" — read-only connection test (admin). Run with the CONNECTION's
// own credential: token → visible subscriptions (counts) → effective permissions per subscription (feature matrix +
// over-privilege warnings) → `print 1` on each declared workspace. Pure parts unit-tested from
// apps/api/test/connectionCheck.test.ts.
import type {
  AzureConnectionOption,
  ConnectionCheckResponse,
  ConnectionCheckStatus,
  ConnectionFeature,
  FeatureStatus,
  PrivilegeWarning,
} from "@aud/types";
import type { Env } from "../env.js";
import type { AzureConnection } from "../infra/connectionRegistry.js";
import { credentials } from "../infra/connectionCredentials.js";
import { HttpError, maskGuids, safeMessage } from "../infra/requestParams.js";

export type PermissionSet = { actions?: string[]; notActions?: string[]; dataActions?: string[]; notDataActions?: string[] };

/** One representative operation per feature; `data` = a data-plane action; `scopedBelow` = usually granted on a resource */
export const FEATURE_ACTIONS: Record<ConnectionFeature, { action: string; data?: boolean; scopedBelow?: boolean }> = {
  inventory: { action: "Microsoft.Resources/subscriptions/resourceGroups/read" },
  metrics: { action: "Microsoft.Insights/metrics/read" },
  logs: { action: "Microsoft.OperationalInsights/workspaces/query/AzureDiagnostics/read", scopedBelow: true },
  security: { action: "Microsoft.Security/assessments/read" },
  cost: { action: "Microsoft.CostManagement/query/read" },
  aksCredential: { action: "Microsoft.ContainerService/managedClusters/listClusterUserCredential/action", scopedBelow: true },
  flowLogBlobs: { action: "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read", data: true, scopedBelow: true },
  prometheus: { action: "Microsoft.Monitor/accounts/data/metrics/read", data: true, scopedBelow: true },
};

const toRe = (pattern: string) => new RegExp(`^${pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\/]/g, "\\$&")).join(".*")}$`, "i");
const matches = (patterns: string[] | undefined, action: string) => (patterns ?? []).some((p) => toRe(p).test(action));

/**
 * ok = allowed at the subscription · missing = not allowed · unknown = not at the subscription, but such roles are
 * usually granted on the resource itself (a workspace, a cluster, the flow-log storage account)
 */
export function featureCoverage(perms: PermissionSet[]): Record<ConnectionFeature, FeatureStatus> {
  const out = {} as Record<ConnectionFeature, FeatureStatus>;
  for (const [feature, def] of Object.entries(FEATURE_ACTIONS) as Array<[ConnectionFeature, (typeof FEATURE_ACTIONS)[ConnectionFeature]]>) {
    const allowed = perms.some((p) => def.data
      ? matches(p.dataActions, def.action) && !matches(p.notDataActions, def.action)
      : matches(p.actions, def.action) && !matches(p.notActions, def.action));
    out[feature] = allowed ? "ok" : def.scopedBelow ? "unknown" : "missing";
  }
  return out;
}

/** More than this platform needs — reported, never blocked (deny-list over the effective actions) */
export function privilegeWarnings(perms: PermissionSet[]): PrivilegeWarning[] {
  const actions = perms.flatMap((p) => p.actions ?? []);
  const out = new Set<PrivilegeWarning>();
  for (const a of actions) {
    const l = a.toLowerCase();
    if (l === "*") out.add("wildcard");
    if ((/\/write$|\/delete$|^\*\/write$|^\*\/delete$/.test(l) || l === "*") && !l.startsWith("microsoft.support/")) out.add("write_or_delete");
    if (l === "*" || /^microsoft\.authorization\/(\*|roleassignments)\/(\*|write)$/.test(l) || l === "microsoft.authorization/*") out.add("role_assignment_write");
    if (l === "*" || /listclusteradmincredential\/action$/.test(l) || l === "microsoft.containerservice/*" || l === "microsoft.containerservice/managedclusters/*") out.add("cluster_admin_credential");
  }
  return [...out];
}

export const connectionOption = (c: AzureConnection): AzureConnectionOption => ({
  key: c.key,
  displayName: c.displayName,
  mode: c.mode,
  subscriptionCount: c.subscriptions.length,
  workspaceCount: c.logAnalyticsWorkspaces.length,
  ...(lastChecks.get(c.key) ? { lastCheck: lastChecks.get(c.key)! } : {}),
});

const lastChecks = new Map<string, { at: string; status: ConnectionCheckStatus }>();

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

async function getJson<T>(f: Fetch, url: string, token: string, init?: RequestInit): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await f(url, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, signal: ctrl.signal });
    if (!res.ok) {
      let code = `http_${res.status}`;
      try { code = ((await res.json()) as { error?: { code?: string } }).error?.code ?? code; } catch { /* keep */ }
      throw new HttpError(res.status, code, code);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The connection test. A delegated connection is tested with the admin's own token (that IS its credential);
 * every other mode with the connection's credential — never the caller's.
 */
export async function checkConnection(env: Env, c: AzureConnection, bearerToken: string, f: Fetch = fetch): Promise<ConnectionCheckResponse> {
  const base = { generatedAt: new Date().toISOString(), connection: connectionOption(c) };
  let arm: string;
  try {
    arm = await credentials().token(env, c, "https://management.azure.com/.default", bearerToken);
  } catch (e) {
    const code = e instanceof HttpError ? e.code : "connection_failed";
    lastChecks.set(c.key, { at: base.generatedAt, status: "failed" });
    return { ...base, connection: connectionOption(c), status: "failed", token: { ok: false, code }, visible: null, subscriptions: [], workspaces: [] };
  }

  let visible: ConnectionCheckResponse["visible"] = null;
  try {
    const list = await getJson<{ value?: Array<{ subscriptionId?: string }> }>(f, "https://management.azure.com/subscriptions?api-version=2022-12-01", arm);
    const seen = new Set((list.value ?? []).map((s) => (s.subscriptionId ?? "").toLowerCase()));
    const declared = new Set(c.subscriptions);
    visible = {
      declared: declared.size,
      visible: [...declared].filter((s) => seen.has(s)).length,
      missing: [...declared].filter((s) => !seen.has(s)).length,
      extra: [...seen].filter((s) => !declared.has(s)).length,
    };
  } catch { /* counts unknown */ }

  const subscriptions = await Promise.all(c.subscriptions.map(async (sub) => {
    const label = maskGuids(sub);
    try {
      const [perm, info] = await Promise.all([
        getJson<{ value?: PermissionSet[] }>(f, `https://management.azure.com/subscriptions/${sub}/providers/Microsoft.Authorization/permissions?api-version=2022-04-01`, arm),
        getJson<{ displayName?: string }>(f, `https://management.azure.com/subscriptions/${sub}?api-version=2022-12-01`, arm).catch(() => ({ displayName: undefined })),
      ]);
      const perms = perm.value ?? [];
      return { label: info.displayName ?? label, reachable: true, features: featureCoverage(perms), warnings: privilegeWarnings(perms) };
    } catch (e) {
      return { label, reachable: false, features: featureCoverage([]), warnings: [] as PrivilegeWarning[], error: e instanceof HttpError ? e.code : safeMessage(e) };
    }
  }));

  const workspaces = await Promise.all(c.logAnalyticsWorkspaces.map(async (ws) => {
    const label = maskGuids(ws);
    try {
      const la = await credentials().token(env, c, "https://api.loganalytics.io/.default", bearerToken);
      await getJson(f, `https://api.loganalytics.io/v1/workspaces/${ws}/query`, la, { method: "POST", body: JSON.stringify({ query: "print 1" }) });
      return { label, ok: true };
    } catch (e) {
      return { label, ok: false, code: e instanceof HttpError ? e.code : "failed" };
    }
  }));

  const failed = subscriptions.some((s) => !s.reachable) || workspaces.some((w) => !w.ok) || (visible?.missing ?? 0) > 0;
  const warned = subscriptions.some((s) => s.warnings.length > 0 || Object.values(s.features).includes("missing"));
  const status: ConnectionCheckStatus = failed ? "failed" : warned ? "warning" : "ok";
  lastChecks.set(c.key, { at: base.generatedAt, status });
  return { ...base, connection: connectionOption(c), status, token: { ok: true }, visible, subscriptions, workspaces };
}
