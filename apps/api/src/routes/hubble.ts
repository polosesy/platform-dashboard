import type { Request, Response, Router } from "express";
import type { Env } from "../env";
import { getHubbleFlows, getHubbleStatus } from "../services/hubbleClient";
import { collectServiceMap, collectNetworkSummary, collectSecuritySummary } from "../services/hubbleCollector";
import type {
  HubbleStatusResponse,
  HubbleFlowsResponse,
} from "@aud/types";

export function registerHubbleRoutes(router: Router, env: Env) {
  // ── Status — Hubble Relay 연결 상태 ──
  router.get("/api/hubble/status", async (req: Request, res: Response) => {
    const clusterId = typeof req.query.clusterId === "string" ? req.query.clusterId : "";
    if (!clusterId) {
      res.status(400).json({ error: "missing_params", message: "clusterId is required" });
      return;
    }
    try {
      const status = await getHubbleStatus(env, req.auth?.bearerToken, clusterId);
      const data: HubbleStatusResponse = {
        clusterId,
        generatedAt: new Date().toISOString(),
        ...status,
      };
      res.json(data);
    } catch (e: unknown) {
      console.error("[hubble] status error:", e instanceof Error ? e.message : e);
      res.status(500).json({ error: "hubble_status_failed", message: e instanceof Error ? e.message : String(e) });
    }
  });

  // ── Service Map — 서비스 종속성 그래프 ──
  router.get("/api/hubble/service-map", async (req: Request, res: Response) => {
    const clusterId = typeof req.query.clusterId === "string" ? req.query.clusterId : "";
    const timeWindow = Math.min(60, Math.max(1, parseInt(String(req.query.timeWindow ?? "5"), 10) || 5));
    const namespace = typeof req.query.namespace === "string" ? req.query.namespace : undefined;
    if (!clusterId) {
      res.status(400).json({ error: "missing_params", message: "clusterId is required" });
      return;
    }
    try {
      const data = await collectServiceMap(env, req.auth?.bearerToken, clusterId, {
        timeWindowMinutes: timeWindow,
        namespace,
      });
      res.json(data);
    } catch (e: unknown) {
      console.error("[hubble] service-map error:", e instanceof Error ? e.message : e);
      res.status(500).json({ error: "service_map_failed", message: e instanceof Error ? e.message : String(e) });
    }
  });

  // ── Flows — 원시 플로우 테이블 ──
  router.get("/api/hubble/flows", async (req: Request, res: Response) => {
    const clusterId = typeof req.query.clusterId === "string" ? req.query.clusterId : "";
    const namespace = typeof req.query.namespace === "string" ? req.query.namespace : undefined;
    const verdict = typeof req.query.verdict === "string" ? req.query.verdict : undefined;
    const type = typeof req.query.type === "string" ? req.query.type : undefined;
    const limit = Math.min(10_000, Math.max(100, parseInt(String(req.query.limit ?? "1000"), 10) || 1000));
    if (!clusterId) {
      res.status(400).json({ error: "missing_params", message: "clusterId is required" });
      return;
    }
    try {
      const flows = await getHubbleFlows(env, req.auth?.bearerToken, clusterId, {
        namespace,
        verdict,
        type,
        last: limit,
      });
      const data: HubbleFlowsResponse = {
        clusterId,
        generatedAt: new Date().toISOString(),
        flows: flows.slice(0, limit),
        totalReturned: Math.min(flows.length, limit),
        hasMore: flows.length > limit,
      };
      res.json(data);
    } catch (e: unknown) {
      console.error("[hubble] flows error:", e instanceof Error ? e.message : e);
      res.status(500).json({ error: "flows_failed", message: e instanceof Error ? e.message : String(e) });
    }
  });

  // ── Network Summary — 네트워크 모니터링 ──
  router.get("/api/hubble/network-summary", async (req: Request, res: Response) => {
    const clusterId = typeof req.query.clusterId === "string" ? req.query.clusterId : "";
    const timeWindow = Math.min(60, Math.max(1, parseInt(String(req.query.timeWindow ?? "5"), 10) || 5));
    if (!clusterId) {
      res.status(400).json({ error: "missing_params", message: "clusterId is required" });
      return;
    }
    try {
      const data = await collectNetworkSummary(env, req.auth?.bearerToken, clusterId, timeWindow);
      res.json(data);
    } catch (e: unknown) {
      console.error("[hubble] network-summary error:", e instanceof Error ? e.message : e);
      res.status(500).json({ error: "network_summary_failed", message: e instanceof Error ? e.message : String(e) });
    }
  });

  // ── Security Summary — 보안 관측 ──
  router.get("/api/hubble/security-summary", async (req: Request, res: Response) => {
    const clusterId = typeof req.query.clusterId === "string" ? req.query.clusterId : "";
    const timeWindow = Math.min(60, Math.max(1, parseInt(String(req.query.timeWindow ?? "5"), 10) || 5));
    if (!clusterId) {
      res.status(400).json({ error: "missing_params", message: "clusterId is required" });
      return;
    }
    try {
      const data = await collectSecuritySummary(env, req.auth?.bearerToken, clusterId, timeWindow);
      res.json(data);
    } catch (e: unknown) {
      console.error("[hubble] security-summary error:", e instanceof Error ? e.message : e);
      res.status(500).json({ error: "security_summary_failed", message: e instanceof Error ? e.message : String(e) });
    }
  });
}
