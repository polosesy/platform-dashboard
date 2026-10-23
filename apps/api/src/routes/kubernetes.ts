import type { Request, Response, Router } from "express";
import type { Env } from "../env.js";
import type { KubernetesClusterInfo } from "@aud/types";
import { listAksClusters, getClusterOverview, mockClusters, mockClusterOverview } from "../services/kubernetes.js";
import { collectClusterPolicies } from "../services/k8sPolicyCollector.js";
import { collectPolicyInsights } from "../services/policyInsightsCollector.js";
import { collectWorkloadIdentity } from "../services/workloadIdentityCollector.js";
import { queryLang } from "../infra/lang.js";
import { HttpError, assertArmResourceId, isSigninRequired, queryArmResourceId, querySubscriptionId, respondWithFallback, safeMessage, sendError } from "../infra/requestParams.js";

/** Minimal cluster info derived from an ARM ID, used when the cluster is not in the listing. */
function clusterInfoFromId(azureResourceId: string): KubernetesClusterInfo {
  const segment = (key: string) => azureResourceId.match(new RegExp(`/${key}/([^/]+)`, "i"))?.[1] ?? "";
  return {
    id: azureResourceId.toLowerCase(),
    name: azureResourceId.split("/").pop() ?? "unknown",
    resourceGroup: segment("resourceGroups"),
    subscriptionId: segment("subscriptions"),
    location: "",
    kubernetesVersion: "",
    nodeCount: 0,
    powerState: "unknown",
    fqdn: "",
  };
}

export function registerKubernetesRoutes(router: Router, env: Env) {
  // List AKS clusters
  router.get("/api/kubernetes/clusters", (req: Request, res: Response) =>
    respondWithFallback(
      res,
      () => listAksClusters(env, req.auth?.bearerToken, { subscriptionId: querySubscriptionId(req, env) }),
      mockClusters,
      "kubernetes",
    ),
  );

  // Get cluster overview (K8s objects). clusterId is the base64url-encoded Azure resource ID.
  router.get("/api/kubernetes/cluster/:clusterId/overview", async (req: Request, res: Response) => {
    let azureResourceId: string;
    let subscriptionId: string | undefined;
    // A sample cluster (what anonymous callers are shown) answers with its sample overview
    const decoded = Buffer.from(req.params.clusterId ?? "", "base64url").toString("utf-8").toLowerCase();
    const sample = mockClusters.clusters.find((c) => c.id === decoded);
    if (sample) return void res.json({ ...mockClusterOverview(sample), note: req.auth?.bearerToken ? "mock data" : "signin_required" });
    try {
      azureResourceId = assertArmResourceId(env, Buffer.from(req.params.clusterId ?? "", "base64url").toString("utf-8"), "clusterId");
      subscriptionId = querySubscriptionId(req, env);
    } catch (e: unknown) {
      return sendError(res, e, "invalid_cluster_id");
    }

    try {
      const clustersData = await listAksClusters(env, req.auth?.bearerToken, { subscriptionId });
      const clusterInfo =
        clustersData.clusters.find((c) => c.id === azureResourceId.toLowerCase()) ?? clusterInfoFromId(azureResourceId);
      res.json(await getClusterOverview(env, req.auth?.bearerToken, azureResourceId, clusterInfo));
    } catch (e: unknown) {
      // Sign in → the sample overview; a real refusal (expired sign-in, Entra-only cluster …) stays an error
      if (e instanceof HttpError && !isSigninRequired(e)) return sendError(res, e, "cluster_overview_failed", "kubernetes");
      console.error("[kubernetes] overview error:", safeMessage(e));
      res.json({
        ...mockClusterOverview(mockClusters.clusters[0]!),
        note: isSigninRequired(e) ? "signin_required" : safeMessage(e),
      });
    }
  });

  // Policy insights: risk combinations, attack paths, RBAC matrix, workload network map, KBOM
  // (registered before /policies so the more specific path is matched first)
  router.get("/api/kubernetes/policies/insights", async (req: Request, res: Response) => {
    try {
      const clusterId = queryArmResourceId(req, env, "clusterId");
      res.json(await collectPolicyInsights(env, req.auth?.bearerToken, clusterId, queryLang(req)));
    } catch (e: unknown) {
      sendError(res, e, "policy_insights_failed", "kubernetes");
    }
  });

  // Workload identity map: pods → ServiceAccount → federated credential → managed identity → Azure roles (WI-01…16).
  // Read when the tab opens; ?scan=subscription also checks other identities of the cluster's subscription (capped)
  router.get("/api/kubernetes/policies/workload-identity", async (req: Request, res: Response) => {
    try {
      const clusterId = queryArmResourceId(req, env, "clusterId");
      res.json(await collectWorkloadIdentity(env, req.auth?.bearerToken, clusterId, queryLang(req), { scan: req.query.scan === "subscription" }));
    } catch (e: unknown) {
      sendError(res, e, "workload_identity_failed", "kubernetes");
    }
  });

  // Cluster policy posture: PSA, NetworkPolicy, RBAC, VPA/HPA/PDB, resource governance
  router.get("/api/kubernetes/policies", async (req: Request, res: Response) => {
    try {
      const clusterId = queryArmResourceId(req, env, "clusterId");
      res.json(await collectClusterPolicies(env, req.auth?.bearerToken, clusterId, queryLang(req)));
    } catch (e: unknown) {
      sendError(res, e, "policies_failed", "kubernetes");
    }
  });
}
