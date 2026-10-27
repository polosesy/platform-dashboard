// Azure connections — which customer tenants and subscriptions this platform reads, and with which credential.
// Unit-tested from apps/api/test/connectionRegistry.test.ts.
//
//   platform          the home tenant, read with the platform's own identity (AZURE_AD_CLIENT_ID's service principal,
//                     secret or AUD_PLATFORM_CERT_PATH). Users need no Azure role assignment.
//   lighthouse        a customer tenant delegated to the home tenant with Azure Lighthouse — the home credential reads it
//                     (the delegation names the platform's service principal)
//   servicePrincipal  a service principal the customer created in their tenant; the file names the env var holding
//                     its secret (`secretEnv`), an absolute certificate path, or `federation` — no secret at all: the
//                     customer's app trusts this platform's Kubernetes service account (workload identity federation,
//                     a federated credential with our cluster's OIDC issuer + our SA as subject)
//   delegated         each signed-in user's own Azure permissions (OBO) — opt-in; a request never falls back to another mode
//
// The file holds IDs, names and references only. Unknown keys (clientSecret, password …) and PEM text are refused.
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { ConnectionMode, PlatformRole } from "@aud/types";
import type { Env } from "../env.js";

const GUID = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "must be a GUID").transform((s) => s.toLowerCase());
const ROLES = ["viewer", "operator", "admin"] as const;

