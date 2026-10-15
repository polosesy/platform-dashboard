// AKS access — how the platform signs in to a cluster's API server, and whether it can reach it at all.
// Pure parts (+ an injected-network probe) unit-tested from apps/api/test/aksAccess.test.ts.
//
//   Sign-in (planClusterAuth)
//     Entra-integrated cluster → a short-lived Entra token for the AKS server application, minted with the
//                                connection's own credential (azureClientFactory.aksApiToken). This is what kubelogin
//                                does — but no program runs on the API host. The audience is a constant, never read
//                                from the kubeconfig; the kubeconfig's --server-id is only compared with it.
//     no Entra (local account) → the kubeconfig's static certificate is cluster-admin and revocable only by rotating
//                                the cluster CA → refused unless the connection (or local development) allows it.
//     The token goes only to a server whose host is one of the cluster's ARM FQDNs, over verified TLS with the CA.
//   Reach (probeApiServer)
//     DNS, then TCP 443, each with a short timeout — a private cluster read from outside its network answers
//     `cluster_dns_unresolved` / `cluster_unreachable` at once instead of hanging every list call.
//
// docs/integrations/azure/aks.md has the decision record and the customer-facing tiers.
import * as k8s from "@kubernetes/client-node";
import { lookup } from "node:dns/promises";
import { connect } from "node:net";
import { HttpError } from "../infra/requestParams.js";
import type { Env } from "../env.js";
import { AKS_SERVER_APP_ID, clusterConnection } from "../infra/azureClientFactory.js";
import type { AzureConnection } from "../infra/connectionRegistry.js";

export type AksClusterProfile = {
  powerState: string;
  private: boolean;
  /** AKS-managed Entra integration */
  entra: boolean;
  /** Legacy Entra integration (customer server app) — retired by Microsoft, not supported */
  legacyEntra: boolean;
  entraTenantId?: string;
  localAccounts: boolean;
  azureRbac: boolean;
  /** Host names the kubeconfig's server may name (lowercase): fqdn · privateFQDN · azurePortalFQDN */
  hosts: string[];
};

/** The parts of a managedCluster's ARM `properties` that decide sign-in and reach */
export function aksClusterProfile(props: Record<string, unknown> | undefined): AksClusterProfile {
  const p = props ?? {};
  const aad = (p.aadProfile ?? null) as { managed?: boolean; enableAzureRBAC?: boolean; tenantID?: string } | null;
  const api = (p.apiServerAccessProfile ?? {}) as { enablePrivateCluster?: boolean };
  const host = (v: unknown) => (typeof v === "string" && v ? v.toLowerCase() : null);
  return {
    powerState: String((p.powerState as { code?: string } | undefined)?.code ?? "unknown"),
    private: api.enablePrivateCluster === true,
    entra: !!aad && aad.managed === true,
    legacyEntra: !!aad && aad.managed !== true,
    ...(aad?.tenantID ? { entraTenantId: aad.tenantID.toLowerCase() } : {}),
    localAccounts: p.disableLocalAccounts !== true,
    azureRbac: aad?.enableAzureRBAC === true,
    hosts: [...new Set([host(p.fqdn), host(p.privateFQDN), host(p.azurePortalFQDN)].filter((h): h is string => !!h))],
  };
}

/** kubelogin's `--server-id` in an exec user (`--server-id X` or `--server-id=X`) */
export function kubeloginServerId(user: k8s.User | null | undefined): string | undefined {
  const args = user?.exec?.args ?? [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--server-id") return args[i + 1]?.toLowerCase();
    if (a.startsWith("--server-id=")) return a.slice("--server-id=".length).toLowerCase();
  }
  return undefined;
}

export type AuthPlan = { kind: "entra" | "static"; host: string };

/**
 * How to sign in to this cluster — or why not. `credentialTenantId` = the tenant the connection's tokens come from
 * (an Entra cluster only accepts tokens of its own tenant: a Lighthouse delegation cannot sign in to it).
 */
