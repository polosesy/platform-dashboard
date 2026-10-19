import { decodeJwt } from "jose";
// "Does this connection work, and what can it read?" — read-only connection test (admin). Run with the CONNECTION's
// own credential: token → visible subscriptions (counts) → effective permissions per subscription (feature matrix +
// over-privilege warnings) → resource-scope permissions on a few sample resources (clusters, workspaces, Azure
// Monitor workspaces, flow-log storage) where the subscription does not grant it → `print 1` on each declared
// workspace → each feature's readiness (services/featureCatalog.ts). Pure parts unit-tested from
// apps/api/test/connections.test.ts and featureCatalog.test.ts.
import type {
  AzureConnectionOption,
  ConnectionCheckResponse,
  ConnectionCheckStatus,
  ConnectionFeature,
  FeatureStatus,
  PermissionCell,
  PermissionKey,
  PrivilegeWarning,
} from "@aud/types";
import { AZURE_PROBES, FEATURES, PERMISSIONS, cellFrom, rollupFeature } from "./featureCatalog.js";
import type { Env } from "../env.js";
import { credentialKind, platformCredentialKind, type AzureConnection } from "../infra/connectionRegistry.js";
import { credentials } from "../infra/connectionCredentials.js";
import { HttpError, maskGuids, safeMessage } from "../infra/requestParams.js";

export type PermissionSet = { actions?: string[]; notActions?: string[]; dataActions?: string[]; notDataActions?: string[] };

/**
 * One representative operation per feature (from the catalog); `data` = a data-plane action; `scopedBelow` = usually
 * granted on a resource — checked on samples below
 */
export const FEATURE_ACTIONS: Record<ConnectionFeature, { action: string; data?: boolean; scopedBelow?: boolean }> = AZURE_PROBES;

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

/** Does one effective-permission list allow a probe? */
export function allows(perms: PermissionSet[], probe: { action: string; data?: boolean }): boolean {
  return perms.some((p) => probe.data
    ? matches(p.dataActions, probe.action) && !matches(p.notDataActions, probe.action)
    : matches(p.actions, probe.action) && !matches(p.notActions, probe.action));
}

/** Resource-scoped permissions: the ARM type the check samples */
export const RESOURCE_KEYS = PERMISSIONS.filter((p) => p.plane === "azure" && p.scope.kind === "resource").map((p) => p.key as ConnectionFeature);
/** Samples per permission and in total (each one GET of Microsoft.Authorization/permissions) */
export const SAMPLE_CAP: Partial<Record<ConnectionFeature, number>> = { aksCredential: 5 };
export const SAMPLE_DEFAULT = 3;
export const SAMPLE_TOTAL = 20;

const subOf = (id: string) => id.split("/")[2]?.toLowerCase() ?? "";

/**
 * Per permission for the whole connection (pure). Subscription scope: allowed / checked / declared subscriptions.
 * Resource scope: a resource in a subscription that grants it counts as allowed (inherited); the others are the
 * sampled answers (true / false; null = the GET failed, not counted). Kubernetes: unknown until a cluster check
 * runs, or off when its switch is off.
 */
export function permissionCells(input: {
  subs: Array<{ id: string; reachable: boolean; features: Record<ConnectionFeature, FeatureStatus> }>;
  /** resource ids by permission; null = the sample query failed */
  resources: Partial<Record<ConnectionFeature, string[]>> | null;
  probes: ReadonlyMap<string, boolean | null>;
  gates: { hubbleExec: boolean; podLogs: boolean };
}): Record<PermissionKey, PermissionCell> {
  const out = {} as Record<PermissionKey, PermissionCell>;
  const reachable = input.subs.filter((s) => s.reachable);
  for (const p of PERMISSIONS) {
    if (p.plane === "kubernetes") {
      const on = p.gate === "hubbleExec" ? input.gates.hubbleExec : p.gate === "podLogs" ? input.gates.podLogs : true;
      out[p.key] = on ? { status: "unknown", at: "cluster", reason: "clusterNotChecked" } : { status: "optInOff", at: "cluster", reason: "gateOff" };
      continue;
    }
    const key = p.key as ConnectionFeature;
    if (p.scope.kind === "subscription") {
      out[key] = cellFrom("subscription", reachable.filter((s) => s.features[key] === "ok").length, reachable.length, input.subs.length);
      continue;
    }
    if (!input.resources) { out[key] = { status: "unknown", at: "resource", reason: "readFailed" }; continue; }
    const ids = input.resources[key] ?? [];
    const inherit = new Set(reachable.filter((s) => s.features[key] === "ok").map((s) => s.id.toLowerCase()));
    let ok = 0, checked = 0, inherited = 0;
    for (const id of ids) {
      if (inherit.has(subOf(id))) { ok++; checked++; inherited++; continue; }
      const v = input.probes.get(id);
      if (v === true) { ok++; checked++; } else if (v === false) checked++;
    }
    out[key] = cellFrom("resource", ok, checked, ids.length, ids.length && inherited === ids.length ? "inherited" : undefined);
  }
  return out;
}

