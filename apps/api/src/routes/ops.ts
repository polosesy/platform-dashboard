// 알림·대응 › 사례·런북 (docs/architecture/ops-knowledge.md §5): the team's cases and runbooks, and "have we seen
// this before?". Read and search = signed in; write = operator or above. No sample data (facts only): anonymous
// callers get empty lists.
import type { Request, Response, Router } from "express";
import { z } from "zod";
import type { Env } from "../env.js";
import type { OpsCase, OpsKnowledgeResponse, OpsRunbook, OpsSimilarResponse } from "@aud/types";
import { accessibleConnections, callerOf, requireRole, roleAtLeast } from "../infra/platformAccess.js";
import { connectionForSubscription } from "../infra/connectionRegistry.js";
import { sendError } from "../infra/requestParams.js";
import { CaseBody, RunbookBody, maskTexts, opsKnowledgeDir, readKnowledge, runbookUsage, writeOps, type OpsWriteResult } from "../services/opsKnowledgeStore.js";
import { findSimilar } from "../services/opsMatch.js";

const SimilarBody = z.object({
  text: z.string().max(20_000).optional(),
  signals: z.array(z.object({ kind: z.string().max(20), value: z.string().max(120) }).strict()).max(20).optional(),
  scope: z.object({
    clusterId: z.string().max(400).optional(), clusterName: z.string().max(253).optional(), namespace: z.string().max(253).optional(),
    workload: z.string().max(253).optional(), resourceType: z.string().max(253).optional(),
  }).strict().optional(),
  exclude: z.string().max(48).optional(),
}).strict();

/** The connection a cluster's ARM id belongs to (by its subscription) — null when none is named, undefined when unknown */
function connectionOfCluster(env: Env, clusterId: string | undefined): string | null | undefined {
  if (!clusterId) return null;
  const sub = /^\/subscriptions\/([0-9a-f-]{36})\//i.exec(clusterId)?.[1];
  return sub ? connectionForSubscription(env, sub)?.key : undefined;
}