export function planClusterAuth(
  kc: k8s.KubeConfig,
  profile: AksClusterProfile,
  opts: { allowLocalAccount: boolean; credentialTenantId: string },
): AuthPlan {
  if (/^stopped$/i.test(profile.powerState)) throw new HttpError(409, "cluster_stopped", "The cluster is stopped");
  const cluster = kc.getCurrentCluster();
  if (!cluster?.server) throw new HttpError(502, "aks_kubeconfig_invalid", "The kubeconfig names no API server");
  if (cluster.skipTLSVerify || !cluster.caData) {
    throw new HttpError(502, "aks_kubeconfig_invalid", "The kubeconfig must carry the cluster CA and verify TLS");
  }
  let host = "";
  try { host = new URL(cluster.server).hostname.toLowerCase(); } catch { /* checked below */ }
  // A token (or certificate) is only ever sent to the API server Azure says this cluster has
  if (!host || !profile.hosts.includes(host)) {
    throw new HttpError(502, "aks_server_mismatch", "The kubeconfig's API server is not one of the cluster's addresses");
  }

  if (profile.legacyEntra) {
    throw new HttpError(501, "aad_cluster_unsupported", "Legacy Entra integration (customer server app) is not supported — migrate to AKS-managed Entra integration");
  }
  if (profile.entra) {
    if (profile.entraTenantId && profile.entraTenantId !== opts.credentialTenantId.toLowerCase()) {
      throw new HttpError(501, "aks_aad_cross_tenant_unsupported",
        "This cluster accepts Entra tokens of its own tenant only — read it through a connection with a service principal in that tenant");
    }
    const serverId = kubeloginServerId(kc.getCurrentUser());
    if (serverId && serverId !== AKS_SERVER_APP_ID) {
      throw new HttpError(502, "aks_server_id_mismatch", "The kubeconfig asks for a token of an unexpected server application");
    }
    return { kind: "entra", host };
  }
  if (!opts.allowLocalAccount) {
    throw new HttpError(403, "aks_local_account_refused",
      "This cluster has no Entra integration: its kubeconfig is a cluster-admin certificate and is not used — enable AKS-managed Entra integration");
  }
  sanitizeKubeconfig(kc); // throws when there is no static credential
  return { kind: "static", host };
}

/**
 * Static credentials only: exec plugins (kubelogin …) and auth providers would run programs on the API host
 * with whatever identity it has — they are removed. Entra clusters never reach this (they use an Entra token).
 */
export function sanitizeKubeconfig(kc: k8s.KubeConfig): k8s.KubeConfig {
  const users = kc.users.map((u) => ({ ...u, exec: undefined, authProvider: undefined }));
  const current = kc.getContextObject(kc.getCurrentContext());
  const user = users.find((u) => u.name === current?.user);
  const hasStatic = !!user && (!!(user.certData && user.keyData) || !!(user.certFile && user.keyFile) || !!user.token || !!(user.username && user.password));
  if (!hasStatic) throw new HttpError(501, "aad_cluster_unsupported", "This cluster needs an Entra sign-in plugin (kubelogin); it is not run on the API host");
  const out = new k8s.KubeConfig();
  out.loadFromOptions({ clusters: kc.clusters, users, contexts: kc.contexts, currentContext: kc.getCurrentContext() });
  return out;
}

/** The kubeconfig's cluster (server + CA) with a bearer token as the only user — no exec, no certificates */
export function tokenKubeConfig(kc: k8s.KubeConfig, token: string): k8s.KubeConfig {
  const cluster = kc.getCurrentCluster();
  if (!cluster) throw new HttpError(502, "aks_kubeconfig_invalid", "The kubeconfig names no API server");
  const out = new k8s.KubeConfig();
  out.loadFromOptions({
    clusters: [{ name: cluster.name, server: cluster.server, caData: cluster.caData, skipTLSVerify: false }],
    users: [{ name: "aud-entra", token }],
    contexts: [{ name: "aud", cluster: cluster.name, user: "aud-entra" }],
    currentContext: "aud",
  });
  return out;
}

// ── Reach ──

export type ProbeDeps = {
  lookup: (host: string) => Promise<unknown>;
  connect: (host: string, port: number, timeoutMs: number) => Promise<void>;
};

const defaultProbeDeps: ProbeDeps = {
  lookup: (host) => lookup(host),
  connect: (host, port, timeoutMs) => new Promise<void>((resolve, reject) => {
    const s = connect({ host, port });
    const done = (e?: Error) => { s.destroy(); if (e) reject(e); else resolve(); };
    s.setTimeout(timeoutMs, () => done(new Error("timeout")));
    s.once("connect", () => done());
    s.once("error", (e) => done(e));
  }),
};

function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("timeout")), ms); })])
    .finally(() => clearTimeout(timer));
}

