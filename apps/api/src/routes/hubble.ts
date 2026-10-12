import type { Request, Response, Router } from "express";
import type { Env } from "../env.js";
import { getHubbleFlows, getHubbleStatus } from "../services/hubbleClient.js";
import { collectServiceMap, collectNetworkSummary, collectSecuritySummary } from "../services/hubbleCollector.js";
import type { HubbleStatusResponse, HubbleFlowsResponse } from "@aud/types";
import { queryArmResourceId, queryInt, queryString, sendError } from "../infra/requestParams.js";

export function registerHubbleRoutes(router: Router, env: Env) {
  // ── Status — Hubble Relay 연결 상태 ──
  router.get("/api/hubble/status", async (req: Request, res: Response) => {
    try {
      const clusterId = queryArmResourceId(req, env, "clusterId");
      const status = await getHubbleStatus(env, req.auth?.bearerToken, clusterId);
      const data: HubbleStatusResponse = { clusterId, generatedAt: new Date().toISOString(), ...status };
      res.json(data);
    } catch (e: unknown) {
      sendError(res, e, "hubble_status_failed", "hubble");
    }
  });

  // ── Service Map — 서비스 종속성 그래프 ──
  router.get("/api/hubble/service-map", async (req: Request, res: Response) => {
    try {
      const clusterId = queryArmResourceId(req, env, "clusterId");
      const data = await collectServiceMap(env, req.auth?.bearerToken, clusterId, {
        timeWindowMinutes: queryInt(req, "timeWindow", 5, 1, 60),
        namespace: queryString(req, "namespace"),
      });
      res.json(data);
    } catch (e: unknown) {
      sendError(res, e, "service_map_failed", "hubble");
    }
  });

  // ── Flows — 원시 플로우 테이블 ──
  router.get("/api/hubble/flows", async (req: Request, res: Response) => {
    try {
      const clusterId = queryArmResourceId(req, env, "clusterId");
      const limit = queryInt(req, "limit", 1000, 100, 10_000);
      const { flows, coverage } = await getHubbleFlows(env, req.auth?.bearerToken, clusterId, {
        namespace: queryString(req, "namespace"),
        verdict: queryString(req, "verdict"),
        type: queryString(req, "type"),
        last: limit,
      });
      const data: HubbleFlowsResponse = {
        clusterId,
        generatedAt: new Date().toISOString(),
        flows: flows.slice(0, limit),
        totalReturned: Math.min(flows.length, limit),
        hasMore: flows.length > limit,
        coverage,
      };
      res.json(data);
    } catch (e: unknown) {
      sendError(res, e, "flows_failed", "hubble");
    }
  });

  // ── Network Summary — 네트워크 모니터링 ──
  router.get("/api/hubble/network-summary", async (req: Request, res: Response) => {
    try {
      const clusterId = queryArmResourceId(req, env, "clusterId");
      res.json(await collectNetworkSummary(env, req.auth?.bearerToken, clusterId, queryInt(req, "timeWindow", 5, 1, 60)));
    } catch (e: unknown) {
      sendError(res, e, "network_summary_failed", "hubble");
    }
  });

  // ── Security Summary — 보안 관측 ──
  router.get("/api/hubble/security-summary", async (req: Request, res: Response) => {
    try {
      const clusterId = queryArmResourceId(req, env, "clusterId");
      res.json(await collectSecuritySummary(env, req.auth?.bearerToken, clusterId, queryInt(req, "timeWindow", 5, 1, 60)));
    } catch (e: unknown) {
      sendError(res, e, "security_summary_failed", "hubble");
    }
  });
}