export function registerOpsRoutes(router: Router, env: Env) {
  const dir = opsKnowledgeDir(env);
  const usable = (req: Request) => new Set(accessibleConnections(env, callerOf(env, req.auth?.bearerToken)?.role ?? null).map((c) => c.key));

  router.get("/api/ops/knowledge", async (req: Request, res: Response) => {
    try {
      if (req.auth?.kind !== "user") {
        return res.json({ cases: [], runbooks: [], usage: {}, durable: !!dir, signedIn: false, canWrite: false } satisfies OpsKnowledgeResponse);
      }
      const { cases, runbooks } = await readKnowledge(dir, usable(req));
      const canWrite = roleAtLeast(callerOf(env, req.auth.bearerToken)?.role ?? null, "operator");
      res.json({ cases, runbooks, usage: runbookUsage(cases), durable: !!dir, signedIn: true, canWrite } satisfies OpsKnowledgeResponse);
    } catch (e: unknown) {
      sendError(res, e, "ops_read_failed");
    }
  });

  router.post("/api/ops/similar", async (req: Request, res: Response) => {
    try {
      if (req.auth?.kind !== "user") return res.status(401).json({ error: "signin_required" });
      const body = SimilarBody.safeParse(req.body);
      if (!body.success) return res.status(400).json({ error: "ops_similar_invalid" });
      const { cases, runbooks } = await readKnowledge(dir, usable(req));
      const signals = (body.data.signals ?? []).filter((s): s is OpsCase["signals"][number] =>
        ["k8sReason", "exitCode", "dropReason", "alertRule", "httpStatus", "errorCode", "exception", "resourceType", "keyword"].includes(s.kind));
      res.json(findSimilar({ ...body.data, signals }, cases, runbooks) satisfies OpsSimilarResponse);
    } catch (e: unknown) {
      sendError(res, e, "ops_similar_failed");
    }
  });

  const answer = <T>(res: Response, r: OpsWriteResult<T>, what: "case" | "runbook", redactions = 0) => {
    if (r.ok) return res.json({ item: r.item, durable: !!dir, redactions });
    if (r.error === "conflict") return res.status(409).json({ error: `ops_${what}_conflict`, current: r.current });
    if (r.error === "forbidden") return res.status(403).json({ error: "connection_forbidden" });
    if (r.error === "not_found") return res.status(404).json({ error: `ops_${what}_not_found` });
    return res.status(400).json({ error: r.error === "store_full" ? `ops_${what}_store_full` : `ops_${what}_invalid` });
  };

  const write = (kind: "cases" | "runbooks", remove: boolean) => async (req: Request, res: Response) => {
    const what = kind === "cases" ? "case" : "runbook";
    try {
      if (req.auth?.kind !== "user") return res.status(401).json({ error: "signin_required" });
      const id = typeof req.query.id === "string" && req.query.id ? req.query.id : null;
      const role = callerOf(env, req.auth.bearerToken)?.role ?? null;
      const allowed = new Set(accessibleConnections(env, role).map((c) => c.key));
      const mayUse = (k: string) => allowed.has(k);
      const by = req.auth.principal.name;
      if (remove) {
        const rev = Number(req.query.baseRev);
        if (!id || !Number.isInteger(rev) || rev < 1) return res.status(400).json({ error: `ops_${what}_invalid` });
        return answer(res, await writeOps(dir, kind, id, null, { baseRev: rev, connection: null, mayUse }), what);
      }
      const now = new Date();
      if (kind === "cases") {
        const parsed = CaseBody.safeParse(req.body);
        if (!parsed.success) return res.status(400).json({ error: "ops_case_invalid", fields: parsed.error.issues.map((i) => i.path.join(".")).slice(0, 10) });
        const connection = connectionOfCluster(env, parsed.data.scope.clusterId);
        if (connection === undefined) return res.status(400).json({ error: "ops_cluster_unknown" });
        const { body: b, n } = maskTexts(parsed.data, ["symptoms", "cause", "resolution", "lessons", "title"]);
        const { baseRev, ...rest } = b;
        const r = await writeOps<OpsCase>(dir, "cases", id, (prev, nid) => ({
          ...rest, id: nid, rev: (prev?.rev ?? 0) + 1,
          ...(rest.status === "resolved" ? { resolvedAt: rest.resolvedAt ?? prev?.resolvedAt ?? now.toISOString() } : {}),
          createdAt: prev?.createdAt ?? now.toISOString(), ...(prev?.createdBy ?? by ? { createdBy: prev?.createdBy ?? by } : {}),
          updatedAt: now.toISOString(), ...(by ? { updatedBy: by } : {}), ...(n || prev?.redactions ? { redactions: (prev?.redactions ?? 0) + n } : {}),
        }), { baseRev, connection, mayUse, title: rest.title, now });
        return answer(res, r, what, n);
      }
      const parsed = RunbookBody.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "ops_runbook_invalid", fields: parsed.error.issues.map((i) => i.path.join(".")).slice(0, 10) });
      const connection = connectionOfCluster(env, parsed.data.scope?.clusterId);
      if (connection === undefined) return res.status(400).json({ error: "ops_cluster_unknown" });
      let n = 0;
      const masked = maskTexts(parsed.data, ["title", "when", "rollback"]);
      n += masked.n;
      const steps = masked.body.steps.map((s) => { const m = maskTexts(s, ["title", "detail", "command", "check"]); n += m.n; return m.body; });
      const { baseRev, scope: _scope, ...rest } = { ...masked.body, steps };
      const r = await writeOps<OpsRunbook>(dir, "runbooks", id, (prev, nid) => ({
        ...rest, id: nid, rev: (prev?.rev ?? 0) + 1,
        createdAt: prev?.createdAt ?? now.toISOString(), ...(prev?.createdBy ?? by ? { createdBy: prev?.createdBy ?? by } : {}),
        updatedAt: now.toISOString(), ...(by ? { updatedBy: by } : {}), ...(n || prev?.redactions ? { redactions: (prev?.redactions ?? 0) + n } : {}),
      }), { baseRev, connection, mayUse, title: rest.title, now });
      return answer(res, r, what, n);
    } catch (e: unknown) {
      sendError(res, e, `ops_${what}_write_failed`);
    }
  };
  router.put("/api/ops/cases", requireRole(env, "operator"), write("cases", false));
  router.delete("/api/ops/cases", requireRole(env, "operator"), write("cases", true));
  router.put("/api/ops/runbooks", requireRole(env, "operator"), write("runbooks", false));
  router.delete("/api/ops/runbooks", requireRole(env, "operator"), write("runbooks", true));
}
