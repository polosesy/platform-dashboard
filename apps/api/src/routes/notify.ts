// 알림 센터 routes.
//   POST /hooks/alerts/:source   — the receiver (outside /api: no SSO token — Azure action groups and Grafana carry the
//                                  shared secret, ?token= or Authorization: Bearer). Mounted before the /api auth.
//   GET  /api/notifications      — the inbox for the signed-in user (alerts on subscriptions their role can't use are hidden)
//   PUT  /api/notifications/ack  — acknowledge / clear (operator)
//   GET  /api/notifications/receiver — receiver status and paths (admin; the token itself is never returned)
//   POST /api/notifications/test — a sample Azure / Grafana delivery through the same parser (operator)
import { createHash, timingSafeEqual } from "node:crypto";
import type { Express, Request, Response, Router } from "express";
import type { NotificationsResponse, NotifyAlert, NotifyCategory, NotifyReceiverInfo, NotifySeverity, OwnerRule } from "@aud/types";
import type { Env } from "../env.js";
import { accessibleConnections, callerOf, requireRole, roleAtLeast } from "../infra/platformAccess.js";
import { connectionForSubscription, getConnections } from "../infra/connectionRegistry.js";
import { sendError } from "../infra/requestParams.js";
import { debug } from "../infra/logger.js";
import { parseAlertPayload, samplePayload, type ParsedAlert } from "../services/alertPayloads.js";
import { ingest, listAlerts, notifyDir, ownerTeam, setAck, setRelayResult } from "../services/notifyStore.js";
import { relay, relayWanted } from "../services/notifyRelay.js";

const SEV_RANK: Record<NotifySeverity, number> = { sev1: 1, sev2: 2, sev3: 3, sev4: 4 };
const PER_MINUTE = 600;

const digest = (s: string) => createHash("sha256").update(s).digest();
/** Constant-time comparison of the presented secret with the configured one */
export function tokenMatches(presented: string | undefined, expected: string | undefined): boolean {
  if (!presented || !expected) return false;
  return timingSafeEqual(digest(presented), digest(expected));
}

function presentedToken(req: Request): string | undefined {
  const h = req.headers.authorization;
  if (typeof h === "string" && /^Bearer\s+/i.test(h)) return h.replace(/^Bearer\s+/i, "").trim();
  return typeof req.query.token === "string" ? req.query.token : undefined;
}

/** The dashboard's public origin (relay links): the first CORS origin when it is https */
const publicBase = (env: Env): string | null => {
  const o = env.CORS_ORIGIN.split(",")[0]?.trim() ?? "";
  return /^https:\/\//.test(o) ? o.replace(/\/$/, "") : null;
};

function ownersFor(env: Env, a: ParsedAlert): OwnerRule[] {
  const sub = a.target.subscriptionId;
  if (sub) return connectionForSubscription(env, sub)?.owners ?? [];
  return getConnections(env).flatMap((c) => c.owners ?? []);
}

async function deliver(env: Env, parsed: ParsedAlert[]): Promise<number> {
  const dir = notifyDir(env);
  const changed = await ingest(dir, parsed, { retentionDays: env.AUD_NOTIFY_RETENTION_DAYS, teamOf: (a) => ownerTeam(a, ownersFor(env, a)) });
  const url = env.AUD_NOTIFY_RELAY_URL;
  if (url) {
    // Fire and forget — the receiver answers the sender at once; the inbox records each result
    for (const a of changed.filter((x) => relayWanted(x, env.AUD_NOTIFY_RELAY_MIN_SEVERITY))) {
      void relay(url, a, publicBase(env)).then((r) => setRelayResult(dir, a.id, { at: new Date().toISOString(), ok: r.ok, ...(r.status ? { status: r.status } : {}) })).catch(() => undefined);
    }
  }
  return changed.length;
}

export function registerNotifyHooks(app: Express, env: Env) {
  let windowStart = 0, count = 0;
  app.post("/hooks/alerts/:source", async (req: Request, res: Response) => {
    res.setHeader("cache-control", "no-store");
    if (!env.AUD_ALERT_RECEIVER_TOKEN) return res.status(404).json({ error: "receiver_disabled" });
    if (!tokenMatches(presentedToken(req), env.AUD_ALERT_RECEIVER_TOKEN)) return res.status(401).json({ error: "unauthorized" });
    const now = Date.now();
    if (now - windowStart > 60_000) { windowStart = now; count = 0; }
    if (++count > PER_MINUTE) return res.status(429).json({ error: "rate_limited" });
    const source = String(req.params.source ?? "");
    if (!["azure", "grafana", "alertmanager", "auto"].includes(source)) return res.status(404).json({ error: "unknown_source" });
    try {
      const r = parseAlertPayload(req.body, new Date());
      if (r.kind === "unsupported") return res.status(400).json({ error: "unsupported_payload", reason: r.reason });
      // A path that names a format catches a misconfigured sender (Grafana pointed at the Azure path …)
      if (source !== "auto" && !(source === r.kind || (source === "grafana" && r.kind === "alertmanager"))) {
        return res.status(400).json({ error: "payload_mismatch", detected: r.kind });
      }
      const changed = await deliver(env, r.alerts);
      debug(`[notify] ${r.kind}: ${r.alerts.length} alert(s), ${changed} new / changed`);
      res.status(202).json({ accepted: r.alerts.length, kind: r.kind });
    } catch (e: unknown) {
      sendError(res, e, "notify_receive_failed", "notify");
    }
  });
}