const ConnectionSchema = z.object({
  /** Multi-cloud seam (docs/architecture/multi-cloud.md): only Azure today — a file without it is Azure */
  provider: z.literal("azure").default("azure"),
  key: z.string().regex(/^[a-z0-9-]{2,32}$/, "2–32 characters: a-z 0-9 -"),
  displayName: z.string().min(1).max(80),
  tenantId: GUID,
  /**
   * The tenant's directory name, shown next to the connection (optional). Declared here: the platform's read-only
   * credentials cannot read it (ARM /tenants gives no name to a service principal, Graph needs Organization.Read.All,
   * and a Lighthouse delegation has no Graph access at all). Not an id — a GUID here is refused.
   */
  tenantName: z.string().min(1).max(120).refine((s) => !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(s), "a name, not an id").optional(),
  mode: z.enum(["platform", "lighthouse", "servicePrincipal", "delegated"]),
  subscriptions: z.array(GUID).default([]),
  /** servicePrincipal only: the customer's app (client) id */
  clientId: GUID.optional(),
  /** servicePrincipal only: NAME of the env var holding the secret (AUD_CONN_<KEY>_SECRET) */
  secretEnv: z.string().regex(/^AUD_CONN_[A-Z0-9_]+_SECRET$/, "an env var name like AUD_CONN_CUSTA_SECRET").optional(),
  /** servicePrincipal only: absolute path of a PEM (certificate + private key) */
  certificatePath: z.string().refine((p) => isAbsolute(p), "must be an absolute path").optional(),
  /**
   * servicePrincipal only: no secret — the app's federated credential trusts this platform's Kubernetes service
   * account. The token file comes from AUD_FEDERATED_TOKEN_FILE / AZURE_FEDERATED_TOKEN_FILE, never from this file.
   */
  federation: z.object({ kind: z.literal("kubernetes") }).strict().optional(),
  /** Platform roles that may read through this connection (default: all) */
  roles: z.array(z.enum(ROLES)).min(1).optional(),
  /** Log Analytics workspaces (customer id GUIDs) read through this connection */
  logAnalyticsWorkspaces: z.array(GUID).default([]),
  /**
   * What this connection may do inside AKS clusters (services/aksAccess.ts). Everything off by default:
   *   allowLocalAccount  read clusters WITHOUT Entra integration (their kubeconfig is a cluster-admin certificate)
   *   hubbleExec         Hubble flows by exec into cilium-agent (≈ node access) — customer connections only with this
   *   podLogNamespaces   namespaces whose pod logs may be read from the cluster (kubelet); others → Container Insights.
   *                      Unset: every namespace for the home connection, none for customer connections
   *   observability.grafana  the customer's Azure Managed Grafana: endpoint + datasource UIDs — links into Explore
   *                      only (AKS 모니터링 › 관측 스택); nothing is read from Grafana
   *   observability.loki     the cluster's own Loki, read in-cluster (workload logs, Hubble drops from
   *                      hubble-flow-exporter) — cluster-internal URL only, behind the pod-log gate
   *   observability.hubbleUi  the cluster's Hubble UI (kube-system/hubble-ui), read in-cluster: its backend already
   *                      holds the relay's mTLS client certificate, so a short live sample of flows (service map,
   *                      flows, network, security) needs no exec and no Secret — cluster-internal URL only
   *   observability.logErrors  the collector's log-ERROR counter in the workspace (site-specific name) and the
   *                      label that names the app pod (heatmap 'log ERROR')
   */
  aks: z.object({
    allowLocalAccount: z.boolean().optional(),
    hubbleExec: z.boolean().optional(),
    podLogNamespaces: z.array(z.string().regex(/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/, "a namespace name")).optional(),
    observability: z.object({
      grafana: z.object({
        endpoint: z.string().regex(/^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.grafana\.azure\.com\/?$/i, "an https://<name>.<region>.grafana.azure.com endpoint"),
        datasources: z.object({
          prometheus: z.string().regex(/^[\w.-]{1,64}$/).optional(),
          loki: z.string().regex(/^[\w.-]{1,64}$/).optional(),
          tempo: z.string().regex(/^[\w.-]{1,64}$/).optional(),
          pyroscope: z.string().regex(/^[\w.-]{1,64}$/).optional(),
        }).strict().default({}),
      }).strict().optional(),
      loki: z.object({
        // In-cluster only: <svc>.<ns>[.svc[.cluster.local]] or a private address — never a public endpoint
        url: z.string().regex(/^https?:\/\/([a-z0-9-]+\.[a-z0-9-]+(\.svc(\.cluster\.local)?)?|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+)(:\d{1,5})?\/?$/,
          "an in-cluster http(s)://<service>.<namespace>[.svc]:<port> or private address"),
        tenant: z.string().regex(/^[\w.-]{1,64}$/).optional(),
      }).strict().optional(),
      hubbleUi: z.object({
        url: z.string().regex(/^https?:\/\/([a-z0-9-]+\.[a-z0-9-]+(\.svc(\.cluster\.local)?)?|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+)(:\d{1,5})?\/?$/,
          "an in-cluster http(s)://<service>.<namespace>[.svc]:<port> or private address"),
      }).strict().optional(),
      logErrors: z.object({
        metric: z.string().regex(/^[a-zA-Z_:][a-zA-Z0-9_:]{0,199}$/, "a Prometheus metric name"),
        podLabel: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/).optional(),
      }).strict().optional(),
    }).strict().optional(),
  }).strict().optional(),
}).strict();

const RegistrySchema = z.object({ connections: z.array(ConnectionSchema).min(1) }).strict();

// Version 1 ("tenants", access home|lighthouse) is still read and converted
const V1Schema = z.object({
  tenants: z.array(z.object({
    key: z.string(), displayName: z.string(), tenantId: z.string(), access: z.enum(["home", "lighthouse"]), subscriptions: z.array(z.string()).default([]),
  }).strict()).min(1),
}).strict();

export type AzureConnection = z.infer<typeof ConnectionSchema> & { roles: PlatformRole[] };