/** null = reachable · "dns" = the name does not resolve here · "tcp" = no connection on 443 */
export async function probeApiServer(host: string, timeoutMs: number, deps: ProbeDeps = defaultProbeDeps): Promise<"dns" | "tcp" | null> {
  try { await within(deps.lookup(host), timeoutMs); } catch { return "dns"; }
  try { await deps.connect(host, 443, timeoutMs); } catch { return "tcp"; }
  return null;
}

/**
 * The coded error for a probe failure. The message names no host: viewers learn only that the cluster is out of
 * reach — private names stay in the admin documentation.
 */
export function unreachableError(reason: "dns" | "tcp", isPrivate: boolean): HttpError {
  return reason === "dns"
    ? new HttpError(503, "cluster_dns_unresolved", isPrivate
      ? "The private cluster's API server name does not resolve where the platform API runs — run the API in a network linked to the cluster's private DNS zone"
      : "The API server name does not resolve where the platform API runs")
    : new HttpError(503, "cluster_unreachable", "The platform API cannot open a connection to the API server (port 443) — network path, authorized IP ranges or firewall");
}

const NETWORK_CODES: Record<string, "dns" | "tcp"> = {
  ENOTFOUND: "dns", EAI_AGAIN: "dns",
  ETIMEDOUT: "tcp", ECONNREFUSED: "tcp", ECONNRESET: "tcp", EHOSTUNREACH: "tcp", ENETUNREACH: "tcp", UND_ERR_CONNECT_TIMEOUT: "tcp",
};

/** A Kubernetes client failure as a coded error (401/403 from the API server, network failures); others unchanged */
export function k8sError(e: unknown, isPrivate = false): unknown {
  if (e instanceof HttpError) return e;
  const o = (e && typeof e === "object" ? e : {}) as { code?: unknown; statusCode?: unknown; cause?: { code?: unknown } };
  const status = typeof o.code === "number" ? o.code : typeof o.statusCode === "number" ? o.statusCode : undefined;
  if (status === 401) return new HttpError(502, "aks_unauthorized", "The API server did not accept the platform's sign-in");
  if (status === 403) {
    return new HttpError(403, "aks_rbac_forbidden",
      "The connection's identity has no Kubernetes read role here — bind the aud-dashboard-reader ClusterRole (docs/integrations/azure/templates/aks)");
  }
  const net = NETWORK_CODES[String(typeof o.code === "string" ? o.code : o.cause?.code ?? "")];
  return net ? unreachableError(net, isPrivate) : e;
}

// ── What a connection may do inside a cluster (connections file `aks`, docs/integrations/azure/aks.md) ──

const isHome = (c: AzureConnection) => c.mode === "platform" || c.mode === "delegated";

/** Pod logs from the kubelet: the connection's `aks.podLogNamespaces`, else every namespace (home) or none (customers) */
export function podLogNamespaceAllowed(env: Env, clusterArmId: string, namespace: string): boolean {
  const { connection } = clusterConnection(env, clusterArmId);
  const allowed = connection.aks?.podLogNamespaces;
  return allowed ? allowed.includes(namespace) : isHome(connection);
}

/** Hubble's exec into cilium-agent is on in development, off in production unless HUBBLE_EXEC_ENABLED=true */
export const hubbleExecSwitch = (env: Env) => env.HUBBLE_EXEC_ENABLED ?? env.NODE_ENV !== "production";

/**
 * exec into the privileged cilium-agent (≈ node access) and the API server's service proxy: the deployment switch,
 * then the home connection or a customer connection that opted in (`aks.hubbleExec`). Throws 501 hubble_exec_disabled.
 */
export function assertHubbleExecAllowed(env: Env, clusterArmId: string): void {
  if (!hubbleExecSwitch(env)) {
    throw new HttpError(501, "hubble_exec_disabled", "Hubble exec is off for this deployment (HUBBLE_EXEC_ENABLED) — use Hubble metrics (Managed Prometheus) or ACNS flow logs");
  }
  const { connection } = clusterConnection(env, clusterArmId);
  if (!isHome(connection) && connection.aks?.hubbleExec !== true) {
    throw new HttpError(501, "hubble_exec_disabled", "Hubble exec is not allowed for this connection (aks.hubbleExec) — use Hubble metrics (Managed Prometheus) or ACNS flow logs");
  }
}