const CATS: NotifyCategory[] = ["incident", "security", "monitoring", "change"];
const SEVS: NotifySeverity[] = ["sev1", "sev2", "sev3", "sev4"];

/** Pure: what this caller may see — alerts on a subscription of a connection the role can't use are hidden */
export function visibleTo(alerts: NotifyAlert[], subs: Set<string> | "all"): NotifyAlert[] {
  return alerts.filter((a) => subs === "all" || !a.target.subscriptionId || subs.has(a.target.subscriptionId.toLowerCase()));
}

export function inboxResponse(items: NotifyAlert[], opts: { status: "firing" | "resolved" | "all"; limit: number }): Omit<NotificationsResponse, "durable" | "receiverEnabled" | "canWrite"> {
  const counts = {
    firing: 0, firingUnacked: 0,
    bySeverity: Object.fromEntries(SEVS.map((s) => [s, 0])) as Record<NotifySeverity, number>,
    byCategory: Object.fromEntries(CATS.map((c) => [c, 0])) as Record<NotifyCategory, number>,
  };
  for (const a of items) if (a.status === "firing") {
    counts.firing++;
    if (!a.ack) counts.firingUnacked++;
    counts.bySeverity[a.severity]++;
    counts.byCategory[a.category]++;
  }
  const list = items.filter((a) => opts.status === "all" || a.status === opts.status)
    .sort((a, b) => Number(b.status === "firing") - Number(a.status === "firing") || SEV_RANK[a.severity] - SEV_RANK[b.severity] || Date.parse(b.lastReceivedAt) - Date.parse(a.lastReceivedAt))
    .slice(0, opts.limit);
  return { items: list, counts };
}

export function registerNotifyRoutes(router: Router, env: Env) {
  const dir = notifyDir(env);

  router.get("/api/notifications", async (req: Request, res: Response) => {
    try {
      if (req.auth?.kind !== "user") return res.status(401).json({ error: "signin_required" });
      const role = callerOf(env, req.auth.bearerToken)?.role ?? null;
      const subs = role === "admin" ? "all" as const : new Set(accessibleConnections(env, role).flatMap((c) => c.subscriptions.map((s) => s.toLowerCase())));
      const status = req.query.status === "firing" || req.query.status === "resolved" ? req.query.status : "all";
      const limit = Math.min(Math.max(Number(req.query.limit) || 500, 1), 1000);
      res.setHeader("cache-control", "no-store");
      res.json({
        ...inboxResponse(visibleTo(await listAlerts(dir), subs), { status, limit }),
        durable: !!dir, receiverEnabled: !!env.AUD_ALERT_RECEIVER_TOKEN, canWrite: roleAtLeast(role, "operator"),
      } satisfies NotificationsResponse);
    } catch (e: unknown) {
      sendError(res, e, "notifications_read_failed");
    }
  });

  router.put("/api/notifications/ack", requireRole(env, "operator"), async (req: Request, res: Response) => {
    try {
      if (req.auth?.kind !== "user") return res.status(401).json({ error: "signin_required" });
      const id = typeof req.query.id === "string" ? req.query.id : "";
      if (!/^(az|gf|am):[0-9a-f]{24}$/.test(id)) return res.status(400).json({ error: "notification_id_invalid" });
      const body = (req.body ?? {}) as { ack?: unknown; note?: unknown };
      const note = typeof body.note === "string" ? body.note.trim().slice(0, 300) : undefined;
      const r = await setAck(dir, id, body.ack === false ? null : { by: req.auth.principal.name ?? "", ...(note ? { note } : {}) });
      if (!r.ok) return res.status(404).json({ error: "notification_not_found" });
      res.json({ alert: r.alert });
    } catch (e: unknown) {
      sendError(res, e, "notification_ack_failed");
    }
  });

  router.get("/api/notifications/receiver", requireRole(env, "admin"), (_req: Request, res: Response) => {
    const url = env.AUD_NOTIFY_RELAY_URL;
    res.json({
      enabled: !!env.AUD_ALERT_RECEIVER_TOKEN,
      paths: { azure: "/hooks/alerts/azure", grafana: "/hooks/alerts/grafana", auto: "/hooks/alerts/auto" },
      tokenHint: env.AUD_ALERT_RECEIVER_TOKEN ? `…${env.AUD_ALERT_RECEIVER_TOKEN.slice(-4)}` : null,
      relay: { configured: !!url, host: url ? new URL(url).host : null, minSeverity: env.AUD_NOTIFY_RELAY_MIN_SEVERITY },
      durable: !!dir, retentionDays: env.AUD_NOTIFY_RETENTION_DAYS,
    } satisfies NotifyReceiverInfo);
  });

  router.post("/api/notifications/test", requireRole(env, "operator"), async (req: Request, res: Response) => {
    try {
      const kind = req.query.kind === "grafana" ? "grafana" : "azure";
      const r = parseAlertPayload(samplePayload(kind));
      if (r.kind === "unsupported") return res.status(500).json({ error: "sample_unparsed" });
      const changed = await deliver(env, r.alerts.map((a) => ({ ...a, source: "test" as const, labels: { ...a.labels, test: "true" } })));
      res.status(202).json({ accepted: r.alerts.length, changed });
    } catch (e: unknown) {
      sendError(res, e, "notification_test_failed");
    }
  });
}
