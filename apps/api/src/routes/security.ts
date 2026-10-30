import type { Request, Response, Router } from "express";
import type { Env } from "../env.js";
import { mockSecureScore, mockSecurityAlerts, mockSecurityPosture } from "../mockData.js";
import { tryGetSecureScore, tryGetSecurityAlerts } from "../services/security.js";
import { tryGetSecurityPosture } from "../services/securityPosture.js";
import { queryArmResourceId, querySubscriptionId, respondWithFallback, sendError } from "../infra/requestParams.js";
import { queryLang } from "../infra/lang.js";
import { collectAdvisories } from "../services/advisoriesCollector.js";
import type { IssueStatesResponse, SavedQueriesResponse } from "@aud/types";
import { callerOf, requireRole, roleAtLeast } from "../infra/platformAccess.js";
import { connectionForSubscription } from "../infra/connectionRegistry.js";
import { IssueStateBody, issueStateDir, readIssueStates, writeIssueState } from "../services/issueStateStore.js";
import { SavedQueryBody, readSavedQueries, writeSavedQuery } from "../services/savedQueryStore.js";

export function registerSecurityRoutes(router: Router, env: Env) {
  const enabled = env.AZURE_SECURITY_ENABLED;

  router.get("/api/security/score", (req: Request, res: Response) =>
    respondWithFallback(
      res,
      async () => {
        const subscriptionId = querySubscriptionId(req, env);
        return enabled ? tryGetSecureScore(env, req.auth?.bearerToken, { subscriptionId }) : null;
      },
      mockSecureScore,
      "security",
    ),
  );

  router.get("/api/security/alerts", (req: Request, res: Response) =>
    respondWithFallback(
      res,
      async () => {
        const subscriptionId = querySubscriptionId(req, env);
        return enabled ? tryGetSecurityAlerts(env, req.auth?.bearerToken, { subscriptionId }) : null;
      },
      mockSecurityAlerts,
      "security",
    ),
  );

  // Defender posture via Resource Graph — recommendations, controls, compliance, plans, alerts (OBO or SP)
  router.get("/api/security/posture", (req: Request, res: Response) =>
    respondWithFallback(
      res,
      async () => tryGetSecurityPosture(env, req.auth?.bearerToken, { subscriptionId: querySubscriptionId(req, env) }),
      mockSecurityPosture,
      "security",
    ),
  );

  // 보안 › 긴급 취약점: official feeds (CISA KEV, NVD, nodejs.org, php.net) matched against this dashboard's runtime,
  // the selected cluster's images and Defender container findings. ?cves= adds a watch list (CVE IDs only, max 20)
  router.get("/api/security/advisories", async (req: Request, res: Response) => {
    try {
      const clusterId = typeof req.query.clusterId === "string" && req.query.clusterId ? queryArmResourceId(req, env, "clusterId") : null;
      const watch = typeof req.query.cves === "string" ? req.query.cves.split(/[\s,]+/).filter(Boolean) : [];
      res.json(await collectAdvisories(env, req.auth?.bearerToken, { clusterId, watch, lang: queryLang(req) }));
    } catch (e: unknown) {
      sendError(res, e, "advisories_failed", "security");
    }
  });

  // 통합 위험 › 이슈 목록: the team's status per issue (the issues are recomputed by the web from their sources).
  // Read = signed-in; write = operator or above. The subscription is checked against the caller's connections by
  // the authorize middleware before this runs.
  const stateDir = issueStateDir(env);
  router.get("/api/security/issue-states", async (req: Request, res: Response) => {
    try {
      if (req.auth?.kind !== "user") return res.json({ states: {}, durable: !!stateDir, signedIn: false, canWrite: false } satisfies IssueStatesResponse);
      const subscriptionId = querySubscriptionId(req, env);
      const canWrite = roleAtLeast(callerOf(env, req.auth.bearerToken)?.role ?? null, "operator");
      if (!subscriptionId) return res.json({ states: {}, durable: !!stateDir, signedIn: true, canWrite } satisfies IssueStatesResponse);
      const owners = connectionForSubscription(env, subscriptionId)?.owners ?? [];
      res.json({ states: await readIssueStates(stateDir, subscriptionId), owners, durable: !!stateDir, signedIn: true, canWrite } satisfies IssueStatesResponse);
    } catch (e: unknown) {
      sendError(res, e, "issue_state_read_failed");
    }
  });
  router.put("/api/security/issue-states", requireRole(env, "operator"), async (req: Request, res: Response) => {
    try {
      if (req.auth?.kind !== "user") return res.status(401).json({ error: "signin_required" });
      const subscriptionId = querySubscriptionId(req, env);
      if (!subscriptionId) return res.status(400).json({ error: "subscription_required" });
      const key = typeof req.query.key === "string" ? req.query.key : "";
      const body = IssueStateBody.safeParse(req.body);
      if (!body.success) return res.status(400).json({ error: "issue_state_invalid" });
      const r = await writeIssueState(stateDir, subscriptionId, key, body.data, { by: req.auth.principal.name });
      if (r.ok) return res.json({ state: r.state, durable: !!stateDir });
      if (r.error === "conflict") return res.status(409).json({ error: "issue_state_conflict", current: "current" in r ? r.current : null });
      res.status(400).json({ error: r.error });
    } catch (e: unknown) {
      sendError(res, e, "issue_state_write_failed");
    }
  });
  // 그래프 탐색 › 팀 저장 질문 (P5): the questions only (results are recomputed). Same rights as the issue states.
  router.get("/api/security/saved-queries", async (req: Request, res: Response) => {
    try {
      if (req.auth?.kind !== "user") return res.json({ queries: [], durable: !!stateDir, signedIn: false, canWrite: false } satisfies SavedQueriesResponse);
      const subscriptionId = querySubscriptionId(req, env);
      const canWrite = roleAtLeast(callerOf(env, req.auth.bearerToken)?.role ?? null, "operator");
      res.json({ queries: subscriptionId ? await readSavedQueries(stateDir, subscriptionId) : [], durable: !!stateDir, signedIn: true, canWrite } satisfies SavedQueriesResponse);
    } catch (e: unknown) {
      sendError(res, e, "saved_query_read_failed");
    }
  });
  const writeQuery = (remove: boolean) => async (req: Request, res: Response) => {
    try {
      if (req.auth?.kind !== "user") return res.status(401).json({ error: "signin_required" });
      const subscriptionId = querySubscriptionId(req, env);
      if (!subscriptionId) return res.status(400).json({ error: "subscription_required" });
      const id = typeof req.query.id === "string" && req.query.id ? req.query.id : null;
      let body: SavedQueryBody | { baseRev: number };
      if (remove) {
        const rev = Number(req.query.baseRev);
        if (!id || !Number.isInteger(rev) || rev < 1) return res.status(400).json({ error: "saved_query_invalid" });
        body = { baseRev: rev };
      } else {
        const parsed = SavedQueryBody.safeParse(req.body);
        if (!parsed.success) return res.status(400).json({ error: "saved_query_invalid" });
        body = parsed.data;
      }
      const r = await writeSavedQuery(stateDir, subscriptionId, id, body, { by: req.auth.principal.name, remove });
      if (r.ok) return res.json({ query: r.query, durable: !!stateDir });
      if (r.error === "conflict") return res.status(409).json({ error: "saved_query_conflict", current: "current" in r ? r.current : null });
      res.status(400).json({ error: r.error });
    } catch (e: unknown) {
      sendError(res, e, "saved_query_write_failed");
    }
  };
  router.put("/api/security/saved-queries", requireRole(env, "operator"), writeQuery(false));
  router.delete("/api/security/saved-queries", requireRole(env, "operator"), writeQuery(true));
}
