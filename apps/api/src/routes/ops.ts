// 알림·대응 › 사례·런북 (docs/architecture/ops-knowledge.md §5): the team's cases and runbooks, and "have we seen
// this before?". Read and search = signed in; write = operator or above. No sample data (facts only): anonymous
// callers get empty lists.
import type { Request, Response, Router } from "express";
import { z } from "zod";
import type { Env } from "../env.js";
import type { OpsAgentStatus, OpsCase, OpsKnowledgeResponse, OpsRunbook, OpsSimilarResponse } from "@aud/types";
import { agentContext, agentProvider, agentStatus } from "../services/opsAgent.js";
import { accessibleConnections, callerOf, requireRole, roleAtLeast } from "../infra/platformAccess.js";
import { connectionForSubscription } from "../infra/connectionRegistry.js";
import { sendError } from "../infra/requestParams.js";
import { CaseBody, RunbookBody, maskTexts, opsKnowledgeDir, readKnowledge, runbookUsage, writeOps, type OpsWriteResult } from "../services/opsKnowledgeStore.js";
import { findSimilar } from "../services/opsMatch.js";
import { RECURRENCE_DAYS, azureRecurrenceFirings, centerFirings, recurrenceGroups, type RecurrenceDays } from "../services/opsRecurrence.js";
import { listAlerts, notifyDir } from "../services/notifyStore.js";
import { visibleTo } from "./notify.js";
import type { OpsAlertRecurrence, OpsRecurrenceResponse } from "@aud/types";
import { queryArmResourceId } from "../infra/requestParams.js";
import { LIBRARY } from "../services/opsLibrary.js";
import { getChanges } from "../services/opsChanges.js";
import { takeEvidence } from "../services/opsEvidence.js";
import { attachEvidence } from "../services/opsKnowledgeStore.js";
import { recurrenceKey } from "../services/opsRecurrence.js";
import { checkFeeds, decideItem, feedsResponse, setFeeds, startFeedWatch } from "../services/opsFeeds.js";

