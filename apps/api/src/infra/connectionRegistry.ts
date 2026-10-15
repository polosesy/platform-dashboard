// Azure connections — which customer tenants and subscriptions this platform reads, and with which credential.
// Unit-tested from apps/api/test/connectionRegistry.test.ts.
//
//   platform          the home tenant, read with the platform's own identity (AZURE_AD_CLIENT_ID's service principal,
//                     secret or AUD_PLATFORM_CERT_PATH). Users need no Azure role assignment.
//   lighthouse        a customer tenant delegated to the home tenant with Azure Lighthouse — the home credential reads it
//                     (the delegation names the platform's service principal)
//   servicePrincipal  a service principal the customer created in their tenant; the file names the env var holding
//                     its secret (`secretEnv`) or an absolute certificate path — never the secret itself
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
  key: z.string().regex(/^[a-z0-9-]{2,32}$/, "2–32 characters: a-z 0-9 -"),
  displayName: z.string().min(1).max(80),
  tenantId: GUID,
  mode: z.enum(["platform", "lighthouse", "servicePrincipal", "delegated"]),
  subscriptions: z.array(GUID).default([]),
  /** servicePrincipal only: the customer's app (client) id */
  clientId: GUID.optional(),
  /** servicePrincipal only: NAME of the env var holding the secret (AUD_CONN_<KEY>_SECRET) */
  secretEnv: z.string().regex(/^AUD_CONN_[A-Z0-9_]+_SECRET$/, "an env var name like AUD_CONN_CUSTA_SECRET").optional(),
  /** servicePrincipal only: absolute path of a PEM (certificate + private key) */
  certificatePath: z.string().refine((p) => isAbsolute(p), "must be an absolute path").optional(),
  /** Platform roles that may read through this connection (default: all) */
  roles: z.array(z.enum(ROLES)).min(1).optional(),
  /** Log Analytics workspaces (customer id GUIDs) read through this connection */
  logAnalyticsWorkspaces: z.array(GUID).default([]),
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
    if (sp && !!c.secretEnv === !!c.certificatePath) fail(`"${c.key}": servicePrincipal needs exactly one of secretEnv or certificatePath`);
    if (!sp && (c.clientId || c.secretEnv || c.certificatePath)) fail(`"${c.key}": clientId / secretEnv / certificatePath are for servicePrincipal only`);
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
      key: "home", displayName: "Home", tenantId: (env.AZURE_AD_TENANT_ID ?? "").toLowerCase(), mode: env.AUD_HOME_CONNECTION_MODE,
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
export function credentialGroup(env: Env, c: AzureConnection): "platform" | "delegated" | `sp:${string}` {
  if (c.mode === "servicePrincipal") return `sp:${c.key}`;
  if (c.mode === "lighthouse") return homeConnection(env).mode === "delegated" ? "delegated" : "platform";
  return c.mode === "delegated" ? "delegated" : "platform";
}

export type { ConnectionMode };
