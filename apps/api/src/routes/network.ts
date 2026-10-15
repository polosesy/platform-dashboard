import type { Request, Response, Router } from "express";
import type { Env } from "../env.js";
import type { NetDir, NetSection, NetTalkerDim } from "@aud/types";
import { mockNetworkSummary, tryGetNetworkSummaryFromLogAnalytics } from "../services/network.js";
import { getNetCoverage, getNetFlows } from "../services/networkFlows.js";
import { mockNetCoverage, mockNetFlows } from "../services/networkMock.js";
import { RANGES } from "../services/networkQueries.js";
import { anonymousSpAllowed, signinRequired } from "../infra/azureClientFactory.js";
import { HttpError, queryInt, queryString, querySubscriptionId, respondLiveOrSignin, sendError } from "../infra/requestParams.js";

const SECTIONS: NetSection[] = ["overview", "talkers", "blocked", "internet"];
const DIMS: NetTalkerDim[] = ["subnet", "vm", "ip", "port"];
const DIRS: NetDir[] = ["in", "out"];
const VNET_KEY = /^[A-Za-z0-9._()-]{1,90}\/[A-Za-z0-9._-]{2,64}$/;

function oneOf<T extends string>(req: Request, name: string, allowed: readonly T[], fallback: T): T {
  const v = queryString(req, name);
  if (v === undefined) return fallback;
  if (!(allowed as readonly string[]).includes(v)) throw new HttpError(400, "invalid_param", `${name} must be one of ${allowed.join(", ")}`);
  return v as T;
}

function requiredSubscription(req: Request, env: Env): string {
  const sub = querySubscriptionId(req, env);
  if (!sub) throw new HttpError(400, "invalid_param", "subscriptionId is required");
  return sub;
}

/** Anonymous callers (dev switch off) get the sample — checked before the subscription so the sample needs none */
const anonymous = (req: Request, env: Env) => !req.auth?.bearerToken && !anonymousSpAllowed(env);

export function registerNetworkRoutes(router: Router, env: Env) {
  // ── Flow-log sections (one per request: only the open tab is queried) ──
  router.get("/api/network/flows", async (req: Request, res: Response) => {
    let params: Parameters<typeof getNetFlows>[2];
    try {
      const section = oneOf(req, "section", SECTIONS, "overview");
      const dim = oneOf(req, "dim", DIMS, "subnet");
      const dir = oneOf(req, "dir", DIRS, "in");
      const rangeRaw = queryInt(req, "range", 1440, 1, 10080);
      const range = (RANGES as readonly number[]).includes(rangeRaw) ? rangeRaw : 1440;
      const top = queryInt(req, "top", 20, 5, 50);
      const vnet = queryString(req, "vnet");
      if (vnet !== undefined && !VNET_KEY.test(vnet)) throw new HttpError(400, "invalid_param", "vnet must be <resource group>/<vnet name>");
      if (anonymous(req, env)) {
        return res.json({ ...mockNetFlows(section, dim, dir, range), note: "signin_required" });
      }
      params = { subscriptionId: requiredSubscription(req, env), vnet, section, range, top, dim, dir };
    } catch (e: unknown) {
      return sendError(res, e, "invalid_param");
    }
    await respondLiveOrSignin(res, () => getNetFlows(env, req.auth?.bearerToken, params), () => mockNetFlows(params.section, params.dim, params.dir, params.range), "network_query_failed");
  });

  // ── Coverage: which VNets have (VNet / NSG) flow logs + Traffic Analytics, and is anything arriving ──
  router.get("/api/network/coverage", async (req: Request, res: Response) => {
    if (anonymous(req, env)) return res.json({ ...mockNetCoverage(), note: "signin_required" });
    let subscriptionId: string;
    try {
      subscriptionId = requiredSubscription(req, env);
    } catch (e: unknown) {
      return sendError(res, e, "invalid_param");
    }
    await respondLiveOrSignin(res, () => getNetCoverage(env, req.auth?.bearerToken, subscriptionId), mockNetCoverage, "network_coverage_failed");
  });

  // ── Legacy summary (architecture overlay shape). Signed-in without a workspace: zero rows, never sample data ──
  router.get("/api/network/summary", async (req: Request, res: Response) => {
    const lookbackMinutes = queryInt(req, "lookbackMinutes", 60, 5, 60 * 24 * 14);
    const top = queryInt(req, "top", 15, 5, 50);
    const empty = () => ({ ...mockNetworkSummary(lookbackMinutes, env.AZURE_LOG_ANALYTICS_TABLE), totals: { totalBytes: 0, allowedFlows: 0, deniedFlows: 0 }, topSubnetPairs: [], topIpPairs: [], topPorts: [] });
    await respondLiveOrSignin(
      res,
      async () => {
        if (anonymous(req, env)) throw signinRequired();
        return (await tryGetNetworkSummaryFromLogAnalytics(env, req.auth?.bearerToken, { lookbackMinutes, top })) ?? empty();
      },
      () => mockNetworkSummary(lookbackMinutes, env.AZURE_LOG_ANALYTICS_TABLE),
      "network_query_failed",
    );
  });
}
