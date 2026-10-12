import type { Request, Response, Router } from "express";
import type { Env } from "../env.js";
import type { KubernetesClusterInfo } from "@aud/types";
import { listAksClusters, getClusterOverview, mockClusters, mockClusterOverview } from "../services/kubernetes.js";
import { collectClusterPolicies } from "../services/k8sPolicyCollector.js";
import { collectPolicyInsights } from "../services/policyInsightsCollector.js";
import { assertArmResourceId, queryArmResourceId, querySubscriptionId, respondWithFallback, sendError } from "../infra/requestParams.js";

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
      console.error("[kubernetes] overview error:", e instanceof Error ? e.message : e);
      // Fall back to mock overview
      res.json({
        ...mockClusterOverview(mockClusters.clusters[0]!),
        note: e instanceof Error ? e.message : "overview error",
      });
    }
  });

  // Policy insights: risk combinations, attack paths, RBAC matrix, workload network map, KBOM
  // (registered before /policies so the more specific path is matched first)
  router.get("/api/kubernetes/policies/insights", async (req: Request, res: Response) => {
    try {
      const clusterId = queryArmResourceId(req, env, "clusterId");
      res.json(await collectPolicyInsights(env, req.auth?.bearerToken, clusterId));
    } catch (e: unknown) {
      sendError(res, e, "policy_insights_failed", "kubernetes");
    }
  });

  // Cluster policy posture: PSA, NetworkPolicy, RBAC, VPA/HPA/PDB, resource governance
  router.get("/api/kubernetes/policies", async (req: Request, res: Response) => {
    try {
      const clusterId = queryArmResourceId(req, env, "clusterId");
      res.json(await collectClusterPolicies(env, req.auth?.bearerToken, clusterId));
    } catch (e: unknown) {
      sendError(res, e, "policies_failed", "kubernetes");
    }
  });
}