const envSubscriptions = (env: Env) => (env.AZURE_SUBSCRIPTION_IDS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const fail = (msg: string): never => { throw new Error(`Invalid connections file: ${msg}`); };

function upgrade(doc: unknown, env: Env): unknown {
  const v1 = V1Schema.safeParse(doc);
  if (!v1.success) return doc;
  return {
    connections: v1.data.tenants.map((t) => ({
      key: t.key, displayName: t.displayName, tenantId: t.tenantId, subscriptions: t.subscriptions,
      mode: t.access === "home" ? env.AUD_HOME_CONNECTION_MODE : "lighthouse",
    })),
  };
}

/** Validate a connections document against this deployment (exported for tests) */
export function parseConnections(doc: unknown, env: Env): AzureConnection[] {
  if (JSON.stringify(doc ?? null).includes("-----BEGIN")) fail("key material (PEM) does not belong in this file — use certificatePath");
  const parsed = RegistrySchema.safeParse(upgrade(doc, env));
  if (!parsed.success) fail(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const list = parsed.data!.connections.map((c) => ({ ...c, roles: c.roles ?? [...ROLES] }));
  const homeTid = (env.AZURE_AD_TENANT_ID ?? "").toLowerCase();

  const home = list.filter((c) => c.tenantId === homeTid && (c.mode === "platform" || c.mode === "delegated"));
  if (home.length !== 1) fail("exactly one connection must be the home tenant (AZURE_AD_TENANT_ID) with mode platform or delegated");
  if (!home[0]!.subscriptions.length) home[0]!.subscriptions = envSubscriptions(env);

  const keys = new Set<string>();
  const subs = new Map<string, string>();
  const workspaces = new Map<string, string>();
  for (const c of list) {
    if (keys.has(c.key)) fail(`duplicate key "${c.key}"`);
    keys.add(c.key);
    if (c.mode === "lighthouse" && c.tenantId === homeTid) fail(`"${c.key}": a Lighthouse connection is a customer tenant, not the home tenant`);
    if ((c.mode === "platform" || c.mode === "delegated") && c.tenantId !== homeTid) fail(`"${c.key}": mode ${c.mode} is for the home tenant only`);
    const sp = c.mode === "servicePrincipal";
    if (sp && !c.clientId) fail(`"${c.key}": servicePrincipal needs clientId`);
    if (sp && [c.secretEnv, c.certificatePath, c.federation].filter(Boolean).length !== 1) fail(`"${c.key}": servicePrincipal needs exactly one of secretEnv, certificatePath or federation`);
    if (!sp && (c.clientId || c.secretEnv || c.certificatePath || c.federation)) fail(`"${c.key}": clientId / secretEnv / certificatePath / federation are for servicePrincipal only`);
    if (c.federation && !federatedTokenFile(env)) fail(`"${c.key}": federation needs AUD_FEDERATED_TOKEN_FILE (or AZURE_FEDERATED_TOKEN_FILE from the workload identity webhook)`);
    for (const s of c.subscriptions) {
      if (subs.has(s)) fail(`a subscription is listed under "${subs.get(s)}" and "${c.key}"`);
      subs.set(s, c.key);
    }
    for (const w of c.logAnalyticsWorkspaces) {
      if (workspaces.has(w)) fail(`a workspace is listed under "${workspaces.get(w)}" and "${c.key}"`);
      workspaces.set(w, c.key);
    }
  }
  if (list.length > 1 && env.AUD_ANONYMOUS_SP) {
    fail("AUD_ANONYMOUS_SP cannot be on with customer connections (anonymous reads would use the platform credential)");
  }
  return list;
}

const memo = new WeakMap<Env, AzureConnection[]>();

/** The connections of this deployment — the file named by AUD_CONNECTIONS_FILE (or AUD_TENANTS_FILE), or home alone */
export function getConnections(env: Env): AzureConnection[] {
  const hit = memo.get(env);
  if (hit) return hit;
  const file = env.AUD_CONNECTIONS_FILE ?? env.AUD_TENANTS_FILE;
  let list: AzureConnection[];
  if (file) {
    const path = connectionsPath(file);
    list = parseConnections(JSON.parse(readFileSync(path, "utf8")), env);
  } else {
    list = [{
      provider: "azure", key: "home", displayName: "Home", tenantId: (env.AZURE_AD_TENANT_ID ?? "").toLowerCase(), mode: env.AUD_HOME_CONNECTION_MODE,
      subscriptions: envSubscriptions(env), logAnalyticsWorkspaces: [], roles: [...ROLES],
    }];
  }
  memo.set(env, list);
  return list;
}

/**
 * A relative AUD_CONNECTIONS_FILE is relative to the repository root — where the .env that names it lives
 * (src/index.ts loads ../../../.env; the API's working directory is apps/api in workspace mode). The working
 * directory is still tried for older setups.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
export function connectionsPath(file: string): string {
  if (isAbsolute(file)) return file;
  const fromRoot = resolve(REPO_ROOT, file);
  if (existsSync(fromRoot)) return fromRoot;
  const fromCwd = resolve(process.cwd(), file);
  return existsSync(fromCwd) ? fromCwd : fromRoot;
}

export function homeConnection(env: Env): AzureConnection {
  const homeTid = (env.AZURE_AD_TENANT_ID ?? "").toLowerCase();
  return getConnections(env).find((c) => c.tenantId === homeTid && (c.mode === "platform" || c.mode === "delegated"))!;
}

/** Every managed subscription (the allow-list) */
export const registrySubscriptions = (env: Env) => getConnections(env).flatMap((c) => c.subscriptions);

export function connectionForSubscription(env: Env, subscriptionId: string): AzureConnection | undefined {
  const s = subscriptionId.toLowerCase();
  return getConnections(env).find((c) => c.subscriptions.includes(s));
}

export const connectionByKey = (env: Env, key: string) => getConnections(env).find((c) => c.key === key);

/** The connection that reads a workspace: the one listing it, else home (the configured workspace lives there) */
export function connectionForWorkspace(env: Env, workspaceId: string): AzureConnection {
  const w = workspaceId.toLowerCase();
  return getConnections(env).find((c) => c.logAnalyticsWorkspaces.includes(w)) ?? homeConnection(env);
}

/**
 * How a connection's token is obtained. Lighthouse follows home (the delegation is to the home identity):
 * "platform" = the platform credential · "delegated" = the user's OBO · "sp:<key>" = that connection's own principal
 */
/** The projected service-account token file for federation — env only */
export const federatedTokenFile = (env: Env): string | undefined => env.AUD_FEDERATED_TOKEN_FILE ?? env.AZURE_FEDERATED_TOKEN_FILE;

/**
 * The platform identity's credential: an explicit AUD_PLATFORM_CREDENTIAL, else certificate > secret > workload
 * identity (a token file) — null when nothing is configured
 */
export type PlatformCredentialKind = "certificate" | "secret" | "workloadIdentity";
export function platformCredentialKind(env: Env): PlatformCredentialKind | null {
  if (env.AUD_PLATFORM_CREDENTIAL) return env.AUD_PLATFORM_CREDENTIAL;
  if (env.AUD_PLATFORM_CERT_PATH) return "certificate";
  if (env.AZURE_AD_CLIENT_SECRET) return "secret";
  if (federatedTokenFile(env)) return "workloadIdentity";
  return null;
}
/** The client id the platform credential signs in as — workload identity: the managed identity, never the SSO app */
export const platformClientId = (env: Env): string | undefined =>
  platformCredentialKind(env) === "workloadIdentity" ? env.AUD_PLATFORM_CLIENT_ID ?? env.AZURE_CLIENT_ID : env.AUD_PLATFORM_CLIENT_ID ?? env.AZURE_AD_CLIENT_ID;

export type CredentialKind = "platform" | "delegated" | "secret" | "certificate" | "federatedKubernetes";
/** How a connection proves who it is — shown by the connection check (federation = no secret anywhere) */
export function credentialKind(env: Env, c: AzureConnection): CredentialKind {
  const group = credentialGroup(env, c);
  if (group === "delegated") return "delegated";
  if (group === "platform") return "platform";
  return c.federation ? "federatedKubernetes" : c.certificatePath ? "certificate" : "secret";
}

export function credentialGroup(env: Env, c: AzureConnection): "platform" | "delegated" | `sp:${string}` {
  if (c.mode === "servicePrincipal") return `sp:${c.key}`;
  if (c.mode === "lighthouse") return homeConnection(env).mode === "delegated" ? "delegated" : "platform";
  return c.mode === "delegated" ? "delegated" : "platform";
}

export type { ConnectionMode };
