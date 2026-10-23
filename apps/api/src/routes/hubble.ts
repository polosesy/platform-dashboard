import type { Request, Response, Router } from "express";
import type { Env } from "../env.js";
import { getHubbleFlows, getHubbleStatus } from "../services/hubbleClient.js";
import { collectServiceMap, collectNetworkSummary, collectSecuritySummary } from "../services/hubbleCollector.js";
import type { HubbleStatusResponse, HubbleFlowsResponse } from "@aud/types";
import { queryArmResourceId, queryInt, queryString, sendError } from "../infra/requestParams.js";
import { queryLang } from "../infra/lang.js";
import { getHubbleSources } from "../services/hubbleSources.js";
import { getHubbleMetricsSummary } from "../services/hubbleMetrics.js";
import { getLokiDrops } from "../services/lokiLogs.js";

export function registerHubbleRoutes(router: Router, env: Env) {
  // ── Status — Hubble Relay 연결 상태 ──
  router.get("/api/hubble/status", async (req: Request, res: Response) => {
    try {
      const clusterId = queryArmResourceId(req, env, "clusterId");
      const status = await getHubbleStatus(env, req.auth?.bearerToken, clusterId, queryLang(req));
      const data: HubbleStatusResponse = { clusterId, generatedAt: new Date().toISOString(), ...status };
      res.json(data);
    } catch (e: unknown) {
      sendError(res, e, "hubble_status_failed", "hubble");
    }
  });

  // ── Sources — exec / ACNS flow logs / Hubble metrics: what the views can read for this cluster ──
  router.get("/api/hubble/sources", async (req: Request, res: Response) => {
    try {
      const clusterId = queryArmResourceId(req, env, "clusterId");
      res.json(await getHubbleSources(env, req.auth?.bearerToken, clusterId));
    } catch (e: unknown) {
      sendError(res, e, "hubble_sources_failed", "hubble");
    }
  });

  // ── Metrics summary — Hubble metrics in Managed Prometheus (no exec, no edges) ──
  router.get("/api/hubble/metrics-summary", async (req: Request, res: Response) => {
    try {
      const clusterId = queryArmResourceId(req, env, "clusterId");
      res.json(await getHubbleMetricsSummary(env, req.auth?.bearerToken, clusterId, queryInt(req, "window", 15, 1, 1440)));
    } catch (e: unknown) {
      sendError(res, e, "hubble_metrics_failed", "hubble");
    }
  });

  // ── Drops from Loki (hubble-flow-exporter → {job="hubble-flows"}) + the exporter pipeline's health ──
  router.get("/api/hubble/loki-drops", async (req: Request, res: Response) => {
    try {
      const clusterId = queryArmResourceId(req, env, "clusterId");
      const minutes = queryInt(req, "window", 60, 1, 1440);
      // AMW cross-check: Hubble counted drops in the same window (hubble_drop_total) — the metrics view's 60 m figure
      const amw = async () => {
        const m = await getHubbleMetricsSummary(env, req.auth?.bearerToken, clusterId, 60);
        return m.state === "ok" && !m.missing.includes("hubble_drop_total") ? m.dropsByReason.reduce((a, d) => a + d.count, 0) : null;
      };
      res.json(await getLokiDrops(env, req.auth?.bearerToken, clusterId, minutes, amw));
    } catch (e: unknown) {
      sendError(res, e, "loki_drops_failed", "hubble");
    }
  });

  // ── Service Map — 서비스 종속성 그래프 ──
  router.get("/api/hubble/service-map", async (req: Request, res: Response) => {
    try {
      const clusterId = queryArmResourceId(req, env, "clusterId");
      const data = await collectServiceMap(env, req.auth?.bearerToken, clusterId, {
        timeWindowMinutes: queryInt(req, "timeWindow", 5, 1, 60),
        namespace: queryString(req, "namespace"),
        lang: queryLang(req),
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
        lang: queryLang(req),
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
      res.json(await collectNetworkSummary(env, req.auth?.bearerToken, clusterId, queryInt(req, "timeWindow", 5, 1, 60), queryLang(req)));
    } catch (e: unknown) {
      sendError(res, e, "network_summary_failed", "hubble");
    }
  });

  // ── Security Summary — 보안 관측 ──
  router.get("/api/hubble/security-summary", async (req: Request, res: Response) => {
    try {
      const clusterId = queryArmResourceId(req, env, "clusterId");
      res.json(await collectSecuritySummary(env, req.auth?.bearerToken, clusterId, queryInt(req, "timeWindow", 5, 1, 60), queryLang(req)));
    } catch (e: unknown) {
      sendError(res, e, "security_summary_failed", "hubble");
    }
  });
}