/** Which resources to ask about: not covered by its subscription, up to the caps — deterministic (id order) */
export function pickSamples(
  resources: Partial<Record<ConnectionFeature, string[]>>,
  inherited: (key: ConnectionFeature, id: string) => boolean,
): Array<{ key: ConnectionFeature; id: string }> {
  const out: Array<{ key: ConnectionFeature; id: string }> = [];
  for (const key of RESOURCE_KEYS) {
    const want = [...(resources[key] ?? [])].sort().filter((id) => !inherited(key, id)).slice(0, SAMPLE_CAP[key] ?? SAMPLE_DEFAULT);
    for (const id of want) if (out.length < SAMPLE_TOTAL) out.push({ key, id });
  }
  return out;
}

// One Resource Graph query for the samples: clusters, workspaces, Azure Monitor workspaces, and the storage
// accounts that flow logs write to (a flow log's storageId)
const SAMPLE_QUERY =
  "resources | where type in~ ('microsoft.containerservice/managedclusters','microsoft.operationalinsights/workspaces','microsoft.monitor/accounts')" +
  " | project id = tolower(id), type = tolower(type)" +
  " | union (resources | where type =~ 'microsoft.network/networkwatchers/flowlogs' | extend sid = tolower(tostring(properties.storageId))" +
  " | where isnotempty(sid) | distinct sid | project id = sid, type = 'microsoft.storage/storageaccounts')";

/** What a caller may see of a connection: the full tenant id only with `fullTenantId` (admins) */
export const connectionOption = (env: Env, c: AzureConnection, opts: { fullTenantId?: boolean } = {}): AzureConnectionOption => ({
  key: c.key,
  displayName: c.displayName,
  ...(c.tenantName ? { tenantName: c.tenantName } : {}),
  tenantIdTail: c.tenantId.slice(-4),
  ...(opts.fullTenantId ? { tenantId: c.tenantId } : {}),
  mode: c.mode,
  credentialKind: credentialKind(env, c),
  subscriptionCount: c.subscriptions.length,
  workspaceCount: c.logAnalyticsWorkspaces.length,
  ...(lastChecks.get(c.key) ? { lastCheck: lastChecks.get(c.key)! } : {}),
});

const lastChecks = new Map<string, { at: string; status: ConnectionCheckStatus }>();

/**
 * Admin-only: the object id the token was issued to (oid — what a ClusterRoleBinding names), the advice to drop a
 * secret, and this platform's federation issuer/subject when the deployment declares them
 */
