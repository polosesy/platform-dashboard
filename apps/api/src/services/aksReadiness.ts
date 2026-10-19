// AKS integration readiness — what the platform can do with a cluster and what to ask the customer for, decided from
// Azure facts only (ARM properties, effective permissions, the cluster's own monitoring workspaces, a DNS/TCP probe):
// it works when the API server is private and unreachable, so the checklist is there before any Kubernetes call.
// Pure `aksReadiness` + `askSnippet` tested from apps/api/test/aksReadiness.test.ts; `collectAksReadiness` reads Azure.
//
//   tier 0  Azure only — Defender for Containers, Azure Policy add-on, managed Prometheus (+ Monitoring Data Reader on
//           the cluster's OWN workspace), Container Insights
//   tier 1  inside the cluster — Entra sign-in, local accounts off, how access is granted (Kubernetes RBAC binding vs
//           Azure RBAC role), Cluster User Role, network reach
//   credential  how the connection signs in (federation = no secret)
import type { AksAskKind, AksReadinessItem, AksReadinessKey, CredentialKind } from "@aud/types";
import type { Env } from "../env.js";
import { clusterConnection, getArmFetcherAuto } from "../infra/azureClientFactory.js";
import { credentialKind } from "../infra/connectionRegistry.js";
import { debug } from "../infra/logger.js";
import { decodeJwt } from "jose";
import { credentials } from "../infra/connectionCredentials.js";
import { aksClusterProfile, probeApiServer } from "./aksAccess.js";
import { clusterMonitorAccounts } from "./clusterMonitoring.js";
import { allows, type PermissionSet } from "./connectionCheck.js";

const at = (o: unknown, path: string): unknown => path.split(".").reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined), o);
const on = (v: unknown): boolean | null => (v === true ? true : v === false ? false : null);

export type ReadinessContext = {
  /** The connection's tenant (Entra sign-in must be in it) */
  connectionTenantId: string;
  credential: CredentialKind;
  /** listClusterUserCredential allowed on the cluster (null = could not read the permissions) */
  clusterUserRole: boolean | null;
  /** The cluster's own Azure Monitor workspaces and whether the connection may read their metrics */
  workspaces: Array<{ dataReader: boolean | null }> | null;
  /** DNS/TCP probe of the API server: null = reached, "dns"/"tcp" = failed there, "notRun" = no host */
  probe: "dns" | "tcp" | null | "notRun";
};

/** The checklist (pure) — every item is a fact from ARM or the context, "unknown" when it could not be read */
const KEYS: Array<[AksReadinessKey, 0 | 1]> = [["defender", 0], ["policyAddon", 0], ["prometheus", 0], ["containerInsights", 0], ["entra", 1], ["localAccounts", 1], ["authz", 1], ["clusterUserRole", 1], ["reach", 1], ["credential", 1]];

