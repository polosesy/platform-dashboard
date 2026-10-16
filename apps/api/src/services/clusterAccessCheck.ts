// "What may the platform do inside this cluster?" — the in-cluster half of the connection check (admin, one cluster
// at a time). Sign-in goes through the same path every Kubernetes feature uses (kubernetes.ts loadKubeConfig), then
// SelfSubjectAccessReview asks the API server about each rule of the read surface (k8sReadSurface.ts), the pod-log
// and Hubble opt-ins when their switch is on, and a few over-privilege probes. Nothing is stored in the cluster.
// SelfSubjectRulesReview is not used: under Azure RBAC for Kubernetes (a webhook authorizer) it is incomplete.
// Pure rollup tested from apps/api/test/featureCatalog.test.ts.
import * as k8s from "@kubernetes/client-node";
import type { ClusterCheckResponse, ClusterPrivilegeWarning, PermissionCell } from "@aud/types";
import type { Env } from "../env.js";
import { clusterConnection } from "../infra/azureClientFactory.js";
import { HttpError, maskGuids } from "../infra/requestParams.js";
import { cellFrom } from "./featureCatalog.js";
import { HUBBLE_EXEC_RULES, K8S_READ_SURFACE, POD_LOG_RULE, type ReadRule } from "./k8sReadSurface.js";
import { hubbleExecSwitch } from "./aksAccess.js";
import { loadKubeConfig } from "./kubernetes.js";

/** One review: true / false, null = the review itself failed */
export type Review = { rule: string; allowed: boolean | null };

const ruleId = (r: { apiGroup: string; resource: string }) => (r.apiGroup ? `${r.apiGroup}/${r.resource}` : r.resource);

/** Permissions, missing read rules and warnings from the reviews (pure) */
export function rollupClusterRules(input: {
  read: Review[];
  podLogs: Review[] | null;
  hubble: Review[] | null;
  over: { secrets: boolean | null; exec: boolean | null; wildcard: boolean | null };
  hubbleOn: boolean;
}): Pick<ClusterCheckResponse, "permissions" | "missingRules" | "warnings"> {
  const cell = (rs: Review[]): PermissionCell => {
    const known = rs.filter((r) => r.allowed != null);
    return cellFrom("cluster", known.filter((r) => r.allowed).length, known.length, rs.length);
  };
  const permissions: ClusterCheckResponse["permissions"] = {
    k8sRead: cell(input.read),
    k8sPodLogs: input.podLogs ? cell(input.podLogs) : { status: "optInOff", at: "cluster", reason: "gateOff" },
    hubbleExec: input.hubble ? cell(input.hubble) : { status: "optInOff", at: "cluster", reason: "gateOff" },
  };
  const warnings: ClusterPrivilegeWarning[] = [];
  if (input.over.secrets) warnings.push("k8s_secrets_read");
  if (input.over.exec && !input.hubbleOn) warnings.push("k8s_exec");
  if (input.over.wildcard) warnings.push("k8s_wildcard");
  return { permissions, missingRules: input.read.filter((r) => r.allowed === false).map((r) => r.rule), warnings };
}

const ACCESS: Record<string, ClusterCheckResponse["access"]> = {
  aks_credential_forbidden: "credentialForbidden",
  aks_local_account_refused: "localAccountRefused",
  cluster_dns_unresolved: "unreachable",
  cluster_unreachable: "unreachable",
};

export async function checkClusterAccess(env: Env, bearerToken: string, clusterId: string): Promise<ClusterCheckResponse> {
  const base = { generatedAt: new Date().toISOString(), cluster: maskGuids(clusterId.split("/").pop() ?? "") };
  const { connection } = clusterConnection(env, clusterId);
  const home = connection.mode === "platform" || connection.mode === "delegated";
  const hubbleOn = hubbleExecSwitch(env) && (home || connection.aks?.hubbleExec === true);
  const podNamespaces = connection.aks?.podLogNamespaces ?? (home ? [undefined] : []);
  let kc: k8s.KubeConfig;
  try {
    kc = await loadKubeConfig(env, bearerToken, clusterId);
  } catch (e) {
    const code = e instanceof HttpError ? e.code : "failed";
    return { ...base, access: ACCESS[code] ?? "failed", code, permissions: {}, missingRules: [], warnings: [] };
  }
  const access = kc.getCurrentUser()?.token ? "entra" : "localAccount";
  const api = kc.makeApiClient(k8s.AuthorizationV1Api);
  const review = async (group: string, resourcePath: string, verb: string, namespace?: string): Promise<boolean | null> => {
    const [resource, subresource] = resourcePath.split("/");
    try {
      const r = await api.createSelfSubjectAccessReview({
        body: { apiVersion: "authorization.k8s.io/v1", kind: "SelfSubjectAccessReview", spec: { resourceAttributes: { group, resource, ...(subresource ? { subresource } : {}), verb, ...(namespace ? { namespace } : {}) } } },
      });
      return r.status?.allowed === true;
    } catch {
      return null;
    }
  };
  const many = async (items: Array<{ rule: ReadRule; verb: string; namespace?: string }>): Promise<Review[]> => {
    const out: Review[] = [];
    for (let i = 0; i < items.length; i += 8) {
      out.push(...await Promise.all(items.slice(i, i + 8).map(async (x) => ({ rule: `${ruleId(x.rule)} ${x.verb}${x.namespace ? ` (${x.namespace})` : ""}`, allowed: await review(x.rule.apiGroup, x.rule.resource, x.verb, x.namespace) }))));
    }
    return out;
  };
  const [read, podLogs, hubble, secrets, exec, wildcard] = await Promise.all([
    many(K8S_READ_SURFACE.map((rule) => ({ rule, verb: "list" }))),
    podNamespaces.length ? many(podNamespaces.map((namespace) => ({ rule: POD_LOG_RULE, verb: "get", ...(namespace ? { namespace } : {}) }))) : Promise.resolve(null),
    hubbleOn ? many(HUBBLE_EXEC_RULES.map((rule) => ({ rule, verb: rule.resource === "pods/exec" ? "create" : "get", namespace: "kube-system" }))) : Promise.resolve(null),
    review("", "secrets", "list"),
    review("", "pods/exec", "create", "kube-system"),
    review("*", "*", "*"),
  ]);
  return { ...base, access, ...rollupClusterRules({ read, podLogs, hubble, over: { secrets, exec, wildcard }, hubbleOn }) };
}