const NAME = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;
const isoOf = (v: unknown): string | null => { const t = typeof v === "string" ? Date.parse(v) : NaN; return Number.isNaN(t) ? null : new Date(t).toISOString(); };

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
  // 외부 학습: the registered blogs are read in the background
  startFeedWatch(env);

  router.get("/api/ops/knowledge", async (req: Request, res: Response) => {
    try {
      if (req.auth?.kind !== "user") {
        return res.json({ cases: [], runbooks: [], usage: {}, durable: !!dir, signedIn: false, canWrite: false } satisfies OpsKnowledgeResponse);
      }
      const { cases, runbooks } = await readKnowledge(dir, usable(req));
      const canWrite = roleAtLeast(callerOf(env, req.auth.bearerToken)?.role ?? null, "operator");
      res.json({ cases, library: LIBRARY, runbooks, usage: runbookUsage(cases), durable: !!dir, signedIn: true, canWrite } satisfies OpsKnowledgeResponse);
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
      // the team's cases and the public library (lib- ids) — the screen says which is which
      res.json(findSimilar({ ...body.data, signals }, [...cases, ...LIBRARY], runbooks) satisfies OpsSimilarResponse);
    } catch (e: unknown) {
      sendError(res, e, "ops_similar_failed");
    }
  });

  // Agent (stage 2 — skeleton): its status, and the draft call that answers 501 until a provider is configured.
  // The context it would be given is built either way (the same code a provider will receive), so the answer can say
  // how much would have been sent — never the text itself.
  // 재발: every firing of the same alert rule on the same target (Azure Monitor + the alert centre), with the cases and
  // runbooks written for it — signed in; the caller's subscriptions and connections only (§10)
  router.get("/api/ops/recurrence", async (req: Request, res: Response) => {
    try {
      if (req.auth?.kind !== "user") return res.status(401).json({ error: "signin_required" });
      const days = (RECURRENCE_DAYS as readonly number[]).includes(Number(req.query.days)) ? (Number(req.query.days) as RecurrenceDays) : 30;
      const role = callerOf(env, req.auth.bearerToken)?.role ?? null;
      const subs = role === "admin" ? "all" as const : new Set(accessibleConnections(env, role).flatMap((c) => c.subscriptions.map((x) => x.toLowerCase())));
      const [azure, center, kb] = await Promise.all([
        azureRecurrenceFirings(env, req.auth.bearerToken, days),
        listAlerts(notifyDir(env)).then((l) => ({ firings: centerFirings(visibleTo(l, subs)), error: null as string | null }), (e: unknown) => ({ firings: [], error: e instanceof Error ? e.message : String(e) })),
        readKnowledge(dir, usable(req)),
      ]);
      const gaps = [...azure.gaps, ...(center.error ? [{ source: "alertCenter" as const, scope: "inbox", reason: center.error.slice(0, 200) }] : [])];
      const { groups, totals } = recurrenceGroups([...azure.firings, ...center.firings], kb.cases, kb.runbooks, new Date(), days);
      res.setHeader("cache-control", "no-store");
      res.json({
        generatedAt: new Date().toISOString(), days,
        // nothing read at all = failed (never "no recurrence"); some sources = partial, said per gap
        state: !gaps.length ? "ok" : azure.read === 0 && center.error ? "failed" : "partial",
        gaps, totals, groups,
      } satisfies OpsRecurrenceResponse);
    } catch (e: unknown) {
      sendError(res, e, "ops_recurrence_failed");
    }
  });

  // 변경 상관 (§10 B): the changes near a moment in a cluster — rollouts, node maintenance, Warning events (signed in)
  router.get("/api/ops/changes", async (req: Request, res: Response) => {
    try {
      if (req.auth?.kind !== "user") return res.status(401).json({ error: "signin_required" });
      const clusterId = queryArmResourceId(req, env, "clusterId");
      const at = isoOf(req.query.at) ?? new Date().toISOString();
      const ns = typeof req.query.namespace === "string" && NAME.test(req.query.namespace) ? req.query.namespace : undefined;
      const wl = typeof req.query.workload === "string" && NAME.test(req.query.workload) ? req.query.workload : undefined;
      res.json(await getChanges(env, req.auth.bearerToken, clusterId, at, { ...(ns ? { namespace: ns } : {}), ...(wl ? { workload: wl } : {}) }));
    } catch (e: unknown) {
      sendError(res, e, "ops_changes_failed");
    }
  });

  // 증거 스냅샷 (§10 C): read-only facts about a case's scope, fixed into the case (operator — event messages, log counts)
  router.post("/api/ops/cases/evidence", requireRole(env, "operator"), async (req: Request, res: Response) => {
    try {
      if (req.auth?.kind !== "user") return res.status(401).json({ error: "signin_required" });
      const id = typeof req.query.id === "string" ? req.query.id : "";
      const { cases } = await readKnowledge(dir, usable(req));
      const c = cases.find((x) => x.id === id);
      if (!c) return res.status(404).json({ error: "ops_case_not_found" });
      if (!c.scope.clusterId) return res.status(400).json({ error: "ops_evidence_no_cluster" });
      const ev = await takeEvidence(env, req.auth.bearerToken, c.scope, c.occurredAt, req.auth.principal.name ?? undefined);
      const allowed = usable(req);
      const r = await attachEvidence(dir, id, ev, (k) => allowed.has(k));
      if (!r.ok) return res.status(r.error === "forbidden" ? 403 : r.error === "not_found" ? 404 : 400).json({ error: `ops_evidence_${r.error}` });
      res.json({ item: r.item, evidence: ev });
    } catch (e: unknown) {
      sendError(res, e, "ops_evidence_failed");
    }
  });

  // 알림 → 재발 (§10 D): which firing of its group an alert-centre alert is, and the cases / runbooks of that group
  router.get("/api/ops/recurrence/alert", async (req: Request, res: Response) => {
    try {
      if (req.auth?.kind !== "user") return res.status(401).json({ error: "signin_required" });
      const role = callerOf(env, req.auth.bearerToken)?.role ?? null;
      const subs = role === "admin" ? "all" as const : new Set(accessibleConnections(env, role).flatMap((c) => c.subscriptions.map((x) => x.toLowerCase())));
      const all = visibleTo(await listAlerts(notifyDir(env)), subs);
      const a = all.find((x) => x.id === req.query.id);
      if (!a) return res.status(404).json({ error: "notify_alert_not_found" });
      const days = 30;
      const kb = await readKnowledge(dir, usable(req));
      let firings: ReturnType<typeof centerFirings> = [];
      let key: string | null = null;
      let state: OpsAlertRecurrence["state"] = "ok";
      if (a.source === "azure-monitor") {
        const rule = a.rule.split("/").filter(Boolean).pop() ?? a.rule;
        key = a.target.resourceId ? recurrenceKey({ source: "azureMonitor", rule, targetId: a.target.resourceId }) : null;
        const az = await azureRecurrenceFirings(env, req.auth.bearerToken, days);
        firings = az.firings;
        if (az.gaps.length) state = az.read === 0 ? "failed" : "partial";
      } else if (a.source !== "test") {
        const mine = centerFirings([a]);
        key = mine[0] ? recurrenceKey(mine[0]) : null;
        firings = centerFirings(all);
      }
      const since = Date.now() - days * 86_400_000;
      const group = key ? firings.filter((f) => recurrenceKey(f) === key && Date.parse(f.at) >= since).sort((x, y) => (x.at < y.at ? -1 : 1)) : [];
      const lastStart = a.history?.filter((h) => h.status === "firing").map((h) => h.at).sort().pop() ?? a.startsAt;
      const n = group.filter((f) => f.at <= lastStart).length;
      const { groups } = recurrenceGroups(group, kb.cases, kb.runbooks, new Date(), days);
      const g = groups[0];
      const byId = new Map(kb.cases.map((c) => [c.id, c]));
      const caseRow = (id: string, link: "linked" | "rule") => { const c = byId.get(id)!; return { id, title: c.title, status: c.status, link, occurredAt: c.occurredAt, ...(c.resolution ? { resolution: c.resolution.slice(0, 300) } : {}) }; };
      res.setHeader("cache-control", "no-store");
      res.json({
        key, n: n || (group.length ? group.length : 0), total: group.length, days, firstAt: group[0]?.at ?? null,
        cases: g ? [...g.cases.linked.map((id) => caseRow(id, "linked")), ...g.cases.rule.filter((id) => !g.cases.linked.includes(id)).map((id) => caseRow(id, "rule"))].filter((x) => x.title).slice(0, 10) : [],
        runbooks: g ? g.runbooks.map((id) => kb.runbooks.find((r) => r.id === id)).filter((r): r is NonNullable<typeof r> => !!r).map((r) => ({ id: r.id, title: r.title })) : [],
        state: !key ? "notGrouped" : state,
      } satisfies OpsAlertRecurrence);
    } catch (e: unknown) {
      sendError(res, e, "ops_alert_recurrence_failed");
    }
  });

  // 외부 학습 — 기술 블로그 감시 (§11): the registered feeds and their posts (signed in), the list (operator),
  // a check now (operator, once a minute), a post's decision (operator: recorded as a case / skipped)
  router.get("/api/ops/feeds", async (req: Request, res: Response) => {
    try {
      if (req.auth?.kind !== "user") return res.status(401).json({ error: "signin_required" });
      res.json(await feedsResponse(env, roleAtLeast(callerOf(env, req.auth.bearerToken)?.role ?? null, "operator")));
    } catch (e: unknown) {
      sendError(res, e, "ops_feeds_failed");
    }
  });
  router.put("/api/ops/feeds", requireRole(env, "operator"), async (req: Request, res: Response) => {
    try {
      if (req.auth?.kind !== "user") return res.status(401).json({ error: "signin_required" });
      const b = req.body as { feeds?: unknown; baseRev?: unknown };
      if (!Array.isArray(b?.feeds) || typeof b.baseRev !== "number") return res.status(400).json({ error: "ops_feeds_invalid" });
      const list = b.feeds.map((f) => ({ name: String((f as { name?: unknown })?.name ?? ""), url: String((f as { url?: unknown })?.url ?? "") }));
      const r = await setFeeds(env, list, b.baseRev, req.auth.principal.name ?? "operator");
      if (!r.ok) return res.status(r.error === "conflict" ? 409 : 400).json({ error: r.error === "conflict" ? "ops_feeds_conflict" : "ops_feeds_invalid", ...(r.detail ? { detail: r.detail } : {}) });
      for (const id of r.added) void checkFeeds(env, undefined, id).catch(() => undefined);
      res.json({ rev: r.rev });
    } catch (e: unknown) {
      sendError(res, e, "ops_feeds_write_failed");
    }
  });
  let lastFeedCheck = 0;
  router.post("/api/ops/feeds/check", requireRole(env, "operator"), async (req: Request, res: Response) => {
    try {
      if (Date.now() - lastFeedCheck < 60_000) return res.status(429).json({ error: "ops_feeds_too_soon" });
      lastFeedCheck = Date.now();
      await checkFeeds(env);
      res.json(await feedsResponse(env, true));
    } catch (e: unknown) {
      sendError(res, e, "ops_feeds_check_failed");
    }
  });
  router.put("/api/ops/feeds/item", requireRole(env, "operator"), async (req: Request, res: Response) => {
    try {
      if (req.auth?.kind !== "user") return res.status(401).json({ error: "signin_required" });
      const b = req.body as { id?: unknown; decision?: unknown; caseId?: unknown };
      const decision = b?.decision === "case" || b?.decision === "ignored" ? b.decision : b?.decision === null ? null : undefined;
      if (typeof b?.id !== "string" || decision === undefined) return res.status(400).json({ error: "ops_feed_item_invalid" });
      const ok = await decideItem(env, b.id, decision, req.auth.principal.name ?? "operator", typeof b.caseId === "string" ? b.caseId.slice(0, 48) : undefined);
      if (!ok) return res.status(404).json({ error: "ops_feed_item_not_found" });
      res.json({ ok: true });
    } catch (e: unknown) {
      sendError(res, e, "ops_feed_item_failed");
    }
  });

  router.get("/api/ops/agent", (req: Request, res: Response) => {
    if (req.auth?.kind !== "user") return res.status(401).json({ error: "signin_required" });
    res.json(agentStatus(env) satisfies OpsAgentStatus);
  });
  router.post("/api/ops/agent/draft", requireRole(env, "operator"), async (req: Request, res: Response) => {
    try {
      if (req.auth?.kind !== "user") return res.status(401).json({ error: "signin_required" });
      const body = SimilarBody.safeParse(req.body);
      if (!body.success || !body.data.text?.trim()) return res.status(400).json({ error: "ops_agent_invalid" });
      const provider = agentProvider(env);
      const { cases, runbooks } = await readKnowledge(dir, usable(req));
      const similar = findSimilar({ text: body.data.text, ...(body.data.scope ? { scope: body.data.scope } : {}) }, cases, runbooks);
      const ctx = agentContext(body.data.text, similar, cases, runbooks);
      if (!provider) {
        return res.status(501).json({
          error: "ops_agent_not_configured", status: agentStatus(env),
          wouldSend: { textChars: ctx.text.length, cases: ctx.cases.length, runbooks: ctx.runbooks.length, redactions: ctx.redactions },
        });
      }
      res.json(await provider.draftCase(ctx, AbortSignal.timeout(60_000)));
    } catch (e: unknown) {
      sendError(res, e, "ops_agent_failed");
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
        const masked = maskTexts(parsed.data, ["symptoms", "cause", "resolution", "lessons", "title"]);
        let n = masked.n;
        // timeline lines and follow-ups are free text too (a pasted log line, a token in a note)
        const timeline = masked.body.timeline?.map((e) => { const m = maskTexts(e, ["text"]); n += m.n; return m.body; });
        const followUps = masked.body.followUps?.map((f) => { const m = maskTexts(f, ["title"]); n += m.n; return { ...m.body, ...(m.body.status === "done" ? { doneAt: m.body.doneAt ?? now.toISOString() } : { doneAt: undefined }) }; });
        const b = { ...masked.body, ...(timeline ? { timeline: timeline.sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0)) } : {}), ...(followUps ? { followUps } : {}) };
        const { baseRev, ...rest } = b;
        const r = await writeOps<OpsCase>(dir, "cases", id, (prev, nid) => ({
          ...rest, id: nid, rev: (prev?.rev ?? 0) + 1,
          // evidence is attached by its own call and never edited — kept across edits
          ...(prev?.evidence?.length ? { evidence: prev.evidence } : {}),
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