export function aksReadiness(props: Record<string, unknown> | undefined, ctx: ReadinessContext): AksReadinessItem[] {
  // The cluster could not be read: nothing is known — never "missing" on an absent property
  if (!props) return KEYS.map(([key, tier]) => ({ key, tier, state: "unknown" }));
  const p = props;
  const prof = aksClusterProfile(p);
  const items: AksReadinessItem[] = [];
  const add = (key: AksReadinessKey, tier: AksReadinessItem["tier"], state: AksReadinessItem["state"], ask?: AksReadinessItem["ask"], detail?: AksReadinessItem["detail"]) =>
    items.push({ key, tier, state, ...(ask ? { ask } : {}), ...(detail ? { detail } : {}) });

  // ── tier 0: Azure only ──
  // ARM leaves out a profile that is not configured: with the cluster read, absent = off
  const defender = on(at(p, "securityProfile.defender.securityMonitoring.enabled"));
  add("defender", 0, defender === true ? "ok" : "missing");
  const policy = on(at(p, "addonProfiles.azurepolicy.enabled") ?? at(p, "addonProfiles.azurePolicy.enabled"));
  add("policyAddon", 0, policy === true ? "ok" : "missing");
  const prom = on(at(p, "azureMonitorProfile.metrics.enabled"));
  if (prom !== true) add("prometheus", 0, "missing", undefined, "metricsOff");
  else if (ctx.workspaces == null) add("prometheus", 0, "unknown");
  else if (!ctx.workspaces.length) add("prometheus", 0, "missing", undefined, "noWorkspace");
  else {
    const readable = ctx.workspaces.filter((w) => w.dataReader === true).length;
    const unknown = ctx.workspaces.some((w) => w.dataReader == null);
    add("prometheus", 0, readable ? "ok" : unknown ? "unknown" : "missing", readable ? undefined : "amwDataReader", readable ? undefined : "noDataReader");
  }
  const ci = on(at(p, "azureMonitorProfile.containerInsights.enabled") ?? at(p, "addonProfiles.omsagent.enabled"));
  add("containerInsights", 0, ci === true ? "ok" : "missing");

  // ── tier 1: inside the cluster ──
  const entraOk = prof.entra && (!prof.entraTenantId || prof.entraTenantId === ctx.connectionTenantId.toLowerCase());
  add("entra", 1, entraOk ? "ok" : "missing", undefined, entraOk ? undefined : prof.legacyEntra ? "legacyEntra" : prof.entra ? "otherTenant" : "noEntra");
  add("localAccounts", 1, prof.localAccounts ? "missing" : "ok");
  // Kubernetes RBAC: a ClusterRoleBinding to the identity's object id (GitOps); Azure RBAC: an Azure role assignment
  add("authz", 1, "info", prof.azureRbac ? "azureRbacRole" : "clusterRoleBinding", prof.azureRbac ? "azureRbac" : "kubernetesRbac");
  add("clusterUserRole", 1, ctx.clusterUserRole === true ? "ok" : ctx.clusterUserRole === false ? "missing" : "unknown", ctx.clusterUserRole === true ? undefined : "clusterUserRole");
  if (ctx.probe === "notRun") add("reach", 1, "unknown");
  else if (ctx.probe == null) add("reach", 1, "ok");
  else add("reach", 1, "missing", prof.private ? "privateEndpoint" : "allowedIp", prof.private ? (ctx.probe === "dns" ? "privateDns" : "privateTcp") : ctx.probe === "dns" ? "publicDns" : "publicTcp");

  // ── how the connection signs in ──
  add("credential", 1, ctx.credential === "secret" ? "info" : "ok", ctx.credential === "secret" ? "federation" : undefined, ctx.credential);
  return items;
}

/** Copy-ready requests for the customer (placeholders unless the value is known; never run by the platform) */
export function askSnippet(kind: AksAskKind, v: { objectId?: string; issuer?: string; subject?: string } = {}): string {
  const oid = v.objectId ?? "<CONNECTION_IDENTITY_OBJECT_ID>";
  switch (kind) {
    case "clusterUserRole":
      return `az role assignment create --assignee-object-id ${oid} --assignee-principal-type ServicePrincipal \\\n  --role "Azure Kubernetes Service Cluster User Role" --scope <CLUSTER_RESOURCE_ID>`;
    case "clusterRoleBinding":
      return [
        "# aud-dashboard-reader ClusterRole: docs/integrations/azure/templates/aks/aud-dashboard-reader.yaml (list only, no Secret/exec)",
        "apiVersion: rbac.authorization.k8s.io/v1",
        "kind: ClusterRoleBinding",
        "metadata:",
        "  name: aud-dashboard-reader",
        "subjects:",
        "  - kind: User",
        `    name: "${oid}"`,
        "    apiGroup: rbac.authorization.k8s.io",
        "roleRef:",
        "  kind: ClusterRole",
        "  name: aud-dashboard-reader",
        "  apiGroup: rbac.authorization.k8s.io",
      ].join("\n");
    case "azureRbacRole":
      return `az role assignment create --assignee-object-id ${oid} --assignee-principal-type ServicePrincipal \\\n  --role "Azure Kubernetes Service RBAC Reader" --scope <CLUSTER_RESOURCE_ID>`;
    case "amwDataReader":
      return `az role assignment create --assignee-object-id ${oid} --assignee-principal-type ServicePrincipal \\\n  --role "Monitoring Data Reader" --scope <AZURE_MONITOR_WORKSPACE_RESOURCE_ID>`;
    case "privateEndpoint":
      return [
        "# Platform side: a Private Endpoint for this cluster's API server in the platform VNet (customer subnet + NSG)",
        "az network private-endpoint create --name pe-<CUSTOMER>-<CLUSTER> --resource-group <PLATFORM_RG> \\",
        "  --vnet-name <PLATFORM_VNET> --subnet <CUSTOMER_SUBNET> --group-id management \\",
        "  --private-connection-resource-id <CLUSTER_RESOURCE_ID> --connection-name <CUSTOMER>-<CLUSTER> --manual-request true",
        "# Customer side: approve the request on the cluster (Networking › Private endpoint connections)",
        "# Platform DNS: privatelink.<region>.azmk8s.io → the endpoint IP (the cluster's privateFQDN)",
      ].join("\n");
    case "allowedIp":
      return "az aks update -g <CLUSTER_RG> -n <CLUSTER> --api-server-authorized-ip-ranges <PLATFORM_EGRESS_IP>/32,<EXISTING_RANGES>";
    case "federation":
      return JSON.stringify({
        name: "fed-common-aud-dashboard",
        issuer: v.issuer ?? "<PLATFORM_OIDC_ISSUER_URL>",
        subject: v.subject ?? "system:serviceaccount:<PLATFORM_NAMESPACE>:<PLATFORM_SERVICE_ACCOUNT>",
        description: "Azure Unified Dashboard (read-only) - Workload Identity, no secret",
        audiences: ["api://AzureADTokenExchange"],
      }, null, 2);
  }
}