function identityOf(env: Env, c: AzureConnection, armToken?: string): NonNullable<ConnectionCheckResponse["identity"]> {
  let objectId: string | undefined;
  if (armToken && c.mode !== "delegated") {
    try { const oid = decodeJwt(armToken).oid; if (typeof oid === "string" && /^[0-9a-f-]{36}$/i.test(oid)) objectId = oid.toLowerCase(); } catch { /* opaque */ }
  }
  const kind = credentialKind(env, c);
  const platform = kind === "platform" ? platformCredentialKind(env) : null;
  const federation = env.AUD_PLATFORM_OIDC_ISSUER && env.AUD_PLATFORM_FEDERATION_SUBJECT ? { issuer: env.AUD_PLATFORM_OIDC_ISSUER, subject: env.AUD_PLATFORM_FEDERATION_SUBJECT } : undefined;
  return {
    ...(objectId ? { objectId } : {}),
    ...(kind === "secret" || platform === "secret" ? { advice: "preferFederation" as const } : {}),
    ...(platform ? { platformCredential: platform } : {}),
    ...(federation && c.mode === "servicePrincipal" ? { federation } : {}),
  };
}

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
  // Admin-only route: the full tenant id
  const base = { generatedAt: new Date().toISOString(), connection: connectionOption(env, c, { fullTenantId: true }) };
  let arm: string;
  try {
    arm = await credentials().token(env, c, "https://management.azure.com/.default", bearerToken);
  } catch (e) {
    const code = e instanceof HttpError ? e.code : "connection_failed";
    lastChecks.set(c.key, { at: base.generatedAt, status: "failed" });
    return { ...base, status: "failed", token: { ok: false, code }, visible: null, subscriptions: [], workspaces: [], identity: identityOf(env, c) };
  }
  const identity = identityOf(env, c, arm);

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

  // ── Resource scope: where the subscription does not grant it, ask a few of the resources themselves ──
  const subIds = c.subscriptions;
  const subFeatures = subscriptions.map((s, i) => ({ id: subIds[i]!, reachable: s.reachable, features: s.features }));
  let resources: Partial<Record<ConnectionFeature, string[]>> | null = null;
  try {
    const rows: Array<{ id?: string; type?: string }> = [];
    let skip: string | undefined;
    for (let page = 0; page < 5; page++) {
      const body = { subscriptions: subIds, query: SAMPLE_QUERY, options: { $top: 1000, ...(skip ? { $skipToken: skip } : {}) } };
      const r = await getJson<{ data?: Array<{ id?: string; type?: string }>; $skipToken?: string }>(f, "https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01", arm, { method: "POST", body: JSON.stringify(body) });
      rows.push(...(r.data ?? []));
      skip = r.$skipToken;
      if (!skip) break;
    }
    resources = {};
    for (const key of RESOURCE_KEYS) {
      const type = (PERMISSIONS.find((p) => p.key === key)!.scope as { armType: string }).armType;
      resources[key] = [...new Set(rows.filter((x) => x.type === type && x.id).map((x) => x.id!))];
    }
  } catch { /* sample query failed: resource-scope permissions stay unknown */ }
  const inheritedBy = (key: ConnectionFeature, id: string) => subFeatures.some((s) => s.reachable && s.id.toLowerCase() === subOf(id) && s.features[key] === "ok");
  const samples = resources ? pickSamples(resources, inheritedBy) : [];
  const probes = new Map<string, boolean | null>();
  const resourceWarnings = new Set<PrivilegeWarning>();
  for (let i = 0; i < samples.length; i += 6) {
    await Promise.all(samples.slice(i, i + 6).map(async ({ key, id }) => {
      try {
        const perm = await getJson<{ value?: PermissionSet[] }>(f, `https://management.azure.com${id}/providers/Microsoft.Authorization/permissions?api-version=2022-04-01`, arm);
        const perms = perm.value ?? [];
        probes.set(id, allows(perms, FEATURE_ACTIONS[key]));
        for (const w of privilegeWarnings(perms)) resourceWarnings.add(w);
      } catch {
        probes.set(id, null);
      }
    }));
  }
  const home = c.mode === "platform" || c.mode === "delegated";
  const hubbleOn = (env.HUBBLE_EXEC_ENABLED ?? env.NODE_ENV !== "production") && (home || c.aks?.hubbleExec === true);
  const podLogsOn = home || (c.aks?.podLogNamespaces?.length ?? 0) > 0;
  const permissions = permissionCells({ subs: subFeatures, resources, probes, gates: { hubbleExec: hubbleOn, podLogs: podLogsOn } });
  const readiness = FEATURES.map((d) => rollupFeature(d, permissions));

  const failed = subscriptions.some((s) => !s.reachable) || workspaces.some((w) => !w.ok) || (visible?.missing ?? 0) > 0;
  const warned = subscriptions.some((s) => s.warnings.length > 0 || Object.values(s.features).includes("missing"))
    || resourceWarnings.size > 0 || readiness.some((r) => r.readiness === "blocked" || r.readiness === "partial");
  const status: ConnectionCheckStatus = failed ? "failed" : warned ? "warning" : "ok";
  lastChecks.set(c.key, { at: base.generatedAt, status });
  return {
    ...base, status, token: { ok: true }, visible, subscriptions, workspaces, identity,
    permissions, readiness, resourceWarnings: [...resourceWarnings],
    workspaceSummary: { n: workspaces.length, ok: workspaces.filter((w) => w.ok).length, failed: workspaces.filter((w) => !w.ok).length },
    clusters: [...(resources?.aksCredential ?? [])].sort().slice(0, 50).map((id) => ({ id, name: maskGuids(id.split("/").pop() ?? "") })),
  };
}
