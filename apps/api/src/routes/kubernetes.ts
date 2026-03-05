import type { Request, Response, Router } from "express";
import type { Env } from "../env";
import { listAksClusters, getClusterOverview, mockClusters, mockClusterOverview } from "../services/kubernetes";

export function registerKubernetesRoutes(router: Router, env: Env) {
  // List AKS clusters
  router.get("/api/kubernetes/clusters", async (req: Request, res: Response) => {
    const subscriptionId =
      typeof req.query.subscriptionId === "string" ? req.query.subscriptionId : undefined;
    try {
      const data = await listAksClusters(env, req.auth?.bearerToken, { subscriptionId });
      res.json(data);
    } catch (e: unknown) {
      console.error("[kubernetes] clusters error:", e instanceof Error ? e.message : e);
      res.json({ ...mockClusters, note: e instanceof Error ? e.message : "clusters error" });
    }
  });

  // Get cluster overview (K8s objects)
  router.get("/api/kubernetes/cluster/:clusterId/overview", async (req: Request, res: Response) => {
    const clusterId = req.params.clusterId;
    // clusterId is base64url-encoded Azure resource ID
    let azureResourceId: string;
    try {
      azureResourceId = Buffer.from(clusterId, "base64url").toString("utf-8");
    } catch {
      res.status(400).json({ error: "invalid_cluster_id" });
      return;
    }

    try {
      // First, get cluster info from the clusters list
      const subscriptionId =
        typeof req.query.subscriptionId === "string" ? req.query.subscriptionId : undefined;
      const clustersData = await listAksClusters(env, req.auth?.bearerToken, { subscriptionId });
      const clusterInfo = clustersData.clusters.find(
        (c) => c.id === azureResourceId.toLowerCase(),
      );

      if (!clusterInfo) {
        // Fallback: create minimal cluster info from the resource ID
        const parts = azureResourceId.split("/");
        const name = parts[parts.length - 1] ?? "unknown";
        const rg = parts[parts.indexOf("resourcegroups") + 1] ?? parts[parts.indexOf("resourceGroups") + 1] ?? "";
        const subId = parts[parts.indexOf("subscriptions") + 1] ?? "";

        const overview = await getClusterOverview(env, req.auth?.bearerToken, azureResourceId, {
          id: azureResourceId.toLowerCase(),
          name,
          resourceGroup: rg,
          subscriptionId: subId,
          location: "",
          kubernetesVersion: "",
          nodeCount: 0,
          powerState: "unknown",
          fqdn: "",
        });
        res.json(overview);
        return;
      }

      const overview = await getClusterOverview(env, req.auth?.bearerToken, azureResourceId, clusterInfo);
      res.json(overview);
    } catch (e: unknown) {
      console.error("[kubernetes] overview error:", e instanceof Error ? e.message : e);
      // Fall back to mock overview
      const fallbackCluster = mockClusters.clusters[0]!;
      res.json({
        ...mockClusterOverview(fallbackCluster),
        note: e instanceof Error ? e.message : "overview error",
      });
    }
  });
}