const ARM = "https://management.azure.com";
const LIST_USER = { action: "Microsoft.ContainerService/managedClusters/listClusterUserCredential/action" };
const METRICS_READ = { action: "Microsoft.Monitor/accounts/data/metrics/read", data: true };
const PROBE_MS = 3_000;

/** Read the Azure facts of one cluster with the connection's credential (admin route) */
export async function collectAksReadiness(env: Env, bearerToken: string, clusterId: string): Promise<{ items: AksReadinessItem[]; snippets: Partial<Record<AksAskKind, string>> }> {
  const { connection } = clusterConnection(env, clusterId);
  const fetcher = await getArmFetcherAuto(env, bearerToken);
  const perms = async (scope: string) => {
    try {
      return (await fetcher.fetchJson<{ value?: PermissionSet[] }>(`${ARM}${scope}/providers/Microsoft.Authorization/permissions?api-version=2022-04-01`)).value ?? [];
    } catch (e) {
      debug(`[aks-ready] permissions not read: ${String(e).slice(0, 120)}`);
      return null;
    }
  };
  let props: Record<string, unknown> | undefined;
  try {
    props = (await fetcher.fetchJson<{ properties?: Record<string, unknown> }>(`${ARM}${clusterId}?api-version=2024-09-01`)).properties;
  } catch (e) {
    debug(`[aks-ready] cluster not read: ${String(e).slice(0, 120)}`);
  }
  const prof = aksClusterProfile(props);
  const host = prof.private ? prof.hosts.find((h) => h.includes(".privatelink.") || h.includes(".private")) ?? prof.hosts[0] : prof.hosts[0];
  const [clusterPerms, accounts, probe] = await Promise.all([
    perms(clusterId),
    clusterMonitorAccounts(fetcher, clusterId).catch(() => null),
    host ? probeApiServer(host, PROBE_MS).catch(() => "tcp" as const) : Promise.resolve("notRun" as const),
  ]);
  const workspaces = accounts == null ? null : await Promise.all(accounts.slice(0, 5).map(async (id) => {
    const p = await perms(id);
    return { dataReader: p == null ? null : allows(p, METRICS_READ) };
  }));
  const items = aksReadiness(props, {
    connectionTenantId: connection.tenantId,
    credential: credentialKind(env, connection),
    clusterUserRole: clusterPerms == null ? null : allows(clusterPerms, LIST_USER),
    workspaces,
    probe,
  });
  // The identity's object id (what the binding and role assignments name) from the connection's own token
  let objectId: string | undefined;
  if (connection.mode !== "delegated") {
    try {
      const oid = decodeJwt(await credentials().token(env, connection, `${ARM}/.default`, bearerToken)).oid;
      if (typeof oid === "string" && /^[0-9a-f-]{36}$/i.test(oid)) objectId = oid.toLowerCase();
    } catch { /* placeholder stays */ }
  }
  const federation = env.AUD_PLATFORM_OIDC_ISSUER && env.AUD_PLATFORM_FEDERATION_SUBJECT ? { issuer: env.AUD_PLATFORM_OIDC_ISSUER, subject: env.AUD_PLATFORM_FEDERATION_SUBJECT } : {};
  const snippets: Partial<Record<AksAskKind, string>> = {};
  for (const it of items) if (it.ask) snippets[it.ask] = askSnippet(it.ask, { objectId, ...federation });
  return { items, snippets };
}
